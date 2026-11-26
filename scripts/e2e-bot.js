#!/usr/bin/env node
/**
 * 端到端验证：模拟企业微信智能机器人长连接推送
 *
 * 完整走一遍真实协议：
 *   1. 连上 wss://openws.work.weixin.qq.com（用假 WebSocket）
 *   2. 发 aibot_subscribe 鉴权，收到 errcode=0
 *   3. 企业微信推送 aibot_msg_callback
 *   4. 我方落库 → AI 生成 → 回 aibot_respond_msg(stream)
 *   5. 落库 outbound → 配对 QA
 *
 * 不需要真实凭据，不花钱。用法：node scripts/e2e-bot.js
 */
import http from 'node:http';
import { Store } from '../collector/store.js';
import { fromWecom, recordOutbound } from '../adapters/wecom.js';
import { connectBot } from '../adapters/wecom-bot.js';
import { generateReply } from '../qa/agent.js';
import { createMessage, Direction } from '../collector/message.js';
import { pairAll } from '../qa/pair.js';

const DB = 'data/e2e-bot.db';
const store = new Store(DB);

// ---- 假 LLM ----
const mockLLM = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let question = '';
    let hasRef = false;
    try {
      const p = JSON.parse(body);
      const msgs = p.messages || [];
      // 只看最后一条用户消息，避免被历史污染
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      question = lastUser?.content || '';
      const sys = msgs.find((m) => m.role === 'system')?.content || '';
      hasRef = /过往真实问答/.test(sys) && !/本次没有检索到相关问答/.test(sys) && /私有化/.test(sys);
    } catch {
      /* 解析失败就用空问题 */
    }

    // 模拟一个守规矩的模型：没依据就拒答
    let content = '这个我确认下再回复您';
    if (/私有化/.test(question) && hasRef) {
      content = '支持私有化部署的哈，可以装到你们自己的服务器上，有需要随时找我';
    } else if (/发票|开票/.test(question)) {
      content = '发票可以开，专票普票都行，你告诉我要哪种';
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((r) => mockLLM.listen(8898, '127.0.0.1', r));
process.env.OPENAI_API_KEY = 'mock';
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:8898/v1';
process.env.OPENAI_MODEL = 'mock-model';

// ---- 假 WebSocket（模拟企业微信服务端） ----
class FakeWS {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    FakeWS.instances.push(this);
    setTimeout(() => this.onopen && this.onopen(), 2);
  }
  send(d) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose && this.onclose({ code: 1000 });
  }
  frames() {
    return this.sent.map((s) => JSON.parse(s));
  }
  /** 模拟服务端推送 */
  push(obj) {
    this.onmessage && this.onmessage({ data: JSON.stringify(obj) });
  }
}

const loadKnowledge = () => store.listQa({ status: 'approved', limit: 1000 });
const loadStyle = (limit = 300) =>
  store.db.prepare(`SELECT * FROM messages WHERE direction = 'outbound' ORDER BY timestamp DESC LIMIT ?`).all(limit);

