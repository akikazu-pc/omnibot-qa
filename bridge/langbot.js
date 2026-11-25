/**
 * LangBot HTTP Bot 通道
 *
 * LangBot 的 http_bot 适配器用 HMAC-SHA256 做双向签名：
 *   签名串 = `${timestamp}.${rawBody}`
 *   签名头  = X-LB-Timestamp / X-LB-Signature (sha256=<hex>)
 *
 * 出站（我们 → LangBot）：
 *   客户消息 POST 到 LangBot 的 webhook_url，LangBot 交给流水线由 AI 回复
 * 入站（LangBot → 我们）：
 *   LangBot 把回复 POST 回 callback_url，我们落库为 outbound 消息
 */
import crypto from 'node:crypto';

const HEADER_TS = 'x-lb-timestamp';
const HEADER_SIG = 'x-lb-signature';
const REPLAY_WINDOW = 300; // 秒

/** 计算签名 */
export function computeSignature(secret, bodyString, timestamp) {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(bodyString, 'utf8')
    .digest('hex');
  return `sha256=${digest}`;
}

/** 签名后 POST */
export async function signedPost(url, payload, secret, { timeoutMs = 10000 } = {}) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = computeSignature(secret, body, ts);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [HEADER_TS]: ts,
      [HEADER_SIG]: sig,
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

/** 校验入站签名 */
export function verifySignature(secret, rawBody, headers, { replayWindow = REPLAY_WINDOW } = {}) {
  const ts = headers[HEADER_TS];
  const sig = headers[HEADER_SIG];
  if (!ts || !sig) return { ok: false, reason: 'missing signature headers' };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!Number.isFinite(age) || age > replayWindow) {
    return { ok: false, reason: 'timestamp out of window' };
  }

  const expect = computeSignature(secret, rawBody, ts);
  const a = Buffer.from(expect);
  const b = Buffer.from(String(sig));
  if (a.length !== b.length) return { ok: false, reason: 'signature mismatch' };
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

/**
 * 把客户消息发给 LangBot，触发 AI 回复。
 * @param {Object} opts
 * @param {string} opts.webhookUrl  LangBot 入站 webhook
 * @param {string} opts.secret
 * @param {string} opts.sessionId   会话标识（对应 conversation_id）
 * @param {string} opts.userId
 * @param {string} opts.text
 */
export async function forwardToLangBot({ webhookUrl, secret, sessionId, userId, text, userName }) {
  return signedPost(
    webhookUrl,
    {
      session_id: sessionId,
      session_type: 'person',
      user_id: userId,
      user_name: userName || userId,
      message: [{ type: 'text', text }],
    },
    secret
  );
}
