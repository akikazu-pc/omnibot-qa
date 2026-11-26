/**
 * 客户语言识别。
 *
 * 目标不是做通用语种检测，而是在「简中 / 繁中 / 英文 / 日语」四选一里
 * 选一个最可能的，选不出来就默认简体中文。所以策略很务实：
 *
 *   1. 有假名（平假名/片假名）→ 日语。这是最可靠的信号，
 *      因为中文和英文都不会出现假名。
 *   2. 出现繁体专用字或繁体用词 → 繁体中文。
 *   3. 全是 ASCII 且有一定长度 → 英文。
 *   4. 其余 → 简体中文（含中英混写、纯数字、纯 emoji）。
 *
 * 刻意不做的事：
 *   - 不调用任何在线服务（客服回复要在几十毫秒内出去）
 *   - 不猜「日文汉字」，因为日语里大量汉字与中文同形，
 *     只靠汉字判断会把「パソコン修理」和「电脑维修」搞混
 */

import { DEFAULT_LANG, normalizeLang } from './site-map.js';

/** 平假名 + 片假名 + 长音符 */
const KANA = /[\u3040-\u309f\u30a0-\u30ff\u30fc]/;

/** 繁体专用字：出现任意一个就基本确定是繁体。只收高频字，不求全 */
const TRAD_ONLY =
  /[們個這來說時會裡麼機電電腦維修組裝價錢費用單張開關閉門問題請謝對臺網軟體應與為從後頁連絡預約確認標準級總額筆記型]/;

/** 繁体常见词：即使字都是通用字，用词也能暴露语种 */
/**
 * 繁体特征词：必须在简体里写法不同，否则区分不了。
 * 「清灰」「有没有」「多久」这类简繁同形的词一律不收 —— 收了只会制造误判。
 */
const TRAD_WORDS = [
  '多少錢', '費用', '報價', '組裝', '維修', '電腦', '筆記型', '桌上型',
  '請問', '謝謝', '預約', '聯絡', '連絡', '到府', '換散熱膏',
  '什麼', '怎麼', '哪裡', '可不可以',
];

/** 简体特征词：同样只收与繁体写法不同的 */
const SIMP_WORDS = [
  '多少钱', '费用', '报价', '组装', '维修', '电脑', '笔记本', '台式',
  '请问', '谢谢', '预约', '联系', '上门', '换硅脂',
  '什么', '怎么', '哪里', '可不可以',
];

/** 常见日语问句词：汉字与中文同形，但配合假名判据一起用更稳 */
const JA_WORDS = [
  'いくら', '料金', '見積', '修理', '組立', '出張', '可能', 'ですか',
  'ますか', 'ください', 'お願い', 'とは', 'について',
];

/**
 * 判断一条消息的语言。
 * @param {string} text
 * @returns {'zh-CN'|'zh-TW'|'en-US'|'ja'}
 */
export function detectLang(text) {
  const s = String(text ?? '').trim();
  if (!s) return DEFAULT_LANG;

  // 1. 假名是最硬的信号
  if (KANA.test(s)) return 'ja';

  // 2. 日语问句常用词（客户可能只用汉字+这些词，没打假名）
  const jaHits = JA_WORDS.filter((w) => s.includes(w)).length;

  // 3. 繁体信号
  const tradChar = TRAD_ONLY.test(s);
  const tradWordHits = TRAD_WORDS.filter((w) => s.includes(w)).length;
  const simpWordHits = SIMP_WORDS.filter((w) => s.includes(w)).length;

  if (tradWordHits > simpWordHits) return 'zh-TW';
  if (tradChar && simpWordHits === 0) return 'zh-TW';

  // 4. 纯 ASCII：可能是英文，也可能只是型号/数字
  const asciiOnly = /^[\x00-\x7F\s]+$/.test(s);
  if (asciiOnly) {
    // 至少要有几个字母才当英文，避免 "4090" "B650M" 被判成英文
    const letters = (s.match(/[A-Za-z]/g) || []).length;
    if (letters >= 3) return 'en-US';
    return DEFAULT_LANG;
  }

  // 5. 有日语词但没假名，且没简体特征
  if (jaHits > 0 && simpWordHits === 0 && tradWordHits === 0) return 'ja';

  return DEFAULT_LANG;
}

/**
 * 判断是否「用中文提问但提到了外语」——
 * 这种情况按中文回，因为客户用的是中文在说话。
 * 目前 detectLang 已经天然满足，这个函数留作显式表达意图。
 */
export function detectLangStrict(text) {
  return normalizeLang(detectLang(text));
}
