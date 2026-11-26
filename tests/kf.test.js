import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadKfConfig,
  isKfConfigured,
  isKfCallbackConfigured,
  parseCallbackXml,
  parseCallback,
  syncMessages,
  normalizeKfMessage,
  sendKfText,
  sendKfEventResponse,
  listKfAccounts,
  getKfAccountUrl,
  getKfAccessToken,
  resetKfTokenCache,
} from '../adapters/wecom-kf.js';

const CALLBACK_XML = `<xml>
   <ToUserName><![CDATA[ww12345678910]]></ToUserName>
   <CreateTime>1348831860</CreateTime>
   <MsgType><![CDATA[event]]></MsgType>
   <Event><![CDATA[kf_msg_or_event]]></Event>
   <Token><![CDATA[ENCApHxnGDNAVNY4AaSJKj4Tb5mwsEMzxhFmHVGcra996NR]]></Token>
   <OpenKfId><![CDATA[wkxxxxxxx]]></OpenKfId>
</xml>`;

describe('kf: 配置', () => {
  test('读环境变量', () => {
    const c = loadKfConfig({
      KF_CORP_ID: 'wk1',
      KF_SECRET: 'sec',
      KF_TOKEN: 'tok',
      KF_AES_KEY: 'a'.repeat(43),
    });
    assert.equal(c.corpId, 'wk1');
    assert.equal(c.secret, 'sec');
    assert.equal(c.token, 'tok');
    assert.equal(c.aesKey.length, 43);
  });

  test('有企业ID和Secret 才能发消息', () => {
    assert.equal(isKfConfigured({ KF_CORP_ID: 'a', KF_SECRET: 'b' }), true);
    assert.equal(isKfConfigured({ KF_CORP_ID: 'a' }), false);
    assert.equal(isKfConfigured({}), false);
  });

  test('回调验签参数独立判断', () => {
    assert.equal(isKfCallbackConfigured({ KF_TOKEN: 't', KF_AES_KEY: 'k' }), true);
    assert.equal(isKfCallbackConfigured({ KF_TOKEN: 't' }), false);
  });
});

describe('kf: 回调 XML 解析', () => {
  test('剥掉 CDATA 包装', () => {
    const x = parseCallbackXml(CALLBACK_XML);
    assert.equal(x.ToUserName, 'ww12345678910');
    assert.equal(x.MsgType, 'event');
    assert.equal(x.Event, 'kf_msg_or_event');
    assert.equal(x.OpenKfId, 'wkxxxxxxx');
  });

  test('外层 xml 根标签不干扰字段提取', () => {
    const x = parseCallbackXml(CALLBACK_XML);
    assert.equal(x.xml, undefined);
    assert.equal(x.CreateTime, '1348831860');
  });

  test('识别消息回调并取出 token', () => {
    const r = parseCallback(CALLBACK_XML);
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'message');
    assert.equal(r.token, 'ENCApHxnGDNAVNY4AaSJKj4Tb5mwsEMzxhFmHVGcra996NR');
    assert.equal(r.openKfid, 'wkxxxxxxx');
  });

  test('不认识的回调类型报错而不是静默通过', () => {
    const r = parseCallback('<xml><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[other]]></Event></xml>');
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });

  test('接受已解析的对象', () => {
    const r = parseCallback({ MsgType: 'event', Event: 'kf_msg_or_event', Token: 't', OpenKfId: 'k' });
    assert.equal(r.ok, true);
    assert.equal(r.token, 't');
  });
});

describe('kf: 消息归一化', () => {
  test('文本消息', () => {
    const n = normalizeKfMessage({
      msgid: 'm1',
      open_kfid: 'k1',
      external_userid: 'e1',
      origin: 3,
      msgtype: 'text',
      text: { content: '多少钱' },
    });
    assert.equal(n.content, '多少钱');
    assert.equal(n.externalUserId, 'e1');
    assert.equal(n.openKfid, 'k1');
    assert.equal(n.fromCustomer, true);
  });

  test('origin=4 是系统推送，不算客户消息', () => {
    const n = normalizeKfMessage({ origin: 4, msgtype: 'text', text: { content: 'x' } });
    assert.equal(n.fromCustomer, false);
  });

  test('图片/语音等转成占位文本', () => {
    assert.equal(normalizeKfMessage({ msgtype: 'image' }).content, '[图片]');
    assert.equal(normalizeKfMessage({ msgtype: 'voice' }).content, '[语音]');
    assert.equal(normalizeKfMessage({ msgtype: 'file' }).content, '[文件]');
  });

  test('位置消息带上地名', () => {
    const n = normalizeKfMessage({
      msgtype: 'location',
      location: { name: '广州', address: '天河区' },
    });
    assert.ok(n.content.includes('广州'));
    assert.ok(n.content.includes('天河区'));
  });
});

