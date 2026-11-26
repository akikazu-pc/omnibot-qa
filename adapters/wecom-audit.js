/**
 * 企业微信「会话内容存档」接入
 *
 * 这个模块解决什么问题：
 *   客户扫码加你企微好友后，客户发的消息、你回的消息，
 *   普通 API 都推不出来。唯一合规获取途径是「会话内容存档」。
 *
 * ⚠️ 三个硬性前提（缺一个都跑不了）：
 *   1. 企业微信完成**企业主体认证**
 *   2. 超级管理员在后台开通「会话内容存档」，**按人付费**（服务版 900 元/人/年，仅文字）
 *   3. 上传 RSA 公钥、拿到存档专用 Secret
 *
 * ⚠️ 平台限制（很重要）：
 *   官方只提供 **Linux / Windows** 的 C SDK（libWeWorkFinanceSdk_C.so / .dll），
 *   **不提供 macOS 版本**。所以在 Mac 上开发时本模块会自动禁用，
 *   只有部署到 Linux 服务器（或 Docker）才能真正拉取数据。
 *
 * 技术流程（对应官方文档 path/91774）：
 *   1. GetChatData(seq, limit) → { chatdata: [{ seq, msgid, publickey_ver, encrypt_random_key, encrypt_chat_msg }] }
 *   2. base64 decode(encrypt_random_key) → RSA PKCS1 私钥解密 → encrypt_key
 *   3. DecryptData(encrypt_key, encrypt_chat_msg) → 明文 JSON
 *   4. 明文 JSON 里 from 是 userid（内部）或 external_userid（外部客户，wo/wm 开头）
 *
 * 注意：只能拉**最近 5 天**的消息，必须定时任务持续拉取。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Platform, Direction, MsgType, createMessage } from '../collector/message.js';

export function loadAuditConfig(env = process.env) {
  return {
    corpId: env.WECOM_AUDIT_CORP_ID || env.WECOM_CORP_ID || '',
    secret: env.WECOM_AUDIT_SECRET || '',
    // RSA 私钥（PKCS#1 或 PKCS#8，PEM 格式）。可以用 \n 转义存放
    privateKey: (env.WECOM_AUDIT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    seqFile: env.WECOM_AUDIT_SEQ_FILE || 'data/audit-seq.json',
    batchSize: Number(env.WECOM_AUDIT_BATCH || 1000),
    // 内部成员 userid 列表（逗号分隔）。用于判断哪条是「我方发的」
    selfUserIds: (env.WECOM_AUDIT_SELF_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

export function isAuditConfigured(env = process.env) {
  const c = loadAuditConfig(env);
  return Boolean(c.corpId && c.secret && c.privateKey);
}

/**
 * 探测当前平台是否支持官方 SDK。
 * 官方只有 linux / win32。
 */
export function isPlatformSupported(platform = process.platform) {
  return platform === 'linux' || platform === 'win32';
}

/**
 * 尝试加载 native SDK。加载失败返回 { ok:false, reason }，不抛异常。
 * @param {Function} [requireFn] 注入 require（ESM 环境用 createRequire）
 * @param {string} [platform] 便于测试注入
 */
export function loadSdk(requireFn, platform = process.platform) {
  if (!isPlatformSupported(platform)) {
    return {
      ok: false,
      reason: `当前平台 ${platform} 不受支持。官方会话存档 SDK 仅提供 Linux / Windows 版本，请部署到 Linux 服务器或 Docker 中运行。`,
    };
  }
  if (typeof requireFn !== 'function') {
    return { ok: false, reason: '未提供 require 实现，无法加载 native 模块' };
  }
  try {
    const mod = requireFn('wework-chat-node');
    const Sdk = mod.WeWorkFinanceSdk || mod.default || mod;
    if (typeof Sdk !== 'function') {
      return { ok: false, reason: 'wework-chat-node 导出结构异常，未找到 WeWorkFinanceSdk 构造函数' };
    }
    return { ok: true, Sdk };
  } catch (err) {
    return {
      ok: false,
      reason: `加载 wework-chat-node 失败：${err.message}。该模块是 C++ 原生扩展，需要能链接官方 .so 的 Linux 环境。`,
    };
  }
}

/**
 * 解密 encrypt_random_key（RSA PKCS1）。
 *
 * 官方流程：
 *   str1 = base64_decode(encrypt_random_key)
 *   str2 = RSA_PKCS1_private_decrypt(str1, privateKey)
 *   str2 就是 DecryptData 需要的 encrypt_key
 *
 * @param {string} encryptedBase64
 * @param {string} privateKeyPem
 * @returns {string} 解密后的 encrypt_key（原始字符串）
 */
