/**
 * 话术库（快捷回复 + 卡片）
 *
 * 解决什么问题：
 *   有些回复不适合让 AI 自由发挥 —— 报价、退换货政策、合同条款。
 *   这类内容必须**一字不差**，AI 一改写就可能变成承诺，将来是要担责任的。
 *
 *   所以这里做两件事：
 *   1. 关键词命中 → 直接回固定话术（不经过模型，零延迟、零成本、零幻觉）
 *   2. 话术可以是纯文本，也可以是多行卡片（见 qa/card.js）
 *
 * 匹配规则刻意做得简单保守：
 *   - 必须是「问句」才触发，避免客户随口一句「价格好贵」也被当成问价
 *   - 支持排除词，比如「报价单模板」不该触发我们的报价
 *   - 命中多条时取 priority 最高的，其次取匹配词最多的
 */

/**
 * @typedef {Object} Snippet
 * @property {string} id            唯一标识
 * @property {string[]} keywords    触发词（任一命中即可）
 * @property {string[]} [exclude]   排除词（命中任一则跳过）
 * @property {string[]} [negative]  负面词（客户在嫌贵/比价时不要甩价格表）
 * @property {string} reply         回复内容（纯文本或卡片文本）
 * @property {boolean} [requireQuestion=true] 是否要求原句像问句
 * @property {number} [priority=0]  优先级，大的先命中
 * @property {string} [label]       人类可读名字（日志/后台用）
 */

/**
 * 语义判负：这句话表达的是「嫌贵 / 比价 / 便宜点」，而不是「问价格」。
 *
 * 为什么要单独一层：
 *   「这个有点贵」「太贵了」在语形上是感叹，但「价格好高」「贵不贵」带疑问词，
 *   looksLikeAsk 照样判成问句。这时候甩一张价格表给客户，只会让人更不爽。
 *   所以只要出现抱怨/议价的词，就一律不触发报价。
 */
const PRICE_COMPLAINT = /(太贵|好贵|有点贵|贵了|贵啊|贵呀|很贵|真贵|挺贵|不便宜|便宜点|便宜些|能便宜|打折|优惠点|划算|值不值|性价比|预算不够|超预算|别家|同行|比价|嫌贵|降点价|降降价|价格高|价钱高|价高|好高|太高|高了)/;

/** 寒暄/答复类动词，不构成提问（「你好」「在吗」「谢谢」） */
const GREETING_PATTERNS = [/^(你好|您好|hi|hello|在吗|在么|在不在|有人吗|谢谢|多谢|好的|好|ok|嗯|收到)[呀啊呢哈！!。.~～]*$/i];

/** 问句特征：问号，或者「多少钱/怎么/是否/能不能」这类疑问词 */
const QUESTION_HINTS = [
  '?', '？',
  '多少', '几块', '几个钱', '什么价', '咋卖', '怎么卖', '怎么收费', '如何收费',
  '报价', '价格', '费用', '钱', '贵不贵', '便宜', '折扣', '优惠',
  '是不是', '有没有', '能不能', '可不可以', '要不要', '支持不支持', '能否', '是否',
  '怎么', '如何', '哪些', '哪种', '多久', '几天',
  // 单字疑问词：「能开票吗」「要专票」这类不带「怎么/多少」的问法
  '能', '可以', '有', '会', '要', '想',
  // 「叫什么」「是谁」「哪家」也是提问，虽然只是闲聊，但同样属于「问句」，
  // 让闲聊类话术（如「介绍一下自己」）也能命中
  '叫什么', '是谁', '哪家', '干什么',
];

/**
 * 判断一句话是不是在提问。
 *
 * 注意不能只看问号 —— 微信里绝大多数提问都不带问号。
 * 但也不能只看关键词 —— 「你好」「在吗」带「吗」却不是问题，
 * 所以先排掉寒暄/应答。
 *
 * @param {string} text
 * @returns {boolean}
 */
/**
 * 判断一句话是不是在提问。
 *
 * 注意不能只看问号 —— 微信里绝大多数提问都不带问号。
 * 但也不能只看关键词 —— 「你好」「在吗」带「吗」却不是问题，
 * 所以先排掉寒暄/应答。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeAsk(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (GREETING_PATTERNS.some((re) => re.test(s))) return false;
  return QUESTION_HINTS.some((h) => s.includes(h));
}

/**
 * 是不是在抱怨价格 / 议价。
 * @param {string} text
 * @returns {boolean}
 */
export function isPriceComplaint(text) {
  return PRICE_COMPLAINT.test(String(text || ''));
}

/**
 * 在一句话里找命中的话术。
 *
 * @param {string} text 客户说的话
 * @param {Snippet[]} snippets 话术库
 * @param {Object} [opts]
 * @param {boolean} [opts.requireQuestion=true]
 * @returns {Snippet|null}
 */
export function matchSnippet(text, snippets = [], opts = {}) {
  const { requireQuestion = true } = opts;
  const s = String(text || '').trim();
  if (!s) return null;

  const hits = [];
  for (const sn of snippets) {
    if (!sn || !sn.reply) continue;

    // 排除词优先：命中就完全跳过这条
    if ((sn.exclude || []).some((w) => w && s.includes(w))) continue;

    const matched = (sn.keywords || []).filter((k) => k && s.includes(k));
    if (!matched.length) continue;

    // 单条话术可以放宽问句要求（如寒暄、致谢这类固定回复）
    const needAsk = sn.requireQuestion === undefined ? requireQuestion : sn.requireQuestion;
    if (needAsk && !looksLikeAsk(s)) continue;

    // 负面词：客户是在嫌贵/比价，不是在问价，回价格表只会让人更不爽
    if (sn.negative && sn.negative.some((w) => w && s.includes(w))) continue;
    // 报价类话术额外兜一层语义判断（「价格好高」「能便宜点吗」）
    if (sn.id === 'price' && isPriceComplaint(s)) continue;

    hits.push({ snippet: sn, matched: matched.length, priority: Number(sn.priority) || 0 });
  }

  if (!hits.length) return null;

  // 先比优先级，再比命中词数，最后比关键词长度（越长越具体）
  hits.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.matched !== a.matched) return b.matched - a.matched;
    const la = Math.max(...(a.snippet.keywords || []).map((k) => k.length), 0);
    const lb = Math.max(...(b.snippet.keywords || []).map((k) => k.length), 0);
    return lb - la;
  });

  return hits[0].snippet;
}

/**
 * 校验话术库配置，返回问题清单（空数组表示没问题）。
 *
 * @param {Snippet[]} snippets
 * @returns {string[]}
 */
export function validateSnippets(snippets = []) {
  const problems = [];
  if (!Array.isArray(snippets)) return ['话术库必须是数组'];

  const seen = new Set();
  snippets.forEach((sn, i) => {
    const at = `第 ${i + 1} 条`;
    if (!sn || typeof sn !== 'object') {
      problems.push(`${at}：不是对象`);
      return;
    }
    if (!sn.id) problems.push(`${at}：缺 id`);
    else if (seen.has(sn.id)) problems.push(`${at}：id 重复 (${sn.id})`);
    else seen.add(sn.id);

    if (!Array.isArray(sn.keywords) || !sn.keywords.length) {
      problems.push(`${at}：keywords 至少要有一个词`);
    }
    if (!sn.reply || !String(sn.reply).trim()) {
      problems.push(`${at}：reply 不能为空`);
    }
  });

  return problems;
}
