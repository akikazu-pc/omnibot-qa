/**
 * 微信客服适配器（kf）—— 真正能触达外部客户的官方渠道
 *
 * 为什么单独一个文件：
 *   企微「智能机器人」(wecombot) 的官方定位是**企业内部员工 AI 助手**，
 *   可见范围只能选通讯录组织架构/人员标签，外部群也明确不支持添加。
 *   想让外部客户（微信用户）直接对话，只有「微信客服」这一条官方合规路：
 *
 *   微信客服 = 微信里的客服会话入口（链接/组件），用户点开即聊，
 *   不需要加好友，企业通过 API 收发消息。
 *
 * 官方文档：
 *   概览    https://kf.weixin.qq.com/api/doc/path/93304
 *   收消息  https://kf.weixin.qq.com/api/doc/path/94745
 *   开发配置 https://kf.weixin.qq.com/api/doc/path/94830
 *
 * 协议是「两段式」，别和别家混：
 *   1. 微信客服服务器 → 你的回调 URL，XML 通知「有新消息了」（不带正文）
 *   2. 你 → sync_msg 接口主动拉取消息正文（带回调里的 token）
 *      漏拉一次就永久丢消息，所以 cursor 必须入库持久化。
 *
 * 关键约束（都是官方文档写死的）：
 *   - 回调 token 10 分钟有效
 *   - access_token 7200 秒，必须缓存，频繁调 gettoken 会被频率拦截
 *   - 只有「微信客服的 Secret」拿到的 access_token 能调 sync_msg
 *   - 拉取必须带 token，否则有严格频率限制
 *
 * 环境变量：
 *   KF_CORP_ID   微信客服企业 ID（kf.weixin.qq.com → 企业信息）
 *   KF_SECRET    微信客服 Secret（kf.weixin.qq.com → 开发配置）
 *   KF_TOKEN     回调配置里的 Token（自己设的，用于签名校验）
 *   KF_AES_KEY   回调配置里的 EncodingAESKey（43 位）
 *   KF_API_BASE  调试用，默认正式地址
 */

const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin/kf';

/** 从环境变量读配置 */
export function loadKfConfig(env = process.env) {
  return {
    corpId: env.KF_CORP_ID || '',
    secret: env.KF_SECRET || '',
    token: env.KF_TOKEN || '',
    aesKey: env.KF_AES_KEY || '',
    apiBase: (env.KF_API_BASE || API_BASE).replace(/\/+$/, ''),
    // 每次拉取条数，官方默认/上限都是 1000
    limit: Number(env.KF_LIMIT || 1000),
  };
}

export function isKfConfigured(env = process.env) {
  const c = loadKfConfig(env);
  return Boolean(c.corpId && c.secret);
}

/** 只配了回调验签参数、没配 API 凭据 —— 能收不能发 */
export function isKfCallbackConfigured(env = process.env) {
  const c = loadKfConfig(env);
  return Boolean(c.token && c.aesKey);
}

// ─────────────────────── access_token ───────────────────────

const tokenCache = new Map(); // corpId -> { token, expiresAt }

export function resetKfTokenCache() {
  tokenCache.clear();
}

/**
 * 取微信客服 access_token（带缓存）。
 * 官方：expires_in 7200 秒；这里提前 5 分钟过期。
 */
export async function getKfAccessToken(cfg = loadKfConfig(), fetchImpl = globalThis.fetch) {
  if (!cfg.corpId || !cfg.secret) throw new Error('KF_CORP_ID / KF_SECRET 未配置');
  const doFetch = fetchImpl || globalThis.fetch;

  const cached = tokenCache.get(cfg.corpId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const url = `${cfg.apiBase.replace(/\/kf$/, '')}/gettoken?corpid=${encodeURIComponent(
    cfg.corpId
  )}&corpsecret=${encodeURIComponent(cfg.secret)}`;
  const resp = await doFetch(url);
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

// ─────────────────────── 回调：解析通知 ───────────────────────

/**
 * 极简 XML 解析：把回调那段 XML 拆成 key → 文本值。
 * 微信客服回调字段很固定（十几个），不需要完整 XML 引擎。
 *
 * @param {string} xml
 * @returns {Object}
 */
export function parseCallbackXml(xml = '') {
  const out = {};
  // 第一步：把所有 CDATA 包装脱掉，换成不会干扰后续解析的占位。
  // （CDATA 里含 '<'，不先脱的话后面的标签匹配会被撑坏。）
  const src = String(xml).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, v) => v);

  // 第二步：只取叶子字段 —— 值里不能再出现 '<'。
  // 这样外层的 <xml>…</xml> 会被自动排除（它的值里含 '<'）。
  const re = /<([A-Za-z_][\w]*)\s*>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(src))) {
    out[m[1]] = (m[2] || '').trim();
  }
  return out;
}

