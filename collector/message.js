/**
 * 统一消息模型
 *
 * 所有平台的原始消息（企业微信 / 小红书 / 抖音 / 飞书…）都归一化成 Message，
 * 下游的收集、QA 配对、知识库构建完全不感知平台差异。
 *
 * 设计原则：
 * 1. 平台私有字段一律放进 raw，不污染主结构
 * 2. direction 区分「客户问」和「我方答」，这是配对 QA 的唯一依据
 * 3. conversation_id 是会话主键，同一会话内的消息按 timestamp 排序即可配对
 */

/** 平台标识。新增平台只改这里。 */
export const Platform = Object.freeze({
  WECOM: 'wecom', // 企业微信（自建应用 / 智能机器人）
  WECOM_CS: 'wecom_cs', // 企业微信客服（外部客户）
  WECOM_AUDIT: 'wecom_audit', // 企业微信会话内容存档（外部客户私聊，需付费开通）
  PASTE: 'paste', // 手动粘贴/导入的聊天记录（无 API 时的兜底路径）
  XHS: 'xhs', // 小红书（聚光三方客服）
  DOUYIN: 'douyin', // 抖音（企业号私信）
  FEISHU: 'feishu',
  DINGTALK: 'dingtalk',
});

/**
 * 消息方向。
 * - INBOUND：对方发来的，通常是客户提问
 * - OUTBOUND：我方发出的，是「标准答案」的来源
 * - SYSTEM：入群提示、转接人工等系统事件，不参与 QA 配对
 */
export const Direction = Object.freeze({
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
  SYSTEM: 'system',
});

/** 内容类型 */
export const MsgType = Object.freeze({
  TEXT: 'text',
  IMAGE: 'image',
  FILE: 'file',
  VOICE: 'voice',
  VIDEO: 'video',
  CARD: 'card',
  EVENT: 'event',
});

/**
 * @typedef {Object} Message
 * @property {string} id            全局唯一 ID，建议 `${platform}:${platform_msg_id}`
 * @property {string} platform      Platform 枚举值
 * @property {string} conversation_id 会话 ID，同平台内唯一
 * @property {string} sender_id     发送者在该平台的唯一 ID
 * @property {string} [sender_name] 发送者昵称/姓名，便于人工审核时辨认
 * @property {string} direction     Direction 枚举值
 * @property {string} msg_type      MsgType 枚举值
 * @property {string} content       纯文本内容（voice 取转写，image/file 取描述或 URL）
 * @property {number} timestamp     Unix 毫秒时间戳
 * @property {boolean} is_group     是否群聊
 * @property {Object} [raw]         平台原始消息，保留用于追溯
 * @property {Object} [meta]        扩展元信息（标签、人工标记等）
 */

/**
 * 构造一条消息，补齐默认值并做基础校验。
 * @param {Partial<Message> & {platform: string, conversation_id: string, sender_id: string}} input
 * @returns {Message}
 */
export function createMessage(input) {
  const {
    platform,
    conversation_id,
    sender_id,
    id,
    sender_name = '',
    direction = Direction.INBOUND,
    msg_type = MsgType.TEXT,
    content = '',
    timestamp = Date.now(),
    is_group = false,
    raw,
    meta,
  } = input;

  if (!platform) throw new Error('Message.platform 必填');
  if (!conversation_id) throw new Error('Message.conversation_id 必填');
  if (!sender_id) throw new Error('Message.sender_id 必填');

  return {
    id: id || `${platform}:${conversation_id}:${timestamp}:${Math.random().toString(36).slice(2, 8)}`,
    platform,
    conversation_id,
    sender_id,
    sender_name,
    direction,
    msg_type,
    content: String(content || '').trim(),
    timestamp,
    is_group,
    ...(raw !== undefined ? { raw } : {}),
    ...(meta !== undefined ? { meta } : {}),
  };
}

/** 消息是否可用于 QA 配对（有实质文字内容、且非系统事件） */
export function isPairableText(msg) {
  if (!msg || msg.direction === Direction.SYSTEM) return false;
  if (msg.msg_type !== MsgType.TEXT) return false;
  return Boolean(msg.content && msg.content.length > 0);
}
