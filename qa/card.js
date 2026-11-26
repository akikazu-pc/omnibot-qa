/**
 * 话术卡片：把配置渲染成聊天窗口里的「一张图」
 *
 * 背景：markdown 的 `a` 标签在企微单聊不渲染，会退化成裸 URL。
 * 问价已改走 template_card（见 qa/price-reply.js），那里整张卡可点。
 *
 * 这一层负责的是「没有网页可跳、只能原样说清楚」的话术（发票/试用/联系方式）：
 *
 *   1. 把信息排成卡片式文本，emoji 当视觉分隔，手机上看就是一张图
 *   2. 真要给网址就写在正文里，客户长按复制
 *
 * 这一层不做任何网络请求，纯字符串处理，方便测试和本地预览。
 */

/**
 * 估算字符串在聊天窗口里的显示宽度。
 * 半角 1，全角/CJK/emoji 2。
 * @param {string} str
 * @returns {number}
 */
export function dispWidth(str) {
  let n = 0;
  for (const c of String(str ?? '')) {
    const cp = c.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) || // 韩文字母
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首 / 汉字
      (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
      (cp >= 0xff00 && cp <= 0xff60) || // 全角标点
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    n += wide ? 2 : 1;
  }
  return n;
}

/**
 * 渲染话术卡片。
 *
 * @param {Object} cfg
 * @param {string} [cfg.title]
 * @param {string} [cfg.intro]
 * @param {Array<Object>} [cfg.plans]
 * @param {string[]} [cfg.notes]
 * @param {Object} [cfg.cta]
 * @param {string} [cfg.footer]
 * @param {number} [cfg.width]
 * @returns {string}
 */
export function renderCard(cfg = {}) {
  const {
    title = '',
    intro = '',
    plans = [],
    notes = [],
    cta = null,
    footer = '',
    width = 34,
  } = cfg;

  const out = [];
  const rule = () => '─'.repeat(Math.max(10, Math.min(width, 40)));

  if (title) out.push(`🎯 ${title}`);
  if (intro) out.push(intro);

  for (const p of plans) {
    if (!p || !p.name) continue;
    out.push('');
    out.push(`📦 ${p.name}`);
    if (p.price) out.push(`   💰 ${p.price}${p.unit ? ` / ${p.unit}` : ''}`);
    for (const it of p.items || []) out.push(`   · ${it}`);
    if (p.note) out.push(`   ${p.note}`);
  }

  if (notes.length) {
    out.push('');
    out.push(rule());
    for (const n of notes) out.push(`✨ ${n}`);
  }

  if (cta && (cta.text || cta.url)) {
    out.push('');
    if (cta.text) out.push(`👉 ${cta.text}`);
    if (cta.url) out.push(cta.url);
  }

  if (footer) {
    out.push('');
    out.push(footer);
  }

  return out.join('\n').trim();
}

/**
 * 找出会被折行的行。
 *
 * 纯分隔线（全是 ─ ━ = - 这类）不算：它本来就是为了凑满一行画的，
 * 而且折行只会多画一点点，视觉上没有影响。
 *
 * @param {string} text
 * @param {number} [width]
 * @returns {{over: Array<{line:string,w:number}>, maxWidth:number}}
 */
export function checkCardWidth(text, width = 34) {
  const over = [];
  let maxWidth = 0;
  for (const line of String(text ?? '').split('\n')) {
    const w = dispWidth(line);
    if (w > maxWidth) maxWidth = w;
    if (w > width && !isRuleLine(line)) over.push({ line, w });
  }
  return { over, maxWidth };
}

/** 是不是一条纯分隔线 */
export function isRuleLine(line = '') {
  const t = String(line).trim();
  return t.length >= 3 && /^[─━═—\-=_*·.]+$/.test(t);
}
