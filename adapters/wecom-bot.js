/**
 * 企业微信智能机器人 WebSocket 长连接客户端
 *
 * 为什么用长连接：
 *   自建应用的回调模式需要「公网域名 + HTTPS 证书 + 备案」，
 *   在公司内网/开发环境里非常麻烦。
 *   智能机器人提供 WebSocket 长连接，本机主动外连即可，
 *   不需要任何公网入口，也不需要 Token/EncodingAESKey。
 *
 * 官方文档：
 *   https://developer.work.weixin.qq.com/document/path/101249
 *
 * 流程：
 *   1. POST https://qyapi.weixin.qq.com/cgi-bin/ai_bot/get_bot_ws_url
 *      body { "botid": "xxx" }  → 拿到 { ws_url, ticket }
 *   2. 连接 ws_url，带上 ticket
 *   3. 收到消息回调后，按需回一条「确认」避免企业微信重试
 *   4. 3 分钟没消息发心跳 ping，断了自动重连
 *
 * 零依赖实现：Node 22+ 自带全局 WebSocket。
 */

const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';

export function loadBotConfig(env = process.env) {
  return {
    botId: env.WECOM_BOT_ID || '',
    secret: env.WECOM_BOT_SECRET || '',
    apiBase: (env.WECOM_API_BASE || API_BASE).replace(/\/+$/, ''),
    reconnectDelayMs: Number(env.WECOM_BOT_RECONNECT_MS || 3000),
    maxDelayMs: Number(env.WECOM_BOT_MAX_DELAY_MS || 30000),
    heartbeatMs: Number(env.WECOM_BOT_HEARTBEAT_MS || 60000),
  };
}

export function isBotConfigured(env = process.env) {
  const c = loadBotConfig(env);
  return Boolean(c.botId && c.secret);
}

/**
 * 换取 WebSocket 连接地址。
 * @param {Object} [cfg]
 * @param {Function} [fetchImpl]
 * @returns {Promise<{wsUrl:string, ticket:string}>}
 */