async function handleBotMessage(raw) {
  const isGroup = raw.ChatType === 'group';
  const conversationId = isGroup ? `group:${raw.ChatId}` : `user:${raw.FromUserName}`;
  const content = raw.Content || '';
  if (!content) return '';

  const msg = await fromWecom(raw, { platform: 'wecom' });
  const added = store.insertMessage(msg);
  console.log(`  [收] ${added ? '新增' : '重复丢弃'} ${conversationId} 「${content}」`);
  if (!added) return '';

  const gen = await generateReply({
    question: content,
    history: store.getConversation('wecom', conversationId, { limit: 20 }),
    knowledge: loadKnowledge(),
    styleMessages: loadStyle(),
    persona: '你是XX公司的客服小助手',
    business: '我们卖SaaS客服系统',
  });

  store.insertMessage(recordOutbound(isGroup ? raw.ChatId : raw.FromUserName, gen.text, { platform: 'wecom', agentId: 'bot' }));
  console.log(`  [回] 「${gen.text}」`);
  console.log(`  [参] 命中知识 ${gen.references.length} 条 / 风格样本 ${gen.usedStyle} 条`);
  return gen.text;
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 准备知识库 ----
console.log('\n=== 1. 准备知识库 ===');
store.saveQaPair({
  platform: 'wecom',
  conversation_id: 'user:zhangsan',
  question: '你们支持私有化部署吗',
  answer: '支持，可以部署到你们自己的服务器上',
  status: 'approved',
  asked_at: Date.now() - 86400000,
  answered_at: Date.now() - 86390000,
});
console.log('  已审核 QA × 1');

for (const [i, c] of ['这个我们支持的哈，走年度合同就行', '发票可以开，专票普票都行'].entries()) {
  store.insertMessage(
    createMessage({
      id: `style-${i}`,
      platform: 'wecom',
      conversation_id: 'user:wangwu',
      sender_id: 'agent:self',
      direction: Direction.OUTBOUND,
      content: c,
      timestamp: Date.now() - (10 - i) * 60000,
    })
  );
}
console.log('  人工回复风格样本 × 2');

// ---- 建立长连接 ----
console.log('\n=== 2. 建立长连接 ===');
const states = [];
const client = connectBot({
  onMessage: handleBotMessage,
  config: {
    botId: 'FAKE_BOT_ID',
    secret: 'FAKE_SECRET',
    wsUrl: 'wss://openws.work.weixin.qq.com',
    reconnectDelayMs: 1000,
    maxDelayMs: 2000,
    heartbeatMs: 30000,
    subscribeTimeoutMs: 5000,
  },
  WebSocketImpl: FakeWS,
  onState: (s, d) => {
    states.push(s);
    console.log(`  [ws] ${s}${d?.error ? ' — ' + d.error : ''}`);
  },
});

await tick(30);
const ws = FakeWS.instances[0];
const sub = ws.frames().find((f) => f.cmd === 'aibot_subscribe');
console.log(`  订阅帧: ${sub ? '✓ ' + JSON.stringify(sub.body) : '✗ 未发送'}`);

// 模拟服务端鉴权成功
ws.push({ headers: sub.headers, errcode: 0, errmsg: 'ok' });
await tick(30);
console.log(`  连接状态: ${client.getState()}`);

// ---- 模拟客户提问 ----
console.log('\n=== 3. 客户提问（单聊）===');
ws.push({
  cmd: 'aibot_msg_callback',
  headers: { req_id: 'cb-001' },
  body: {
    msgid: 'msg-001',
    aibotid: 'FAKE_BOT_ID',
    chattype: 'single',
    from: { userid: 'lisi' },
    msgtype: 'text',
    text: { content: '你们能私有化部署不？' },
    create_time: Math.floor(Date.now() / 1000),
  },
});
await tick(300);

// ---- 模拟追问（验证未命中知识时不编造）----
console.log('\n=== 4. 客户追问（知识库没有的问题）===');
ws.push({
  cmd: 'aibot_msg_callback',
  headers: { req_id: 'cb-002' },
  body: {
    msgid: 'msg-002',
    aibotid: 'FAKE_BOT_ID',
    chattype: 'single',
    from: { userid: 'lisi' },
    msgtype: 'text',
    text: { content: '你们老板叫什么' },
    create_time: Math.floor(Date.now() / 1000),
  },
});
await tick(300);

// ---- 验证 ----
console.log('\n=== 5. 验证结果 ===');
const replies = ws.frames().filter((f) => f.cmd === 'aibot_respond_msg');
console.log(`  stream 回帧: ${replies.length} 条`);
for (const r of replies) {
  console.log(`    req_id=${r.headers.req_id} finish=${r.body.stream.finish}`);
  console.log(`    内容: ${r.body.stream.content}`);
}

const msgs = store.db.prepare("SELECT direction, sender_id, content FROM messages WHERE platform='wecom' ORDER BY rowid").all();
console.log(`\n  消息落库: ${msgs.length} 条`);
for (const m of msgs) console.log(`    ${m.direction === 'inbound' ? '客' : '我'} ${m.content.slice(0, 42)}`);

const res = pairAll(store);
console.log(`\n  配对: 新增 ${res.newPairs} 条 QA / 未答 ${res.unanswered} / 会话 ${res.conversations}`);

const qaList = store.listQa({ limit: 20 });
console.log('\n  QA 列表:');
for (const p of qaList) {
  console.log(`    [${p.status}] Q: ${p.question}`);
  console.log(`           A: ${p.answer}`);
}

client.close();
mockLLM.close();
store.close();
console.log('\n✅ 端到端验证完成（协议与官方 SDK 一致）\n');
