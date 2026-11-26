/**
 * 企业微信智能机器人 WebSocket 长连接客户端
 *
 * 为什么用长连接：
 *   智能机器人的 Webhook 模式需要「公网可访问的 URL」，
 *   开发机/内网环境配不了。长连接是**本机主动外连**，
 *   零公网入口、零证书、零消息加解密。
 *
 * 官方文档：https://developer.work.weixin.qq.com/document/path/101463
 * 官方 SDK：@wecom/aibot-node-sdk（这里不装依赖，按其协议手写实现）
 *
 * 协议要点（都按官方 SDK 的常量来，别猜）：
 *   连接地址  wss://openws.work.weixin.qq.com（固定，不需要先换 URL）
 *   鉴权      { cmd:'aibot_subscribe', headers:{req_id}, body:{bot_id, secret} }
 *   心跳      { cmd:'ping', headers:{req_id} }       建议 30 秒
 *   消息回调  { cmd:'aibot_msg_callback', headers:{req_id}, body:{...} }
 *   回复消息  { cmd:'aibot_respond_msg', headers:{req_id}, body:{ msgtype:'stream', stream:{id, finish, content} } }
 *   事件回调  { cmd:'aibot_event_callback', headers:{req_id}, body:{ event_type, ... } }
 *
 * 限制：同一机器人**同时只能有一个有效长连接**，新连接会踢掉旧连接。
 *
 * 零依赖：Node 22+ 自带全局 WebSocket。
 */

const WS_URL = 'wss://openws.work.weixin.qq.com';

export const WsCmd = Object.freeze({
  SUBSCRIBE: 'aibot_subscribe',
  HEARTBEAT: 'ping',
  RESPONSE: 'aibot_respond_msg',
  RESPONSE_WELCOME: 'aibot_respond_welcome_msg',
  SEND_MSG: 'aibot_send_msg',
  CALLBACK: 'aibot_msg_callback',
  EVENT_CALLBACK: 'aibot_event_callback',
});

export function loadBotConfig(env = process.env) {
  return {
    botId: env.WECOM_BOT_ID || '',
    secret: env.WECOM_BOT_SECRET || '',
    wsUrl: env.WECOM_BOT_WS_URL || WS_URL,
    reconnectDelayMs: Number(env.WECOM_BOT_RECONNECT_MS || 2000),
    maxDelayMs: Number(env.WECOM_BOT_MAX_DELAY_MS || 60000),
    // 官方建议 30 秒
    heartbeatMs: Number(env.WECOM_BOT_HEARTBEAT_MS || 30000),
    // 等订阅响应的超时
    subscribeTimeoutMs: Number(env.WECOM_BOT_SUBSCRIBE_TIMEOUT_MS || 10000),
  };
}

export function isBotConfigured(env = process.env) {
  const c = loadBotConfig(env);
  return Boolean(c.botId && c.secret);
}

let reqSeq = 0;
/** 生成唯一 req_id */
export function nextReqId(prefix = 'req') {
  reqSeq = (reqSeq + 1) % 1e9;
  return `${prefix}_${Date.now()}_${reqSeq}`;
}

/** 解析帧（容忍字符串/对象） */
export function parseFrame(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { cmd: '', reqId: '', body: {}, errcode: undefined };
    }
  }
  if (!obj || typeof obj !== 'object') return { cmd: '', reqId: '', body: {}, errcode: undefined };
  return {
    cmd: obj.cmd || '',
    reqId: obj.headers?.req_id || '',
    body: obj.body || {},
    errcode: obj.errcode,
    errmsg: obj.errmsg,
  };
}

/**
 * 把长连接 body 归一化成 wecom.js 认识的 raw 结构。
 *
 * 字段映射（按官方 SDK 的 BaseMessage）：
 *   msgid / aibotid / chatid / chattype / from.userid / msgtype
 *   text.content / voice.content / image.url
 * @param {object} body
 * @returns {object}
 */
