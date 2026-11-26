/**
 * 问价意图 → 页面路由。
 *
 * 设计原则只有一条：**有几分信息，就发多细的页面**。
 *
 *   客户说「多少钱」                    → 发服务总表（他什么都没说清）
 *   客户说「装机多少钱」                → 发装机页
 *   客户说「台式机组装 + 清灰 多少」    → 发台式机页（命中多个台式机项）
 *   客户说「笔记本清灰多贵」            → 发笔记本清灰页（不会被台式机清灰抢走）
 *
 * 最后一条是关键：中文里「清灰」同时属于台式机和笔记本，
 * 所以判定必须看上下文（有没有「笔记本/筆記型/laptop」这类词），
 * 不能只按关键词先到先得。
 */

import { SERVICE_PAGES } from './site-map.js';

/** 问价信号：客户在问「要花多少钱」，而不是在聊别的 */
const ASK_PRICE = [
  // 中文（简繁通用或各写一遍）
  '多少钱', '多少錢', '什么价', '什麼價', '啥价', '价格', '價格', '价钱', '價錢',
  '报价', '報價', '报个价', '報個價', '报下价', '怎么收费', '怎麼收費', '如何收费', '如何收費',
  '费用', '費用', '收费', '收費', '价位', '價位', '几块', '多少日元', '多少日幣', '多少钱起',
  '贵不贵', '貴不貴', '贵吗', '貴嗎', '怎么算', '怎麼算', '多少钱一次',
  // 问「有没有这项服务」—— 客户在了解能做什么、要多少钱，给价格页正合适
  '有没有', '有沒有', '你们有', '你們有', '有上门吗', '有到府嗎', '能上门吗', '能到府嗎',
  '可以上门吗', '可以到府嗎', '接不接', '做不做', '支持吗', '支援嗎',
  // 英文
  'how much', 'price', 'pricing', 'cost', 'quote', 'estimate', 'fee', 'charge',
  // 英文的问「有没有这项服务」—— 也是在索取服务信息，给价格页正合适
  'do you offer', 'do you have', 'do you do', 'can you do', 'are you available',
  // 日语
  'いくら', '料金', '価格', '値段', '見積', '費用', 'いくらですか',
  'できますか', '対応できますか', 'はありますか',
];

