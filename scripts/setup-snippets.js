#!/usr/bin/env node
/**
 * 话术初始化向导
 *
 * 解决什么问题：
 *   「客户问价直接发报价」听起来简单，但落地要填一堆东西：关键词、排除词、
 *   优先级、排版换行。手写 JSON 容易错一个逗号就全废。
 *
 *   这个脚本做三件事：
 *   1. 从零生成 data/snippets.json（用你的真实价格）
 *   2. 检查已有话术：会不会误触发、卡片会不会折行
 *   3. 给出一句话测试：模拟客户提问，看命中哪条
 *
 * 用法：
 *   node scripts/setup-snippets.js init          # 交互式创建（推荐）
 *   node scripts/setup-snippets.js init --demo   # 用示例数据快速看效果
 *   node scripts/setup-snippets.js lint          # 检查现有配置
 *   node scripts/setup-snippets.js try "多少钱"   # 测试一句话
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { renderCard, checkCardWidth } from '../qa/card.js';
import { matchSnippet, validateSnippets } from '../qa/snippets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'snippets.json');
const DEMO = path.join(ROOT, 'data', 'snippets.example.json');

function ask(rl, question, fallback = '') {
  return new Promise((resolve) => {
    rl.question(fallback ? `${question}（${fallback}）` : question, (ans) => {
      resolve(String(ans || '').trim() || fallback);
    });
  });
}

async function init() {
  if (fs.existsSync(OUT)) {
    console.log(`\n⚠️  ${path.relative(ROOT, OUT)} 已存在。`);
    console.log('   想改就直接编辑它，或先删掉再跑 init。\n');
    return;
  }

  if (process.argv.includes('--demo')) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.copyFileSync(DEMO, OUT);
    console.log(`\n✅ 已生成 ${path.relative(ROOT, OUT)}（示例数据）`);
    console.log('   现在编辑这个文件，把价格和话术换成你自己的。\n');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`
${'─'.repeat(56)}
  话术初始化
  接下来问几个问题，答案会被写进 data/snippets.json
  不确定的直接回车跳过，之后再改文件也行
${'─'.repeat(56)}`);

  const company = await ask(rl, '\n1. 公司/品牌名：', '我们');
  console.log('\n2. 填入你的套餐（最多 3 个，留空结束）');

  const plans = [];
  for (let i = 1; i <= 3; i++) {
    const name = await ask(rl, `   套餐 ${i} 名称：`);
    if (!name) break;
    const price = await ask(rl, `   ${name} 价格（如 2980 元）：`);
    const unit = await ask(rl, `   计价单位：`, '年');
    const itemsRaw = await ask(rl, `   包含内容（逗号分隔）：`);
    plans.push({
      name,
      price,
      unit,
      items: itemsRaw ? itemsRaw.split(/[,，、]/).map((s) => s.trim()).filter(Boolean) : [],
    });
  }

  const notesRaw = await ask(rl, '\n3. 优惠政策（逗号分隔，可留空）：');
  const phone = await ask(rl, '4. 联系电话 / 微信（可留空）：');
  rl.close();

  const card = renderCard({
    title: '产品报价',
    intro: '价格按用量算\n先给你一个大概区间 👇',
    plans: plans.length ? plans : [{ name: '基础版', price: '面议', items: ['按需求定制'] }],
    notes: notesRaw ? notesRaw.split(/[,，、]/).map((s) => s.trim()).filter(Boolean) : [],
    cta: { text: '想要精确报价？\n告诉我你们大概多少人用' },
    footer: `—— ${company}`,
  });

  const priceSnippet = {
    id: 'price',
    label: '报价',
    priority: 100,
    keywords: ['多少钱', '什么价', '价格', '报价', '怎么卖', '怎么收费', '如何收费', '费用', '贵不贵', '几块', '咋卖'],
    exclude: ['模板', '表格', 'excel', 'ppt', '话术'],
    reply: card,
  };

  const snippets = [priceSnippet];
  if (phone) {
    snippets.push({
      id: 'contact',
      label: '联系方式',
      priority: 70,
      keywords: ['电话', '联系方式', '加个微信', '怎么联系', '人工', '转人工'],
      reply: `可以直接联系我 👇\n${phone}\n工作日 9:00-18:00`,
    });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ _说明: '改完重启服务生效', snippets }, null, 2), 'utf8');

  // 立刻自检，有问题当场告诉用户
  const problems = validateSnippets(snippets);
  const { over, maxWidth } = checkCardWidth(card, 34);

  console.log(`\n${'─'.repeat(56)}\n✅ 已写入 ${path.relative(ROOT, OUT)}\n`);
  console.log('生成的话术预览：\n');
  console.log(card);
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`最宽一行 ${maxWidth} 个半角字符`);
  if (over.length) {
    console.log(`⚠️  有 ${over.length} 行可能折行，想更整齐可以手动加换行：`);
    for (const o of over) console.log(`   (${o.w}) ${o.line}`);
  } else {
    console.log('✅ 排版在安全宽度内，手机端不会折行');
  }
  if (problems.length) {
    console.log('⚠️  配置有问题：');
    for (const p of problems) console.log(`   ${p}`);
  }
  console.log('\n下一步：重启服务，然后测试');
  console.log('   node scripts/setup-snippets.js try "你们多少钱"\n');
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    return Array.isArray(d) ? d : d.snippets || [];
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`\n还没有 ${path.relative(ROOT, OUT)}`);
      console.log('先跑：node scripts/setup-snippets.js init\n');
      return null;
    }
    console.log(`读取失败：${err.message}\n`);
    return null;
  }
}

function lint() {
  const list = load();
  if (!list) return;

  console.log(`\n共 ${list.length} 条话术\n`);

  const problems = validateSnippets(list);
  let bad = 0;

  for (const s of list) {
    const { over, maxWidth } = checkCardWidth(s.reply, 34);
    const flag = over.length ? '⚠️ ' : '✅';
    console.log(`${flag} ${(s.label || s.id).padEnd(14)} 优先级 ${String(s.priority || 0).padStart(3)}  最宽 ${maxWidth}`);
    if (over.length) {
      bad++;
      for (const o of over) console.log(`      (${o.w}) ${o.line}`);
    }
  }

  if (problems.length) {
    console.log('\n❌ 配置错误：');
    for (const p of problems) console.log(`   ${p}`);
  }
  if (!bad && !problems.length) console.log('\n全部正常。');

  // 冲突检测：两条话术的触发词高度重叠，容易互相抢
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i].keywords || [];
      const b = list[j].keywords || [];
      const shared = a.filter((k) => b.includes(k));
      if (shared.length) {
        console.log(`\n⚠️  「${list[i].label || list[i].id}」和「${list[j].label || list[j].id}」共用关键词：${shared.join(', ')}`);
        console.log(`   同时命中时按优先级决出（${list[i].priority || 0} vs ${list[j].priority || 0}）`);
      }
    }
  }
  console.log('');
}

function tryText() {
  const text = process.argv.slice(3).join(' ');
  const list = load();
  if (!list) return;
  if (!text) {
    console.log('用法：node scripts/setup-snippets.js try "你们多少钱"\n');
    return;
  }

  const hit = matchSnippet(text, list);
  console.log(`\n客户说：${text}`);
  if (!hit) {
    console.log('结果：没有命中任何话术 → 会交给 AI 回答\n');
    return;
  }
  const { maxWidth, over } = checkCardWidth(hit.reply, 34);
  console.log(`结果：命中「${hit.label || hit.id}」  (最宽 ${maxWidth}${over.length ? `，${over.length} 行会折行` : '，不会折行'})\n`);
  console.log(hit.reply);
  console.log('');
}

function main() {
  const cmd = process.argv[2] || 'lint';
  if (cmd === 'init') return init();
  if (cmd === 'lint') return lint();
  if (cmd === 'try') return tryText();
  console.log(`
话术工具

  node scripts/setup-snippets.js init          交互式创建 data/snippets.json
  node scripts/setup-snippets.js init --demo   用示例数据快速看效果
  node scripts/setup-snippets.js lint          检查现有配置（排版、冲突、错误）
  node scripts/setup-snippets.js try "多少钱"   测试一句话会命中什么
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  Promise.resolve(main()).catch((e) => {
    console.error('失败：', e.message);
    process.exit(1);
  });
}
