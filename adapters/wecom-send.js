/**
 * 企业微信发送客户端
 *
 * 回调只推「客户发来的」，我方回复必须主动调 API 发出去。
 * 这里封装 access_token 缓存 + 发消息，零依赖（只用 fetch）。
 *
 * 需要的环境变量：
 *   WECOM_CORP_ID   企业 ID
 *   WECOM_AGENT_ID  自建应用 AgentId（数字）
 *   WECOM_SECRET    自建应用 Secret
 *
 * 注意：智能机器人（wecombot）走的是另一套接口，这里先支持自建应用。
 * 自建应用只能给「本企业成员」发消息；要给外部客户发，需要用微信客服
 * （kf/sync_msg），后续接。
 */

const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';

/** 从环境变量读配置 */
export function loadWecomConfig(env = process.env) {
  return {
    corpId: env.WECOM_CORP_ID || '',
    agentId: env.WECOM_AGENT_ID || '',
    secret: env.WECOM_SECRET || '',
    apiBase: (env.WECOM_API_BASE || API_BASE).replace(/\/+$/, ''),
  };
}

export function isWecomConfigured(env = process.env) {
  const c = loadWecomConfig(env);
  return Boolean(c.corpId && c.agentId && c.secret);
}

/**
 * access_token 缓存。企业微信 token 有效期 7200s，这里提前 5 分钟过期。
 */
const tokenCache = new Map(); // corpId -> { token, expiresAt }

export function resetTokenCache() {
  tokenCache.clear();
}

/**
 * 取 access_token（带缓存）。
 * @param {Object} [cfg] 覆盖配置
 * @param {Function} [fetchImpl]
 * @returns {Promise<string>}
 */
export async function getAccessToken(cfg = loadWecomConfig(), fetchImpl = globalThis.fetch) {
  if (!cfg.corpId || !cfg.secret) throw new Error('WECOM_CORP_ID / WECOM_SECRET 未配置');

  const cached = tokenCache.get(cfg.corpId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const url = `${cfg.apiBase}/gettoken?corpid=${encodeURIComponent(cfg.corpId)}&corpsecret=${encodeURIComponent(
    cfg.secret
  )}`;
  const resp = await fetchImpl(url);
  const data = await resp.json();

  if (data.errcode !== 0) {
    throw new Error(`获取 access_token 失败: ${data.errcode} ${data.errmsg}`);
  }

  tokenCache.set(cfg.corpId, {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, (data.expires_in || 7200) - 300) * 1000,
  });

  return data.access_token;
}

/**
 * 发送文本消息。
 *
 * @param {Object} p
 * @param {string} p.toUser 接收人 userid
 * @param {string} p.content 文本内容
 * @param {Object} [p.config]  覆盖配置
 * @param {Function} [p.fetchImpl]
 * @returns {Promise<{ok:boolean, msgid?:string, error?:string}>}
 */
export async function sendText({ toUser, content, config, fetchImpl }) {
  const cfg = { ...loadWecomConfig(), ...(config || {}) };
  const doFetch = fetchImpl || globalThis.fetch;

  if (!toUser || !content) throw new Error('toUser 和 content 必填');

  const token = await getAccessToken(cfg, doFetch);

  const resp = await doFetch(`${cfg.apiBase}/message/send?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser: toUser,
      msgtype: 'text',
      agentid: Number(cfg.agentId),
      text: { content },
    }),
  });

  const data = await resp.json();
  if (data.errcode !== 0) {
    // token 失效时清缓存，下次自动重取
    if (data.errcode === 40014 || data.errcode === 42001) tokenCache.delete(cfg.corpId);
    return { ok: false, error: `${data.errcode} ${data.errmsg}` };
  }

  return { ok: true, msgid: data.msgid };
}
