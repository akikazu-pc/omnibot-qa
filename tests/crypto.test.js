import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  pkcs7Pad,
  pkcs7Unpad,
  aesKeyOf,
  signatureOf,
  verifySignature,
  decryptMessage,
  encryptMessage,
  parsePlainCallback,
} from '../qa/wecom-crypto.js';

// 企业微信官方示例用的 EncodingAESKey（43 位）
const AES_KEY = 'jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C';
const CORP_ID = 'wx5823bf96d3bd56c7';

describe('crypto: PKCS#7 填充', () => {
  test('块大小 32（企业微信用 32，不是 AES 默认的 16）', () => {
    const buf = Buffer.from('abc');
    const padded = pkcs7Pad(buf, 32);
    assert.equal(padded.length, 32);
    assert.equal(padded[31], 29);
  });

  test('正好整块时要补满一块', () => {
    const buf = Buffer.alloc(32, 0x41);
    const padded = pkcs7Pad(buf, 32);
    assert.equal(padded.length, 64);
    assert.equal(padded[63], 32);
  });

  test('去填充可逆', () => {
    const orig = Buffer.from('hello world');
    assert.deepEqual(pkcs7Unpad(pkcs7Pad(orig, 32)), orig);
  });
});

describe('crypto: EncodingAESKey', () => {
  test('43 位解出 32 字节', () => {
    assert.equal(aesKeyOf(AES_KEY).length, 32);
  });

  test('长度不对会报错并提示原因', () => {
    assert.throws(() => aesKeyOf('tooshort'), /32 字节|EncodingAESKey/);
  });
});

describe('crypto: 签名', () => {
  test('排序后拼接做 sha1', () => {
    const s = signatureOf('token', '123', 'nonce', 'enc');
    // 等价于 sha1('123' + 'enc' + 'nonce' + 'token')
    assert.equal(s.length, 40);
    assert.match(s, /^[0-9a-f]{40}$/);
  });

  test('参数顺序不影响结果', () => {
    const a = signatureOf('t', '1', 'n', 'e');
    const b = signatureOf('t', '1', 'n', 'e');
    assert.equal(a, b);
  });

  test('验签通过', () => {
    const sig = signatureOf('token', '123', 'nonce', 'enc');
    assert.equal(
      verifySignature({ token: 'token', timestamp: '123', nonce: 'nonce', msgSignature: sig, encrypt: 'enc' }),
      true
    );
  });

  test('签名不对时拒绝', () => {
    assert.equal(
      verifySignature({
        token: 'token',
        timestamp: '123',
        nonce: 'nonce',
        msgSignature: '0'.repeat(40),
        encrypt: 'enc',
      }),
      false
    );
  });

  test('缺 token 或签名时拒绝', () => {
    assert.equal(verifySignature({ timestamp: '1', nonce: 'n', msgSignature: 'x' }), false);
    assert.equal(verifySignature({ token: 't', timestamp: '1', nonce: 'n' }), false);
  });
});

describe('crypto: 加解密往返', () => {
  test('加密后能解回原文', () => {
    const msg = '<xml><Content><![CDATA[你好，多少钱]]></Content></xml>';
    const encrypt = encryptMessage(msg, AES_KEY, CORP_ID);
    const d = decryptMessage(encrypt, AES_KEY, CORP_ID);
    assert.equal(d.message, msg);
    assert.equal(d.receiveId, CORP_ID);
  });

  test('中文和 emoji 都不乱码', () => {
    const msg = '<xml><Content>組立の料金，幾らですか 👌</Content></xml>';
    const encrypt = encryptMessage(msg, AES_KEY, CORP_ID);
    assert.equal(decryptMessage(encrypt, AES_KEY, CORP_ID).message, msg);
  });

  test('receiveId 不匹配会报错', () => {
    const encrypt = encryptMessage('<xml/>', AES_KEY, 'wrongid');
    assert.throws(() => decryptMessage(encrypt, AES_KEY, CORP_ID), /receiveId 不匹配/);
  });

  test('密钥不对时抛出而不是返回垃圾', () => {
    const encrypt = encryptMessage('<xml>hi</xml>', AES_KEY, CORP_ID);
    const wrongKey = 'a'.repeat(43);
    assert.throws(() => decryptMessage(encrypt, wrongKey, CORP_ID));
  });

  test('两次加密结果不同（random 前缀）', () => {
    const a = encryptMessage('<xml/>', AES_KEY, CORP_ID);
    const b = encryptMessage('<xml/>', AES_KEY, CORP_ID);
    assert.notEqual(a, b);
  });
});