export async function getBotWsUrl(cfg = loadBotConfig(), fetchImpl = globalThis.fetch) {
  if (!cfg.botId || !cfg.secret) throw new Error('WECOM_BOT_ID / WECOM_BOT_SECRET 未配置');

  const resp = await fetchImpl(`${cfg.apiBase}/ai_bot/get_bot_ws_url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botid: cfg.botId, secret: cfg.secret }),
  });

  const data = await resp.json();
  if (data.errcode !== 0 || !data.ws_url) {
    throw new Error(`获取 ws_url 失败: ${data.errcode ?? '-'} ${data.errmsg || '未知错误'}`);
  }

  return { wsUrl: data.ws_url, ticket: data.ticket || '' };
}

/**
 * 解析长连接推送的报文。
 *
 * 企业微信智能机器人推送的帧形如：
 *   {"cmd":"aibot_msg_callback","headers":{"req_id":"..."},"body":{...}}
 * body 里是消息本体（字段与回调接口的 XML 语义一致）。
 *
 * @param {string|object} raw
 * @returns {{cmd:string, reqId:string, body:object}}
 */
export function parseFrame(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { cmd: '', reqId: '', body: {} };
    }
  }
  if (!obj || typeof obj !== 'object') return { cmd: '', reqId: '', body: {} };

  const headers = obj.headers || {};
  return {
    cmd: obj.cmd || '',
    reqId: headers.req_id || headers.reqid || '',
    body: obj.body || {},
  };
}

/**
 * 把智能机器人 body 归一化成 wecom.js 认识的 raw 结构。
 *
 * 智能机器人 body 字段名与自建应用回调略有差异，这里做一次映射。
 * @param {object} body
 * @returns {object} 兼容 fromWecom 的 raw
 */
export function normalizeBotBody(body = {}) {
  const from = body.from || {};
  const to = body.to || {};
  const msgtype = body.msgtype || body.MsgType || 'text';

  // 文本内容可能在 body.text.content，也可能在 body.content
  let content = body.text?.content ?? body.content ?? '';
  if (typeof content !== 'string') content = String(content ?? '');

  const chatType = body.chat_type || body.chattype || '';

  return {
    MsgId: body.msgid || body.msg_id || body.id || '',
    FromUserName: from.userid || from.user_id || body.from_user || '',
    FromUserNameName: from.name || '',
    ChatId: body.chat_id || body.chatid || (chatType === 'group' ? body.chatid : ''),
    ChatType: chatType,
    MsgType: msgtype,
    Content: content,
    CreateTime: body.create_time || body.createTime || body.timestamp || 0,
    Recognition: body.voice?.recognition || body.recognition || '',
    FileName: body.filename || body.file_name || '',
    Event: body.event || '',
    ToUserName: to.userid || '',
  };
}

/**
 * 生成一个「确认收到」的空回复帧。
 * 企业微信要求：处理成功后回一条响应，否则会重试推送。
 * @param {string} reqId
 * @param {string} [content]
 */
export function buildAck(reqId, content = '') {
  return {
    cmd: 'aibot_msg_callback_response',
    headers: { req_id: reqId },
    body: { msgtype: 'text', text: { content: content || 'ok' } },
  };
}

/**
 * 连接智能机器人长连接。
 *
 * @param {Object} p
 * @param {(msg:object, ctx:{reqId:string}) => Promise<string|void>} p.onMessage 收到消息回调；返回字符串则作为回复内容
 * @param {Object} [p.config]
 * @param {(state:string, detail?:any)=>void} [p.onState] 状态变化回调（connecting/connected/reconnecting/error）
 * @param {Function} [p.fetchImpl]
 * @param {Object} [p.WebSocketImpl] 注入 WebSocket 实现（测试用）
 * @returns {{close:()=>void, getState:()=>string}}
 */
export function connectBot({
  onMessage,
  config = loadBotConfig(),
  onState = () => {},
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  let ws = null;
  let closed = false;
  let retry = 0;
  let timer = null;
  let heartbeat = null;
  let state = 'idle';

  const setState = (s, detail) => {
    state = s;
    try {
      onState(s, detail);
    } catch {
      /* 状态回调异常不影响主流程 */
    }
  };

  const clearTimers = () => {
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    timer = null;
    heartbeat = null;
  };

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = Math.min(config.reconnectDelayMs * 2 ** retry, config.maxDelayMs);
    retry += 1;
    setState('reconnecting', { delay });
    timer = setTimeout(open, delay);
  };

  async function open() {
    if (closed) return;
    clearTimers();
    setState('connecting');

    let wsUrl = '';
    let ticket = '';
    try {
      ({ wsUrl, ticket } = await getBotWsUrl(config, fetchImpl));
    } catch (err) {
      setState('error', { error: err.message });
      scheduleReconnect();
      return;
    }

    const target = ticket ? `${wsUrl}?ticket=${encodeURIComponent(ticket)}` : wsUrl;

    try {
      ws = new WebSocketImpl(target);
    } catch (err) {
      setState('error', { error: err.message });
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      retry = 0;
      setState('connected', { wsUrl: target });
      heartbeat = setInterval(() => {
        try {
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ cmd: 'ping' }));
        } catch {
          /* 心跳失败交给 onclose 处理 */
        }
      }, config.heartbeatMs);
    };

    ws.onmessage = async (ev) => {
      let frame;
      try {
        frame = parseFrame(ev?.data ?? ev);
      } catch {
        return;
      }
      if (!frame.cmd) return;

      // 心跳响应直接忽略
      if (frame.cmd === 'ping' || frame.cmd === 'pong') return;

      if (frame.cmd === 'aibot_msg_callback') {
        const raw = normalizeBotBody(frame.body);
        let reply = '';
        try {
          reply = (await onMessage(raw, { reqId: frame.reqId })) || '';
        } catch (err) {
          setState('error', { error: err.message });
        }
        // 必须回执，否则企业微信会重复推送
        try {
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify(buildAck(frame.reqId, reply)));
          }
        } catch {
          /* 忽略发送失败 */
        }
      }
    };

    ws.onerror = (ev) => {
      setState('error', { error: ev?.message || 'websocket error' });
    };

    ws.onclose = () => {
      clearTimers();
      ws = null;
      if (closed) {
        setState('closed');
        return;
      }
      scheduleReconnect();
    };
  }

  open();

  return {
    close() {
      closed = true;
      clearTimers();
      try {
        if (ws) ws.close();
      } catch {
        /* 忽略 */
      }
      setState('closed');
    },
    getState: () => state,
  };
}
