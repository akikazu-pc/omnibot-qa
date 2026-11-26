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
 * 必备词校验：查询里必须至少有一个「稀有关键词」在文档中出现。
 *
 * 为什么需要它：
 *   「私有化多少钱」和文档「私有化部署支持国产化环境吗」共享「私有化」这个 bigram，
 *   BM25 会给一个不低的分数，于是「国产化适配」的答案就被拿去回答「多少钱」了。
 *   FAQ 场景里这种错误比拒答严重得多，所以这里加一道硬门槛。
 *
 * 判定规则：
 *   1. 先找出查询里的「稀有关键词」—— df/总数 <= 0.6，即不是烂大街的词
 *      （避免「你们」「支持」这类词被当成必备词，那会导致该答的不答）
 *   2. 有稀有关键词时，文档必须命中至少一个
 *   3. 全是常见词时不做限制，交给分数阈值判断
 *
 * @param {string[]} qSet 去重后的查询 token
 * @param {Map<string,number>} tf 当前文档的词频
 * @param {Map<string,number>} df 全局文档频次
 * @param {number} n 文档总数
 */
export function hasMandatoryHits(qSet, tf, df, n) {
  const rare = qSet.filter((q) => {
    const d = df.get(q) || 0;
    return n > 0 && d / n <= 0.6;
  });
  if (rare.length === 0) return true;
  return rare.some((q) => (tf.get(q) || 0) > 0);
}

/**
 * BM25 打分检索。
 *
 * @param {string} query
 * @param {Array<{question:string, answer:string, [k:string]:any}>} docs
 * @param {Object} [opts]
 * @param {number} [opts.topK=3]
 * @param {number} [opts.minScore=1.2] 低于该分数视为不相关。
 *   ⚠️ 这个阈值不能低：宁可拒答「这个我确认下再回复您」，也不能拿不相干的
 *   答案去糊客户。FAQ 场景里一次瞎答的代价远高于一次拒答。
 *   （调低到 0.5 会让「私有化多少钱」错误命中「国产化环境」那一条）
 * @param {number} [opts.k1=1.5]
 * @param {number} [opts.b=0.75]
 * @returns {Array<{doc:Object, score:number}>}
 */
export function search(query, docs, opts = {}) {
  const { topK = 3, minScore = 1.2, k1 = 1.5, b = 0.75 } = opts;
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

    // 必备词校验：「私有化多少钱」里「多少钱」没有命中，那这条文档就没有资格答题。
    // 只靠总分阈值挡不住这种错误 —— BM25 会给「私有化」这个共有词一个不低的分数，
    // 结果就是拿「国产化环境适配」的答案去回答「多少钱」，属于最伤客户的错误。
    if (!hasMandatoryHits(qSet, tf, idx.df, idx.n)) continue;

    if (score >= minScore) scored.push({ doc: idx.docs[i], score });
  }

  // 知识库很小时（刚起步、只有几条 QA），idf 上不去，绝对分数天然偏低。
  // 这时退一步用「查询覆盖率」兜底：超过半数查询词都命中，就算相关。
  // 这解决的是「刚开始用、导入了两条对话就发现 AI 什么都不肯答」的体验问题，
  // 而「私有化多少钱」这类真正缺信息的提问仍会被必备词校验挡掉。
  if (!scored.length && qSet.length) {
    for (let i = 0; i < idx.n; i++) {
      const len = idx.docTokens[i].length || 1;
      const tf = new Map();
      for (const t of idx.docTokens[i]) tf.set(t, (tf.get(t) || 0) + 1);
      if (!hasMandatoryHits(qSet, tf, idx.df, idx.n)) continue;
      const covered = qSet.filter((q) => (tf.get(q) || 0) > 0).length / qSet.length;
      if (covered >= 0.6) scored.push({ doc: idx.docs[i], score: minScore * covered });
    }
  }

  scored.sort((a, b2) => b2.score - a.score);
  return scored.slice(0, topK);
}
