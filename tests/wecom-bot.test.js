/**
 * 企业微信智能机器人长连接测试
 *
 * 协议依据官方 SDK @wecom/aibot-node-sdk 的常量定义：
 *   aibot_subscribe / ping / aibot_respond_msg / aibot_msg_callback / aibot_event_callback
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WsCmd,
  loadBotConfig,
  isBotConfigured,
  nextReqId,
  parseFrame,
  normalizeBotBody,
  buildSubscribe,
  buildPing,
  buildReply,
  buildSendMsg,
  connectBot,
} from '../adapters/wecom-bot.js';

test('loadBotConfig 读取环境变量并带默认值', () => {
  const c = loadBotConfig({ WECOM_BOT_ID: 'b1', WECOM_BOT_SECRET: 's1' });
  assert.equal(c.botId, 'b1');
  assert.equal(c.secret, 's1');
  assert.equal(c.wsUrl, 'wss://openws.work.weixin.qq.com');
  assert.equal(c.heartbeatMs, 30000);
});

test('isBotConfigured 判断', () => {
  assert.equal(isBotConfigured({ WECOM_BOT_ID: 'b', WECOM_BOT_SECRET: 's' }), true);
  assert.equal(isBotConfigured({ WECOM_BOT_ID: 'b' }), false);
  assert.equal(isBotConfigured({}), false);
});

test('nextReqId 唯一', () => {
  const a = nextReqId();
  const b = nextReqId();
  assert.notEqual(a, b);
});

test('parseFrame 解析字符串', () => {
  const f = parseFrame(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r1' }, body: { a: 1 } }));
  assert.equal(f.cmd, 'aibot_msg_callback');
  assert.equal(f.reqId, 'r1');
  assert.deepEqual(f.body, { a: 1 });
});

test('parseFrame 解析订阅响应（无 cmd 有 errcode）', () => {
  const f = parseFrame(JSON.stringify({ headers: { req_id: 'r1' }, errcode: 0, errmsg: 'ok' }));
  assert.equal(f.cmd, '');
  assert.equal(f.errcode, 0);
  assert.equal(f.errmsg, 'ok');
});

test('parseFrame 非法 JSON 返回空', () => {
  const f = parseFrame('not json');
  assert.equal(f.cmd, '');
  assert.deepEqual(f.body, {});
});

test('normalizeBotBody 单聊文本', () => {
  const raw = normalizeBotBody({
    msgid: 'm1',
    aibotid: 'bot1',
    chattype: 'single',
    from: { userid: 'zhangsan' },
    msgtype: 'text',
    text: { content: '你好' },
  });
  assert.equal(raw.MsgId, 'm1');
  assert.equal(raw.FromUserName, 'zhangsan');
  assert.equal(raw.Content, '你好');
  assert.equal(raw.ChatType, 'single');
  assert.equal(raw.ChatId, '');
  assert.equal(raw.ToUserName, 'bot1');
});

test('normalizeBotBody 群聊带 chatid', () => {
  const raw = normalizeBotBody({
    msgid: 'm2',
    chatid: 'chat-1',
    chattype: 'group',
    from: { userid: 'u1' },
    msgtype: 'text',
    text: { content: '@机器人 你好' },
  });
  assert.equal(raw.ChatId, 'chat-1');
  assert.equal(raw.ChatType, 'group');
  assert.equal(raw.chatid, 'chat-1');
});

test('normalizeBotBody 语音取 voice.content', () => {
  const raw = normalizeBotBody({
    msgid: 'm3',
    from: { userid: 'u' },
    msgtype: 'voice',
    voice: { content: '我想咨询价格' },
  });
  assert.equal(raw.Content, '我想咨询价格');
  assert.equal(raw.Recognition, '我想咨询价格');
});

test('normalizeBotBody 图片/文件/视频占位文本', () => {
  assert.equal(normalizeBotBody({ msgtype: 'image', image: { url: 'x' } }).Content, '[图片]');
  assert.equal(normalizeBotBody({ msgtype: 'video', video: { url: 'x' } }).Content, '[视频]');
  assert.match(normalizeBotBody({ msgtype: 'file', file: { filename: 'a.pdf' } }).Content, /a\.pdf/);
});

test('normalizeBotBody 图文混排拼接文本', () => {
  const raw = normalizeBotBody({
    msgtype: 'mixed',
    mixed: { msg_item: [{ msgtype: 'text', text: { content: '图片里是这个' } }, { msgtype: 'image', image: { url: 'x' } }] },
  });
  assert.equal(raw.Content, '图片里是这个 [图片]');
});

test('buildSubscribe 格式正确', () => {
  const f = buildSubscribe('bid', 'sec', 'rq');
  assert.equal(f.cmd, 'aibot_subscribe');
  assert.equal(f.headers.req_id, 'rq');
  assert.deepEqual(f.body, { bot_id: 'bid', secret: 'sec' });
});

test('buildPing 格式正确', () => {
  const f = buildPing('p1');
  assert.equal(f.cmd, 'ping');
  assert.equal(f.headers.req_id, 'p1');
});

test('buildReply 使用 aibot_respond_msg + stream', () => {
  const f = buildReply('rq-1', '你好呀', { streamId: 's1' });
  assert.equal(f.cmd, 'aibot_respond_msg');
  assert.equal(f.headers.req_id, 'rq-1');
  assert.equal(f.body.msgtype, 'stream');
  assert.equal(f.body.stream.id, 's1');
  assert.equal(f.body.stream.finish, true);
  assert.equal(f.body.stream.content, '你好呀');
});

test('buildReply 不结束时 finish=false', () => {
  const f = buildReply('rq', '部分内容', { streamId: 's', finish: false });
  assert.equal(f.body.stream.finish, false);
});

test('buildSendMsg 单聊与群聊', () => {
  const single = buildSendMsg({ userId: 'u1', content: 'hi' });
  assert.equal(single.cmd, 'aibot_send_msg');
  assert.equal(single.body.userid, 'u1');
  assert.equal(single.body.chatid, undefined);

  const group = buildSendMsg({ chatId: 'c1', content: 'hi' });
  assert.equal(group.body.chatid, 'c1');
});

test('WsCmd 常量与官方一致', () => {
  assert.equal(WsCmd.SUBSCRIBE, 'aibot_subscribe');
  assert.equal(WsCmd.HEARTBEAT, 'ping');
  assert.equal(WsCmd.RESPONSE, 'aibot_respond_msg');
  assert.equal(WsCmd.CALLBACK, 'aibot_msg_callback');
  assert.equal(WsCmd.EVENT_CALLBACK, 'aibot_event_callback');
  assert.equal(WsCmd.SEND_MSG, 'aibot_send_msg');
});

// ---------------- connectBot 集成 ----------------

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
    setTimeout(() => this.onopen && this.onopen(), 2);
  }
  send(d) {
    this.sent.push(d);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: 1000 });
  }
  push(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
  frames() {
    return this.sent.map((s) => JSON.parse(s));
  }
  /** 模拟服务端对最后一个帧的响应 */
  ackLast(errcode = 0) {
    const last = this.frames().at(-1);
    if (!last) return;
    this.push({ headers: last.headers, errcode, errmsg: errcode === 0 ? 'ok' : 'fail' });
  }
}

