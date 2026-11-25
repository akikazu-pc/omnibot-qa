/**
 * 客服回复代理
 *
 * 目标：让 AI 用「我们自己人的说话方式」回答客户。
 *
 * 三件事拼出回复：
 * 1. 人设（system prompt）+ 业务背景
 * 2. 检索到的历史 QA（已审核的，作为事实依据）
 * 3. 人工回复风格样本（从历史 outbound 消息里挑出来的真实句子）
 *
 * 风格样本是整个系统的灵魂：不是让模型「 impersonate 」，
 * 而是把真实回复作为 few-shot 示例，模型自然学会语气、长度、口头禅。
 */
import { chat, isLlmConfigured } from '../llm/provider.js';
import { search } from './knowledge.js';
import { Direction, isPairableText } from '../collector/message.js';

const DEFAULT_PERSONA = '你是公司的一线客服，负责解答客户咨询。';

/**
 * 从历史消息里挑出「我方回复」作为风格样本。
 *
 * 挑选原则：长度适中（太短没信息，太长不适合当示例）、去重、优先最近的。
 *
 * @param {Array} messages 消息列表（任意会话，direction=outbound）
 * @param {Object} [opts]
 * @param {number} [opts.limit=8]
 * @param {number} [opts.minLen=4]
 * @param {number} [opts.maxLen=200]
 * @returns {string[]}
 */
export function collectStyleSamples(messages, opts = {}) {
  const { limit = 8, minLen = 4, maxLen = 200 } = opts;

  const seen = new Set();
  const picked = [];

  const sorted = [...(messages || [])].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  for (const m of sorted) {
    if (m.direction !== Direction.OUTBOUND) continue;
    if (!isPairableText(m)) continue;
    const text = String(m.content || '').trim();
    if (text.length < minLen || text.length > maxLen) continue;

    // 去掉模板化痕迹过重的（纯链接、纯数字）
    if (/^https?:\/\//.test(text)) continue;

    const key = text.slice(0, 30);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(text);
    if (picked.length >= limit) break;
  }

  // 反转为「时间正序」，读起来更自然
  return picked.reverse();
}

/**
 * 组装 system prompt。
 *
 * @param {Object} ctx
 * @param {string} [ctx.persona]        人设描述
 * @param {string} [ctx.business]       业务背景（卖什么、政策等）
 * @param {Array}  [ctx.references]     检索到的 QA
 * @param {string[]} [ctx.styleSamples] 风格样本
 * @returns {string}
 */
export function buildSystemPrompt(ctx = {}) {
  const { persona = DEFAULT_PERSONA, business = '', references = [], styleSamples = [] } = ctx;

  const parts = [persona];

  if (business) {
    parts.push(`\n## 业务背景\n${business}`);
  }

  if (references.length) {
    const list = references
      .map((r, i) => `${i + 1}. 客户问：${r.doc.question}\n   我们答：${r.doc.answer}`)
      .join('\n');
    parts.push(`\n## 过往真实问答（优先采信，不要编造与之矛盾的内容）\n${list}`);
  }

  if (styleSamples.length) {
    const list = styleSamples.map((s) => `- ${s}`).join('\n');
    parts.push(`\n## 你的说话风格（模仿这些真实回复的语气、长度和用词）\n${list}`);
  }

  parts.push(`
## 回复要求
1. 直接给答案，不要复述客户的问题，不要说"您好，关于您的问题"这类套话。
2. 长度贴近上面的风格样本，通常 1-3 句，不要长篇大论。
3. 只用上面提供的问答和业务背景里的事实；没把握的不要编，直接说"这个我确认下再回复您"。
4. 不要暴露你是 AI，不要提及"知识库""参考文档"这类内部概念。
5. 不要输出 Markdown 标题、加粗等格式，就用自然的口语文本。`);

  return parts.join('\n');
}

/**
 * 生成一条客服回复。
 *
 * @param {Object} params
 * @param {string} params.question 客户当前提问
 * @param {Array}  [params.history] 该会话的历史消息（用于上下文）
 * @param {Array}  [params.knowledge] 已审核 QA 全集（用于检索）
 * @param {Array}  [params.styleMessages] 历史消息全集（用于抽风格样本）
 * @param {string} [params.persona]
 * @param {string} [params.business]
 * @param {Object} [params.llmConfig] 覆盖 LLM 配置
 * @param {Function} [params.fetchImpl] 测试注入
 * @returns {Promise<{text:string, references:Array, usedStyle:number, usage:Object|null}>}
 */
export async function generateReply(params) {
  const {
    question,
    history = [],
    knowledge = [],
    styleMessages = [],
    persona = DEFAULT_PERSONA,
    business = '',
    llmConfig,
    fetchImpl,
  } = params;

  const references = search(question, knowledge, { topK: 3, minScore: 0.5 });
  const styleSamples = collectStyleSamples(styleMessages, { limit: 8 });

  const system = buildSystemPrompt({ persona, business, references, styleSamples });

  // 带上最近几轮对话，保证多轮追问能接住
  const recent = history
    .filter((m) => isPairableText(m))
    .slice(-6)
    .map((m) => ({
      role: m.direction === Direction.INBOUND ? 'user' : 'assistant',
      content: m.content,
    }));

  // 最后一条必须是当前问题（避免历史里已含当前问题导致重复）
  const last = recent[recent.length - 1];
  if (!last || last.content !== question) {
    recent.push({ role: 'user', content: question });
  }

  const messages = [{ role: 'system', content: system }, ...recent];

  const result = await chat(messages, { config: llmConfig, fetchImpl });

  return {
    text: result.text,
    references,
    usedStyle: styleSamples.length,
    usage: result.usage,
  };
}

export { isLlmConfigured };
