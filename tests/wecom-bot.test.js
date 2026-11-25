/**
 * 企业微信智能机器人长连接客户端测试
 *
 * 用假的 fetch + 假的 WebSocket 模拟企业微信推送，验证：
 *   1. getBotWsUrl 的请求格式与错误处理
 *   2. 报文解析（parseFrame）
 *   3. body 归一化（normalizeBotBody）
 *   4. 回执帧格式（buildAck）
 *   5. connectBot 的完整收发流程 + 断线重连
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getBotWsUrl,
  parseFrame,
  normalizeBotBody,
  buildAck,
  connectBot,
  loadBotConfig,
  isBotConfigured,
} from '../adapters/wecom-bot.js';

test('loadBotConfig 读取环境变量', () => {
  const c = loadBotConfig({ WECOM_BOT_ID: 'b1', WECOM_BOT_SECRET: 's1' });
  assert.equal(c.botId, 'b1');
  assert.equal(c.secret, 's1');
  assert.equal(isBotConfigured({ WECOM_BOT_ID: 'b1', WECOM_BOT_SECRET: 's1' }), true);
  assert.equal(isBotConfigured({}), false);
});

test('getBotWsUrl 请求体正确', async () => {
  let captured = null;
  const fetchImpl = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return {
      json: async () => ({ errcode: 0, ws_url: 'wss://example.com/ws', ticket: 'tk' }),
    };
  };

  const r = await getBotWsUrl({ botId: 'bid', secret: 'sec', apiBase: 'https://x' }, fetchImpl);
  assert.equal(r.wsUrl, 'wss://example.com/ws');
  assert.equal(r.ticket, 'tk');
  assert.equal(captured.url, 'https://x/ai_bot/get_bot_ws_url');
  assert.deepEqual(captured.body, { botid: 'bid', secret: 'sec' });
});

test('getBotWsUrl 报错时抛出可读信息', async () => {
  const fetchImpl = async () => ({ json: async () => ({ errcode: 40001, errmsg: 'invalid secret' }) });
  await assert.rejects(() => getBotWsUrl({ botId: 'b', secret: 's', apiBase: 'https://x' }, fetchImpl), /40001/);
});

test('getBotWsUrl 缺少配置时抛错', async () => {
  await assert.rejects(() => getBotWsUrl({ botId: '', secret: '' }), /WECOM_BOT_ID/);
});

test('parseFrame 解析 JSON 字符串', () => {
  const f = parseFrame(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r1' }, body: { a: 1 } }));
  assert.equal(f.cmd, 'aibot_msg_callback');
  assert.equal(f.reqId, 'r1');
  assert.deepEqual(f.body, { a: 1 });
});

test('parseFrame 遇到非法 JSON 返回空', () => {
  const f = parseFrame('not json');
  assert.equal(f.cmd, '');
  assert.deepEqual(f.body, {});
});

test('normalizeBotBody 归一化单聊文本', () => {
  const raw = normalizeBotBody({
    msgid: 'm1',
    from: { userid: 'zhangsan', name: '张三' },
    to: { userid: 'bot' },
    msgtype: 'text',
    text: { content: '你好' },
    create_time: 1700000000,
  });
  assert.equal(raw.MsgId, 'm1');
  assert.equal(raw.FromUserName, 'zhangsan');
  assert.equal(raw.Content, '你好');
  assert.equal(raw.MsgType, 'text');
  assert.equal(raw.CreateTime, 1700000000);
});

test('normalizeBotBody 兼容扁平 content 字段', () => {
  const raw = normalizeBotBody({ from: { userid: 'u' }, content: '扁平内容', msgtype: 'text' });
  assert.equal(raw.Content, '扁平内容');
});

test('normalizeBotBody 群聊带 ChatId', () => {
  const raw = normalizeBotBody({
    from: { userid: 'u' },
    chat_type: 'group',
    chat_id: 'g1',
    text: { content: 'hi' },
  });
  assert.equal(raw.ChatId, 'g1');
  assert.equal(raw.ChatType, 'group');
});

test('buildAck 格式正确', () => {
  const ack = buildAck('req-1', '收到');
  assert.equal(ack.cmd, 'aibot_msg_callback_response');
  assert.equal(ack.headers.req_id, 'req-1');
  assert.equal(ack.body.text.content, '收到');
  assert.equal(buildAck('r').body.text.content, 'ok');
});

/** 假的 WebSocket 实现 */
class FakeWS {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWS.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
  /** 模拟服务端推送 */
  push(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
}

test('connectBot 完整收发流程', async () => {
  FakeWS.instances = [];
  const cfg = { botId: 'b', secret: 's', apiBase: 'https://x', reconnectDelayMs: 10, maxDelayMs: 20, heartbeatMs: 100000 };

  const fetchImpl = async () => ({
    json: async () => ({ errcode: 0, ws_url: 'wss://example.com/ws', ticket: 'TK' }),
  });

  const received = [];
  const client = connectBot({
    onMessage: async (raw) => {
      received.push(raw.Content);
      return '已收到';
    },
    config: cfg,
    fetchImpl,
    WebSocketImpl: FakeWS,
    onState: () => {},
  });

  // 等连接建立
  await new Promise((r) => setTimeout(r, 20));
  const ws = FakeWS.instances[0];
  assert.ok(ws, '应该创建了 WebSocket');
  assert.ok(ws.url.includes('ticket=TK'), 'URL 应带 ticket');

  // 模拟服务端推送一条消息
  ws.push({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'rq-1' },
    body: { msgid: 'm1', from: { userid: 'u1' }, msgtype: 'text', text: { content: '在吗' } },
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(received[0], '在吗');

  // 应该发出了回执
  const acks = ws.sent.map((s) => JSON.parse(s));
  const ack = acks.find((a) => a.cmd === 'aibot_msg_callback_response');
  assert.ok(ack, '应该发出回执');
  assert.equal(ack.headers.req_id, 'rq-1');
  assert.equal(ack.body.text.content, '已收到');

  client.close();
});

test('connectBot 断线后自动重连', async () => {
  FakeWS.instances = [];
  const cfg = { botId: 'b', secret: 's', apiBase: 'https://x', reconnectDelayMs: 10, maxDelayMs: 20, heartbeatMs: 100000 };

  const fetchImpl = async () => ({
    json: async () => ({ errcode: 0, ws_url: 'wss://example.com/ws', ticket: 'TK' }),
  });

  const client = connectBot({
    onMessage: async () => '',
    config: cfg,
    fetchImpl,
    WebSocketImpl: FakeWS,
    onState: () => {},
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(FakeWS.instances.length, 1);

  // 模拟断线
  FakeWS.instances[0].close();

  await new Promise((r) => setTimeout(r, 60));
  assert.ok(FakeWS.instances.length >= 2, '断线后应该重连');

  client.close();
});

test('connectBot 处理消息时抛异常不影响连接', async () => {
  FakeWS.instances = [];
  const cfg = { botId: 'b', secret: 's', apiBase: 'https://x', reconnectDelayMs: 10, maxDelayMs: 20, heartbeatMs: 100000 };

  const fetchImpl = async () => ({
    json: async () => ({ errcode: 0, ws_url: 'wss://example.com/ws', ticket: 'TK' }),
  });

  const client = connectBot({
    onMessage: async () => {
      throw new Error('业务异常');
    },
    config: cfg,
    fetchImpl,
    WebSocketImpl: FakeWS,
    onState: () => {},
  });

  await new Promise((r) => setTimeout(r, 20));
  const ws = FakeWS.instances[0];
  ws.push({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'rq-x' },
    body: { from: { userid: 'u1' }, msgtype: 'text', text: { content: 'x' } },
  });

  await new Promise((r) => setTimeout(r, 20));
  // 仍然应发出回执
  const acks = ws.sent.map((s) => JSON.parse(s)).filter((a) => a.cmd === 'aibot_msg_callback_response');
  assert.equal(acks.length, 1);

  client.close();
});