/** 具体服务项的信号词。顺序即优先级（越靠前越优先）。 */
const SERVICE_HINTS = {
  // 笔记本必须先于台式机判，否则「笔记本清灰」会被「清灰」抢走
  'laptop-cleaning': [
    '笔记本清灰', '筆電清灰', '笔记本 清灰', '筆記型清灰', '笔记本换硅脂', '筆電換散熱膏',
    '笔记本散热', '筆電散熱', '换硅脂', '換散熱膏', '笔电保养', '筆電保養',
    'laptop cleaning', 'laptop repaste', 'thermal paste',
    'ノートpc清掃', 'ノート清掃', 'グリス交換', 'ノートpcの清掃',
  ],
  'laptop-repair': [
    '笔记本维修', '筆電維修', '笔记本修', '筆電修', '笔记本开不了机', '筆電開不了機',
    '笔记本进水', '筆電進水', '笔记本蓝屏', '筆電藍屏', '笔记本诊断',
    'laptop repair', 'laptop diagnostics', 'notebook repair',
    'ノートpc修理', 'ノート修理', 'ノートpcの修理',
  ],

  // 台式机各细项
  assembly: [
    '装机', '組裝', '组装', '装电脑', '裝電腦', '装机服务', '裝機', '帮我装', '幫我裝',
    '装一台', '裝一台', '配一台', '装主机', '組一台',
    'assembly', 'pc build', 'build a pc', 'assemble',
    '組立', '組み立て', '自作pc', 'pc組み立て', '出張組立',
  ],
  bto: [
    '定制', '客製', '订制', '訂製', '按配置', '按需求配', '整机定制', '整機客製',
    'custom pc', 'custom build', 'bto',
    'カスタムpc', 'bto', 'オーダーメイド',
  ],
  cleaning: [
    '清灰', '除尘', '除塵', '清理灰尘', '清理灰塵', '打扫机箱', '灰太多',
    'cleaning', 'dust removal', 'clean the pc',
    '清掃', 'クリーニング', 'ほこり',
  ],
  repair: [
    '维修', '維修', '修理', '修电脑', '修電腦', '坏了', '壞了', '开不了机', '開不了機',
    '点不亮', '點不亮', '黑屏', '蓝屏', '藍屏', '死机', '死機', '报错', '報錯',
    'repair', 'fix', 'broken', 'not booting', 'no display',
    '修理', '故障', '直らない', 'つかない',
  ],
  upgrade: [
    '升级', '升級', '加装', '加裝', '换显卡', '換顯卡', '加内存', '加記憶體',
    '换电源', '換電源', '加硬盘', '加硬碟', '换cpu', '擴充',
    'upgrade', 'add ram', 'new gpu',
    'アップグレード', '増設', '換装',
  ],
  dismantling: [
    '拆机', '拆機', '拆开', '拆開', '分解', '拆件',
    'disassembly', 'disassemble', 'teardown',
    '分解', 'バラし',
  ],

  // 技术支持
  setup: [
    '新机设置', '新機設定', '开箱设置', '開箱設定', '装系统', '裝系統', '重装系统', '重裝系統',
    '系统安装', '系統安裝', '设置电脑', '設定電腦',
    'pc setup', 'windows install', 'setup service',
    'セットアップ', '初期設定', 'osインストール',
  ],
  backup: [
    '数据迁移', '資料移轉', '数据转移', '資料轉移', '搬数据', '備份', '备份',
    'data migration', 'data transfer', 'backup',
    'データ移行', 'データ移転', 'バックアップ',
  ],
  malware: [
    '病毒', '查杀', '查殺', '杀毒', '殺毒', '中招', '木马', '木馬', '弹窗广告', '彈窗廣告',
    'virus', 'malware', 'remove virus', 'antivirus',
    'ウイルス', '駆除', 'マルウェア',
  ],
  inspection: [
    '验机', '驗機', '检查电脑', '檢查電腦', '检测', '檢測', '看看有没有问题',
    'inspection', 'check my pc', 'diagnostic check',
    '動作確認', '点検', 'チェック',
  ],
};

/**
 * 「上门」本身不是某个服务项，但它决定了要不要给客户看上门费规则。
 * 客户说「有上门吗」时，送他上门区域与费用页比送总表更直接。
 */
const ONSITE_HINTS = ['上门', '上門', '到府', '出张', '出張', 'on-site', 'onsite', '上门费', '出張費'];

/**
 * 客户在说「我不想知道价格，我只想抱怨/砍价」时的信号。
 * 命中则不发报价页 —— 甩价格表等于火上浇油。
 */
const PRICE_COMPLAINT = [
  '太贵', '太貴', '好贵', '好貴', '有点贵', '有點貴', '贵了', '貴了', '很贵', '很貴',
  '真贵', '真貴', '不便宜', '便宜点', '便宜點', '能便宜', '打折', '优惠', '優惠',
  '划算', '值不值', '性价比', '性價比', '预算不够', '預算不夠', '超预算', '超預算',
  '别家', '別家', '同行', '比价', '比價', '嫌贵', '嫌貴', '降点价', '降價',
  '价格高', '價格高', '价钱高', '價錢高', '价高', '價高', '好高', '太高', '高了', '贵啊', '貴啊',
  'too expensive', 'expensive', 'cheaper', 'discount', 'any deal',
  '高い', '高すぎ', '安く', '割引',
];

/** 寒暄/致谢：不该触发任何报价 */
const GREETING = /^(你好|您好|hi|hello|在吗|在嗎|在么|在不在|有人吗|有人嗎|谢谢|謝謝|多谢|多謝|好的|好|ok|嗯|收到|ありがとう|こんにちは|thanks|thank you|thx)[呀啊呢哈！!。.~～\s]*$/i;

/** 消息里是否在问价 */
export function asksPrice(text) {
  const s = String(text ?? '').toLowerCase();
  if (!s.trim()) return false;
  if (GREETING.test(String(text ?? '').trim())) return false;
  return ASK_PRICE.some((k) => s.includes(k.toLowerCase()));
}