const fastCfg = () => ({
  botId: 'b',
  secret: 's',
  wsUrl: 'wss://openws.work.weixin.qq.com',
  reconnectDelayMs: 10,
  maxDelayMs: 20,
  heartbeatMs: 100000,
  subscribeTimeoutMs: 5000,
});

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

test('connectBot 连接后发订阅，收到成功响应进入 connected', async () => {
  FakeWS.instances = [];
  const states = [];
  const client = connectBot({
    onMessage: () => '',
    config: fastCfg(),
    WebSocketImpl: FakeWS,
    onState: (s) => states.push(s),
  });

  await tick();
  const ws = FakeWS.instances[0];
  assert.ok(ws);
  assert.equal(ws.url, 'wss://openws.work.weixin.qq.com');

  const sub = ws.frames()[0];
  assert.equal(sub.cmd, 'aibot_subscribe');
  assert.deepEqual(sub.body, { bot_id: 'b', secret: 's' });

  ws.ackLast(0);
  await tick();
  assert.equal(client.getState(), 'connected');
  assert.ok(states.includes('handshaking'));

  client.close();
});

test('connectBot 订阅失败进入 error 并重连', async () => {
  FakeWS.instances = [];
  const states = [];
  const client = connectBot({
    onMessage: () => '',
    config: fastCfg(),
    WebSocketImpl: FakeWS,
    onState: (s) => states.push(s),
  });

  await tick();
  const ws = FakeWS.instances[0];
  // 明确对订阅帧回一个失败
  const sub = ws.frames().find((f) => f.cmd === 'aibot_subscribe');
  assert.ok(sub, '应发送订阅帧');
  ws.push({ headers: sub.headers, errcode: 40001, errmsg: 'invalid secret' });

  await tick();
  assert.ok(states.includes('error'), '应有 error 状态');

  // 重连后应出现第二个实例
  await tick(80);
  assert.ok(FakeWS.instances.length >= 2, '应重连');

  client.close();
});

