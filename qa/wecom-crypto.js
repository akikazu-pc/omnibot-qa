/**
 * 企业微信消息加解密（微信客服 / 自建应用通用）
 *
 * 回调 URL 配置了 Token + EncodingAESKey 之后，企业微信推过来的不是明文，
 * 而是一段加密 XML。必须：
 *   1. 验签（确认请求真的来自微信，且内容没被篡改）
 *   2. 解密（拿到真正的消息 XML）
 *   3. 回复时反向加密
 *
 * 官方算法（企业微信「消息加解密」文档）：
 *   - 签名：sha1(sort([token, timestamp, nonce, msg_encrypt])) 取十六进制
 *   - 加密：AES-256-CBC，key = Base64Decode(EncodingAESKey + "=")   (32 字节)
 *          iv  = key 的前 16 字节
 *   - 明文结构：random(16 字节) + msg_len(4 字节网络序) + msg + receiveid
 *   - 填充：PKCS#7，块大小 32
 *
 * 用 Node 自带的 crypto，零依赖。
 */

import crypto from 'node:crypto';

/** PKCS#7 填充，块大小 32（企业微信用的是 32，不是 AES 默认的 16） */
export function pkcs7Pad(buf, blockSize = 32) {
  const pad = blockSize - (buf.length % blockSize);
  const padding = Buffer.alloc(pad, pad);
  return Buffer.concat([buf, padding]);
}

export function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) return buf; // 非法填充，原样返回（容错）
  return buf.subarray(0, buf.length - pad);
}

/**
 * 从 EncodingAESKey（43 位）推出 32 字节 AES key。
 * 官方要求末尾补一个 '=' 再 Base64 解码。
 */
export function aesKeyOf(encodingAesKey) {
  const key = Buffer.from(String(encodingAesKey || '') + '=', 'base64');
  if (key.length !== 32) {
    throw new Error(`EncodingAESKey 无效：解出 ${key.length} 字节，应为 32。检查是否 43 位`);
  }
  return key;
}

/** 计算签名：sha1 排序拼接后取 hex */
export function signatureOf(token, timestamp, nonce, encrypt) {
  const arr = [String(token), String(timestamp), String(nonce), String(encrypt || '')].sort();
  return crypto.createHash('sha1').update(arr.join('')).digest('hex');
}

/**
 * 校验签名。用 timingSafeEqual 防时序攻击。
 * @returns {boolean}
 */
export function verifySignature({ token, timestamp, nonce, msgSignature, encrypt }) {
  if (!token || !msgSignature) return false;
  const expect = signatureOf(token, timestamp, nonce, encrypt);
  const a = Buffer.from(expect);
  const b = Buffer.from(String(msgSignature));
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * 解密。
 * @param {string} encrypt       密文（Base64）
 * @param {string} encodingAesKey
 * @param {string} [receiveId]   预期接收方（企业ID/CorpID），传了就校验
 * @returns {{message:string, receiveId:string}}
 */
export function decryptMessage(encrypt, encodingAesKey, receiveId) {
  const key = aesKeyOf(encodingAesKey);
  const iv = key.subarray(0, 16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);

  const decrypted = pkcs7Unpad(
    Buffer.concat([decipher.update(Buffer.from(encrypt, 'base64')), decipher.final()])
  );

  if (decrypted.length < 20) throw new Error('解密结果过短，密钥可能不对');

  const msgLen = decrypted.readUInt32BE(16);
  if (msgLen < 0 || 20 + msgLen > decrypted.length) {
    throw new Error('消息长度字段非法，密钥可能不对');
  }

  const message = decrypted.subarray(20, 20 + msgLen).toString('utf8');
  const gotReceiveId = decrypted.subarray(20 + msgLen).toString('utf8');

  if (receiveId && gotReceiveId && gotReceiveId !== receiveId) {
    throw new Error(`receiveId 不匹配：拿到 ${gotReceiveId}，预期 ${receiveId}`);
  }

  return { message, receiveId: gotReceiveId };
}

/**
 * 加密（回复时用）。
 * @param {string} message
 * @param {string} encodingAesKey
 * @param {string} receiveId   企业ID
 * @returns {string} Base64 密文
 */
export function encryptMessage(message, encodingAesKey, receiveId) {
  const key = aesKeyOf(encodingAesKey);
  const iv = key.subarray(0, 16);

  const random = crypto.randomBytes(16);
  const msgBuf = Buffer.from(String(message), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);

  const raw = Buffer.concat([random, lenBuf, msgBuf, Buffer.from(String(receiveId || ''), 'utf8')]);
  const padded = pkcs7Pad(raw, 32);

  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

/**
 * 把解密出来的明文 XML 包成 callback 结构（和 parseCallbackXml 对接）。
 * @param {string} plainXml
 * @returns {Object}
 */
export function parsePlainCallback(plainXml) {
  const out = {};
  const src = String(plainXml).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, v) => v);
  const re = /<([A-Za-z_][\w]*)\s*>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(src))) out[m[1]] = (m[2] || '').trim();
  return out;
}