/**
 * 解析微信客服回调通知。
 *
 * 官方结构：
 *   <ToUserName><![CDATA[ww12345678910]]></ToUserName>   微信客服企业ID
 *   <CreateTime>1348831860</CreateTime>
 *   <MsgType><![CDATA[event]]></MsgType>                   固定 event
 *   <Event><![CDATA[kf_msg_or_event]]></Event>             固定
 *   <Token><![CDATA[...]]></Token>                         拉取时要带的 token
 *   <OpenKfId><![CDATA[wkxxxxxxx]]></OpenKfId>            有新消息的客服账号
 *
 * @param {string|Object} body XML 字符串或已解析对象
 * @returns {{ok:boolean, kind?:string, token?:string, openKfid?:string, error?:string}}
 */
export function parseCallback(body) {
  const x = typeof body === 'string' ? parseCallbackXml(body) : body || {};
  const msgType = x.MsgType || x.msgtype || '';
  const event = x.Event || x.event || '';

  if (msgType === 'event' && event === 'kf_msg_or_event') {
    return {
      ok: true,
      kind: 'message',
      token: x.Token || x.token || '',
      openKfid: x.OpenKfId || x.open_kfid || '',
      createTime: Number(x.CreateTime || 0),
      toUserName: x.ToUserName || '',
    };
  }
  return { ok: false, error: `未识别的回调类型 msgtype=${msgType} event=${event}` };
}

// ─────────────────────── 拉取消息 ───────────────────────

/**
 * 拉取消息（sync_msg）。
 *
 * @param {Object} p
 * @param {string} [p.cursor]       上次的 next_cursor
 * @param {string} [p.token]        回调里的 token（10 分钟有效）
 * @param {string} [p.openKfid]     只拉某个客服账号
 * @param {number} [p.limit]
 * @param {string} [p.cursorStore] 持久化游标的读写接口（由调用方注入）
 * @param {Object} [p.config]
 * @param {Function} [p.fetchImpl]
 * @returns {Promise<{ok:boolean, messages?:Array, nextCursor?:string, hasMore?:boolean, error?:string}>}
 */
export async function syncMessages({
  cursor,
  token,
  openKfid,
  limit,
  config,
  fetchImpl,
} = {}) {
  const cfg = { ...loadKfConfig(), ...(config || {}) };
  const doFetch = fetchImpl || globalThis.fetch;

  const at = await getKfAccessToken(cfg, doFetch);
  const body = {
    limit: Number(limit || cfg.limit || 1000),
    // token 不填会有严格频率限制，能传就传
    ...(token ? { token } : {}),
    ...(cursor ? { cursor } : {}),
    ...(openKfid ? { open_kfid: openKfid } : {}),
  };

  const resp = await doFetch(`${cfg.apiBase}/sync_msg?access_token=${encodeURIComponent(at)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (data.errcode !== 0) {
    if (data.errcode === 40014 || data.errcode === 42001) resetKfTokenCache();
    return { ok: false, error: `${data.errcode} ${data.errmsg}` };
  }
  return {
    ok: true,
    messages: data.msg_list || [],
    nextCursor: data.next_cursor || '',
    // 注意：has_more=1 时 msg_list 可能是空数组，不能靠长度判断是否结束
    hasMore: Number(data.has_more || 0) === 1,
  };
}

/**
 * 把 sync_msg 的消息条目翻译成平台无关的文本内容。
 * @param {Object} m
 * @returns {{content:string, msgType:string, externalUserId:string, openKfid:string, msgid:string}}
 */
export function normalizeKfMessage(m = {}) {
  let content = '';
  let msgType = m.msgtype || 'text';

  switch (msgType) {
    case 'text':
      content = m.text?.content || '';
      break;
    case 'image':
      content = '[图片]';
      break;
    case 'voice':
      content = '[语音]';
      break;
    case 'video':
      content = '[视频]';
      break;
    case 'file':
      content = `[文件] ${m.file?.name || ''}`.trim();
      break;
    case 'location':
      content = m.location?.name
        ? `[位置] ${m.location.name}${m.location.address ? ' ' + m.location.address : ''}`
        : '[位置]';
      break;
    case 'miniprogram':
      content = `[小程序] ${m.miniprogram?.title || ''}`.trim();
      break;
    case 'event':
      content = `[事件] ${m.event?.event_type || ''}`;
      break;
    case 'note':
      content = '[笔记]';
      break;
    default:
      content = m.text?.content || '';
  }

  return {
    content,
    msgType,
    msgid: m.msgid || '',
    externalUserId: m.external_userid || '',
    openKfid: m.open_kfid || '',
    sendTime: Number(m.send_time || 0),
    // origin: 3=客户发来的, 4=系统推送
    fromCustomer: Number(m.origin || 0) === 3,
  };
}

// ─────────────────────── 发消息 ───────────────────────

/**
 * 发送客服消息。
 *
 * ⚠️ 重要：微信客服的发送接口**不支持 markdown**，
 *    只支持 text / menu / image / miniprogram / 等结构化消息。
 *    所以问价要发可点链接，只能：
 *      a) 发纯文本 + 完整 URL（用户自己复制/长按）
 *      b) 发 miniprogram 卡片（需要小程序 appid）
 *    —— 想在微信里做可点卡片，得走小程序，不能靠 markdown。
 *
 * @param {Object} p
 * @param {string} p.touser       客户 external_userid
 * @param {string} p.openKfid     客服账号 ID
 * @param {string} p.content      文本内容
 * @param {Object} [p.config]
 * @param {Function} [p.fetchImpl]
 * @returns {Promise<{ok:boolean, msgid?:string, error?:string}>}
 */
export async function sendKfText({ touser, openKfid, content, config, fetchImpl }) {
  const cfg = { ...loadKfConfig(), ...(config || {}) };
  const doFetch = fetchImpl || globalThis.fetch;

  if (!touser || !content) throw new Error('touser 和 content 必填');
  if (!openKfid) throw new Error('openKfid 必填（客服账号 ID）');

  const at = await getKfAccessToken(cfg, doFetch);
  const resp = await doFetch(`${cfg.apiBase}/send_msg?access_token=${encodeURIComponent(at)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser,
      open_kfid: openKfid,
      msgtype: 'text',
      text: { content },
    }),
  });

  const data = await resp.json();
  if (data.errcode !== 0) {
    if (data.errcode === 40014 || data.errcode === 42001) resetKfTokenCache();
    return { ok: false, error: `${data.errcode} ${data.errmsg}` };
  }
  return { ok: true, msgid: data.msgid };
}

