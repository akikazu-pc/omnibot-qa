/**
 * 站点链接地图：客户问什么，就把他送到哪个页面。
 *
 * 核心约定（按 akikazu.co.jp 的实际结构）：
 *   - 页面路径（path）与语言无关，语言只体现在前缀上
 *   - 日语是默认语言，没有前缀；其余语言都有前缀
 *   - 同一个 path 在所有语言下都存在（已验证 200）
 *
 * 所以「多语言」在这里只是「前缀换一下」，不需要维护四套文案。
 */

/** 站点根，不带末尾斜杠 */
export const SITE_ORIGIN = 'https://www.akikazu.co.jp';

/**
 * 语言 → 路径前缀。
 * 日语刻意用空串：站点根就是日语版，写 '/ja' 反而会 404。
 */
export const LANG_PREFIX = {
  ja: '',
  'zh-CN': '',
  'zh-TW': '/zh-TW',
  'en-US': '/en-US',
};

/** zh-CN 需要显式前缀，修正上面的默认值 */
LANG_PREFIX['zh-CN'] = '/zh-CN';

/** 支持的语言，顺序即回退优先级 */
export const SUPPORTED_LANGS = ['zh-CN', 'zh-TW', 'en-US', 'ja'];

export const DEFAULT_LANG = 'zh-CN';

/**
 * 服务项 → 页面 path。
 *
 * 这些 item 值与站点导航一一对应，改站点时同步这里即可。
 * 每一项都带 lang 名称，用于卡片上的中文/英文字段，
 * 避免出现「简体中文说明 + 日语栏目名」的割裂感。
 */
export const SERVICE_PAGES = {
  // 总表：客户没说清要什么的时候，送到这里
  all: {
    path: '/service',
    label: {
      'zh-CN': '全部服务与价格',
      'zh-TW': '全部服務與價格',
      'en-US': 'All services & prices',
      ja: 'サービス・料金一覧',
    },
  },

  // 台式机
  assembly: {
    path: '/service/desktop?item=assembly',
    label: {
      'zh-CN': '上门装机',
      'zh-TW': '到府組裝',
      'en-US': 'On-site PC assembly',
      ja: '出張組立',
    },
  },
  bto: {
    path: '/service/desktop?item=bto',
    label: {
      'zh-CN': '定制整机',
      'zh-TW': '客製電腦',
      'en-US': 'Custom PC build',
      ja: 'カスタムPC',
    },
  },
  cleaning: {
    path: '/service/desktop?item=cleaning',
    label: {
      'zh-CN': '台式机清灰',
      'zh-TW': '桌上型清灰',
      'en-US': 'Desktop cleaning',
      ja: 'デスクトップ清掃',
    },
  },
  repair: {
    path: '/service/desktop?item=repair',
    label: {
      'zh-CN': '台式机维修',
      'zh-TW': '桌上型維修',
      'en-US': 'Desktop repair',
      ja: 'デスクトップ修理',
    },
  },
  upgrade: {
    path: '/service/desktop?item=upgrade',
    label: {
      'zh-CN': '升级加装',
      'zh-TW': '升級加裝',
      'en-US': 'Upgrade',
      ja: 'アップグレード',
    },
  },
  dismantling: {
    path: '/service/desktop?item=dismantling',
    label: {
      'zh-CN': '拆机',
      'zh-TW': '拆機',
      'en-US': 'Disassembly',
      ja: '分解',
    },
  },

  // 笔记本
  'laptop-cleaning': {
    path: '/service/laptop?item=cleaning',
    label: {
      'zh-CN': '笔记本清灰换硅脂',
      'zh-TW': '筆電清灰換散熱膏',
      'en-US': 'Laptop cleaning & repaste',
      ja: 'ノートPC清掃・グリス交換',
    },
  },
  'laptop-repair': {
    path: '/service/laptop?item=repair',
    label: {
      'zh-CN': '笔记本诊断维修',
      'zh-TW': '筆電診斷維修',
      'en-US': 'Laptop diagnostics & repair',
      ja: 'ノートPC診断修理',
    },
  },

  // 技术支持
  setup: {
    path: '/service/business?item=setup',
    label: {
      'zh-CN': '新机设置',
      'zh-TW': '新機設定',
      'en-US': 'PC setup',
      ja: '新規セットアップ',
    },
  },
  backup: {
    path: '/service/business?item=backup',
    label: {
      'zh-CN': '数据迁移',
      'zh-TW': '資料移轉',
      'en-US': 'Data migration',
      ja: 'データ移行',
    },
  },
  malware: {
    path: '/service/business?item=malware',
    label: {
      'zh-CN': '病毒查杀',
      'zh-TW': '病毒清除',
      'en-US': 'Virus removal',
      ja: 'ウイルス駆除',
    },
  },
  inspection: {
    path: '/service/business?item=inspection',
    label: {
      'zh-CN': '验机检查',
      'zh-TW': '驗機檢查',
      'en-US': 'PC check',
      ja: '動作確認',
    },
  },

  // 其他常用页面
  onsite: {
    path: '/service/onsite',
    label: {
      'zh-CN': '上门区域与上门费',
      'zh-TW': '到府區域與到府費',
      'en-US': 'On-site area & fees',
      ja: '出張エリア・出張費',
    },
  },
  warranty: {
    path: '/warranty',
    label: {
      'zh-CN': '保修说明',
      'zh-TW': '保固說明',
      'en-US': 'Warranty',
      ja: '保証について',
    },
  },
  payment: {
    path: '/payment',
    label: {
      'zh-CN': '支付方式',
      'zh-TW': '付款方式',
      'en-US': 'Payment methods',
      ja: 'お支払い方法',
    },
  },
  contact: {
    path: '/contact',
    label: {
      'zh-CN': '联系与咨询',
      'zh-TW': '聯絡與諮詢',
      'en-US': 'Contact',
      ja: 'お問い合わせ',
    },
  },
  estimation: {
    path: '/estimation',
    label: {
      'zh-CN': '在线估价',
      'zh-TW': '線上估價',
      'en-US': 'Online estimate',
      ja: '見積りシミュレーター',
    },
  },
  appointment: {
    path: '/appointment',
    label: {
      'zh-CN': '预约',
      'zh-TW': '預約',
      'en-US': 'Book a visit',
      ja: 'ご予約',
    },
  },
};

