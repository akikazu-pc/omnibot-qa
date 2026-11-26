/**
 * 回复决策：把「客户说了什么」翻译成「该回什么」
 *
 * 为什么要抽出来：
 *   三个渠道（企微智能机器人 / 微信客服 / 通用入口）需要完全一致的行为，
 *   以前这段逻辑埋在 server.js 的 handleBotMessage 里，只有一条路能用。
 *   抽成独立模块后，任何渠道调用 decide() 都能拿到同样的三层递进：
 *
 *     1. 问价 → 价格页（website 价格只维护一份，机器人不复述数字）
 *     2. 话术库 → 原样直发（一字不差，零延迟零成本，不需要 API Key）
 *     3. 模型 → 模仿你说话（需要 OPENAI_API_KEY）
 *
 * 关键约束：这一层**只做决策，不发送**。
 * 各渠道的发送方式完全不同（卡片 / markdown / 纯文本），留给调用方处理。
 */

/**
 * @typedef {Object} DecideResult
 * @property {'price'|'snippet'|'llm'|'none'} kind  走了哪条路
 * @property {string} text                     要回复的正文
 * @property {Object} [price]                  问价时的详情（含 card/url）
 * @property {string} [snippetId]             命中的话术 id
 * @property {string[]} [references]           模型引用的知识条目
 * @property {number} [usedStyle]              用了多少条风格样本
 * @property {string} [reason]                 没回复的原因
 */

/**
 * @param {Object} p
 * @param {string} p.content           客户原文
 * @param {string} [p.lang]            强制指定语言（不传则自动识别）
 * @param {boolean} [p.enablePrice]    是否启用价格页路由
 * @param {Array}  [p.snippets]        话术库
 * @param {Object} [p.knowledge]       知识库条目
 * @param {Array}  [p.styleMessages]   风格样本
 * @param {string} [p.persona]
 * @param {string} [p.business]
 * @param {Function} [p.generate]      注入的生成函数（便于测试）
 * @param {Function} [p.isLlmReady]    判断模型是否可用
 * @param {Array}  [p.history]         历史对话
 * @returns {Promise<DecideResult>}
 */
export async function decide({
  content,
  lang,
  enablePrice = true,
  snippets = [],
  knowledge = [],
  styleMessages = [],
  persona,
  business,
  generate,
  isLlmReady,
  history = [],
} = {}) {
  const text = String(content || '').trim();
  if (!text) return { kind: 'none', text: '', reason: 'empty' };

  // ── 第一层：问价 → 价格页 ──────────────────────────
  // 放最前面：价格只在网站上维护一份。
  // 机器人复述数字必然会和网站对不上，改了网站忘了改话术是最常见的翻车方式。
  if (enablePrice) {
    const { buildPriceReply } = await import('./price-reply.js');
    const price = buildPriceReply(text, lang ? { lang } : undefined);
    if (price) {
      return {
        kind: 'price',
        text: price.plain,
        price,
        references: [],
        usedStyle: 0,
      };
    }
  }

  // ── 第二层：话术库 → 原样直发 ─────────────────────
  // 发票、试用、联系方式这类必须一字不差，绝不能让模型改写。
  const { matchSnippet } = await import('./snippets.js');
  const hit = matchSnippet(text, snippets);
  if (hit) {
    return {
      kind: 'snippet',
      text: hit.reply,
      snippetId: hit.id,
      references: [],
      usedStyle: 0,
    };
  }

  // ── 第三层：模型 ──────────────────────────────────
  if (isLlmReady && !isLlmReady()) {
    return { kind: 'none', text: '', reason: 'llm-not-configured', references: [], usedStyle: 0 };
  }
  if (!generate) {
    return { kind: 'none', text: '', reason: 'no-generator', references: [], usedStyle: 0 };
  }

  try {
    const gen = await generate({
      question: text,
      history,
      knowledge,
      styleMessages,
      persona,
      business,
    });

    // 没有依据时 AI 只会说「这个我确认下再回复您」。
    // 这对机器人是噪音：既没帮上客户，又占了一条回复，还让人误以为是真人接手了。
    // 所以没有引用就干脆不吭声，留给人工。
    if (!gen.references || !gen.references.length) {
      return {
        kind: 'none',
        text: '',
        reason: 'no-knowledge-hit',
        references: [],
        usedStyle: gen.usedStyle || 0,
      };
    }

    return {
      kind: 'llm',
      text: gen.text,
      references: gen.references,
      usedStyle: gen.usedStyle || 0,
    };
  } catch (err) {
    return {
      kind: 'none',
      text: '',
      reason: `generate-failed: ${err.message}`,
      references: [],
      usedStyle: 0,
    };
  }
}
