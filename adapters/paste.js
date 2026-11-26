/**
 * 聊天记录粘贴导入解析器
 *
 * 为什么需要它：
 *   「客户扫码加我企微好友」这个场景下，客户发消息、我回消息，
 *   官方 API 都不会推给我们（会话存档需付费）。但你可以直接在
 *   企业微信里全选复制聊天记录，粘贴进来 —— 这是零门槛的兜底路径。
 *
 * 支持两种常见粘贴格式：
 *
 * 【格式 A：企业微信/微信客户端复制格式】
 *   张三 10:23
 *   你们支持私有化部署吗
 *
 *   我 10:25
 *   支持，可以装到你们自己服务器上
 *
 * 【格式 B：带日期分隔的完整格式】
 *   2026-11-20 10:23
 *   张三
 *   你们支持私有化部署吗
 *
 * 解析策略：
 *   1. 按「说话人 + 时间」切分成块，块内其余行是内容
 *   2. 时间只给 HH:mm 时，补上当天日期；跨天用日期分隔行更新
 *   3. 「我」/「本人」/自定义我方昵称 → OUTBOUND，其余 → INBOUND
 *   4. 无时间戳的连续行归到上一块（多行消息）
 */

import { Platform, Direction, MsgType, createMessage } from '../collector/message.js';

/** 一天毫秒数 */
const DAY = 86400000;

/**
 * 判断一行是不是「说话人 + 时间」的头行。
 * 形如：`张三 10:23`、`张三 2026-11-20 10:23`、`10:23 张三`
 * @param {string} line
 */
export function matchHeader(line) {
  const t = line.trim();
  if (!t || t.length > 60) return null;

  // 形如 张三 10:23  或  张三 2026-11-20 10:23
  let m = t.match(/^(.{1,24}?)\s+(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s+)?(\d{1,2}:\d{2})(?::\d{2})?$/);
  if (m) return { name: m[1].trim(), date: (m[2] || '').trim(), time: m[3] };

  // 形如 10:23 张三
  m = t.match(/^(?:(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s+)?(\d{1,2}:\d{2})(?::\d{2})?\s+(.{1,24})$/);
  if (m) return { name: m[3].trim(), date: (m[1] || '').trim(), time: m[2] };

  return null;
}

/**
 * 判断一行是不是纯日期分隔行。形如 `2026年11月20日 10:23` 或 `2026-11-20`
 * @param {string} line
 */
export function matchDateLine(line) {
  const t = line.trim();
  const m = t.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(\s+\d{1,2}:\d{2})?$/);
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3], time: m[4]?.trim() || '' };
}

/**
 * 把 HH:mm 转成毫秒时间戳。
 * @param {string} hhmm
 * @param {number} [baseDayTs] 基准日的 00:00 时间戳
 */
export function timeToTs(hhmm, baseDayTs = startOfDay(Date.now())) {
  const [h, mi] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(mi)) return baseDayTs;
  return baseDayTs + h * 3600000 + mi * 60000;
}

/** 取某时间戳当天 00:00 */
export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 解析日期行为 00:00 时间戳 */
export function dateToTs({ year, month, day }) {
  const d = new Date(year, month - 1, day, 0, 0, 0, 0);
  return d.getTime();
}

/**
 * 判断某个说话人是否代表「我方」。
 * @param {string} name
 * @param {string[]} selfNames
 */
export function isSelfSpeaker(name, selfNames = ['我', '本人', '自己']) {
  const n = String(name || '').trim();
  return selfNames.some((s) => s && (n === s || n.includes(s)));
}

/**
 * 解析粘贴的聊天记录文本。
 *
 * @param {string} text 粘贴内容
 * @param {Object} [opts]
 * @param {string} [opts.selfName] 我方在记录里显示的昵称，如「小王」「客服-李雷」
 * @param {string} [opts.customerName] 客户显示名，不传则取第一个非我方说话人
 * @param {number} [opts.baseTs] 无日期信息时的基准时间，默认今天
 * @param {string[]} [opts.selfAliases] 我方别名列表
 * @returns {{messages: Array, speakers: string[], customer: string, self: string, warnings: string[]}}
 */