/**
 * 归一化语言标记。
 * 接受 zh / zh-cn / zh_CN / zh-Hans / zh-Hant / en / ja / jp 这类写法，
 * 认不出来就回退到默认语言，绝不抛错。
 */
export function normalizeLang(input) {
  const s = String(input ?? '').trim();
  if (!s) return DEFAULT_LANG;
  const low = s.toLowerCase().replace(/_/g, '-');

  if (low === 'ja' || low === 'jp' || low === 'ja-jp' || low === 'japanese') return 'ja';
  if (low === 'en' || low === 'en-us' || low === 'en-gb' || low === 'english') return 'en-US';
  if (low.startsWith('zh')) {
    if (low.includes('tw') || low.includes('hk') || low.includes('mo') || low.includes('hant')) return 'zh-TW';
    return 'zh-CN';
  }
  return DEFAULT_LANG;
}

/**
 * 拼一个完整链接。
 * @param {string} path 页面 path，如 '/service/desktop?item=assembly'
 * @param {string} [lang] 语言，认不出就用默认
 */
export function buildUrl(path, lang = DEFAULT_LANG) {
  const p = String(path ?? '/').trim() || '/';
  const prefix = LANG_PREFIX[normalizeLang(lang)] ?? '';
  const withSlash = p.startsWith('/') ? p : `/${p}`;
  return `${SITE_ORIGIN}${prefix}${withSlash}`;
}

/**
 * 取某个服务项在指定语言下的页面链接。
 * @param {string} key SERVICE_PAGES 的键，未知键回退到 all
 * @param {string} [lang]
 * @param {object} [extra] 额外页面表（路由模块里的虚拟键，如 desktop-overview）
 */
export function serviceUrl(key, lang = DEFAULT_LANG, extra = null) {
  const item = SERVICE_PAGES[key] || (extra && extra[key]) || SERVICE_PAGES.all;
  return buildUrl(item.path, lang);
}

/**
 * 取某个服务项在指定语言下的名称。
 * @param {string} key
 * @param {string} [lang]
 * @param {object} [extra]
 */
export function serviceLabel(key, lang = DEFAULT_LANG, extra = null) {
  const item = SERVICE_PAGES[key] || (extra && extra[key]) || SERVICE_PAGES.all;
  return item.label[normalizeLang(lang)] || item.label[DEFAULT_LANG];
}
