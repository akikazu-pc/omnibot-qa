import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LANG_PREFIX,
  SUPPORTED_LANGS,
  DEFAULT_LANG,
  normalizeLang,
  buildUrl,
  serviceUrl,
  serviceLabel,
  SERVICE_PAGES,
  SITE_ORIGIN,
} from '../qa/site-map.js';

import { detectLang } from '../qa/lang-detect.js';

import {
  asksPrice,
  isPriceComplaint,
  detectServices,
  routePricePage,
  pageOf,
  ROUTE_EXTRA,
} from '../qa/price-router.js';

import { buildPriceReply, explainPriceReply } from '../qa/price-reply.js';

import { buildReplyCard, buildPriceCard } from '../adapters/wecom-bot.js';

// ───────────────────────── 链接地图 ─────────────────────────

describe('site-map: 语言前缀', () => {
  test('日语无前缀（站点根就是日语版）', () => {
    assert.equal(LANG_PREFIX.ja, '');
    assert.equal(buildUrl('/service', 'ja'), `${SITE_ORIGIN}/service`);
  });

  test('简体中文有 /zh-CN 前缀', () => {
    assert.equal(buildUrl('/service', 'zh-CN'), `${SITE_ORIGIN}/zh-CN/service`);
  });

  test('繁体 / 英文各自的前缀', () => {
    assert.equal(buildUrl('/service', 'zh-TW'), `${SITE_ORIGIN}/zh-TW/service`);
    assert.equal(buildUrl('/service', 'en-US'), `${SITE_ORIGIN}/en-US/service`);
  });

  test('四种语言都配置了前缀', () => {
    for (const l of SUPPORTED_LANGS) {
      assert.equal(typeof LANG_PREFIX[l], 'string', `${l} 缺前缀定义`);
    }
  });

  test('默认语言是简体中文', () => {
    assert.equal(DEFAULT_LANG, 'zh-CN');
  });
});