/**
 * 发送事件响应消息（欢迎语）。
 * 官方：send_msg_on_event，用 welcome_code 换客户欢迎语。
 */
export async function sendKfEventResponse({ code, openKfid, content, config, fetchImpl }) {
  const cfg = { ...loadKfConfig(), ...(config || {}) };
  const doFetch = fetchImpl || globalThis.fetch;

  if (!code || !openKfid) throw new Error('code 和 openKfid 必填');

  const at = await getKfAccessToken(cfg, doFetch);
  const resp = await doFetch(`${cfg.apiBase}/send_msg_on_event?access_token=${encodeURIComponent(at)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      msgid: `welcome_${Date.now()}`,
      open_kfid: openKfid,
      msgtype: 'text',
      text: { content: content || '您好，有什么可以帮您？' },
    }),
  });

  const data = await resp.json();
  if (data.errcode !== 0) return { ok: false, error: `${data.errcode} ${data.errmsg}` };
  return { ok: true, msgid: data.msgid };
}

// ─────────────────────── 客服账号 ───────────────────────

/**
 * 获取客服账号列表。
 * 客服账号 ID（open_kfid）就是外部客户看到的服务入口，一个账号 = 一个二维码/链接。
 */
export async function listKfAccounts({ config, fetchImpl } = {}) {
  const cfg = { ...loadKfConfig(), ...(config || {}) };
  const doFetch = fetchImpl || globalThis.fetch;
  const at = await getKfAccessToken(cfg, doFetch);

  const resp = await doFetch(`${cfg.apiBase}/account/list?access_token=${encodeURIComponent(at)}`);
  const data = await resp.json();
  if (data.errcode !== 0) return { ok: false, error: `${data.errcode} ${data.errmsg}` };
  return { ok: true, accounts: data.account_list || [] };
}

/**
 * 获取客服账号链接（对外投放用）。
 * 官方：客服链接是这个 API 返回的，外部客户点开就能聊。
 *
 * @param {Object} p
 * @param {string} p.openKfid
 * @param {string} [p.scene]         场景值（开发者自定义，用于统计来源）
 * @param {string} [p.sceneParam]
 */
export async function getKfAccountUrl({ openKfid, scene, sceneParam, config, fetchImpl } = {}) {
  const cfg = { ...loadKfConfig(), ...(config || {}) };
  const doFetch = fetchImpl || globalThis.fetch;
  const at = await getKfAccessToken(cfg, doFetch);

  const resp = await doFetch(`${cfg.apiBase}/account/link?access_token=${encodeURIComponent(at)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      open_kfid: openKfid,
      ...(scene ? { scene } : {}),
      ...(sceneParam ? { scene_param: sceneParam } : {}),
    }),
  });
  const data = await resp.json();
  if (data.errcode !== 0) return { ok: false, error: `${data.errcode} ${data.errmsg}` };
  return { ok: true, url: data.url || '' };
}
