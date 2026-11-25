import { test, describe } from 'node:test';
import assert from 'node:assert';
import { pairConversation, looksLikeQuestion } from '../qa/pair.js';
import { Store } from '../collector/store.js';
import { createMessage, Platform, Direction, MsgType, isPairableText } from '../collector/message.js';
import { fromWecom, recordOutbound } from '../adapters/wecom.js';
import { fromXhs, normalizeWebhookBody } from '../adapters/xhs.js';

const T = 1700000000000;
const mk = (o) => createMessage({ platform: 'wecom', conversation_id: 'c1', sender_id: 'u1', timestamp: T, ...o });
const inb = (c, t) => mk({ direction: Direction.INBOUND, content: c, timestamp: T + (t || 0) });
const out = (c, t) => mk({ direction: Direction.OUTBOUND, sender_id: 'agent:self', content: c, timestamp: T + (t || 0) });

describe('Message 模型', () => {
  test('缺必填字段抛错', () => {
    assert.throws(() => createMessage({ platform: 'x', conversation_id: 'c' }), /sender_id/);
    assert.throws(() => createMessage({ platform: 'x', sender_id: 'u' }), /conversation_id/);
  });

  test('自动生成唯一 id', () => {
    const a = mk({ content: 'a' });
    const b = mk({ content: 'b' });
    assert.notStrictEqual(a.id, b.id);
    assert.ok(a.id.startsWith('wecom:'));
  });

  test('isPairableText 过滤系统消息与非文本', () => {
    assert.strictEqual(isPairableText(inb('你好')), true);
    assert.strictEqual(isPairableText(mk({ direction: Direction.SYSTEM, content: 'x' })), false);
    assert.strictEqual(isPairableText(mk({ msg_type: MsgType.IMAGE, content: '[图片]' })), false);
    assert.strictEqual(isPairableText(inb('   ')), false);
  });
});

describe('QA 配对', () => {
  test('最基本的问-答', () => {
    const { pairs, unanswered } = pairConversation([inb('多少钱'), out('299', 60000)]);
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].question, '多少钱');
    assert.strictEqual(pairs[0].answer, '299');
    assert.strictEqual(unanswered.length, 0);
  });

  test('客户连发两条问题会合并', () => {
    const { pairs } = pairConversation([inb('多少钱', 0), inb('有优惠吗', 10000), out('299 有优惠', 60000)]);
    assert.strictEqual(pairs.length, 1);
    assert.ok(pairs[0].question.includes('多少钱'));
    assert.ok(pairs[0].question.includes('有优惠'));
  });

  test('客户追问后回答，问题取最后一条', () => {
    const { pairs } = pairConversation([
      inb('这个多少钱', 0),
      inb('我要买两件呢', 20000),
      out('两件 550', 60000),
    ]);
    assert.strictEqual(pairs.length, 1);
    assert.ok(pairs[0].question.includes('两件'));
  });

  test('超过 30 分钟不配对', () => {
    const { pairs, unanswered } = pairConversation([inb('在吗', 0), out('在的', 31 * 60 * 1000)]);
    assert.strictEqual(pairs.length, 0);
    assert.strictEqual(unanswered.length, 1);
  });

  test('无人回答的问题被记为未答', () => {
    const { unanswered } = pairConversation([inb('你们开发票吗')]);
    assert.strictEqual(unanswered.length, 1);
    assert.strictEqual(unanswered[0].question, '你们开发票吗');
  });

  test('多轮对话能配出多对', () => {
    const { pairs } = pairConversation([
      inb('多少钱', 0), out('299', 10000),
      inb('怎么付款', 20000), out('支持微信和支付宝', 30000),
    ]);
    assert.strictEqual(pairs.length, 2);
    assert.strictEqual(pairs[1].question, '怎么付款');
  });

  test('一条答案只消费一次', () => {
    const { pairs } = pairConversation([inb('A'), inb('B', 5000), out('答', 10000)]);
    // 两条问题合并成一条，只产生一对
    assert.strictEqual(pairs.length, 1);
  });

  test('我方连发两条，取第一条作答', () => {
    const { pairs } = pairConversation([inb('在吗'), out('在的', 5000), out('有什么可以帮你', 10000)]);
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].answer, '在的');
  });

  test('完全没有消息不报错', () => {
    const { pairs, unanswered } = pairConversation([]);
    assert.deepStrictEqual(pairs, []);
    assert.deepStrictEqual(unanswered, []);
  });
});

describe('looksLikeQuestion', () => {
  test('识别疑问句', () => {
    assert.strictEqual(looksLikeQuestion('多少钱'), true);
    assert.strictEqual(looksLikeQuestion('怎么买'), true);
    assert.strictEqual(looksLikeQuestion('你们在哪'), true);
    assert.strictEqual(looksLikeQuestion('好的谢谢'), false);
  });
});