describe('site-map: normalizeLang', () => {
  const cases = [
    ['zh', 'zh-CN'],
    ['zh-cn', 'zh-CN'],
    ['zh_CN', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['zh-TW', 'zh-TW'],
    ['zh-tw', 'zh-TW'],
    ['zh-Hant', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['en', 'en-US'],
    ['en-US', 'en-US'],
    ['en-GB', 'en-US'],
    ['ja', 'ja'],
    ['jp', 'ja'],
    ['ja-JP', 'ja'],
    ['', 'zh-CN'],
    [null, 'zh-CN'],
    ['klingon', 'zh-CN'],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${expected}`, () => {
      assert.equal(normalizeLang(input), expected);
    });
  }
});

describe('site-map: 页面链接', () => {
  test('用户给的两个样例必须精确一致', () => {
    // 客户没有任何其他信息 → 服务总表
    assert.equal(
      buildUrl(SERVICE_PAGES.all.path, 'zh-CN'),
      'https://www.akikazu.co.jp/zh-CN/service'
    );
    // 确认到装机 → 装机页
    assert.equal(
      serviceUrl('assembly', 'zh-CN'),
      'https://www.akikazu.co.jp/zh-CN/service/desktop?item=assembly'
    );
  });

  test('每个服务项在每种语言下都拼得出合法链接', () => {
    for (const key of Object.keys(SERVICE_PAGES)) {
      for (const lang of SUPPORTED_LANGS) {
        const u = serviceUrl(key, lang);
        assert.match(u, /^https:\/\/www\.akikazu\.co\.jp\//, `${key}/${lang} 域名不对: ${u}`);
        assert.ok(!u.includes('undefined'), `${key}/${lang} 拼出 undefined: ${u}`);
        assert.ok(!u.includes('//service'), `${key}/${lang} 出现双斜杠: ${u}`);
      }
    }
  });

  test('未知键回退到总表，不抛错', () => {
    assert.equal(serviceUrl('nope', 'zh-CN'), `${SITE_ORIGIN}/zh-CN/service`);
    assert.ok(serviceUrl('nope', 'zh-CN'));
  });

  test('每个服务项都有四种语言的名称', () => {
    for (const [key, item] of Object.entries(SERVICE_PAGES)) {
      for (const lang of SUPPORTED_LANGS) {
        assert.ok(item.label[lang], `${key} 缺 ${lang} 名称`);
      }
    }
  });

  test('serviceLabel 按语言返回对应文案', () => {
    assert.equal(serviceLabel('assembly', 'zh-CN'), '上门装机');
    assert.equal(serviceLabel('assembly', 'zh-TW'), '到府組裝');
    assert.equal(serviceLabel('assembly', 'en-US'), 'On-site PC assembly');
    assert.equal(serviceLabel('assembly', 'ja'), '出張組立');
  });
});

// ───────────────────────── 语言识别 ─────────────────────────

describe('lang-detect: 识别客户语言', () => {
  const cases = [
    // 简体
    ['多少钱', 'zh-CN'],
    ['你们装机多少钱', 'zh-CN'],
    ['台式机清灰多少钱', 'zh-CN'],
    // 繁体
    ['多少錢', 'zh-TW'],
    ['你們組裝多少錢', 'zh-TW'],
    ['請問費用怎麼算', 'zh-TW'],
    ['可以到府維修嗎', 'zh-TW'],
    ['筆電清灰', 'zh-TW'],
    // 日语：有假名就是铁证
    ['いくらですか', 'ja'],
    ['出張組立は可能ですか', 'ja'],
    ['料金を教えてください', 'ja'],
    ['パソコン修理', 'ja'],
    // 英文
    ['how much', 'en-US'],
    ['How much for PC assembly?', 'en-US'],
    ['Do you offer on-site service', 'en-US'],
    // 兜底
    ['', 'zh-CN'],
    ['😀', 'zh-CN'],
  ];

  for (const [text, expected] of cases) {
    test(`${JSON.stringify(text)} → ${expected}`, () => {
      assert.equal(detectLang(text), expected);
    });
  }

  test('纯型号/数字不算英文', () => {
    assert.equal(detectLang('4090'), 'zh-CN');
    assert.equal(detectLang('B650M'), 'zh-CN');
    assert.equal(detectLang('2026'), 'zh-CN');
  });

  test('简繁同形词不会造成误判', () => {
    // 「清灰」「有没有」简繁写法相同，不该被当成繁体特征
    assert.equal(detectLang('清灰多少钱'), 'zh-CN');
    assert.equal(detectLang('有沒有装机'), 'zh-CN');
  });
});

// ───────────────────────── 问价路由 ─────────────────────────

describe('price-router: 是否在问价', () => {
  const yes = ['多少钱', '价格', '报价', '怎么收费', '费用', '贵不贵', 'how much', 'price', 'いくら', '料金'];
  const no = ['你好', '在吗', '谢谢', '收到', '你们老板叫什么', '这个功能怎么用'];

  for (const t of yes) {
    test(`「${t}」算问价`, () => assert.equal(asksPrice(t), true));
  }
  for (const t of no) {
    test(`「${t}」不算问价`, () => assert.equal(asksPrice(t), false));
  }

  test('空字符串不算问价', () => {
    assert.equal(asksPrice(''), false);
    assert.equal(asksPrice(null), false);
  });
});

describe('price-router: 嫌贵识别', () => {
  const complains = ['太贵了', '好贵啊', '有点贵', '价格好高', '能便宜点吗', '别家更便宜', '性价比不高', 'too expensive', '高い'];
  for (const t of complains) {
    test(`「${t}」是嫌贵`, () => assert.equal(isPriceComplaint(t), true));
  }

  test('正常问价不算嫌贵', () => {
    assert.equal(isPriceComplaint('多少钱'), false);
    assert.equal(isPriceComplaint('装机价格'), false);
  });
});

describe('price-router: 服务项识别', () => {
  test('装机相关', () => {
    assert.deepEqual(detectServices('装机多少钱'), ['assembly']);
    assert.deepEqual(detectServices('组装一台'), ['assembly']);
    assert.deepEqual(detectServices('組一台電腦'), ['assembly']);
  });

  test('笔记本优先于台式机', () => {
    // 「清灰」两者都有，但说了笔记本就该走笔记本
    assert.deepEqual(detectServices('笔记本清灰多少钱'), ['laptop-cleaning']);
    assert.deepEqual(detectServices('筆電清灰多少錢'), ['laptop-cleaning']);
    assert.deepEqual(detectServices('笔记本维修'), ['laptop-repair']);
  });

  test('明确说台式机时不走笔记本', () => {
    assert.deepEqual(detectServices('台式机清灰多少钱'), ['cleaning']);
  });

  test('没说台式机也没说笔记本时，按台式机处理', () => {
    assert.deepEqual(detectServices('清灰多少钱'), ['cleaning']);
    assert.deepEqual(detectServices('维修多少钱'), ['repair']);
  });

  test('技术支持类', () => {
    assert.deepEqual(detectServices('装系统多少钱'), ['setup']);
    assert.deepEqual(detectServices('数据迁移多少钱'), ['backup']);
    assert.deepEqual(detectServices('杀毒多少钱'), ['malware']);
    assert.deepEqual(detectServices('验机多少钱'), ['inspection']);
  });

  test('没提具体服务返回空数组', () => {
    assert.deepEqual(detectServices('多少钱'), []);
    assert.deepEqual(detectServices(''), []);
  });

  test('英文与日语也能识别', () => {
    assert.deepEqual(detectServices('How much is assembly'), ['assembly']);
    assert.deepEqual(detectServices('price for cleaning'), ['cleaning']);
    assert.deepEqual(detectServices('組立の料金'), ['assembly']);
    assert.deepEqual(detectServices('清掃はいくら'), ['cleaning']);
  });
});

describe('price-router: 路由决策', () => {
  test('泛问价 → 总表', () => {
    const r = routePricePage('多少钱');
    assert.equal(r.key, 'all');
    assert.equal(r.reason, 'no-service-specified');
  });

  test('问装机 → 装机页', () => {
    assert.equal(routePricePage('装机多少钱').key, 'assembly');
  });

  test('只发服务名也算询价', () => {
    const r = routePricePage('装机');
    assert.equal(r.key, 'assembly');
    assert.equal(r.reason, 'service-name-only');
  });

  test('长句子描述情况时不抢答', () => {
    // 客户在描述问题，不是在问价 —— 交给 AI 更合适
    assert.equal(routePricePage('我这台电脑昨天开始一直蓝屏重启进不去系统了怎么办'), null);
  });

  test('多个台式机项 → 台式机总页', () => {
    const r = routePricePage('装机+清灰多少钱');
    assert.equal(r.key, 'desktop-overview');
    assert.equal(r.reason, 'multi-desktop');
  });

  test('嫌贵不发报价页', () => {
    const r = routePricePage('太贵了');
    assert.ok(r, '应该返回对象而不是 null');
    assert.equal(r.key, null);
    assert.equal(r.reason, 'price-complaint');
  });

  test('非问价返回 null', () => {
    assert.equal(routePricePage('你好'), null);
    assert.equal(routePricePage('你们老板叫什么'), null);
    assert.equal(routePricePage(''), null);
  });

  test('pageOf 能解析虚拟键 desktop-overview', () => {
    const p = pageOf('desktop-overview');
    assert.ok(p);
    assert.equal(p.path, '/service/desktop');
  });

  test('pageOf 遇到空键返回 null', () => {
    assert.equal(pageOf(null), null);
    assert.equal(pageOf(''), null);
  });

  test('ROUTE_EXTRA 也有四种语言名称', () => {
    for (const lang of SUPPORTED_LANGS) {
      assert.ok(ROUTE_EXTRA['desktop-overview'].label[lang]);
    }
  });
});

// ───────────────────────── 报价回复组装 ─────────────────────────

describe('price-reply: 用户明确要求的两条', () => {
  test('没有任何其他信息 → /zh-CN/service', () => {
    const r = buildPriceReply('多少钱');
    assert.equal(r.url, 'https://www.akikazu.co.jp/zh-CN/service');
  });

  test('确认到装机 → /zh-CN/service/desktop?item=assembly', () => {
    const r = buildPriceReply('装机多少钱');
    assert.equal(r.url, 'https://www.akikazu.co.jp/zh-CN/service/desktop?item=assembly');
  });
});

describe('price-reply: 多语言', () => {
  test('简体客户拿到简体页面', () => {
    const r = buildPriceReply('装机多少钱');
    assert.equal(r.lang, 'zh-CN');
    assert.match(r.url, /\/zh-CN\//);
  });

  test('繁体客户拿到繁体页面', () => {
    const r = buildPriceReply('你們組裝多少錢');
    assert.equal(r.lang, 'zh-TW');
    assert.match(r.url, /\/zh-TW\//);
    assert.equal(r.card.main_title.title, '到府組裝');
  });

  test('英文客户拿到英文页面', () => {
    const r = buildPriceReply('How much is assembly');
    assert.equal(r.lang, 'en-US');
    assert.match(r.url, /\/en-US\//);
    assert.equal(r.card.source.desc, 'Akikazu PC');
  });

  test('日语客户拿到日语页面（无前缀）', () => {
    const r = buildPriceReply('清掃はいくら');
    assert.equal(r.lang, 'ja');
    assert.ok(!r.url.includes('/zh-'), `日语链接不该有中文前缀: ${r.url}`);
    assert.ok(!r.url.includes('/en-US/'));
  });

  test('可以用 lang 参数强制语言', () => {
    const r = buildPriceReply('多少钱', { lang: 'en-US' });
    assert.equal(r.lang, 'en-US');
    assert.match(r.url, /\/en-US\//);
  });

  test('四种语言的卡片文案各不相同', () => {
    const titles = SUPPORTED_LANGS.map((l) => {
      const r = buildPriceReply('装机多少钱', { lang: l });
      return r.url;
    });
    assert.equal(new Set(titles).size, 4, '四种语言应该拼出四个不同链接');
  });
});

describe('price-reply: 不是问价就不管', () => {
  test('寒暄返回 null', () => {
    assert.equal(buildPriceReply('你好'), null);
    assert.equal(buildPriceReply('谢谢'), null);
  });

  test('嫌贵返回 null（不甩价格表）', () => {
    assert.equal(buildPriceReply('太贵了'), null);
    assert.equal(buildPriceReply('能便宜点吗'), null);
  });

  test('空消息返回 null', () => {
    assert.equal(buildPriceReply(''), null);
  });
});

describe('price-reply: 卡片结构', () => {
  const r = buildPriceReply('装机多少钱');

  test('card_action 是 url 类型且指向价格页', () => {
    assert.equal(r.card.card_type, 'text_notice');
    assert.equal(r.card.card_action.type, 1);
    assert.equal(r.card.card_action.url, r.url);
  });

  test('jump_list 只有一条，避免客户不知道点哪', () => {
    assert.equal(r.card.jump_list.length, 1);
    assert.equal(r.card.jump_list[0].url, r.url);
  });

  test('横向信息不超过 6 条（官方限制）', () => {
    assert.ok(r.card.horizontal_content_list.length <= 6);
  });

  test('副标题不超过官方建议的 112 字', () => {
    for (const lang of SUPPORTED_LANGS) {
      const x = buildPriceReply('多少钱', { lang });
      assert.ok(
        x.card.sub_title_text.length <= 112,
        `${lang} 副标题 ${x.card.sub_title_text.length} 字，超了`
      );
    }
  });

  test('主标题不超过建议的 26 字', () => {
    for (const lang of SUPPORTED_LANGS) {
      for (const q of ['多少钱', '装机多少钱', '笔记本清灰多少钱']) {
        const x = buildPriceReply(q, { lang });
        assert.ok(
          x.card.main_title.title.length <= 26,
          `${lang}/${q} 标题「${x.card.main_title.title}」过长`
        );
      }
    }
  });

  test('plain 里带链接，方便落库和不支持卡片的渠道', () => {
    assert.ok(r.plain.includes(r.url));
  });
});

describe('price-reply: explainPriceReply', () => {
  test('能渲染成可读文本', () => {
    const text = explainPriceReply(buildPriceReply('装机多少钱'));
    assert.ok(text.includes('zh-CN'));
    assert.ok(text.includes('https://www.akikazu.co.jp/zh-CN/service/desktop?item=assembly'));
  });

  test('null 也能给出说明', () => {
    assert.ok(explainPriceReply(null).length > 0);
  });
});

// ───────────────────────── 适配器 ─────────────────────────

describe('wecom-bot: 模板卡片帧', () => {
  const card = buildPriceCard({
    title: '上门装机',
    desc: '日元含税',
    subtitle: '点开看具体价格',
    url: 'https://www.akikazu.co.jp/zh-CN/service/desktop?item=assembly',
    urlLabel: '查看价格',
    rows: [{ keyname: '服务', value: '上门装机' }],
  });

  test('buildReplyCard 产出 template_card 帧', () => {
    const frame = buildReplyCard('req-1', card);
    assert.equal(frame.cmd, 'aibot_respond_msg');
    assert.equal(frame.headers.req_id, 'req-1');
    assert.equal(frame.body.msgtype, 'template_card');
    assert.equal(frame.body.template_card, card);
  });

  test('buildPriceCard 的 card_action 是跳转 URL', () => {
    assert.equal(card.card_action.type, 1);
    assert.ok(card.card_action.url.startsWith('https://'));
  });

  test('buildPriceCard 缺参数抛错', () => {
    assert.throws(() => buildPriceCard({ url: 'https://x.y' }), /title/);
    assert.throws(() => buildPriceCard({ title: 'x' }), /url/);
  });

  test('横向信息超过 6 条会被截断', () => {
    const c = buildPriceCard({
      title: 't',
      url: 'https://x.y',
      rows: Array.from({ length: 10 }, (_, i) => ({ keyname: `k${i}`, value: `v${i}` })),
    });
    assert.equal(c.horizontal_content_list.length, 6);
  });

  test('没有 rows 时不生成空数组', () => {
    const c = buildPriceCard({ title: 't', url: 'https://x.y' });
    assert.equal(c.horizontal_content_list, undefined);
  });
});

// ───────────────── 补充：问「有没有这服务」也走价格页 ─────────────────

describe('price-router: 询问是否有某服务', () => {
  test('英文 do you offer + 服务项', () => {
    const r = buildPriceReply('Do you offer cleaning');
    assert.ok(r);
    assert.equal(r.key, 'cleaning');
    assert.match(r.url, /\/en-US\//);
  });

  test('只问上门 → 上门费用页', () => {
    for (const q of ['你们有上门服务吗', 'Do you offer on-site service', '出張できますか']) {
      const r = buildPriceReply(q);
      assert.ok(r, `「${q}」应该走报价`);
      assert.equal(r.key, 'onsite', `「${q}」应该送去上门页`);
    }
  });

  test('日文 修理はありますか', () => {
    const r = buildPriceReply('修理はありますか');
    assert.equal(r.key, 'repair');
    assert.equal(r.lang, 'ja');
  });

  test('「有没有」不会被当成寒暄', () => {
    assert.equal(buildPriceReply('有没有组装服务')?.key, 'assembly');
  });
});
