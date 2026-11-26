/**
 * 话术卡片与话术库测试
 *
 * 这一块的核心性质是「稳」：
 *   - 问价必须命中报价，且回复一字不差
 *   - 嫌贵、问模板这类不能误触发
 *   - 卡片在手机端不折行
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { dispWidth, renderCard, checkCardWidth, isRuleLine } from '../qa/card.js';
import { looksLikeAsk, matchSnippet, validateSnippets } from '../qa/snippets.js';

// ───────────────────────── 宽度估算 ─────────────────────────

test('dispWidth: 中文算 2、英文算 1', () => {
  assert.equal(dispWidth('价格'), 4);
  assert.equal(dispWidth('price'), 5);
  assert.equal(dispWidth('价格 100'), 8, '4 + 空格 1 + 3');
  assert.equal(dispWidth(''), 0);
});

test('dispWidth: emoji 算 2', () => {
  assert.equal(dispWidth('👌'), 2);
  assert.equal(dispWidth('💰'), 2);
});

test('dispWidth: 全角标点算 2', () => {
  assert.equal(dispWidth('，'), 2);
  assert.equal(dispWidth('。'), 2);
});

test('dispWidth: 空值不报错', () => {
  assert.equal(dispWidth(null), 0);
  assert.equal(dispWidth(undefined), 0);
});

// ───────────────────────── 卡片渲染 ─────────────────────────

describe('card: renderCard', () => {
  test('完整字段都渲染出来', () => {
    const t = renderCard({
      title: '产品报价',
      intro: '价格按用量算',
      plans: [
        { name: '基础版', price: '2980 元', unit: '年', items: ['10 个账号'], note: '适合小团队' },
      ],
      notes: ['年付 9 折'],
      cta: { text: '想知道精确报价请告诉我们人数', url: 'https://example.com/price' },
      footer: '—— XX 科技',
    });

    assert.match(t, /🎯 产品报价/);
    assert.match(t, /价格按用量算/);
    assert.match(t, /📦 基础版/);
    assert.match(t, /2980 元 \/ 年/);
    assert.match(t, /· 10 个账号/);
    assert.match(t, /适合小团队/);
    assert.match(t, /✨ 年付 9 折/);
    assert.match(t, /👉 /);
    assert.match(t, /https:\/\/example\.com\/price/);
    assert.match(t, /—— XX 科技/);
  });

  test('没有 unit 时价格不出现多余的斜杠', () => {
    const t = renderCard({ plans: [{ name: 'A', price: '100 元' }] });
    assert.match(t, /100 元/);
    assert.ok(!t.includes('/ '), '不应出现空单位');
  });

  test('跳过没有 name 的套餐', () => {
    const t = renderCard({ plans: [{ price: '1' }, { name: 'B', price: '2' }] });
    assert.match(t, /📦 B/);
    assert.equal((t.match(/📦/g) || []).length, 1);
  });

  test('空配置返回空串，不炸', () => {
    assert.equal(renderCard({}), '');
    assert.equal(renderCard(), '');
  });

  test('多行 intro / cta 原样保留换行', () => {
    const t = renderCard({ intro: '第一行\n第二行', cta: { text: 'A\nB' } });
    assert.ok(t.includes('第一行\n第二行'));
    assert.ok(t.includes('👉 A\nB'));
  });
});

describe('card: checkCardWidth', () => {
  test('纯分隔线不算超宽（它就是为了凑满一行画的）', () => {
    const line = '─'.repeat(40);
    const { over } = checkCardWidth(line, 34);
    assert.equal(over.length, 0);
  });

  test('正文超宽会被报出来', () => {
    const { over, maxWidth } = checkCardWidth('这是一句非常非常长的话，长到在手机上肯定要折行了', 20);
    assert.equal(over.length, 1);
    assert.ok(maxWidth > 20);
  });

  test('短文案不报', () => {
    const { over, maxWidth } = checkCardWidth('短句', 34);
    assert.equal(over.length, 0);
    assert.equal(maxWidth, 4);
  });

  test('isRuleLine 只认分隔符', () => {
    assert.equal(isRuleLine('─────'), true);
    assert.equal(isRuleLine('===='), true);
    assert.equal(isRuleLine('——'), false, '两个字符太短，可能是正文');
    assert.equal(isRuleLine('普通文字'), false);
  });
});

// ───────────────────────── 问句判断 ─────────────────────────

describe('snippets: looksLikeAsk', () => {
  test('常见问法都算问句', () => {
    for (const t of ['多少钱', '价格怎么算', '能试用吗', '怎么收费', '有没有优惠', '能开专票吗', '要专票', '你们老板叫什么']) {
      assert.equal(looksLikeAsk(t), true, `${t} 应该是问句`);
    }
  });

  test('寒暄和致谢不算问句', () => {
    for (const t of ['你好', '您好', '在吗', '在么', '谢谢', '好的', '收到', '好的👌', 'hi', 'hello']) {
      assert.equal(looksLikeAsk(t), false, `${t} 不该算问句`);
    }
  });

  test('纯感叹不算问句', () => {
    for (const t of ['太贵了', '你们真好', '真好用', '太棒了']) {
      assert.equal(looksLikeAsk(t), false, `${t} 不该算问句`);
    }
  });

  test('带疑问词的评价算问句，靠负面词兜住', () => {
    // 「这个有点贵」「价格好高」确实带「有/价格」，语形上是问句；但语义是嫌贵。
    // 这层不负责语义判断，交给 isPriceComplaint / negative 处理（见 matchSnippet 用例）。
    assert.equal(looksLikeAsk('这个有点贵'), true);
    assert.equal(looksLikeAsk('价格好高'), true);
  });

  test('空值不报错', () => {
    assert.equal(looksLikeAsk(''), false);
    assert.equal(looksLikeAsk(null), false);
  });
});

// ───────────────────────── 话术匹配 ─────────────────────────

describe('snippets: matchSnippet', () => {
  const snippets = [
    {
      id: 'price',
      label: '报价',
      priority: 100,
      keywords: ['多少钱', '价格', '报价', '怎么收费'],
      exclude: ['模板', '表格'],
      negative: ['便宜', '贵了', '太贵', '划算'],
      reply: '报价卡片',
    },
    {
      id: 'enterprise',
      label: '私有化',
      priority: 110,
      keywords: ['私有化', '本地部署'],
      reply: '私有化报价',
    },
    {
      id: 'hello',
      label: '寒暄',
      keywords: ['你好', '在吗'],
      reply: '在的',
      requireQuestion: false,
    },
  ];

  test('问价命中报价', () => {
    for (const t of ['多少钱', '你们这个多少钱', '价格怎么算', '怎么收费啊']) {
      assert.equal(matchSnippet(t, snippets)?.id, 'price', `${t} 应命中报价`);
    }
  });

  test('优先级高的先命中', () => {
    // 「私有化怎么收费」同时命中 price 和 enterprise
    assert.equal(matchSnippet('私有化怎么收费', snippets)?.id, 'enterprise');
  });

  test('排除词生效', () => {
    assert.equal(matchSnippet('报价单模板能给我吗', snippets), null);
  });

  test('负面词生效：客户在嫌贵时不要甩价格表', () => {
    for (const t of ['这个便宜吗', '是不是贵了点', '便宜点行不行']) {
      assert.equal(matchSnippet(t, snippets), null, `${t} 不该命中报价`);
    }
  });

  test('逐条 requireQuestion=false 可以匹配非问句', () => {
    assert.equal(matchSnippet('你好', snippets)?.id, 'hello');
    assert.equal(matchSnippet('在吗', snippets)?.id, 'hello');
  });

  test('没命中返回 null', () => {
    assert.equal(matchSnippet('你们老板叫什么', snippets), null);
    assert.equal(matchSnippet('', snippets), null);
    assert.equal(matchSnippet('随便说的话', []), null);
  });

  test('全局 requireQuestion=false 时所有话术都可匹配非问句', () => {
    const sn = [{ id: 'x', keywords: ['真好'], reply: 'R' }];
    assert.equal(matchSnippet('你们真好', sn), null, '默认要求问句');
    assert.equal(matchSnippet('你们真好', sn, { requireQuestion: false })?.id, 'x');
  });

  test('负面词是第二道闸：语形像问句但语义是嫌贵时也拦住', () => {
    // 「价格好高」looksLikeAsk 为 true，只有 negative 能拦住
    assert.equal(matchSnippet('价格好高', snippets), null);
    assert.equal(matchSnippet('价格好贵啊', snippets), null);
  });

  test('reply 为空的话术被忽略，避免发出空消息', () => {
    const sn = [{ id: 'bad', keywords: ['多少钱'], reply: '' }];
    assert.equal(matchSnippet('多少钱', sn), null);
  });
});

// ───────────────────────── 配置校验 ─────────────────────────

describe('snippets: validateSnippets', () => {
  test('合法配置没有问题', () => {
    assert.deepEqual(validateSnippets([{ id: 'a', keywords: ['x'], reply: 'y' }]), []);
  });

  test('缺 id / 缺关键词 / 缺内容都报出来', () => {
    const p = validateSnippets([{}]);
    assert.ok(p.some((s) => s.includes('缺 id')));
    assert.ok(p.some((s) => s.includes('keywords')));
    assert.ok(p.some((s) => s.includes('reply')));
  });

  test('id 重复被报出来', () => {
    const p = validateSnippets([
      { id: 'a', keywords: ['x'], reply: '1' },
      { id: 'a', keywords: ['y'], reply: '2' },
    ]);
    assert.ok(p.some((s) => s.includes('重复')));
  });
});

// ───────────────────────── 自带示例配置 ─────────────────────────

describe('snippets: data/snippets.example.json', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../data/snippets.example.json', import.meta.url), 'utf8'));
  const list = cfg.snippets;

  test('配置本身合法', () => {
    assert.deepEqual(validateSnippets(list), []);
  });

  test('问价不再走话术（已交给 qa/price-reply.js 发价格页）', () => {
    // 话术库里保留 price 会和网站价格页卡片抢，所以示例配置里必须没有它
    assert.equal(list.find((s) => s.id === 'price'), undefined);
    assert.equal(matchSnippet('你们这个多少钱', list), null);
  });

  test('定制开发仍然走话术', () => {
    const r = matchSnippet('能定制开发吗', list);
    assert.ok(r, '应该命中');
    assert.equal(r.id, 'price-enterprise');
  });

  test('所有卡片都在安全宽度内，手机端不折行', () => {
    for (const s of list) {
      const { over, maxWidth } = checkCardWidth(s.reply, 34);
      assert.equal(over.length, 0, `${s.id} 有超宽行（最宽 ${maxWidth}）：${over.map((o) => o.line)}`);
    }
  });

  test('嫌贵不触发报价', () => {
    assert.equal(matchSnippet('这个价格好便宜啊', list), null);
    assert.equal(matchSnippet('是不是有点贵了', list), null);
  });
});

// ─────────────────── 真实提问回归集（来自实际聊天语气） ───────────────────
// 这些句子是照着微信里客户真实发问的方式写的：多数没有问号、口语化、夹着错别字。

describe('snippets: 真实提问回归集', () => {
  const list = JSON.parse(
    fs.readFileSync(new URL('../data/snippets.example.json', import.meta.url), 'utf8')
  ).snippets;

  const shouldHit = [
    ['私有化怎么弄', 'price-enterprise'],
    ['能本地部署嘛', 'price-enterprise'],
    ['能试用不', 'trial'],
    ['有免费试用吗', 'trial'],
    ['能开专票吗', 'invoice'],
    ['发票怎么弄', 'invoice'],
    ['能报销吗', 'invoice'],
    ['怎么联系你们', 'contact'],
    ['转人工', 'contact'],
    ['我要人工', 'contact'],
    ['人工客服', 'contact'],
    ['客服在吗', 'contact'],
    ['你电话给我', 'contact'],
  ];

  for (const [q, id] of shouldHit) {
    test(`「${q}」命中 ${id}`, () => {
      const r = matchSnippet(q, list);
      assert.ok(r, `「${q}」应该命中，实际没命中`);
      assert.equal(r.id, id);
    });
  }

  // 下面这些绝不能触发报价：要么是嫌贵，要么压根不是在问价
  const shouldNotHit = [
    '太贵了',
    '有点贵啊',
    '价格好高',
    '能不能便宜点',
    '别家比你们便宜',
    '这个性价比不高',
    '你好',
    '在吗',
    '谢谢',
    '好的收到',
    '你们老板叫什么',
    '有价格表模板吗',
    '帮我做个 excel',
    '这个功能怎么用',
    // 报价句由 price-reply 接管，话术库必须放空，否则会文不对题
    // contact 是 requireQuestion:false（「转人工」不带问号），
    // 所以必须确认它不会被「讨论人工」的句子误触
    '你们是人工回复吗',
    '这个要人工审核吗',
    '人工成本高吗',
    'AI 会不会取代人工',
  ];

  for (const q of shouldNotHit) {
    test(`「${q}」不该命中任何话术`, () => {
      const r = matchSnippet(q, list);
      assert.equal(r, null, `「${q}」不该命中，却命中了「${r && r.label}」`);
    });
  }
});
