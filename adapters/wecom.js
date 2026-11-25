/**
 * 企业微信适配器
 *
 * 支持两种来源：
 * 1. 自建应用回调（wecom）—— 内部成员在应用里发消息
 * 2. 智能机器人回调（wecombot）—— 群聊/单聊都能触发，也支持 WS 长连接
 *
 * 两者的回调报文结构基本一致，这里做统一转换。
 *
 * 关键点：企业微信的「我方回复」不会出现在回调报文里——
 * 回调只推客户发给我们的消息。所以要做 QA 配对，必须自己记录
 * 我们发出去的每条消息（见 recordOutbound）。
 */
import { Platform, Direction, MsgType, createMessage } from '../collector/message.js';

/** 企业微信 MsgType → 统一 MsgType */
function mapMsgType(t) {
  switch (t) {
    case 'text':
      return MsgType.TEXT;
    case 'image':
      return MsgType.IMAGE;
    case 'voice':
      return MsgType.VOICE;
    case 'video':
      return MsgType.VIDEO;
    case 'file':
      return MsgType.FILE;
    case 'event':
      return MsgType.EVENT;
    default:
      return MsgType.TEXT;
  }
}

/** 从原始报文提取可读文本 */
function extractContent(raw) {
  switch (raw.MsgType) {
    case 'text':
      return raw.Content || '';
    case 'voice':
      return raw.Recognition || ''; // 企业微信语音转文字
    case 'image':
      return '[图片]';
    case 'video':
      return '[视频]';
    case 'file':
      return `[文件] ${raw.FileName || ''}`.trim();
    case 'event':
      return `[事件] ${raw.Event || ''}`;
    default:
      return '';
  }
}

/**
 * 把企业微信回调报文转成统一 Message
 * @param {Object} raw 解析后的回调 XML 对象
 * @param {Object} [opts]
 * @param {string} [opts.platform] 默认 wecom，可传 wecom_cs
 * @param {(userid:string)=>Promise<{name?:string}>} [opts.resolveUser] 查成员姓名
 * @returns {Promise<import('../collector/message.js').Message>}
 */
export async function fromWecom(raw, opts = {}) {
  const platform = opts.platform || Platform.WECOM;
  const isGroup = Boolean(raw.ChatId && raw.ChatId !== raw.FromUserName);

  let senderName = '';
  if (opts.resolveUser && raw.FromUserName) {
    try {
      const u = await opts.resolveUser(raw.FromUserName);
      senderName = u?.name || '';
    } catch {
      // 查不到就用空，不影响归档
    }
  }

  const msgType = mapMsgType(raw.MsgType);

  return createMessage({
    id: `${platform}:${raw.MsgId || `${raw.FromUserName}:${raw.CreateTime}`}`,
    platform,
    // 单聊按对方 userid 分会话，群聊按 chatid
    conversation_id: isGroup ? `group:${raw.ChatId}` : `user:${raw.FromUserName}`,
    sender_id: raw.FromUserName || '',
    sender_name: senderName,
    direction: Direction.INBOUND,
    msg_type: msgType,
    content: extractContent(raw),
    // 企业微信 CreateTime 是秒
    timestamp: Number(raw.CreateTime || 0) * 1000 || Date.now(),
    is_group: isGroup,
    raw,
  });
}

/**
 * 记录「我方发出」的消息。
 *
 * 这是配对 QA 的关键一环：企业微信不会把我们的回复回调给我们，
 * 所以每次调用发消息 API 成功后，必须主动落库，否则永远配不出答案。
 *
 * @param {string} toUser 接收人 userid
 * @param {string} content 发出的文本
 * @param {Object} [opts]
 * @param {boolean} [opts.isGroup]
 * @param {string} [opts.chatId]
 * @param {string} [opts.agentId]
 */
export function recordOutbound(toUser, content, opts = {}) {
  const platform = opts.platform || Platform.WECOM;
  const now = Date.now();
  return createMessage({
    id: `${platform}:out:${now}:${Math.random().toString(36).slice(2, 8)}`,
    platform,
    conversation_id: opts.isGroup ? `group:${opts.chatId}` : `user:${toUser}`,
    sender_id: `agent:${opts.agentId || 'self'}`,
    sender_name: '我方客服',
    direction: Direction.OUTBOUND,
    msg_type: MsgType.TEXT,
    content,
    timestamp: now,
    is_group: Boolean(opts.isGroup),
    meta: { agentId: opts.agentId },
  });
}