describe('Store', () => {
  test('幂等插入：同 id 只算一次', () => {
    const s = new Store(':memory:');
    const m = mk({ id: 'dup-1', content: 'hi' });
    assert.strictEqual(s.insertMessage(m), true);
    assert.strictEqual(s.insertMessage(m), false);
    s.close();
  });

  test('按会话读取并按时间排序', () => {
    const s = new Store(':memory:');
    s.insertMessages([inb('第二条', 10000), inb('第一条', 0)]);
    const rows = s.getConversation('wecom', 'c1');
    assert.strictEqual(rows[0].content, '第一条');
    assert.strictEqual(rows[1].content, '第二条');
    s.close();
  });

  test('QA 状态流转', () => {
    const s = new Store(':memory:');
    s.saveQaPair({
      platform: 'wecom', conversation_id: 'c1', question: 'q', answer: 'a',
      question_msg_id: 'qm1', answer_msg_id: 'am1',
    });
    const [row] = s.listQa({ status: 'pending' });
    assert.ok(row);
    assert.strictEqual(s.setQaStatus(row.id, 'approved', 'ok'), true);
    assert.strictEqual(s.listQa({ status: 'pending' }).length, 0);
    assert.strictEqual(s.listQa({ status: 'approved' }).length, 1);
    s.close();
  });

  test('重复 QA 不重复入库', () => {
    const s = new Store(':memory:');
    const p = {
      platform: 'wecom', conversation_id: 'c1', question: 'q', answer: 'a',
      question_msg_id: 'qm1', answer_msg_id: 'am1',
    };
    assert.strictEqual(s.saveQaPair(p), true);
    assert.strictEqual(s.saveQaPair(p), false);
    s.close();
  });
});

describe('企业微信适配器', () => {
  const raw = {
    ToUserName: 'ww_corp', FromUserName: 'zhangsan', CreateTime: '1700000000',
    MsgType: 'text', Content: '你好', MsgId: '1001', AgentID: '1000002',
  };

  test('文本消息归一化', async () => {
    const m = await fromWecom(raw);
    assert.strictEqual(m.platform, Platform.WECOM);
    assert.strictEqual(m.conversation_id, 'user:zhangsan');
    assert.strictEqual(m.direction, Direction.INBOUND);
    assert.strictEqual(m.content, '你好');
    assert.strictEqual(m.timestamp, 1700000000000);
    assert.strictEqual(m.is_group, false);
  });

  test('群聊按 chatid 分会话', async () => {
    const m = await fromWecom({ ...raw, ChatId: 'wr_group1' });
    assert.strictEqual(m.conversation_id, 'group:wr_group1');
    assert.strictEqual(m.is_group, true);
  });

  test('语音取转写文本', async () => {
    const m = await fromWecom({ ...raw, MsgType: 'voice', Recognition: '我要退款。' });
    assert.strictEqual(m.content, '我要退款。');
    assert.strictEqual(m.msg_type, MsgType.VOICE);
  });

  test('能解析出成员姓名', async () => {
    const m = await fromWecom(raw, { resolveUser: async () => ({ name: '张三' }) });
    assert.strictEqual(m.sender_name, '张三');
  });

  test('查姓名失败不影响归档', async () => {
    const m = await fromWecom(raw, { resolveUser: async () => { throw new Error('api down'); } });
    assert.strictEqual(m.sender_name, '');
    assert.strictEqual(m.content, '你好');
  });

  test('recordOutbound 生成 outbound 消息', () => {
    const m = recordOutbound('zhangsan', '这是回复');
    assert.strictEqual(m.direction, Direction.OUTBOUND);
    assert.strictEqual(m.conversation_id, 'user:zhangsan');
    assert.strictEqual(m.content, '这是回复');
  });
});

describe('小红书适配器', () => {
  test('入站在消息', async () => {
    const m = await fromXhs({
      msg_id: 'x1', session_id: 's1', from_user_id: 'u100',
      msg_type: 'text', content: '请问怎么买', timestamp: 1700000000,
    });
    assert.strictEqual(m.platform, Platform.XHS);
    assert.strictEqual(m.direction, Direction.INBOUND);
    assert.strictEqual(m.content, '请问怎么买');
    assert.strictEqual(m.timestamp, 1700000000000);
  });

  test('出站（我方）消息识别', async () => {
    const m = await fromXhs({
      msg_id: 'x2', session_id: 's1', from_user_id: 'shop1', sender_type: 'seller',
      content: '这样下单', timestamp: 1700000000,
    });
    assert.strictEqual(m.direction, Direction.OUTBOUND);
  });

  test('毫秒时间戳不重复放大', async () => {
    const m = await fromXhs({ msg_id: 'x3', session_id: 's', from_user_id: 'u', content: 'a', timestamp: 1700000000000 });
    assert.strictEqual(m.timestamp, 1700000000000);
  });

  test('normalizeWebhookBody 兼容多种结构', () => {
    assert.deepStrictEqual(normalizeWebhookBody([{ a: 1 }]), [{ a: 1 }]);
    assert.deepStrictEqual(normalizeWebhookBody({ data: [{ a: 1 }] }), [{ a: 1 }]);
    assert.deepStrictEqual(normalizeWebhookBody({ messages: [{ a: 1 }] }), [{ a: 1 }]);
    assert.deepStrictEqual(normalizeWebhookBody({ a: 1 }), [{ a: 1 }]);
    assert.deepStrictEqual(normalizeWebhookBody(null), []);
  });
});

describe('端到端：收集 → 配对', () => {
  test('企业微信收消息 + 回报回复 → 能配出 QA', async () => {
    const s = new Store(':memory:');
    // 用「刚刚」作为消息时间，避免与 recordOutbound 的当前时间差超过配对窗口
    const nowSec = Math.floor(Date.now() / 1000);
    const incoming = await fromWecom({
      FromUserName: 'zhangsan', CreateTime: String(nowSec), MsgType: 'text',
      Content: '你们支持定制吗', MsgId: 'm1',
    });
    s.insertMessage(incoming);

    s.insertMessage(recordOutbound('zhangsan', '支持，具体需求可以聊'));

    const msgs = s.getConversation('wecom', 'user:zhangsan');
    const { pairs } = pairConversation(msgs);
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].question, '你们支持定制吗');
    assert.strictEqual(pairs[0].answer, '支持，具体需求可以聊');
    s.close();
  });
});
