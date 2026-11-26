/**
 * 聊天记录粘贴导入解析器测试
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchHeader,
  matchDateLine,
  timeToTs,
  startOfDay,
  dateToTs,
  isSelfSpeaker,
  parsePastedChat,
  importMessages,
} from '../adapters/paste.js';
import { Direction, Platform } from '../collector/message.js';
import { Store } from '../collector/store.js';

describe('paste: matchHeader', () => {
  test('识别「说话人 时间」', () => {
    const h = matchHeader('张三 10:23');
    assert.equal(h.name, '张三');
    assert.equal(h.time, '10:23');
  });

  test('识别带秒的时间', () => {
    const h = matchHeader('李四 09:05:30');
    assert.equal(h.name, '李四');
    assert.equal(h.time, '09:05');
  });

  test('识别带日期的时间', () => {
    const h = matchHeader('张三 2026-11-20 10:23');
    assert.equal(h.name, '张三');
    assert.equal(h.date, '2026-11-20');
  });

  test('识别时间在前的格式', () => {
    const h = matchHeader('10:23 张三');
    assert.equal(h.name, '张三');
  });

  test('普通内容行不误判', () => {
    assert.equal(matchHeader('你们支持私有化部署吗'), null);
    assert.equal(matchHeader('价格是 299'), null);
  });

  test('空行不误判', () => {
    assert.equal(matchHeader(''), null);
    assert.equal(matchHeader('   '), null);
  });
});

describe('paste: matchDateLine', () => {
  test('识别 yyyy-mm-dd', () => {
    const d = matchDateLine('2026-11-20');
    assert.deepEqual({ year: d.year, month: d.month, day: d.day }, { year: 2026, month: 11, day: 20 });
  });

  test('识别中文日期', () => {
    const d = matchDateLine('2026年11月20日');
    assert.equal(d.month, 11);
  });

  test('非日期不误判', () => {
    assert.equal(matchDateLine('张三 10:23'), null);
  });
});

describe('paste: 时间换算', () => {
  test('timeToTs 基于当天零点', () => {
    const base = dateToTs({ year: 2026, month: 11, day: 20 });
    assert.equal(timeToTs('00:00', base), base);
    assert.equal(timeToTs('01:30', base), base + 5400000);
  });

  test('startOfDay 归零', () => {
    const ts = new Date(2026, 10, 20, 15, 33, 12).getTime();
    const s = new Date(startOfDay(ts));
    assert.equal(s.getHours(), 0);
    assert.equal(s.getMinutes(), 0);
  });

  test('非法时间回退基准日', () => {
    const base = 1000;
    assert.equal(timeToTs('xx:yy', base), base);
  });
});

describe('paste: isSelfSpeaker', () => {
  test('默认识别「我」', () => {
    assert.equal(isSelfSpeaker('我'), true);
    assert.equal(isSelfSpeaker('本人'), true);
    assert.equal(isSelfSpeaker('张三'), false);
  });

  test('自定义别名', () => {
    assert.equal(isSelfSpeaker('客服-李雷', ['客服-李雷']), true);
    assert.equal(isSelfSpeaker('王五', ['客服-李雷']), false);
  });
});

describe('paste: parsePastedChat', () => {
  const sample = `张三 10:23
你们支持私有化部署吗

我 10:25
支持，可以装到你们自己服务器上

张三 10:26
那价格呢
多少钱一年

我 10:30
基础版 299 一个月
年度合同有折扣`;

  test('解析出 4 条消息', () => {
    const r = parsePastedChat(sample);
    assert.equal(r.messages.length, 4);
  });

  test('方向正确', () => {
    const r = parsePastedChat(sample);
    assert.equal(r.messages[0].direction, Direction.INBOUND);
    assert.equal(r.messages[1].direction, Direction.OUTBOUND);
    assert.equal(r.messages[2].direction, Direction.INBOUND);
    assert.equal(r.messages[3].direction, Direction.OUTBOUND);
  });

  test('多行消息合并', () => {
    const r = parsePastedChat(sample);
    assert.match(r.messages[2].content, /那价格呢[\s\S]*多少钱一年/);
  });

  test('识别客户与我方', () => {
    const r = parsePastedChat(sample);
    assert.equal(r.customer, '张三');
    assert.equal(r.self, '我');
  });

  test('时间戳递增', () => {
    const r = parsePastedChat(sample);
    for (let i = 1; i < r.messages.length; i++) {
      assert.ok(
        r.messages[i].timestamp > r.messages[i - 1].timestamp,
        `第 ${i} 条时间应大于前一条`
      );
    }
  });

  test('platform 与 conversation_id 正确', () => {
    const r = parsePastedChat(sample);
    assert.equal(r.messages[0].platform, Platform.PASTE);
    assert.match(r.messages[0].conversation_id, /^paste:/);
  });

  test('自定义我方昵称', () => {
    const text = `张三 10:23
在吗

客服小王 10:25
在的`;
    const r = parsePastedChat(text, { selfName: '客服小王' });
    assert.equal(r.self, '客服小王');
    assert.equal(r.messages[1].direction, Direction.OUTBOUND);
  });

  test('指定客户名', () => {
    const r = parsePastedChat(sample, { customerName: '张总' });
    assert.equal(r.customer, '张总');
  });

  test('带日期分隔行切换天', () => {
    const text = `2026-11-20
张三 23:50
今天的问题

2026-11-21
我 00:10
隔天回复`;
    const r = parsePastedChat(text);
    assert.equal(r.messages.length, 2);
    assert.ok(r.messages[1].timestamp > r.messages[0].timestamp, '跨天时间应递增');
  });

  test('空输入返回空数组与警告', () => {
    const r = parsePastedChat('');
    assert.equal(r.messages.length, 0);
    assert.ok(r.warnings.length > 0);
  });

  test('没有我方说话人时给出警告', () => {
    const text = `张三 10:23
在吗`;
    const r = parsePastedChat(text);
    assert.ok(r.warnings.some((w) => w.includes('我方')));
  });

  test('同一分钟多条按顺序补毫秒', () => {
    const text = `张三 10:23
第一条
张三 10:23
第二条`;
    const r = parsePastedChat(text);
    assert.equal(r.messages.length, 2);
    assert.ok(r.messages[1].timestamp > r.messages[0].timestamp);
  });

  test('微信客户端「时间在上一行」格式也能识别', () => {
    const text = `张三 2026-11-20 10:23
你们支持私有化部署吗`;
    const r = parsePastedChat(text);
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].content, '你们支持私有化部署吗');
  });
});

describe('paste: importMessages', () => {
  test('写入 store 并幂等', () => {
    const store = new Store(':memory:');
    const r = parsePastedChat(`张三 10:23
在吗

我 10:25
在的`);

    const first = importMessages(store, r.messages);
    assert.equal(first.added, 2);

    // 再导一次，应该全部跳过
    const second = importMessages(store, r.messages);
    assert.equal(second.added, 0);
    assert.equal(second.skipped, 2);

    store.close();
  });
});