export function normalizeBotBody(body = {}) {
  const msgtype = body.msgtype || 'text';

  let content = '';
  switch (msgtype) {
    case 'text':
      content = body.text?.content || '';
      break;
    case 'voice':
      // 长连接模式下语音已转文字，字段是 voice.content
      content = body.voice?.content || body.text?.content || '';
      break;
    case 'image':
      content = '[图片]';
      break;
    case 'file':
      content = `[文件] ${body.file?.filename || ''}`.trim();
      break;
    case 'video':
      content = '[视频]';
      break;
    case 'mixed': {
      // 图文混排：把文本段拼起来
      const items = body.mixed?.msg_item || [];
      content = items
        .map((it) => (it.msgtype === 'text' ? it.text?.content || '' : '[图片]'))
        .filter(Boolean)
        .join(' ');
      break;
    }
    default:
      content = body.text?.content || '';
  }

  const chattype = body.chattype || 'single';
  const isGroup = chattype === 'group';

  return {
    MsgId: body.msgid || '',
    FromUserName: body.from?.userid || '',
    ChatId: isGroup ? body.chatid || '' : '',
    ChatType: chattype,
    MsgType: msgtype,
    Content: content,
    // 长连接 body 里可能没有 create_time，用当前时间兜底
    CreateTime: body.create_time || Math.floor(Date.now() / 1000),
    Recognition: msgtype === 'voice' ? body.voice?.content || '' : '',
    FileName: body.file?.filename || '',
    Event: body.event_type || '',
    ToUserName: body.aibotid || '',
    // 回复时要用：群聊需要 chatid，单聊不需要
    chatid: body.chatid || '',
    responseUrl: body.response_url || '',
  };
}

/**
 * 构造订阅帧
 * @param {string} botId
 * @param {string} secret
 * @param {string} [reqId]
 */
export function buildSubscribe(botId, secret, reqId = nextReqId('sub')) {
  return {
    cmd: WsCmd.SUBSCRIBE,
    headers: { req_id: reqId },
    body: { bot_id: botId, secret },
  };
}

/** 构造心跳帧 */
export function buildPing(reqId = nextReqId('ping')) {
  return { cmd: WsCmd.HEARTBEAT, headers: { req_id: reqId } };
}

/**
 * 构造回复消息帧。
 *
 * 注意：必须用 `aibot_respond_msg` + `msgtype:'stream'`，
 * 而不是简单的 text —— 这是长连接模式的要求。
 * finish=true 表示这条流式消息结束。一次性回复就 finish 直接 true。
 *
 * @param {string} reqId 透传回调的 req_id
 * @param {string} content 回复内容（支持 markdown）
 * @param {Object} [opts]
 * @param {string} [opts.streamId] 流式消息 ID，不传则自动生成
 * @param {boolean} [opts.finish] 是否结束，默认 true
 * @returns {object}
 */
export function buildReply(reqId, content, opts = {}) {
  const streamId = opts.streamId || nextReqId('stream');
  return {
    cmd: WsCmd.RESPONSE,
    headers: { req_id: reqId },
    body: {
      msgtype: 'stream',
      stream: {
        id: streamId,
        finish: opts.finish !== false,
        content: String(content ?? ''),
      },
    },
  };
}

/**
 * 构造模板卡片回复帧。
 *
 * 为什么需要这个：单聊里 markdown 的 `a` 标签不会被渲染成可点链接，
 * 客户看到的是一串裸 URL。而模板卡片是原生卡片，
 * 底部按钮的 `card_action.type = 1` 能真正跳转网页。
 *
 * 「问价 → 发价格表页面」这个需求只能靠卡片实现，
 * 靠 markdown 发链接在单聊里等于没发。
 *
 * 卡片类型取 text_notice：纯文字排版，不需要图片素材，
 * 适合「服务名称 + 价格说明 + 跳转按钮」这种结构。
 *
 * @param {string} reqId
 * @param {object} card 模板卡片结构（见官方 template_card 定义）
 * @returns {object}
 */
export function buildReplyCard(reqId, card) {
  return {
    cmd: WsCmd.RESPONSE,
    headers: { req_id: reqId },
    body: {
      msgtype: 'template_card',
      template_card: card,
    },
  };
}