/** 是否在抱怨价格 */
export function isPriceComplaint(text) {
  const s = String(text ?? '').toLowerCase();
  return PRICE_COMPLAINT.some((k) => s.includes(k.toLowerCase()));
}

/**
 * 找出消息里提到的服务项。
 *
 * 关键处理：中文里「清灰」「维修」同时属于台式机和笔记本，
 * 所以一旦判定是笔记本语境，就把台式机的同名词压掉 ——
 * 否则「笔记本清灰多少钱」会被判成「提了两件事」，最后发去总表。
 *
 * @returns {string[]} SERVICE_PAGES 的键，按命中优先级排序；空数组表示没提具体服务
 */
export function detectServices(text) {
  const s = String(text ?? '').toLowerCase();
  if (!s.trim()) return [];
  const hits = [];
  for (const [key, words] of Object.entries(SERVICE_HINTS)) {
    if (words.some((w) => s.includes(w.toLowerCase()))) hits.push(key);
  }

  const laptopHit = hits.some((k) => k.startsWith('laptop-'));
  if (laptopHit) {
    // 明确说了是台式机时不动手，否则笔记本优先
    const desktopExplicit = /台式|桌上型|desktop|\b塔式\b/.test(s);
    if (!desktopExplicit) {
      return hits.filter(
        (k) => k.startsWith('laptop-') || k === 'assembly' || k === 'bto'
      );
    }
  }
  return hits;
}

/**
 * 决定该发哪个页面。
 *
 * 返回值里带 reason，方便调试时知道为什么发了这一页。
 *
 * @param {string} text 客户原话
 * @returns {{ key: string, reason: string, services: string[] } | null}
 *   null 表示「这不是问价，别管」
 */
export function routePricePage(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  // 抱怨价格时不甩价格表
  if (isPriceComplaint(raw)) return { key: null, reason: 'price-complaint', services: [] };

  const services = detectServices(raw);
  const priceAsked = asksPrice(raw);

  if (!priceAsked) {
    // 客户只发了服务名（「装机」「笔记本清灰」），也是在询价 ——
    // 但不是「你好」「谢谢」这类寒暄，也不是「怎么联系」
    if (!services.length) return null;
    if (GREETING.test(raw)) return null;
    // 短句才当询价，长句子说明他在描述情况，交给 AI 更合适
    if (raw.length > 12) return null;
    return { key: services[0], reason: 'service-name-only', services };
  }

  if (!services.length) {
    // 只提了「上门」，没提具体服务 → 给他上门区域与费用页
    if (ONSITE_HINTS.some((w) => raw.toLowerCase().includes(w.toLowerCase()))) {
      return { key: 'onsite', reason: 'onsite-only', services: [] };
    }
    return { key: 'all', reason: 'no-service-specified', services: [] };
  }

  // 命中 1 个：直接给他
  if (services.length === 1) {
    return { key: services[0], reason: 'single-service', services };
  }

  // 命中多个：如果全都属于台式机，送台式机总页比送某一项更合适
  const DESKTOP_GROUP = ['assembly', 'bto', 'cleaning', 'repair', 'upgrade', 'dismantling'];
  const allDesktop = services.every((k) => DESKTOP_GROUP.includes(k));
  if (allDesktop) {
    return { key: 'desktop-overview', reason: 'multi-desktop', services };
  }

  // 其它多命中情况：送总表，让客户自己挑
  return { key: 'all', reason: 'multi-service', services };
}

/**
 * desktop-overview 不在 SERVICE_PAGES 里（它没有独立页面），
 * 这里补一个映射：台式机多个细项 → /service/desktop
 */
export const ROUTE_EXTRA = {
  'desktop-overview': {
    path: '/service/desktop',
    label: {
      'zh-CN': '台式机服务与价格',
      'zh-TW': '桌上型服務與價格',
      'en-US': 'Desktop services & prices',
      ja: 'デスクトップサービス・料金',
    },
  },
};

/** 取路由目标对应的页面信息（含 desktop-overview 这类虚拟键） */
export function pageOf(key) {
  if (!key) return null;
  return SERVICE_PAGES[key] || ROUTE_EXTRA[key] || null;
}
