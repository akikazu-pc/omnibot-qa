#!/usr/bin/env node
/**
 * 端到端验证：模拟企业微信智能机器人推送
 *
 * 起一个假的 WebSocket 服务端 + 假 LLM，然后：
 *   1. 服务端启动长连接（用注入的假 WebSocket 实现）
 *   2. 模拟企业微信推送一条客户消息
 *   3. 验证：落库 → AI 生成 → 回帧 → 落库 outbound → 配对 QA
 *
 * 用法：node scripts/e2e-bot.js
 */
import http from 'node:http';
import { Store } from '../collector/store.js';
import { fromWecom, recordOutbound } from '../adapters/wecom.js';
import { connectBot } from '../adapters/wecom-bot.js';
import { generateReply } from '../qa/agent.js';

const DB = 'data/e2e-bot.db';
const store = new Store(DB);

// ---- 假 LLM ----
const mockLLM = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const prompt = JSON.stringify(parsed.messages || []);
    const content = prompt.includes('私有化')
      ? '支持私有化部署的哈，可以装到你们自己的服务器上，有需要随时找我'
      : '这个我确认下再回复您';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((r) => mockLLM.listen(8898, '127.0.0.1', r));
process.env.OPENAI_API_KEY = 'mock';
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:8898/v1';
process.env.OPENAI_MODEL = 'mock-model';

// ---- 假 WebSocket ----
class FakeWS {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    FakeWS.instances.push(this);
    setTimeout(() => this.onopen && this.onopen(), 5);
  }
  send(d) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose && this.onclose();
  }
}

const loadKnowledge = () => store.listQa({ status: 'approved', limit: 1000 });
const loadStyle = (limit = 300) =>
  store.db.prepare(`SELECT * FROM messages WHERE direction = 'outbound' ORDER BY timestamp DESC LIMIT ?`).all(limit);

async function handleBotMessage(raw) {
  const isGroup = Boolean(raw.ChatId && raw.ChatType === 'group');
  const conversationId = isGroup ? `group:${raw.ChatId}` : `user:${raw.FromUserName}`;
  const content = raw.Content || '';
  if (!content) return '';

  const msg = await fromWecom(raw, { platform: 'wecom' });
  const added = store.insertMessage(msg);
  console.log(`  [收] ${added ? '新增' : '重复'} ${conversationId} 「${content}」`);
  if (!added) return '';

  const gen = await generateReply({
    question: content,
    history: store.getConversation('wecom', conversationId, { limit: 20 }),
    knowledge: loadKnowledge(),
    styleMessages: loadStyle(),
    persona: '你是XX公司的客服小助手',
    business: '我们卖SaaS客服系统',
  });

  store.insertMessage(
    recordOutbound(raw.FromUserName, gen.text, { platform: 'wecom', agentId: 'bot' })
  );
  console.log(`  [回] 「${gen.text}」`);
  console.log(`  [参] 命中知识 ${gen.references.length} 条 / 风格样本 ${gen.usedStyle} 条`);
  return gen.text;
}

// ---- 准备：一条已审核 QA + 两条人工回复风格样本 ----
console.log('\n=== 准备知识库 ===');
store.saveQaPair({
  platform: 'wecom',
  conversation_id: 'user:zhangsan',
  question: '你们支持私有化部署吗',
  answer: '支持，可以部署到你们自己的服务器上',
  status: 'approved',
  asked_at: Date.now() - 86400000,
  answered_at: Date.now() - 86390000,
});
console.log('  已插入 1 条已审核 QA');

const { Direction, createMessage } = await import('../collector/message.js');
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
console.log('  已插入 2 条人工回复风格样本');

// ---- 启动长连接 ----
console.log('\n=== 启动长连接 ===');
const client = connectBot({
  onMessage: handleBotMessage,
  config: { botId: 'fake', secret: 'fake', apiBase: 'https://qyapi.weixin.qq.com/cgi-bin', reconnectDelayMs: 1000, maxDelayMs: 2000, heartbeatMs: 60000 },
  fetchImpl: async () => ({ json: async () => ({ errcode: 0, ws_url: 'wss://fake.local/ws', ticket: 'TICKET' }) }),
  WebSocketImpl: FakeWS,
  onState: (s, d) => console.log(`  [ws] ${s}${d?.error ? ' ' + d.error : ''}`),
});

await new Promise((r) => setTimeout(r, 300));

// ---- 模拟企业微信推送 ----
console.log('\n=== 模拟客户提问 ===');
const ws = FakeWS.instances[0];
ws.onmessage({
  data: JSON.stringify({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'req-001' },
    body: {
      msgid: 'msg-001',
      from: { userid: 'lisi', name: '李四' },
      to: { userid: 'bot' },
      msgtype: 'text',
      chat_type: 'single',
      text: { content: '你们能私有化部署不？' },
      create_time: Math.floor(Date.now() / 1000),
    },
  }),
});

await new Promise((r) => setTimeout(r, 500));

// ---- 验证 ----
console.log('\n=== 验证结果 ===');
const acks = ws.sent.map((s) => JSON.parse(s)).filter((s) => s.cmd === 'aibot_msg_callback_response');
console.log(`  回执帧: ${acks.length ? '✓ 已发送 req_id=' + acks[0].headers.req_id : '✗ 缺失'}`);
console.log(`  回执内容: ${acks[0]?.body?.text?.content || '(无)'}`);

const msgs = store.db.prepare("SELECT direction, content FROM messages ORDER BY rowid").all();
console.log(`  消息落库: ${msgs.length} 条`);
for (const m of msgs) console.log(`    ${m.direction === 'inbound' ? '客' : '我'} ${m.content.slice(0, 45)}`);

const { pairAll } = await import('../qa/pair.js');
const res = pairAll(store);
console.log(`\n  配对结果: 新增 ${res.newPairs} 条 QA, 未答 ${res.unanswered} 条, 扫描 ${res.conversations} 个会话`);

const qaList = store.listQa({ limit: 20 });
for (const p of qaList) {
  console.log(`    [${p.status}] Q: ${p.question}`);
  console.log(`           A: ${p.answer}`);
}

client.close();
mockLLM.close();
store.close();
console.log('\n✅ 端到端验证完成\n');