/**
 * 拼一张「价格页跳转」卡片。
 *
 * @param {Object} p
 * @param {string} p.title      主标题，如「上门装机 · 价格」
 * @param {string} [p.desc]     标题右侧辅助信息
 * @param {string} [p.subtitle] 二级说明，建议 ≤ 112 字
 * @param {string} p.url        点击卡片跳转的地址
 * @param {string} [p.urlLabel] 底部提示文案
 * @param {string} [p.iconUrl]  来源图标
 * @param {string} [p.sourceDesc] 来源描述，如站点名
 * @param {Array} [p.rows]      [{keyname, value}] 横向两列信息，最多 6 条
 * @returns {object} template_card
 */
export function buildPriceCard({
  title,
  desc = '',
  subtitle = '',
  url,
  urlLabel = '',
  iconUrl = '',
  sourceDesc = '',
  rows = [],
}) {
  if (!title) throw new Error('buildPriceCard: title 必填');
  if (!url) throw new Error('buildPriceCard: url 必填');

  const card = {
    card_type: 'text_notice',
    main_title: desc ? { title, desc } : { title },
    // type:1 = 跳转 URL。这是整个卡片能点得动的关键
    card_action: { type: 1, url },
  };

  if (sourceDesc) {
    card.source = iconUrl ? { icon_url: iconUrl, desc: sourceDesc } : { desc: sourceDesc };
  }

  if (subtitle) card.sub_title_text = subtitle;

  if (rows.length) {
    card.horizontal_content_list = rows
      .filter((r) => r && r.keyname)
      .slice(0, 6)
      .map((r) => ({ keyname: r.keyname, value: String(r.value ?? '') }));
  }

  if (urlLabel) {
    // jump_list 最多 3 条，这里只放一条，避免客户不知道点哪
    card.jump_list = [{ type: 1, title: urlLabel, url }];
  }

  return card;
}

/**
 * 构造主动发消息帧（无用户消息触发时用，如定时提醒）。
 * 单聊用 user_id，群聊用 chatid。
 */
export function buildSendMsg({ userId, chatId, content, reqId = nextReqId('send') }) {
  const body = {
    msgtype: 'markdown',
    markdown: { content: String(content ?? '') },
  };
  if (chatId) body.chatid = chatId;
  if (userId) body.userid = userId;
  return { cmd: WsCmd.SEND_MSG, headers: { req_id: reqId }, body };
}

/**
 * 连接智能机器人长连接。
 *
 * @param {Object} p
 * @param {(msg:object, ctx:{reqId:string, raw:object}) => Promise<string|void>|string|void} p.onMessage
 *        收到消息时调用；返回字符串则作为回复发送
 * @param {(evt:object, ctx:{reqId:string}) => void} [p.onEvent] 事件回调（如用户进入会话）
 * @param {Object} [p.config]
 * @param {(state:string, detail?:any)=>void} [p.onState]
 * @param {Object} [p.WebSocketImpl] 注入 WebSocket 实现（测试用）
 * @param {Object} [p.logger]
 * @returns {{close:()=>void, getState:()=>string, sendMessage:Function}}
 */