describe('kf: 拉取消息', () => {
  test('请求体带 cursor / token / limit', async () => {
    resetKfTokenCache();
    let called = null;
    const fetchImpl = async (url, opts) => {
      if (url.includes('gettoken')) {
        return { json: async () => ({ errcode: 0, access_token: 'AT', expires_in: 7200 }) };
      }
      called = { url, body: JSON.parse(opts.body) };
      return {
        json: async () => ({
          errcode: 0,
          next_cursor: 'C2',
          has_more: 0,
          msg_list: [{ msgid: 'm', msgtype: 'text', text: { content: 'hi' } }],
        }),
      };
    };

    const r = await syncMessages({
      cursor: 'C1',
      token: 'TK',
      openKfid: 'wk1',
      limit: 500,
      config: { corpId: 'wk1', secret: 's', apiBase: 'https://qyapi.weixin.qq.com/cgi-bin/kf' },
      fetchImpl,
    });

    assert.equal(r.ok, true);
    assert.equal(r.messages.length, 1);
    assert.equal(r.nextCursor, 'C2');
    assert.equal(called.body.cursor, 'C1');
    assert.equal(called.body.token, 'TK');
    assert.equal(called.body.limit, 500);
    assert.equal(called.body.open_kfid, 'wk1');
    assert.ok(called.url.includes('sync_msg'));
  });

  test('has_more=1 但 msg_list 为空时，仍然报告 hasMore', async () => {
    resetKfTokenCache();
    const fetchImpl = async (url) => {
      if (url.includes('gettoken')) {
        return { json: async () => ({ errcode: 0, access_token: 'AT', expires_in: 7200 }) };
      }
      return { json: async () => ({ errcode: 0, next_cursor: 'C', has_more: 1, msg_list: [] }) };
    };
    const r = await syncMessages({
      config: { corpId: 'w', secret: 's', apiBase: 'https://x/kf' },
      fetchImpl,
    });
    // 官方明确说不能用 msg_list 是否为空判断是否结束
    assert.equal(r.hasMore, true);
    assert.deepEqual(r.messages, []);
  });

  test('token 失效时清缓存', async () => {
    resetKfTokenCache();
    let n = 0;
    const fetchImpl = async (url) => {
      if (url.includes('gettoken')) {
        n += 1;
        return { json: async () => ({ errcode: 0, access_token: 'AT' + n, expires_in: 7200 }) };
      }
      return { json: async () => ({ errcode: 40014, errmsg: 'invalid token' }) };
    };
    const cfg = { corpId: 'w', secret: 's', apiBase: 'https://x/kf' };
    await syncMessages({ config: cfg, fetchImpl });
    await syncMessages({ config: cfg, fetchImpl });
    // 第二次应该重新取 token
    assert.equal(n, 2);
  });
});

describe('kf: access_token 缓存', () => {
  test('有效期内只取一次', async () => {
    resetKfTokenCache();
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      return { json: async () => ({ errcode: 0, access_token: 'AT', expires_in: 7200 }) };
    };
    const cfg = { corpId: 'w', secret: 's', apiBase: 'https://x' };
    const a = await getKfAccessToken(cfg, fetchImpl);
    const b = await getKfAccessToken(cfg, fetchImpl);
    assert.equal(a, b);
    assert.equal(n, 1);
  });
});

