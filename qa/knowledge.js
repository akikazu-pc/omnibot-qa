/**
 * 知识库检索（零依赖 BM25）
 *
 * 数据来源就是本项目自己沉淀的 QA：已审核（approved）的 QA 对。
 * 不需要向量库、不需要 embedding 服务 —— 客服场景问题往往很短，
 * 关键词命中 + BM25 排序已经足够，而且完全可解释、可离线。
 *
 * 中文没有空格，这里做二元切分（bigram）：
 *   "支持私有化部署吗" → ["支持","持私","私有","有化","化部","部署","署吗"]
 * 英文/数字按词切分。这样无需分词词典，召回也够用。
 */

const STOPWORDS = new Set([
  '的', '了', '吗', '呢', '啊', '吧', '是', '在', '有', '和', '就', '都', '也', '还', '又',
  '你', '我', '他', '她', '它', '们', '这', '那', '个', '不', '要', '会', '能', '可以',
  'a', 'an', 'the', 'is', 'are', 'do', 'does', 'can', 'i', 'you', 'we', 'it', 'to', 'of',
]);

/**
 * 把文本切成检索单元。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];

  // 英文/数字：按非字母数字切词
  for (const w of s.match(/[a-z0-9][a-z0-9_.+-]*/g) || []) {
    if (w.length >= 2 && !STOPWORDS.has(w)) tokens.push(w);
  }

  // 中文：连续 CJK 段做 bigram，单字段保留单字
  const cjkRuns = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of cjkRuns) {
    const chars = [...run].filter((c) => !STOPWORDS.has(c));
    if (chars.length === 1) {
      tokens.push(chars[0]);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
  }

  return tokens;
}

/** 建索引：文档 = 一条 QA（问题和答案都参与） */
function buildIndex(docs) {
  const df = new Map(); // token -> 文档频次
  const docTokens = [];
  let totalLen = 0;

  for (const d of docs) {
    const tk = tokenize(`${d.question} ${d.answer}`);
    docTokens.push(tk);
    totalLen += tk.length;
    for (const t of new Set(tk)) df.set(t, (df.get(t) || 0) + 1);
  }

  return {
    docs,
    docTokens,
    df,
    avgLen: docs.length ? totalLen / docs.length : 0,
    n: docs.length,
  };
}

/**
 * BM25 打分检索。
 *
 * @param {string} query
 * @param {Array<{question:string, answer:string, [k:string]:any}>} docs
 * @param {Object} [opts]
 * @param {number} [opts.topK=3]
 * @param {number} [opts.minScore=0.5] 低于该分数视为不相关
 * @param {number} [opts.k1=1.5]
 * @param {number} [opts.b=0.75]
 * @returns {Array<{doc:Object, score:number}>}
 */
export function search(query, docs, opts = {}) {
  const { topK = 3, minScore = 0.5, k1 = 1.5, b = 0.75 } = opts;
  if (!docs || docs.length === 0) return [];

  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];

  const idx = buildIndex(docs);
  const qSet = [...new Set(qTokens)];
  const scored = [];

  for (let i = 0; i < idx.n; i++) {
    const tk = idx.docTokens[i];
    const len = tk.length || 1;
    const tf = new Map();
    for (const t of tk) tf.set(t, (tf.get(t) || 0) + 1);

    let score = 0;
    let hit = 0;
    for (const q of qSet) {
      const f = tf.get(q) || 0;
      if (f === 0) continue;
      hit++;
      const n = idx.df.get(q) || 0;
      const idf = Math.log(1 + (idx.n - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / (idx.avgLen || 1))));
    }

    // 覆盖率加成：命中的查询词占比越高越可信，避免长文档靠单个高频词刷分
    if (score > 0) score *= 0.5 + 0.5 * (hit / qSet.length);

    if (score >= minScore) scored.push({ doc: idx.docs[i], score });
  }

  scored.sort((a, b2) => b2.score - a.score);
  return scored.slice(0, topK);
}