export function connectBot({
  onMessage,
  onEvent,
  config = loadBotConfig(),
  onState = () => {},
  WebSocketImpl = globalThis.WebSocket,
  logger = console,
} = {}) {
  let ws = null;
  let closed = false;
  let retry = 0;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let subscribeTimer = null;
  let subscribed = false;
  let state = 'idle';
  let hbMissed = 0;

  const setState = (s, detail) => {
    state = s;
    try {
      onState(s, detail);
    } catch {
      /* 状态回调异常不影响主流程 */
    }
  };

  const clearTimers = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (subscribeTimer) clearTimeout(subscribeTimer);
    reconnectTimer = null;
    heartbeatTimer = null;
    subscribeTimer = null;
  };

  const scheduleReconnect = (reason) => {
    if (closed) return;
    clearTimers();
    subscribed = false;
    const delay = Math.min(config.reconnectDelayMs * 2 ** retry, config.maxDelayMs);
    retry += 1;
    setState('reconnecting', { delay, reason });
    reconnectTimer = setTimeout(open, delay);
  };

  const rawSend = (frame) => {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      logger.warn?.('[ws] 发送失败:', err.message);
      return false;
    }
  };

  const startHeartbeat = () => {
    heartbeatTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1) return;
      hbMissed += 1;
      // 连丢 3 次心跳就认为连接假死，主动断开重连
      if (hbMissed > 3) {
        logger.warn?.('[ws] 心跳连续丢失，主动重连');
        try {
          ws.close();
        } catch {
          /* 忽略 */
        }
        return;
      }
      rawSend(buildPing());
    }, config.heartbeatMs);
  };

  const doSubscribe = () => {
    const frame = buildSubscribe(config.botId, config.secret);
    rawSend(frame);
    subscribeTimer = setTimeout(() => {
      if (!subscribed) {
        logger.warn?.('[ws] 订阅超时，重连');
        try {
          ws?.close();
        } catch {
          /* 忽略 */
        }
      }
    }, config.subscribeTimeoutMs);
  };

  async function handleCallback(frame) {
    const msg = normalizeBotBody(frame.body);
    let reply = null;
    try {
      reply = (await onMessage(msg, { reqId: frame.reqId, raw: frame.body })) || null;
    } catch (err) {
      logger.error?.('[ws] 处理消息失败:', err.message);
      reply = null;
    }

    // onMessage 可以返回三种东西：
    //   ''            → 不回复（重复消息、机器人自己发的）
    //   '文本'        → 当成 markdown 流式回复
    //   { card: {...} } → 发模板卡片（单聊里唯一能让客户点得动的形式）
    if (!reply) return;

    if (typeof reply === 'object' && reply.card) {
      rawSend(buildReplyCard(frame.reqId, reply.card));
      return;
    }

    rawSend(buildReply(frame.reqId, String(reply)));
  }

  function open() {
    if (closed) return;
    clearTimers();
    setState('connecting');

    try {
      ws = new WebSocketImpl(config.wsUrl);
    } catch (err) {
      setState('error', { error: err.message });
      scheduleReconnect('构造失败');
      return;
    }

    ws.onopen = () => {
      setState('handshaking');
      doSubscribe();
    };

    ws.onmessage = async (ev) => {
      const frame = parseFrame(ev?.data ?? ev);

      // 订阅响应：无 cmd，带 errcode
      if (!frame.cmd && frame.errcode !== undefined) {
        if (frame.errcode === 0) {
          subscribed = true;
          retry = 0;
          hbMissed = 0;
          if (subscribeTimer) clearTimeout(subscribeTimer);
          subscribeTimer = null;
          setState('connected');
          startHeartbeat();
        } else {
          subscribed = false;
          setState('error', { error: `订阅失败 ${frame.errcode} ${frame.errmsg || ''}` });
          // 鉴权失败重试没意义，但保留重连以应对密钥轮换
          scheduleReconnect('订阅失败');
        }
        return;
      }

      // 心跳响应（cmd 为 ping 或没有 cmd 但有 headers）→ 清丢失计数
      if (frame.cmd === WsCmd.HEARTBEAT || frame.cmd === 'pong') {
        hbMissed = 0;
        return;
      }
      // 其他响应帧带 errcode 0，也当作心跳回执
      if (frame.cmd === '' && frame.reqId && frame.errcode === undefined) {
        hbMissed = 0;
        return;
      }

      if (frame.cmd === WsCmd.CALLBACK) {
        await handleCallback(frame);
        return;
      }

      if (frame.cmd === WsCmd.EVENT_CALLBACK) {
        try {
          onEvent?.(frame.body, { reqId: frame.reqId });
        } catch (err) {
          logger.error?.('[ws] 事件处理失败:', err.message);
        }
        return;
      }
    };

    ws.onerror = (ev) => {
      setState('error', { error: ev?.message || 'websocket error' });
    };

    ws.onclose = (ev) => {
      clearTimers();
      ws = null;
      subscribed = false;
      if (closed) {
        setState('closed');
        return;
      }
      scheduleReconnect(`连接关闭 code=${ev?.code ?? '-'}`);
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
    /** 主动发消息（不依赖用户先说话） */
    sendMessage(args) {
      return rawSend(buildSendMsg(args));
    },
  };
}
