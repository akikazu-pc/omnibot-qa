/**
 * QA 配对引擎
 *
 * 核心逻辑：在同一个会话里，找「客户问」→「我方答」的相邻对。
 *
 * 配对规则：
 * 1. 从 inbound 消息开始，向后找最近的一条 outbound 消息作为答案
 * 2. 两条消息时间间隔不超过 MAX_GAP_MS（默认 30 分钟），超时视为不相关
 * 3. 答案之前如果客户又追问了，取最后一个问题（客户最后问的那个才是真正被回答的）
 * 4. 中间插入的其它 inbound（客户的补充说明）会被合并进问题
 * 5. 带疑问词但仍未配对的问题，标记为「未回答」，这是最宝贵的数据——
 *    说明知识库还缺这块内容
 */
import { Direction, MsgType, isPairableText } from '../collector/message.js';

const MAX_GAP_MS = 30 * 60 * 1000;

/**
 * 从一段按时间升序的消息里配对 QA
 * @param {Array} messages 同一会话的消息，时间升序
 * @returns {{pairs: Array, unanswered: Array}}
 */
export function pairConversation(messages) {
  const pairs = [];
  const unanswered = [];
  const used = new Set();

  for (let i = 0; i < messages.length; i++) {
    const q = messages[i];
    if (used.has(i)) continue;
    if (!isPairableText(q) || q.direction !== Direction.INBOUND) continue;

    // 向后找答案
    let answerIdx = -1;
    let lastQuestionIdx = i;

    for (let j = i + 1; j < messages.length; j++) {
      const m = messages[j];
      if (!isPairableText(m)) continue;
      if (m.timestamp - q.timestamp > MAX_GAP_MS) break;

      if (m.direction === Direction.OUTBOUND) {
        answerIdx = j;
        break;
      }
      // 客户又补充/追问了，把问题往后推
      if (m.direction === Direction.INBOUND) {
        lastQuestionIdx = j;
      }
    }

    if (answerIdx === -1) {
      // 问到一半没人答，或超时无响应
      const questionText = mergeQuestions(messages, i, messages.length).text;
      unanswered.push({
        platform: q.platform,
        conversation_id: q.conversation_id,
        question: questionText,
        asked_at: q.timestamp,
        question_msg_id: q.id,
        sender_id: q.sender_id,
        sender_name: q.sender_name,
        is_group: q.is_group,
      });
      used.add(i);
      continue;
    }

    // 把 i..lastQuestionIdx 之间所有客户消息合并成一个问题
    const qMerge = mergeQuestions(messages, i, lastQuestionIdx);
    const a = messages[answerIdx];

    pairs.push({
      platform: q.platform,
      conversation_id: q.conversation_id,
      question: qMerge.text,
      answer: a.content,
      question_msg_id: q.id,
      answer_msg_id: a.id,
      asked_at: qMerge.firstTime,
      answered_at: a.timestamp,
      status: 'pending',
    });

    // 标记已消费
    for (let k = i; k <= lastQuestionIdx; k++) used.add(k);
    used.add(answerIdx);
    i = answerIdx;
  }

  return { pairs, unanswered };
}

/** 合并 [from..to] 区间内的客户消息为一个问题文本 */
function mergeQuestions(messages, from, to) {
  const parts = [];
  let firstTime = messages[from].timestamp;
  for (let k = from; k <= to && k < messages.length; k++) {
    const m = messages[k];
    if (m.direction !== Direction.INBOUND) continue;
    if (!isPairableText(m)) continue;
    parts.push(m.content);
  }
  return {
    text: dedupeJoin(parts),
    firstTime,
  };
}

/** 去掉相邻重复片段后拼接（客户常连发两三条相似的话） */
function dedupeJoin(parts) {
  const out = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if (out.length && (out[out.length - 1].includes(t) || t.includes(out[out.length - 1]))) {
      // 有包含关系就保留更长的那个
      if (t.length > out[out.length - 1].length) out[out.length - 1] = t;
      continue;
    }
    out.push(t);
  }
  return out.join(' ');
}

/**
 * 从 Store 里扫全量会话做配对
 * @param {import('./store.js').Store} store
 */
export function pairAll(store) {
  const convs = store.db
    .prepare('SELECT DISTINCT platform, conversation_id FROM messages')
    .all();

  let totalPairs = 0;
  let totalUnanswered = 0;

  for (const c of convs) {
    const msgs = store.getConversation(c.platform, c.conversation_id, { limit: 5000 });
    const { pairs, unanswered } = pairConversation(msgs);
    for (const p of pairs) {
      if (store.saveQaPair(p)) totalPairs++;
    }
    totalUnanswered += unanswered.length;
  }

  return { newPairs: totalPairs, unanswered: totalUnanswered, conversations: convs.length };
}

/** 从文本判断是否像客服提问（用于筛选高价值未答问题） */
const QUESTION_HINTS = ['?', '？', '怎么', '如何', '多少', '什么', '可以', '能否', '是否', '有没有', '在哪', '为什么', '多久', '价格', '多少钱', '怎样'];

export function looksLikeQuestion(text) {
  if (!text) return false;
  return QUESTION_HINTS.some((h) => text.includes(h));
}