export function parsePastedChat(text, opts = {}) {
  const {
    selfName = '',
    customerName = '',
    baseTs = Date.now(),
    selfAliases = ['我', '本人', '自己'],
  } = opts;

  const aliases = [...new Set([...selfAliases, selfName].filter(Boolean))];
  const warnings = [];
  const blocks = [];

  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let currentDayTs = startOfDay(baseTs);
  let cur = null;

  const flush = () => {
    if (!cur) return;
    const content = cur.lines.join('\n').trim();
    if (content) blocks.push({ ...cur, content });
    cur = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\u00a0/g, ' ');
    const trimmed = line.trim();

    // 空行：属于内容分隔，保留在块内
    if (!trimmed) {
      if (cur) cur.lines.push('');
      continue;
    }

    // 日期分隔行：更新基准日
    const dl = matchDateLine(trimmed);
    if (dl) {
      currentDayTs = dateToTs(dl);
      flush();
      continue;
    }

    // 说话人 + 时间
    const h = matchHeader(trimmed);
    if (h) {
      flush();
      if (h.date) {
        const d = h.date.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
        if (d) currentDayTs = dateToTs({ year: +d[1], month: +d[2], day: +d[3] });
      }
      cur = {
        name: h.name,
        lines: [],
        ts: timeToTs(h.time, currentDayTs),
      };
      continue;
    }

    if (cur) {
      cur.lines.push(trimmed);
    } else {
      // 文档开头的寒暄/标题等，忽略但提示
      warnings.push(`跳过无法归属的行：${trimmed.slice(0, 30)}`);
    }
  }
  flush();

  if (!blocks.length) {
    return { messages: [], speakers: [], customer: '', self: '', warnings: ['没有解析出任何消息'] };
  }

  // 识别说话人
  const speakerSet = [...new Set(blocks.map((b) => b.name))];
  const selfSpeaker = speakerSet.find((n) => isSelfSpeaker(n, aliases)) || '';
  const customer =
    customerName ||
    speakerSet.find((n) => n !== selfSpeaker) ||
    '客户';

  if (!selfSpeaker) {
    warnings.push('没识别出「我方」说话人，请用 --self 指定你在记录里的显示名');
  }

  // 时间递增修正：同一分钟内多条消息时，按顺序补毫秒，避免排序错乱
  let lastTs = 0;
  const messages = blocks.map((b, i) => {
    const isSelf = selfSpeaker ? b.name === selfSpeaker : false;
    const direction = isSelf ? Direction.OUTBOUND : Direction.INBOUND;
    let ts = b.ts;
    if (ts <= lastTs) ts = lastTs + 1000;
    lastTs = ts;

    return createMessage({
      id: `${Platform.PASTE}:${customer}:${ts}:${i}`,
      platform: Platform.PASTE,
      conversation_id: `paste:${customer}`,
      sender_id: isSelf ? 'agent:self' : `customer:${b.name}`,
      sender_name: b.name,
      direction,
      msg_type: MsgType.TEXT,
      content: b.content,
      timestamp: ts,
      is_group: false,
      meta: { importedAt: Date.now(), source: 'paste' },
    });
  });

  return { messages, speakers: speakerSet, customer, self: selfSpeaker, warnings };
}

/**
 * 把解析结果批量写入 store。
 * @param {Object} store Store 实例
 * @param {Array} messages
 * @returns {{added: number, skipped: number}}
 */
export function importMessages(store, messages) {
  let added = 0;
  let skipped = 0;
  for (const m of messages) {
    if (store.insertMessage(m)) added += 1;
    else skipped += 1;
  }
  return { added, skipped };
}