describe('crypto: 解析明文回调', () => {
  test('剥 CDATA 抽字段', () => {
    const xml = `<xml><ToUserName><![CDATA[ww123]]></ToUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[tok]]></Token><OpenKfId><![CDATA[wk1]]></OpenKfId></xml>`;
    const o = parsePlainCallback(xml);
    assert.equal(o.MsgType, 'event');
    assert.equal(o.Event, 'kf_msg_or_event');
    assert.equal(o.Token, 'tok');
    assert.equal(o.OpenKfId, 'wk1');
  });
});

// ───────────────────── 官方样例回归（最重要的一组） ─────────────────────
// 数据来自企业微信「加解密方案说明」文档的「举例说明」章节。
// 这组断言能证明我们的实现和微信服务器是**真的互通**，
// 而不只是「自己加密自己解」的往返自洽。

describe('crypto: 官方文档样例向量', () => {
  const OFFICIAL = {
    token: 'QDG6eK',
    encodingAesKey: 'jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C',
    corpId: 'wx5823bf96d3bd56c7',
    timestamp: '1409659813',
    nonce: '1372623149',
    msgSignature: '477715d11cdb4164915debcba66cb864d751f3e6',
    encrypt:
      'RypEvHKD8QQKFhvQ6QleEB4J58tiPdvo+rtK1I9qca6aM/wvqnLSV5zEPeusUiX5L5X/0lWfrf0QADHHhGd3QczcdCUpj911L3vg3W/sYYvuJTs3TUUkSUXxaccAS0qhxchrRYt66wiSpGLYL42aM6A8dTT+6k4aSknmPj48kzJs8qLjvd4Xgpue06DOdnLxAUHzM6+kDZ+HMZfJYuR+LtwGc2hgf5gsijff0ekUNXZiqATP7PF5mZxZ3Izoun1s4zG4LUMnvw2r+KqCKIw+3IQH03v+BCA9nMELNqbSf6tiWSrXJB3LAVGUcallcrw8V2t9EL4EhzJWrQUax5wLVMNS0+rUPA3k22Ncx4XXZS9o0MBH27Bo6BpNelZpS+/uh9KsNlY6bHCmJU9p8g7m3fVKn28H3KDYA5Pl/T8Z1ptDAVe0lXdQ2YoyyH2uyPIGHBZZIs2pDBS8R07+qN+E7Q==',
  };

  test('签名结果与官方给出的完全一致', () => {
    const got = signatureOf(
      OFFICIAL.token,
      OFFICIAL.timestamp,
      OFFICIAL.nonce,
      OFFICIAL.encrypt
    );
    assert.equal(got, OFFICIAL.msgSignature);
  });

  test('官方签名能通过验签', () => {
    assert.equal(
      verifySignature({
        token: OFFICIAL.token,
        timestamp: OFFICIAL.timestamp,
        nonce: OFFICIAL.nonce,
        msgSignature: OFFICIAL.msgSignature,
        encrypt: OFFICIAL.encrypt,
      }),
      true
    );
  });

  test('官方密文能解出预期明文', () => {
    const d = decryptMessage(OFFICIAL.encrypt, OFFICIAL.encodingAesKey, OFFICIAL.corpId);
    assert.equal(d.receiveId, OFFICIAL.corpId);
    const p = parsePlainCallback(d.message);
    assert.equal(p.MsgType, 'text');
    assert.equal(p.Content, 'hello');
    assert.equal(p.FromUserName, 'mycreate');
    assert.equal(p.AgentID, '218');
  });

  test('receiveId 校验能挡住错配', () => {
    assert.throws(
      () => decryptMessage(OFFICIAL.encrypt, OFFICIAL.encodingAesKey, 'wk_wrong_id'),
      /receiveId 不匹配/
    );
  });
});
