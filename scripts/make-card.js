#!/usr/bin/env node
/**
 * 报价话术卡片生成器
 *
 * 为什么需要它：
 *   企业微信「智能机器人」在单聊里**发不出链接**。链接要么被转成纯文本，
 *   要么点了跳不过去。所以「客户问价 → 直接把价格表页面甩过去」这条路，
 *   只能靠 markdown 卡片里的 A 标签（仅群里渲染）或者引导客户自己去点。
 *
 *   更现实的做法：把价格信息做成一张排版整齐的**卡片式文本**，
 *   用 emoji 当视觉分隔，在聊天窗口里看起来就是一张图。
 *   零成本、零依赖、不会被平台吞。
 *
 * 用法：
 *   node scripts/make-card.js                     # 用内置示例
 *   node scripts/make-card.js my-card.json        # 从 JSON 读
 *   node scripts/make-card.js my-card.json --json # 输出 JSON（给接口用）
 *
 * JSON 结构见 README「报价话术卡片」一节。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderCard, checkCardWidth, dispWidth } from '../qa/card.js';

export { dispWidth };

/** 聊天窗口里一行大约能放多少半角宽度（企微手机端约 34-38） */
const DEFAULT_WIDTH = 34;

/**
 * 兼容旧名字：渲染话术卡片
 * @param {Object} cfg
 * @returns {string}
 */
export function renderPriceCard(cfg = {}) {
  return renderCard(cfg);
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const asJson = args.includes('--json');

  const cfg = file
    ? JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
    : {
        title: '产品报价',
        intro: '价格按用量算，先给你一个大概区间 👇',
        plans: [
          {
            name: '基础版',
            price: '2980 元',
            unit: '年',
            items: ['10 个账号', '标准客服功能', '工单 + 知识库'],
            note: '适合 5 人以内小团队',
          },
          {
            name: '专业版',
            price: '9800 元',
            unit: '年',
            items: ['50 个账号', '含 AI 自动回复', '开放 API'],
            note: '大多数客户选这个',
          },
          {
            name: '私有化部署',
            price: '39800 元',
            unit: '起',
            items: ['装到你们自己服务器', '含一年维护', '实施 3-5 个工作日'],
          },
        ],
        notes: ['年付 9 折', '首年赠送 2 次上门培训', '支持专票'],
        cta: { text: '想要精确报价？告诉我你们大概多少人用', url: '' },
        footer: '—— 我们是 XX 科技，做企业级客服系统',
      };

  const text = renderPriceCard(cfg);
  const { over, maxWidth } = checkCardWidth(text, cfg.width);

  if (asJson) {
    console.log(JSON.stringify({ text, maxWidth, over: over.map((o) => o.w) }, null, 2));
    return;
  }

  console.log(text);
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`最宽一行 ${maxWidth} 个半角字符`);
  if (over.length) {
    console.log(`⚠️  有 ${over.length} 行超过 ${cfg.width || DEFAULT_WIDTH}，可能会折行：`);
    for (const o of over) console.log(`   (${o.w}) ${o.line.slice(0, 40)}`);
  } else {
    console.log('✅ 都在安全宽度内，企微手机端不会折行');
  }
}

// 只在直接运行时执行（被 import 时不跑）
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
