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
      .map((r, i) => {
        // 只有人工审核过的答案才能当事实；pending 只能当「参考说法」，
        // 否则自己都没确认的话会被 AI 反复复制放大
        const tag = r.doc.status === 'approved' ? '已确认' : '未审核';
        return `${i + 1}. [${tag}] 客户问：${r.doc.question}\n   我们答：${r.doc.answer}`;
      })
      .join('\n');
    parts.push(`\n## 过往真实问答（这是你唯一可信的事实来源，优先采信）\n${list}`);
  } else {
    parts.push(`\n## 过往真实问答\n（本次没有检索到相关问答，你没有任何可依据的事实）`);
  }

  if (styleSamples.length) {
    const list = styleSamples.map((s) => `- ${s}`).join('\n');
    parts.push(`\n## 你的说话风格（只学语气和长度，不要把样本内容当答案）\n${list}`);
  }

  parts.push(`
## 回复要求
1. 直接给答案，不要复述客户的问题，不要说"您好，关于您的问题"这类套话。
2. 长度贴近上面的风格样本，通常 1-3 句，不要长篇大论。
3. 事实来源只有两处：上面的「过往真实问答」和「业务背景」。除此之外一律视为不知道。
4. 如果客户问的内容在上面找不到依据（比如问老板名字、问未提及的政策、问具体报价），
   必须只回一句"这个我确认下再回复您"，禁止猜测、禁止用风格样本里的内容充当答案。
5. 不要把上一个问题的答案套用到当前问题上，每个问题独立判断有没有依据。
6. 标注「未审核」的问答只能给你参考，如果里面含具体承诺、价格、时间，要先核实再答。
7. 不要暴露你是 AI，不要提及"知识库""参考文档"这类内部概念。
8. 不要输出 Markdown 标题、加粗等格式，就用自然的口语文本。`);

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

  const references = search(question, knowledge, { topK: 3, minScore: 1.2 });
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