describe('kf: 发消息', () => {
  test('发送文本消息的请求体', async () => {
    resetKfTokenCache();
    let body = null;
    const fetchImpl = async (url, opts) => {
      if (url.includes('gettoken')) {
        return { json: async () => ({ errcode: 0, access_token: 'AT', expires_in: 7200 }) };
      }
      body = JSON.parse(opts.body);
      return { json: async () => ({ errcode: 0, msgid: 'MSG1' }) };
    };
    const r = await sendKfText({
      touser: 'ext1',
      openKfid: 'wk1',
      content: '您好',
      config: { corpId: 'w', secret: 's', apiBase: 'https://x/kf' },
      fetchImpl,
    });
    assert.equal(r.ok, true);
    assert.equal(r.msgid, 'MSG1');
    assert.equal(body.touser, 'ext1');
    assert.equal(body.open_kfid, 'wk1');
    assert.equal(body.msgtype, 'text');
    assert.equal(body.text.content, '您好');
  });

  test('缺 open_kfid 直接抛错', async () => {
    await assert.rejects(
      () => sendKfText({ touser: 'e', content: 'x', config: { corpId: 'w', secret: 's' } }),
      /openKfid/
    );
  });

  test('错误码返回错误而不是抛异常', async () => {
    resetKfTokenCache();
    const fetchImpl = async (url) => {
      if (url.includes('gettoken')) {
        return { json: async () => ({ errcode: 0, access_token: 'AT', expires_in: 7200 }) };
      }
      return { json: async () => ({ errcode: 40001, errmsg: 'bad touser' }) };
    };
    const r = await sendKfText({
      touser: 'e',
      openKfid: 'k',
      content: 'x',
      config: { corpId: 'w', secret: 's', apiBase: 'https://x/kf' },
      fetchImpl,
    });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('40001'));
  });

  test('欢迎语走 send_msg_on_event', async () => {
    resetKfTokenCache();
    let url = '';
    let body = null;
    const fetchImpl = async (u, opts) => {
      url = u;
      if (u.includes('gettoken')) {
        return { json: async () => ({ errcode: 0, access_token: 'AT', expires_in: 7200 }) };
      }
      body = JSON.parse(opts.body);
      return { json: async () => ({ errcode: 0, msgid: 'M' }) };
    };
    const r = await sendKfEventResponse({
      code: 'WC',
      openKfid: 'wk1',
      content: '您好',
      config: { corpId: 'w', secret: 's', apiBase: 'https://x/kf' },
      fetchImpl,
    });
    assert.equal(r.ok, true);
    assert.ok(url.includes('send_msg_on_event'));
    assert.equal(body.code, 'WC');
  });
});

describe('kf: 客服账号', () => {
  test('列出账号', async () => {
    resetKfTokenCache();
    const fetchImpl = async (url) => {
      if (url.includes('gettoken')) {
        return { json: async () => ({ errcode: 0, access_token: 'AT', expires_in: 7200 }) };
      }
      assert.ok(url.includes('account/list'));
      return { json: async () => ({ errcode: 0, account_list: [{ open_kfid: 'wk1', name: '客服' }] }) };
    };
    const r = await listKfAccounts({
      config: { corpId: 'w', secret: 's', apiBase: 'https://x/kf' },
      fetchImpl,
    });
    assert.equal(r.ok, true);
    assert.equal(r.accounts.length, 1);
    assert.equal(r.accounts[0].open_kfid, 'wk1');
  });

  test('获取对外客服链接', async () => {
    resetKfTokenCache();
    let body = null;
    const fetchImpl = async (url, opts) => {
      if (url.includes('gettoken')) {
        return { json: async () => ({ errcode: 0, access_token: 'AT', expires_in: 7200 }) };
      }
      assert.ok(url.includes('account/link'));
      body = JSON.parse(opts.body);
      return { json: async () => ({ errcode: 0, url: 'https://work.weixin.qq.com/kfid/xxx' }) };
    };
    const r = await getKfAccountUrl({
      openKfid: 'wk1',
      scene: 'akikazu',
      config: { corpId: 'w', secret: 's', apiBase: 'https://x/kf' },
      fetchImpl,
    });
    assert.equal(r.ok, true);
    assert.ok(r.url.includes('kfid'));
    assert.equal(body.open_kfid, 'wk1');
    assert.equal(body.scene, 'akikazu');
  });
});
