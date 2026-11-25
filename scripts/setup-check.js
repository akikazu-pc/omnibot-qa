#!/usr/bin/env node
/**
 * 配置向导
 *
 * 检查环境变量是否齐全，告诉你缺什么、去哪拿。
 * 用法：node scripts/setup-check.js
 */
import { isBotConfigured, loadBotConfig } from '../adapters/wecom-bot.js';
import { isWecomConfigured, loadWecomConfig } from '../adapters/wecom-send.js';
import { isLlmConfigured } from '../qa/agent.js';

const c = process.stdout.isTTY ? '\x1b[36m' : '';
const g = process.stdout.isTTY ? '\x1b[32m' : '';
const r = process.stdout.isTTY ? '\x1b[31m' : '';
const y = process.stdout.isTTY ? '\x1b[33m' : '';
const dim = process.stdout.isTTY ? '\x1b[2m' : '';
const b = process.stdout.isTTY ? '\x1b[1m' : '';
const x = process.stdout.isTTY ? '\x1b[0m' : '';

function line(ok, label, detail, where) {
  const mark = ok ? `${g}✓${x}` : `${r}✗${x}`;
  console.log(`  ${mark} ${label.padEnd(22)} ${ok ? dim + detail + x : `${y}${detail}${x}`}`);
  if (!ok && where) console.log(`    ${dim}→ ${where}${x}`);
}

console.log(`\n${b}omnibot-qa 配置检查${x}\n`);

console.log(`${b}大模型（必需，用于生成回复）${x}`);
const llmOk = isLlmConfigured();
line(llmOk, 'OPENAI_API_KEY', llmOk ? '已设置' : '未设置', '任意 OpenAI 兼容服务的 API Key');
line(Boolean(process.env.OPENAI_BASE_URL), 'OPENAI_BASE_URL', process.env.OPENAI_BASE_URL || '未设置（用默认）', '如 DeepSeek: https://api.deepseek.com/v1');
line(Boolean(process.env.OPENAI_MODEL), 'OPENAI_MODEL', process.env.OPENAI_MODEL || '未设置（用默认）', '模型名，如 deepseek-chat');

console.log(`\n${b}企业微信 · 智能机器人长连接（推荐，不需要公网域名）${x}`);
const botCfg = loadBotConfig();
const botOk = isBotConfigured();
line(botOk, 'WECOM_BOT_ID', botCfg.botId || '未设置', '企业微信后台 → 应用管理 → 智能机器人 → BotID');
line(botOk, 'WECOM_BOT_SECRET', botCfg.secret ? '已设置' : '未设置', '同上页面 → 机器人详情 → Secret');

console.log(`\n${b}企业微信 · 自建应用（可选，用于消息 API 发送）${x}`);
const weCfg = loadWecomConfig();
line(isWecomConfigured(), 'WECOM_CORP_ID', weCfg.corpId || '未设置', '我的企业 → 企业信息 → 企业ID');
line(isWecomConfigured(), 'WECOM_AGENT_ID', weCfg.agentId || '未设置', '应用详情页 → AgentId');
line(isWecomConfigured(), 'WECOM_SECRET', weCfg.secret ? '已设置' : '未设置', '应用详情页 → Secret');

console.log(`\n${b}个性化（可选）${x}`);
line(Boolean(process.env.BOT_PERSONA), 'BOT_PERSONA', process.env.BOT_PERSONA || '未设置', '你是谁的人设，如「，叫小助手，语气亲切」');
line(Boolean(process.env.BOT_BUSINESS), 'BOT_BUSINESS', process.env.BOT_BUSINESS || '未设置', '公司/产品简介，用于回答业务问题');

const ready = llmOk && botOk;
console.log(
  ready
    ? `\n${g}${b}✅ 配置齐全，可以启动${x}\n\n  ${c}AUTO_REPLY=1 npm start${x}\n\n`
    : `\n${y}${b}⚠️  还缺配置${x}\n\n  最小可跑组合：OPENAI_API_KEY + WECOM_BOT_ID + WECOM_BOT_SECRET\n  若企业微信后台没有智能机器人，先建「智能机器人」或「自建应用」\n\n`
);

process.exit(ready ? 0 : 1);
