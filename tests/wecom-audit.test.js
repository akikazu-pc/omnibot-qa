/**
 * 会话内容存档客户端测试
 *
 * 重点覆盖「不需要 native SDK 也能验证」的纯逻辑部分：
 *   - 配置解析
 *   - 平台探测（macOS 必须明确报不支持，而不是静默失败）
 *   - RSA 解密（用自造密钥对往返验证）
 *   - 明文消息归一化（方向判断 / 会话 ID / 各消息类型）
 *   - seq 游标持久化
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  loadAuditConfig,
  isAuditConfigured,
  isPlatformSupported,
  loadSdk,
  decryptRandomKey,
  fromAudit,
  isExternalId,
  conversationIdOf,
  extractContent,
  createAuditPuller,
  createSeqStore,
} from '../adapters/wecom-audit.js';
import { Platform, Direction, MsgType } from '../collector/message.js';

// ───────────────────────── 配置 ─────────────────────────

test('loadAuditConfig: 空环境返回安全默认值', () => {
  const c = loadAuditConfig({});
  assert.equal(c.corpId, '');
  assert.equal(c.secret, '');
  assert.equal(c.privateKey, '');
  assert.equal(c.batchSize, 1000);
  assert.deepEqual(c.selfUserIds, []);
});

test('loadAuditConfig: 复用 WECOM_CORP_ID 作为兜底', () => {
  const c = loadAuditConfig({ WECOM_CORP_ID: 'ww123' });
  assert.equal(c.corpId, 'ww123');
});

test('loadAuditConfig: 存档专用 CORP_ID 优先', () => {
  const c = loadAuditConfig({ WECOM_CORP_ID: 'ww123', WECOM_AUDIT_CORP_ID: 'ww999' });
  assert.equal(c.corpId, 'ww999');
});

test('loadAuditConfig: 私钥里的字面 \\n 转成真实换行', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\\nMIIE\\n-----END RSA PRIVATE KEY-----';
  const c = loadAuditConfig({ WECOM_AUDIT_PRIVATE_KEY: pem });
  assert.ok(c.privateKey.includes('\n'));
  assert.ok(!c.privateKey.includes('\\n'));
});

test('loadAuditConfig: SELF_IDS 支持逗号 + 空格，过滤空项', () => {
  const c = loadAuditConfig({ WECOM_AUDIT_SELF_IDS: ' zhangsan , lisi ,, wangwu ' });
  assert.deepEqual(c.selfUserIds, ['zhangsan', 'lisi', 'wangwu']);
});

test('isAuditConfigured: 三项齐全才算配置完成', () => {
  assert.equal(isAuditConfigured({}), false);
  assert.equal(isAuditConfigured({ WECOM_AUDIT_CORP_ID: 'a' }), false);
  assert.equal(isAuditConfigured({ WECOM_AUDIT_CORP_ID: 'a', WECOM_AUDIT_SECRET: 'b' }), false);
  assert.equal(
    isAuditConfigured({ WECOM_AUDIT_CORP_ID: 'a', WECOM_AUDIT_SECRET: 'b', WECOM_AUDIT_PRIVATE_KEY: 'c' }),
    true
  );
});

// ───────────────────────── 平台探测 ─────────────────────────

test('isPlatformSupported: 官方只支持 linux / win32', () => {
  assert.equal(isPlatformSupported('linux'), true);
  assert.equal(isPlatformSupported('win32'), true);
  assert.equal(isPlatformSupported('darwin'), false);
  assert.equal(isPlatformSupported('freebsd'), false);
});

test('loadSdk: 不支持的平台必须返回 ok:false 且 reason 说清平台和出路', () => {
  const r = loadSdk(undefined, 'darwin');
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('darwin'));
  assert.ok(r.reason.includes('Linux'));
});

test('loadSdk: 支持的平台但没给 require 时给出明确提示', () => {
  const r = loadSdk(undefined, 'linux');
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('require'));
});

test('loadSdk: 模块加载失败不抛异常，返回可读原因', () => {
  const r = loadSdk(() => {
    throw new Error('Cannot find module wework-chat-node');
  }, 'linux');
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('wework-chat-node'));
});

test('loadSdk: 导出结构不对时明确报错', () => {
  const r = loadSdk(() => ({ foo: 1 }), 'linux');
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('WeWorkFinanceSdk'));
});

test('loadSdk: 正常导出时拿到构造函数', () => {
  class FakeSdk {}
  const r = loadSdk(() => ({ WeWorkFinanceSdk: FakeSdk }), 'linux');
  assert.equal(r.ok, true);
  assert.equal(r.Sdk, FakeSdk);
});

// ───────────────────────── RSA 解密 ─────────────────────────

test('decryptRandomKey: 与公钥加密往返一致（PKCS1 v1.5）', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  const original = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // 32 位随机 key
  const cipher = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(original, 'utf8')
  );
  const encryptedBase64 = cipher.toString('base64');

  assert.equal(decryptRandomKey(encryptedBase64, privateKey), original);
});

test('decryptRandomKey: 支持 PKCS#8 私钥', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const cipher = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from('hello-key')
  );
  assert.equal(decryptRandomKey(cipher.toString('base64'), privateKey), 'hello-key');
});

test('decryptRandomKey: 用错私钥时必须抛错而不是返回垃圾', () => {
  const a = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const b = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const cipher = crypto.publicEncrypt(
    { key: a.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from('secret')
  );
  assert.throws(() => decryptRandomKey(cipher.toString('base64'), b.privateKey));
});

test('decryptRandomKey: 空参数给出可读错误', () => {
  assert.throws(() => decryptRandomKey('', 'pem'), /encrypt_random_key/);
  assert.throws(() => decryptRandomKey('abc', ''), /私钥/);
});

// ───────────────────────── 外部 ID ─────────────────────────

test('isExternalId: wo/wm/wb 开头都算外部，普通 userid 不算', () => {
  assert.equal(isExternalId('woABC123'), true);
  assert.equal(isExternalId('wmABC123'), true);
  assert.equal(isExternalId('wbABC123'), true);
  assert.equal(isExternalId('WOABC123'), true, '大小写不敏感');
  assert.equal(isExternalId('zhangsan'), false);
  assert.equal(isExternalId(''), false);
  assert.equal(isExternalId(undefined), false);
});

// ───────────────────────── 会话 ID ─────────────────────────

test('conversationIdOf: 群聊用 roomid', () => {
  const raw = { roomid: 'R123', from: 'zhangsan', tolist: ['lisi'] };
  assert.equal(conversationIdOf(raw), 'audit:room:R123');
});

test('conversationIdOf: 客户单聊，会话键是客户 external_userid', () => {
  const raw = { from: 'woCUST001', tolist: ['zhangsan'] };
  assert.equal(conversationIdOf(raw), 'audit:user:woCUST001');
});

test('conversationIdOf: 我方发出的单聊，会话键仍是对方而不是自己', () => {
  const raw = { from: 'zhangsan', tolist: ['woCUST001'] };
  assert.equal(conversationIdOf(raw, ['zhangsan']), 'audit:user:woCUST001');
});

test('conversationIdOf: 一问一答落在同一个会话键上（配对的前提）', () => {
  const self = ['zhangsan'];
  const inbound = { from: 'woCUST001', tolist: ['zhangsan'] };
  const outbound = { from: 'zhangsan', tolist: ['woCUST001'] };
  assert.equal(conversationIdOf(inbound, self), conversationIdOf(outbound, self));
});

test('conversationIdOf: 没有任何参与方时退回 unknown，不抛错', () => {
  assert.equal(conversationIdOf({}, []), 'audit:user:unknown');
});

// ───────────────────────── 内容抽取 ─────────────────────────

test('extractContent: 文本原样取出', () => {
  const r = extractContent({ msgtype: 'text', text: { content: '你们支持私有化部署吗' } });
  assert.equal(r.content, '你们支持私有化部署吗');
  assert.equal(r.msgType, MsgType.TEXT);
});

test('extractContent: 各种非文本类型都有可读占位', () => {
  assert.equal(extractContent({ msgtype: 'image' }).content, '[图片]');
  assert.equal(extractContent({ msgtype: 'voice' }).content, '[语音]');
  assert.equal(extractContent({ msgtype: 'video' }).content, '[视频]');
  assert.equal(extractContent({ msgtype: 'file', file: { filename: '报价单.pdf' } }).content, '[文件] 报价单.pdf');
  assert.equal(extractContent({ msgtype: 'link', link: { title: '官网' } }).content, '[链接] 官网');
  assert.equal(extractContent({ msgtype: 'weapp', weapp: { title: '小程序' } }).content, '[小程序] 小程序');
  assert.equal(extractContent({ msgtype: 'chatrecord' }).content, '[聊天记录]');
});

test('extractContent: 未知类型返回空串，由上层丢弃', () => {
  const r = extractContent({ msgtype: 'meeting' });
  assert.equal(r.content, '');
});

test('extractContent: 文件没有文件名时不留下尾部空格', () => {
  assert.equal(extractContent({ msgtype: 'file' }).content, '[文件]');
});

// ───────────────────────── 归一化 ─────────────────────────

test('fromAudit: 客户发的 → INBOUND', () => {
  const msg = fromAudit(
    {
      msgid: 'm1',
      action: 'send',
      from: 'woCUST001',
      tolist: ['zhangsan'],
      roomid: '',
      msgtime: 1763000000000,
      msgtype: 'text',
      text: { content: '多少钱' },
    },
    { selfUserIds: ['zhangsan'] }
  );
  assert.equal(msg.direction, Direction.INBOUND);
  assert.equal(msg.platform, Platform.WECOM_AUDIT);
  assert.equal(msg.conversation_id, 'audit:user:woCUST001');
  assert.equal(msg.sender_id, 'woCUST001');
  assert.equal(msg.content, '多少钱');
  assert.equal(msg.timestamp, 1763000000000);
  assert.equal(msg.is_group, false);
  assert.equal(msg.meta.external, true);
});

test('fromAudit: 我方发的 → OUTBOUND（这是「标准答案」的来源）', () => {
  const msg = fromAudit(
    {
      msgid: 'm2',
      action: 'send',
      from: 'zhangsan',
      tolist: ['woCUST001'],
      msgtime: 1763000060000,
      msgtype: 'text',
      text: { content: '标准版 19800 起，支持私有化' },
    },
    { selfUserIds: ['zhangsan'] }
  );
  assert.equal(msg.direction, Direction.OUTBOUND);
  assert.equal(msg.conversation_id, 'audit:user:woCUST001');
});

test('fromAudit: 一问一答可被配对成同会话一问一答', () => {
  const self = ['zhangsan'];
  const q = fromAudit({ msgid: 'q', action: 'send', from: 'woC', tolist: ['zhangsan'], msgtime: 1, msgtype: 'text', text: { content: '能试用吗' } }, { selfUserIds: self });
  const a = fromAudit({ msgid: 'a', action: 'send', from: 'zhangsan', tolist: ['woC'], msgtime: 2, msgtype: 'text', text: { content: '可以，7 天' } }, { selfUserIds: self });
  assert.equal(q.conversation_id, a.conversation_id);
  assert.equal(q.direction, Direction.INBOUND);
  assert.equal(a.direction, Direction.OUTBOUND);
  assert.ok(a.timestamp > q.timestamp);
});

test('fromAudit: recall → SYSTEM，不参与配对', () => {
  const msg = fromAudit({ msgid: 'm3', action: 'recall', from: 'woCUST001', msgtime: 1, msgtype: 'revoke' });
  assert.equal(msg.direction, Direction.SYSTEM);
  assert.equal(msg.content, '[消息已撤回]');
});

test('fromAudit: switch 直接返回 null（切换企业不是消息）', () => {
  assert.equal(fromAudit({ msgid: 'm4', action: 'switch' }), null);
});

test('fromAudit: 没有 msgid 或空对象返回 null', () => {
  assert.equal(fromAudit(null), null);
  assert.equal(fromAudit({}), null);
});

test('fromAudit: 无文本内容的未知类型丢弃，不产生空消息', () => {
  assert.equal(fromAudit({ msgid: 'm5', action: 'send', from: 'woC', msgtype: 'meeting', msgtime: 1 }), null);
});

test('fromAudit: 群聊 is_group=true，会话键用 roomid', () => {
  const msg = fromAudit({
    msgid: 'm6',
    action: 'send',
    from: 'woCUST001',
    tolist: ['zhangsan'],
    roomid: 'R888',
    msgtime: 1,
    msgtype: 'text',
    text: { content: '在吗' },
  });
  assert.equal(msg.is_group, true);
  assert.equal(msg.conversation_id, 'audit:room:R888');
});

test('fromAudit: 缺 msgtime 时用当前时间兜底，不会 NaN', () => {
  const msg = fromAudit({ msgid: 'm7', action: 'send', from: 'woC', msgtype: 'text', text: { content: 'x' } });
  assert.ok(Number.isFinite(msg.timestamp));
  assert.ok(msg.timestamp > 0);
});

// ───────────────────────── 拉取器（不依赖真实 SDK） ─────────────────────────

test('createAuditPuller: SDK 不可用时返回 available:false 且 pullOnce 报错不静默', async () => {
  const p = createAuditPuller({ requireFn: undefined, logger: { warn() {} } });
  // 当前机器若是 macOS 必然不可用；如果是 Linux 但没装包也不可用
  if (!isPlatformSupported()) {
    assert.equal(p.available, false);
    assert.ok(p.reason.includes(process.platform));
    await assert.rejects(() => p.pullOnce(), /不受支持|SDK/);
    assert.doesNotThrow(() => p.close());
  }
});

test('createAuditPuller: 用假 SDK 跑通 拉取→解密→归一化→回调 全链路', async () => {
  // 自造密钥对模拟官方流程
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  const plainA = JSON.stringify({
    msgid: 'real-1',
    action: 'send',
    from: 'woCUST001',
    tolist: ['zhangsan'],
    msgtime: 1763000000000,
    msgtype: 'text',
    text: { content: '能开发票吗' },
  });
  const plainB = JSON.stringify({
    msgid: 'real-2',
    action: 'send',
    from: 'zhangsan',
    tolist: ['woCUST001'],
    msgtime: 1763000030000,
    msgtype: 'text',
    text: { content: '可以，专票普票都行' },
  });

  const encryptKey = 'K'.repeat(32);
  const toItem = (seq, msgid, plain) => ({
    seq,
    msgid,
    publickey_ver: 1,
    // 官方：encrypt_random_key 是 RSA(encrypt_key) 的 base64
    encrypt_random_key: crypto
      .publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(encryptKey))
      .toString('base64'),
    // 假 SDK 的 DecryptData 直接按 key 前缀返回明文，验证 key 传对了
    encrypt_chat_msg: `${encryptKey}|${Buffer.from(plain).toString('base64')}`,
  });

  const batches = [
    { errcode: 0, chatdata: [toItem(101, 'real-1', plainA), toItem(102, 'real-2', plainB)] },
    { errcode: 0, chatdata: [] },
  ];

  let call = 0;
  let destroyed = false;
  class FakeSdk {
    Init(corpId, secret) {
      this.init = { corpId, secret };
      return 0;
    }
    GetChatData(seq, limit) {
      const r = batches[Math.min(call++, batches.length - 1)];
      return JSON.stringify(r);
    }
    DecryptData(key, payload) {
      const [expectKey, b64] = String(payload).split('|');
      if (key !== expectKey) throw new Error('key 不匹配');
      return Buffer.from(b64, 'base64').toString('utf8');
    }
    DestroySdk() {
      destroyed = true;
    }
  }

  const captured = [];
  const puller = createAuditPuller({
    config: {
      corpId: 'wwCORP',
      secret: 'audit-secret',
      privateKey,
      batchSize: 2,
      selfUserIds: ['zhangsan'],
    },
    requireFn: () => ({ WeWorkFinanceSdk: FakeSdk }),
    onBatch: (msgs, meta) => {
      captured.push({ msgs, meta });
    },
    logger: { warn() {} },
  });

  // 假 SDK 在 macOS 上也能构造，但要绕过 isPlatformSupported 的拦截：
  // 因此这里只在支持的平台跑真实断言，其余平台验证 available:false 的契约
  if (!puller.available) {
    assert.ok(puller.reason);
    return;
  }

  const r = await puller.pullOnce(100);
  assert.equal(r.count, 2);
  assert.equal(r.messages.length, 2);
  assert.equal(r.maxSeq, 102);
  assert.deepEqual(r.errors, []);

  assert.equal(r.messages[0].direction, Direction.INBOUND);
  assert.equal(r.messages[0].content, '能开发票吗');
  assert.equal(r.messages[1].direction, Direction.OUTBOUND);
  assert.equal(r.messages[1].content, '可以，专票普票都行');

  assert.equal(captured.length, 1);
  assert.equal(captured[0].meta.seq, 102);
  assert.equal(puller.getSeq(), 102);

  // 第二轮空数据
  const r2 = await puller.pullOnce();
  assert.equal(r2.count, 0);
  assert.equal(r2.maxSeq, 102, '空批不推进游标');

  puller.setSeq(0);
  assert.equal(puller.getSeq(), 0);

  puller.close();
  if (isPlatformSupported()) assert.equal(destroyed, true);
});

// ───────────────────────── seq 游标 ─────────────────────────

test('createSeqStore: 首次读取无文件返回 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-seq-'));
  const store = createSeqStore(path.join(dir, 'nested', 'seq.json'));
  assert.equal(store.load(), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createSeqStore: 保存后可读回，且自动创建目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-seq-'));
  const file = path.join(dir, 'deep', 'nested', 'seq.json');
  const store = createSeqStore(file);

  assert.equal(store.save(12345), true);
  assert.ok(fs.existsSync(file));
  assert.equal(createSeqStore(file).load(), 12345);

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.seq, 12345);
  assert.ok(onDisk.updatedAt > 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('createSeqStore: 文件内容损坏时返回 0 而不是崩溃', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-seq-'));
  const file = path.join(dir, 'seq.json');
  fs.writeFileSync(file, '{ 这不是 JSON');
  assert.equal(createSeqStore(file).load(), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createSeqStore: seq 非数字时归零', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-seq-'));
  const file = path.join(dir, 'seq.json');
  fs.writeFileSync(file, JSON.stringify({ seq: 'abc' }));
  assert.equal(createSeqStore(file).load(), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