export function decryptRandomKey(encryptedBase64, privateKeyPem) {
  if (!encryptedBase64) throw new Error('encrypt_random_key 为空');
  if (!privateKeyPem) throw new Error('缺少 RSA 私钥');

  const buf = Buffer.from(encryptedBase64, 'base64');
  const key = crypto.createPrivateKey(privateKeyPem);

  // 官方用的是 PKCS1 v1.5 padding
  const out = crypto.privateDecrypt(
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    buf
  );

  const text = out.toString('utf8');

  // ⚠️ OpenSSL 在部分版本/构建下对 PKCS1 v1.5 解密失败不抛错，而是返回随机字节。
  // 这里做「可打印字符」校验，避免把垃圾串当成 encrypt_key 交给 DecryptData，
  // 否则会得到一个莫名其妙的全量解密失败，排查成本极高。
  if (!isPlausibleKey(text)) {
    throw new Error(
      'RSA 解密结果不可信（可能是私钥不匹配或 padding 不对）。请确认上传到企微后台的公钥与本地私钥是同一对。'
    );
  }

  return text;
}

/** 官方 encrypt_key 是 32 字节随机串，这里放宽到「全部是可打印 ASCII」 */
function isPlausibleKey(s) {
  if (!s || s.length > 256) return false;
  return /^[\x20-\x7e]+$/.test(s);
}

/**
 * 把存档明文消息归一化成统一 Message。
 *
 * 明文结构示例：
 *   { msgid, action, from, tolist:[], roomid, msgtime, msgtype, text:{content} }
 *
 * 方向判断：
 *   - from 在 selfUserIds 里 → OUTBOUND（我方发的）
 *   - 否则 → INBOUND（客户发的）
 *   - action=recall → SYSTEM
 *
 * @param {Object} raw
 * @param {Object} [opts]
 * @param {string[]} [opts.selfUserIds]
 * @returns {Object|null} 无法识别时返回 null
 */
export function fromAudit(raw, opts = {}) {
  if (!raw || !raw.msgid) return null;

  const selfIds = opts.selfUserIds || [];
  const from = raw.from || '';
  const tolist = Array.isArray(raw.tolist) ? raw.tolist : [];
  const isGroup = Boolean(raw.roomid);

  if (raw.action === 'recall') {
    return createMessage({
      id: `${Platform.WECOM_AUDIT}:${raw.msgid}`,
      platform: Platform.WECOM_AUDIT,
      conversation_id: conversationIdOf(raw, selfIds),
      sender_id: from,
      direction: Direction.SYSTEM,
      msg_type: MsgType.EVENT,
      content: '[消息已撤回]',
      timestamp: Number(raw.msgtime) || Date.now(),
      is_group: isGroup,
      raw,
    });
  }

  if (raw.action === 'switch') {
    // 切换企业日志，不参与配对
    return null;
  }

  const isSelf = selfIds.includes(from);
  const direction = isSelf ? Direction.OUTBOUND : Direction.INBOUND;

  const { content, msgType } = extractContent(raw);
  if (!content) return null;

  return createMessage({
    id: `${Platform.WECOM_AUDIT}:${raw.msgid}`,
    platform: Platform.WECOM_AUDIT,
    conversation_id: conversationIdOf(raw, selfIds),
    sender_id: from,
    direction,
    msg_type: msgType,
    content,
    timestamp: Number(raw.msgtime) || Date.now(),
    is_group: isGroup,
    raw,
    meta: { external: isExternalId(from), tolist },
  });
}

/** 外部联系人的 ID 以 wo / wm 开头，机器人以 wb 开头 */
export function isExternalId(id = '') {
  return /^w[obm]/i.test(String(id));
}

/**
 * 构造会话 ID。
 * 单聊：用「非我方那个人的 ID」作为会话键，保证一问一答落在同一会话。
 * 群聊：用 roomid。
 *
 * ⚠️ 必须传 selfUserIds，否则我方发出的消息会被误判成「对方是自己」，
 * 导致同一段对话被拆到两个会话键上，QA 配对直接失效。
 */
export function conversationIdOf(raw, selfUserIds = []) {
  if (raw.roomid) return `audit:room:${raw.roomid}`;
  const from = raw.from || '';
  const tolist = Array.isArray(raw.tolist) ? raw.tolist : [];
  const self = Array.isArray(selfUserIds) ? selfUserIds : [];
  // 找一个不是自己的参与方；我方发的 → 取 tolist 里的人，对方发的 → 取 from
  const peer = self.includes(from) ? tolist.find((u) => !self.includes(u)) || tolist[0] || from : from;
  return `audit:user:${peer || 'unknown'}`;
}

