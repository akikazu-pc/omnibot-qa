/**
 * 小红书适配器（企业专业号 + 聚光平台三方客服）
 *
 * 接入前提（缺一不可）：
 * 1. 企业专业号认证
 * 2. 聚光平台推广资质认证
 * 3. 聚光平台 → 工具 → 三方客服管理 → 授权
 * 4. 商业开放平台创建应用，配置回调地址
 *
 * 限制：
 * - 只能收发「粉丝私信」，非粉丝消息收不到
 * - 与小红书电商客服、小程序客服是两个独立系统
 * - 支持文本/图片/视频，富文本会被拆成上述类型
 *
 * 注意：小红书开放平台的消息结构随版本变化，本适配器按通用 webhook
 * 结构做兼容处理，字段用多候选兜底。首次接入时请打印一条真实报文核对。
 */
import { Platform, Direction, MsgType, createMessage } from '../collector/message.js';

/** 小红书消息类型 → 统一类型 */
function mapMsgType(t) {
  const s = String(t || '').toLowerCase();
  if (s.includes('image') || s === '2') return MsgType.IMAGE;
  if (s.includes('video') || s === '3') return MsgType.VIDEO;
  if (s.includes('card') || s.includes('goods') || s.includes('order')) return MsgType.CARD;
  if (s.includes('event') || s.includes('system')) return MsgType.EVENT;
  return MsgType.TEXT;
}

/** 多候选字段取值，兼容不同版本的报文 */
function pick(obj, ...keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function extractContent(raw) {
  const type = mapMsgType(pick(raw, 'msg_type', 'type', 'message_type'));
  const text = pick(
    raw,
    'content',
    'text',
    'msg_content',
    'message.content',
    'data.content',
    'payload.text'
  );
  if (type === MsgType.IMAGE) return text ? `[图片] ${text}` : '[图片]';
  if (type === MsgType.VIDEO) return '[视频]';
  if (type === MsgType.CARD) return text ? `[卡片] ${text}` : '[卡片]';
  if (type === MsgType.EVENT) return `[事件] ${pick(raw, 'event', 'event_type') || ''}`;
  return String(text || '');
}

/**
 * 小红书 webhook 报文 → 统一 Message
 *
 * 小红书一次推送可能是数组，外面调用方需先拆开逐条传入。
 *
 * @param {Object} raw
 * @param {Object} [opts]
 * @param {(userId:string)=>Promise<{name?:string}>} [opts.resolveUser]
 */
export async function fromXhs(raw, opts = {}) {
  // 小红书用 event 类型标记「我方发出」，需要区分方向
  const rawDirection = String(pick(raw, 'direction', 'msg_direction', 'sender_type') || '').toLowerCase();
  const isOutbound =
    rawDirection.includes('out') ||
    rawDirection.includes('self') ||
    rawDirection.includes('shop') ||
    rawDirection === 'seller' ||
    rawDirection === '2';

  const fromUserId = pick(raw, 'from_user_id', 'sender_id', 'user_id', 'from.account_id') || '';
  const toUserId = pick(raw, 'to_user_id', 'receiver_id', 'to.account_id') || '';
  const senderId = isOutbound ? `agent:${fromUserId || 'self'}` : fromUserId;

  let senderName = '';
  if (!isOutbound && opts.resolveUser && fromUserId) {
    try {
      const u = await opts.resolveUser(fromUserId);
      senderName = u?.name || '';
    } catch {
      // ignore
    }
  }

  const tsRaw = pick(raw, 'timestamp', 'create_time', 'msg_time', 'send_time');
  // 兼容秒/毫秒
  let ts = Number(tsRaw || 0);
  if (ts && ts < 1e12) ts *= 1000;
  if (!ts) ts = Date.now();

  const conversationId = pick(raw, 'session_id', 'conversation_id', 'chat_id', 'session.id');
  const msgType = mapMsgType(pick(raw, 'msg_type', 'type', 'message_type'));

  return createMessage({
    id: `${Platform.XHS}:${pick(raw, 'msg_id', 'message_id', 'id') || `${senderId}:${ts}`}`,
    platform: Platform.XHS,
    conversation_id: `xhs:${conversationId || fromUserId || toUserId || 'unknown'}`,
    sender_id: senderId,
    sender_name: senderName || (isOutbound ? '我方客服' : ''),
    direction: isOutbound ? Direction.OUTBOUND : Direction.INBOUND,
    msg_type: msgType,
    content: extractContent(raw),
    timestamp: ts,
    is_group: false, // 小红书私信本质是单聊
    raw,
  });
}

/**
 * 把小红书 webhook 请求体规范化成消息数组。
 * 兼容 {data:[...]} / {messages:[...]} / 裸数组 / 单对象 四种形态。
 * @returns {Object[]}
 */
export function normalizeWebhookBody(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const key of ['data', 'messages', 'msg_list', 'events']) {
    if (Array.isArray(body[key])) return body[key];
    if (body[key] && typeof body[key] === 'object') return [body[key]];
  }
  return [body];
}