test('connectBot 收到消息回调后用 stream 回复', async () => {
  FakeWS.instances = [];
  const got = [];
  const client = connectBot({
    onMessage: async (msg) => {
      got.push(msg.Content);
      return '这是回复';
    },
    config: fastCfg(),
    WebSocketImpl: FakeWS,
    onState: () => {},
  });

  await tick();
  const ws = FakeWS.instances[0];
  ws.ackLast(0);
  await tick();

  ws.push({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'rq-cb' },
    body: { msgid: 'm1', chattype: 'single', from: { userid: 'u1' }, msgtype: 'text', text: { content: '在吗' } },
  });
  await tick();

  assert.equal(got[0], '在吗');
  const reply = ws.frames().find((f) => f.cmd === 'aibot_respond_msg');
  assert.ok(reply, '应发送回复帧');
  assert.equal(reply.headers.req_id, 'rq-cb');
  assert.equal(reply.body.stream.content, '这是回复');
  assert.equal(reply.body.stream.finish, true);

  client.close();
});

test('connectBot 返回空字符串时不回复', async () => {
  FakeWS.instances = [];
  const client = connectBot({
    onMessage: () => '',
    config: fastCfg(),
    WebSocketImpl: FakeWS,
    onState: () => {},
  });

  await tick();
  const ws = FakeWS.instances[0];
  ws.ackLast(0);
  await tick();

  ws.push({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'rq-x' },
    body: { msgid: 'm2', chattype: 'single', from: { userid: 'u1' }, msgtype: 'text', text: { content: 'x' } },
  });
  await tick();

  assert.equal(ws.frames().filter((f) => f.cmd === 'aibot_respond_msg').length, 0);

  client.close();
});

test('connectBot 处理异常时仍不崩、不回复', async () => {
  FakeWS.instances = [];
  const client = connectBot({
    onMessage: () => {
      throw new Error('boom');
    },
    config: fastCfg(),
    WebSocketImpl: FakeWS,
    onState: () => {},
    logger: { warn() {}, error() {} },
  });

  await tick();
  const ws = FakeWS.instances[0];
  ws.ackLast(0);
  await tick();

  ws.push({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'rq-e' },
    body: { msgid: 'm3', chattype: 'single', from: { userid: 'u1' }, msgtype: 'text', text: { content: 'x' } },
  });
  await tick();

  assert.equal(client.getState(), 'connected');

  client.close();
});

test('connectBot 事件回调交给 onEvent', async () => {
  FakeWS.instances = [];
  const events = [];
  const client = connectBot({
    onMessage: () => '',
    onEvent: (body) => events.push(body.event_type),
    config: fastCfg(),
    WebSocketImpl: FakeWS,
    onState: () => {},
  });

  await tick();
  const ws = FakeWS.instances[0];
  ws.ackLast(0);
  await tick();

  ws.push({
    cmd: 'aibot_event_callback',
    headers: { req_id: 'rq-ev' },
    body: { event_type: 'enter_chat', from: { userid: 'u1' } },
  });
  await tick();

  assert.equal(events[0], 'enter_chat');

  client.close();
});

test('connectBot 断线自动重连', async () => {
  FakeWS.instances = [];
  const client = connectBot({
    onMessage: () => '',
    config: fastCfg(),
    WebSocketImpl: FakeWS,
    onState: () => {},
  });

  await tick();
  FakeWS.instances[0].ackLast(0);
  await tick();
  assert.equal(client.getState(), 'connected');

  FakeWS.instances[0].close();
  await tick(80);
  assert.ok(FakeWS.instances.length >= 2, '应重连');
  assert.ok(FakeWS.instances[1].frames()[0].cmd === 'aibot_subscribe');

  client.close();
});

test('sendMessage 主动发送', async () => {
  FakeWS.instances = [];
  const client = connectBot({
    onMessage: () => '',
    config: fastCfg(),
    WebSocketImpl: FakeWS,
    onState: () => {},
  });

  await tick();
  const ws = FakeWS.instances[0];
  ws.ackLast(0);
  await tick();

  const ok = client.sendMessage({ userId: 'u9', content: '提醒你一下' });
  assert.equal(ok, true);
  const sent = ws.frames().find((f) => f.cmd === 'aibot_send_msg');
  assert.ok(sent);
  assert.equal(sent.body.userid, 'u9');

  client.close();
});