/** 从明文里抽可读文本 */
export function extractContent(raw) {
  switch (raw.msgtype) {
    case 'text':
      return { content: raw.text?.content || '', msgType: MsgType.TEXT };
    case 'image':
      return { content: '[图片]', msgType: MsgType.IMAGE };
    case 'voice':
      // 存档不带语音转文字，需要 extra 里的转写（如开通）
      return { content: '[语音]', msgType: MsgType.VOICE };
    case 'video':
      return { content: '[视频]', msgType: MsgType.VIDEO };
    case 'file':
      return { content: `[文件] ${raw.file?.filename || ''}`.trim(), msgType: MsgType.FILE };
    case 'link':
      return { content: `[链接] ${raw.link?.title || ''}`.trim(), msgType: MsgType.CARD };
    case 'weapp':
      return { content: `[小程序] ${raw.weapp?.title || ''}`.trim(), msgType: MsgType.CARD };
    case 'chatrecord':
      return { content: '[聊天记录]', msgType: MsgType.FILE };
    case 'agree':
    case 'disagree':
    case 'revoke':
      return { content: '[系统消息]', msgType: MsgType.EVENT };
    default:
      return { content: '', msgType: MsgType.TEXT };
  }
}

/**
 * 存档拉取器。封装了 seq 游标、分页、解密、归一化。
 *
 * @param {Object} p
 * @param {Object} [p.config]
 * @param {Function} p.requireFn 用于加载 native 模块
 * @param {Function} [p.onBatch] 每批回调 (messages, { seq, raw })
 * @param {Object} [p.logger]
 */
export function createAuditPuller({ config = loadAuditConfig(), requireFn, onBatch, logger = console } = {}) {
  const loaded = loadSdk(requireFn);
  if (!loaded.ok) {
    return {
      available: false,
      reason: loaded.reason,
      async pullOnce() {
        throw new Error(loaded.reason);
      },
      close() {},
    };
  }

  const { Sdk } = loaded;
  const sdk = new Sdk();
  const initCode = sdk.Init(config.corpId, config.secret, '');
  if (initCode !== 0) {
    return {
      available: false,
      reason: `SDK Init 失败，返回码 ${initCode}。请检查 CorpID / 存档 Secret 是否正确、是否已开通存档。`,
      async pullOnce() {
        throw new Error('SDK 未初始化成功');
      },
      close() {},
    };
  }

  let seq = 0;
  let closed = false;

  function decryptOne(item) {
    const encryptKey = decryptRandomKey(item.encrypt_random_key, config.privateKey);
    const plain = sdk.DecryptData(encryptKey, item.encrypt_chat_msg);
    if (!plain) throw new Error(`消息 ${item.msgid} 解密结果为空`);
    return JSON.parse(plain);
  }

  /**
   * 拉一批。
   * @param {number} [startSeq] 不传则用内部游标
   * @returns {Promise<{messages:Array, maxSeq:number, count:number, errors:Array}>}
   */
  async function pullOnce(startSeq = seq) {
    if (closed) throw new Error('puller 已关闭');

    const res = sdk.GetChatData(startSeq, config.batchSize, '', '', 30);
    // SDK 返回可能是对象或 JSON 字符串
    const data = typeof res === 'string' ? JSON.parse(res) : res;

    if (!data || data.errcode !== 0) {
      throw new Error(`GetChatData 失败: ${data?.errcode} ${data?.errmsg || ''}`);
    }

    const list = data.chatdata || [];
    const messages = [];
    const errors = [];
    let maxSeq = startSeq;

    for (const item of list) {
      if (Number(item.seq) > maxSeq) maxSeq = Number(item.seq);
      try {
        const plain = decryptOne(item);
        const msg = fromAudit(plain, { selfUserIds: config.selfUserIds });
        if (msg) messages.push(msg);
      } catch (err) {
        errors.push({ seq: item.seq, msgid: item.msgid, error: err.message });
        logger.warn?.(`[audit] 解密失败 seq=${item.seq}: ${err.message}`);
      }
    }

    seq = maxSeq;
    if (messages.length && onBatch) await onBatch(messages, { seq: maxSeq, raw: data });

    return { messages, maxSeq, count: list.length, errors };
  }

  /**
   * 持续拉取直到没有新数据。
   */
  async function drain({ maxRounds = 100 } = {}) {
    let total = 0;
    const allErrors = [];
    for (let i = 0; i < maxRounds; i++) {
      const r = await pullOnce();
      total += r.messages.length;
      allErrors.push(...r.errors);
      if (r.count < config.batchSize) break;
    }
    return { total, errors: allErrors };
  }

  return {
    available: true,
    pullOnce,
    drain,
    getSeq: () => seq,
    setSeq: (v) => {
      seq = Number(v) || 0;
    },
    close() {
      closed = true;
      try {
        sdk.DestroySdk?.();
      } catch {
        /* 忽略 */
      }
    },
  };
}

/**
 * seq 游标持久化，避免重启后重复拉取。
 */
export function createSeqStore(filePath) {
  return {
    path: filePath,
    load() {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const obj = JSON.parse(raw);
        return Number(obj.seq) || 0;
      } catch {
        return 0;
      }
    },
    save(seq) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify({ seq, updatedAt: Date.now() }, null, 2));
        return true;
      } catch {
        return false;
      }
    },
  };
}
