/**
 * 报价回复：客户问价 → 回他一张对应语言的卡片，点开就是价格表。
 *
 * 为什么不在聊天里直接报数字：
 *   价格表在网站上改一次就全站生效，而写死在话术里要改代码、要重启、
 *   改漏一个套餐就是报错价。所以机器人只负责「把人送到价格页」。
 *
 * 为什么用模板卡片而不是 markdown 链接：
 *   企微单聊里 markdown 的 `a` 标签不渲染，客户看到的是一串裸 URL。
 *   模板卡片的 card_action.type=1 才能真的点开。
 *
 * 语言策略：
 *   客户用什么语言问，就给什么语言的页面。
 *   「企业微信默认发简体中文」这点保留为兜底 —— 认不出语言时走 zh-CN。
 */

import { detectLang } from './lang-detect.js';
import { routePricePage, pageOf, ROUTE_EXTRA } from './price-router.js';
import { buildUrl, serviceLabel, normalizeLang, SITE_ORIGIN } from './site-map.js';

/**
 * 各语言的卡片文案。
 * 只放「页面给不了」的引导语 —— 价格本身在网站上，不在这里重复，
 * 避免两边价格不一致。
 */
const COPY = {
  'zh-CN': {
    sourceDesc: '秋和PC',
    urlLabel: '查看价格',
    subtitleAll: '价格按项目列在页面上，点开就能看到具体金额。\n配件、耗材、交通费另计，最终以现场确认为准。',
    subtitleItem: '点开看这一项的具体价格与包含内容。\n最终金额以现场确认为准。',
    rowService: '服务',
    rowWhere: '上门',
    rowWhereValue: '东京及周边',
    rowNote: '价格',
    rowNoteValue: '日元含税',
    fallbackTitle: '服务与价格',
  },
  'zh-TW': {
    sourceDesc: '秋和PC',
    urlLabel: '查看價格',
    subtitleAll: '價格按項目列在頁面上，點開就能看到具體金額。\n配件、耗材、交通費另計，最終以現場確認為準。',
    subtitleItem: '點開看這一項的具體價格與包含內容。\n最終金額以現場確認為準。',
    rowService: '服務',
    rowWhere: '到府',
    rowWhereValue: '東京及周邊',
    rowNote: '價格',
    rowNoteValue: '日圓含稅',
    fallbackTitle: '服務與價格',
  },
  'en-US': {
    sourceDesc: 'Akikazu PC',
    urlLabel: 'View prices',
    subtitleAll: 'Prices are itemised on the page — tap to see exact amounts.\nParts and travel extra; final amount on site.',
    subtitleItem: 'Tap to see the price and what is included.\nFinal amount confirmed on site.',
    rowService: 'Service',
    rowWhere: 'On-site',
    rowWhereValue: 'Tokyo & nearby',
    rowNote: 'Prices',
    rowNoteValue: 'JPY, tax incl.',
    fallbackTitle: 'Services & prices',
  },
  ja: {
    sourceDesc: '秋和PC',
    urlLabel: '料金を見る',
    subtitleAll: '料金はページに項目ごとに記載しています。タップして金額をご確認ください。\n部品代・消耗品代・交通費は別途、最終金額は当日の確認によります。',
    subtitleItem: 'タップするとこの項目の料金と内容がご覧いただけます。\n最終金額は当日の確認によります。',
    rowService: 'サービス',
    rowWhere: '出張',
    rowWhereValue: '東京および周辺',
    rowNote: '料金',
    rowNoteValue: '税込・日本円',
    fallbackTitle: 'サービスと料金',
  },
};

function copyOf(lang) {
  return COPY[normalizeLang(lang)] || COPY['zh-CN'];
}

/**
 * 决定怎么回复这条问价消息。
 *
 * @param {string} text 客户原话
 * @param {Object} [opts]
 * @param {string} [opts.lang] 强制指定语言（不传则自动识别）
 * @returns {null | {
 *   lang: string, key: string, url: string, title: string,
 *   reason: string, services: string[],
 *   card: object,          // 可直接发给企微的 template_card
 *   plain: string,         // 纯文本版，用于不支持卡片的渠道 / 日志 / 调试
 * }}
 *   null 表示这条消息不走报价流程
 */
export function buildPriceReply(text, opts = {}) {
  const route = routePricePage(text);
  if (!route) return null; // 不是问价
  if (!route.key) return null; // 是嫌贵，不甩价格表

  const lang = normalizeLang(opts.lang || detectLang(text));
  const copy = copyOf(lang);
  const page = pageOf(route.key);
  const url = buildUrl(page.path, lang);
  const label = serviceLabel(route.key, lang, ROUTE_EXTRA);

  const isAll = route.key === 'all';
  const title = isAll ? copy.fallbackTitle : label;
  const subtitle = isAll ? copy.subtitleAll : copy.subtitleItem;

  const card = {
    card_type: 'text_notice',
    source: { desc: copy.sourceDesc },
    main_title: { title, desc: copy.rowNoteValue },
    sub_title_text: subtitle,
    horizontal_content_list: [
      { keyname: copy.rowService, value: label },
      { keyname: copy.rowWhere, value: copy.rowWhereValue },
    ],
    jump_list: [{ type: 1, title: copy.urlLabel, url }],
    // type:1 = 跳转 URL。整张卡片可点，也可以点底部按钮
    card_action: { type: 1, url },
  };

  // 纯文本兜底：渠道不支持卡片、或者日志里要看清楚时用
  const plain = `${title}\n${url}`;

  return {
    lang,
    key: route.key,
    url,
    title,
    reason: route.reason,
    services: route.services,
    card,
    plain,
  };
}

/**
 * 把报价结果渲染成一段人话，用于 CLI / HTTP 调试。
 * 不发送任何消息。
 */
export function explainPriceReply(result) {
  if (!result) return '这条消息不走报价流程（不是问价，或在抱怨价格）';
  return [
    `语言: ${result.lang}`,
    `页面: ${result.key}  (${result.reason})`,
    `链接: ${result.url}`,
    '',
    '--- 卡片预览 ---',
    `[${result.card.source.desc}]  ${result.card.main_title.title}  ${result.card.main_title.desc || ''}`,
    ...String(result.card.sub_title_text || '').split('\n').map((l) => `  ${l}`),
    ...(result.card.horizontal_content_list || []).map(
      (r) => `  ${r.keyname}: ${r.value}`
    ),
    ...(result.card.jump_list || []).map((j) => `  [ ${j.title} ] → ${j.url}`),
  ].join('\n');
}

export { SITE_ORIGIN };
