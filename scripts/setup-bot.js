#!/usr/bin/env node
/**
 * 企业微信智能机器人 · 凭据配置 + 真机自检
 *
 * 用法：
 *   node scripts/setup-bot.js            # 交互式：贴 BotID / Secret，写入 .env
 *   node scripts/setup-bot.js --test     # 只用现有 .env 试连一次，不进交互
 *   node scripts/setup-bot.js --show     # 看当前配置（Secret 打码）
 *
 * 写入的是项目根目录的 .env（已在 .gitignore 里，不会进仓库）。
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = path.join(ROOT, '.env');

const KEYS = ['WECOM_BOT_ID', 'WECOM_BOT_SECRET', 'AUTO_REPLY'];

/** 极简 .env 读写（不引依赖） */
export function readEnv(file = ENV_PATH) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

export function writeEnv(patch, file = ENV_PATH) {
  const cur = readEnv(file);
  Object.assign(cur, patch);
  const body =
    '# 由 scripts/setup-bot.js 生成，含密钥，已在 .gitignore 中\n' +
    Object.entries(cur)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') +
    '\n';
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}

export function mask(s) {
  if (!s) return '(未设置)';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}${'*'.repeat(Math.min(s.length - 8, 16))}${s.slice(-4)}`;
}

/** 常见误贴：把 Token / EncodingAESKey / 应用 Secret 当成机器人 Secret */
export function checkShape(botId, secret) {
  const problems = [];
  if (!botId) problems.push('BotID 为空');
  if (!secret) problems.push('Secret 为空');
  if (botId && /\s/.test(botId)) problems.push('BotID 里有空格，可能复制多了');
  if (secret && /\s/.test(secret)) problems.push('Secret 里有空格，可能复制多了');
  if (botId && /^ww[a-zA-Z0-9]{16,}$/.test(botId)) {
    problems.push('这个更像企业 CorpID（ww 开头），不是机器人 BotID');
  }
  if (secret && secret.length === 43) {
    problems.push('长度 43 的很可能是 EncodingAESKey，不是机器人 Secret');
  }
  return problems;
}

async function tryConnect({ botId, secret }) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'adapters/wecom-bot.js')).href);
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client?.close?.();
      } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), 15000);

    const client = mod.connectBot({
      config: { ...mod.loadBotConfig({}), botId, secret },
      onState: (state, detail) => {
        if (state === 'connected') done({ ok: true });
        if (state === 'error') done({ ok: false, reason: detail?.error || 'error' });
      },
      onMessage: () => {},
      onEvent: () => {},
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const cur = readEnv();

  if (argv.includes('--show')) {
    console.log('当前 .env 配置：');
    for (const k of KEYS) console.log(`  ${k} = ${k.includes('SECRET') ? mask(cur[k]) : cur[k] || '(未设置)'}`);
    return;
  }

  if (argv.includes('--test')) {
    const botId = cur.WECOM_BOT_ID || process.env.WECOM_BOT_ID;
    const secret = cur.WECOM_BOT_SECRET || process.env.WECOM_BOT_SECRET;
    const bad = checkShape(botId, secret);
    if (bad.length) {
      console.error('❌ 配置有问题：');
      for (const b of bad) console.error('   · ' + b);
      process.exit(1);
    }
    console.log('🔌 正在试连企业微信长连接…');
    const r = await tryConnect({ botId, secret });
    if (r.ok) {
      console.log('✅ 已连接。订阅成功，机器人可以收发消息了。');
    } else {
      console.error(`❌ 连接失败：${r.reason}`);
      console.error('   常见原因：BotID/Secret 不对、后台没开「API 模式 / 长连接」、');
      console.error('   或同一机器人已在别处建立长连接（互踢）。');
      process.exit(1);
    }
    return;
  }

  // 交互式
  const rl = readline.createInterface({ input, output });
  console.log('');
  console.log('企业微信智能机器人 · 凭据配置');
  console.log('─'.repeat(44));
  console.log('在后台「机器人详情 → API 模式 → 长连接」里能找到这两个值。');
  console.log('直接粘贴后回车即可，右边有空格也可以。');
  console.log('');

  let botId = '';
  while (!botId) {
    botId = (await rl.question('BotID:   ')).trim();
    if (!botId) console.log('  （不能为空）');
  }
  let secret = '';
  while (!secret) {
    secret = (await rl.question('Secret:  ')).trim();
    if (!secret) console.log('  （不能为空）');
  }
  rl.close();

  const bad = checkShape(botId, secret);
  if (bad.length) {
    console.log('');
    console.log('⚠️  提交前提醒：');
    for (const b of bad) console.log('   · ' + b);
    console.log('   如果确认无误仍要继续，请重新运行本脚本。');
    process.exit(1);
  }

  const file = writeEnv({ WECOM_BOT_ID: botId, WECOM_BOT_SECRET: secret, AUTO_REPLY: '1' });
  console.log('');
  console.log(`✅ 已写入 ${path.relative(process.cwd(), file) || file}`);
  console.log(`   BotID  = ${mask(botId)}`);
  console.log(`   Secret = ${mask(secret)}`);
  console.log('');
  console.log('下一步：');
  console.log('   node scripts/setup-bot.js --test    # 试连，看到「已连接」就成了');
  console.log('   npm run serve                       # 起服务，会带 .env 里的配置');
  console.log('');
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  });
}
