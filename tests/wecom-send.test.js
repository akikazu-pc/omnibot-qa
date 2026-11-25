import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAccessToken,
  sendText,
  loadWecomConfig,
  isWecomConfigured,
  resetTokenCache,
} from '../adapters/wecom-send.js';

const CFG = { corpId: 'corp1', agentId: '1000002', secret: 'sec', apiBase: 'http://fake' };

beforeEach(() => resetTokenCache());

function mockFetch(handlers) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const h = url.includes('/gettoken') ? handlers.token : handlers.send;
    const body = typeof h === 'function' ? h(url, init) : h;
    return { ok: true, status: 200, json: async () => body };
  };
  f.calls = calls;
  return f;
}

describe('wecom-send: config', () => {
  test('读取环境变量', () => {
    const c = loadWecomConfig({ WECOM_CORP_ID: 'a', WECOM_AGENT_ID: '1', WECOM_SECRET: 's' });
    assert.equal(c.corpId, 'a');
    assert.equal(isWecomConfigured({ WECOM_CORP_ID: 'a', WECOM_AGENT_ID: '1', WECOM_SECRET: 's' }), true);
    assert.equal(isWecomConfigured({}), false);
  });
});

describe('wecom-send: getAccessToken', () => {
  test('成功获取并缓存', async () => {
    const f = mockFetch({ token: { errcode: 0, access_token: 'tok', expires_in: 7200 } });
    const t1 = await getAccessToken(CFG, f);
    const t2 = await getAccessToken(CFG, f);
    assert.equal(t1, 'tok');
    assert.equal(t2, 'tok');
    assert.equal(f.calls.length, 1, '第二次应命中缓存');
  });

  test('errcode 非 0 抛错', async () => {
    const f = mockFetch({ token: { errcode: 40013, errmsg: 'invalid corpid' } });
    await assert.rejects(() => getAccessToken(CFG, f), /invalid corpid/);
  });

  test('缺凭据抛错', async () => {
    await assert.rejects(() => getAccessToken({ corpId: '', secret: '' }), /WECOM_CORP_ID/);
  });
});

describe('wecom-send: sendText', () => {
  test('发送成功', async () => {
    const f = mockFetch({
      token: { errcode: 0, access_token: 'tok', expires_in: 7200 },
      send: { errcode: 0, msgid: 'm1' },
    });
    const r = await sendText({ toUser: 'u1', content: '你好', config: CFG, fetchImpl: f });
    assert.equal(r.ok, true);
    assert.equal(r.msgid, 'm1');

    const sendCall = f.calls.find((c) => c.url.includes('/message/send'));
    const payload = JSON.parse(sendCall.init.body);
    assert.equal(payload.touser, 'u1');
    assert.equal(payload.agentid, 1000002);
    assert.equal(payload.text.content, '你好');
  });

  test('token 失效时清缓存', async () => {
    const f = mockFetch({
      token: { errcode: 0, access_token: 'tok', expires_in: 7200 },
      send: { errcode: 42001, errmsg: 'access_token expired' },
    });
    const r = await sendText({ toUser: 'u1', content: 'x', config: CFG, fetchImpl: f });
    assert.equal(r.ok, false);
    assert.match(r.error, /42001/);

    // 再调一次会重新取 token
    await sendText({ toUser: 'u1', content: 'x', config: CFG, fetchImpl: f });
    const tokenCalls = f.calls.filter((c) => c.url.includes('/gettoken'));
    assert.equal(tokenCalls.length, 2, '失效后应重新获取 token');
  });

  test('缺参数抛错', async () => {
    await assert.rejects(() => sendText({ toUser: '', content: 'x', config: CFG }), /必填/);
  });
});
