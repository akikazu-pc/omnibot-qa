#!/usr/bin/env node
/**
 * 微信客服 / 企业微信回调自检工具
 *
 * 用途：在把回调地址填进企微后台之前，先自测这条路通不通。
 *
 *   node scripts/check-webhook.js                       # 检查本地服务是否起来
 *   node scripts/check-webhook.js https://你的域名       # 检查公网域名能否被访问
 *   node scripts/check-webhook.js --simulate            # 用本地密钥模拟一次真实回调
 *
 * 为什么需要它：
 *   企微后台点「保存」时，它会立刻向你的 URL 发一个 GET 请求带 echostr。
 *   如果签名/解密有任何一个环节不对，你只会看到一句「回调地址验证失败」，
 *   完全没有细节。这个工具把每一步拆开告诉你哪一步挂了。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { loadEnvFile } = await import(pathToFileURL(path.join(ROOT, 'qa/env.js')).href);
loadEnvFile(path.join(ROOT, '.env'));

const c = process.stdout.isTTY ? '\x1b[36m' : '';
const g = process.stdout.isTTY ? '\x1b[32m' : '';
const r = process.stdout.isTTY ? '\x1b[31m' : '';
const y = process.stdout.isTTY ? '\x1b[33m' : '';
const b = process.stdout.isTTY ? '\x1b[1m' : '';
const x = process.stdout.isTTY ? '\x1b[0m' : '';

const ok = (m) => console.log(`  ${g}✓${x} ${m}`);
const bad = (m) => console.log(`  ${r}✗${x} ${m}`);
const warn = (m) => console.log(`  ${y}!${x} ${m}`);

async function main() {
  const args = process.argv.slice(2);
  const baseUrl = args.find((a) => a.startsWith('http'));

  console.log(`\n${b}回调自检${x}\n`);
  console.log(`${b}1. 本地配置${x}`);

  const cfg = {
    corpId: process.env.KF_CORP_ID || '',
    secret: process.env.KF_SECRET || '',
    token: process.env.KF_TOKEN || '',
    aesKey: process.env.KF_AES_KEY || '',
  };

  const missing = [];
  if (!cfg.corpId) missing.push('KF_CORP_ID');
  if (!cfg.secret) missing.push('KF_SECRET');
  if (!cfg.token) missing.push('KF_TOKEN');
  if (!cfg.aesKey) missing.push('KF_AES_KEY');

  if (missing.length) {
    bad(`缺少：${missing.join(', ')}`);
    console.log(`\n  先跑 ${c}npm run kf:setup${x} 补齐\n`);
    process.exit(1);
  }
  ok(`企业ID ${cfg.corpId.slice(0, 6)}…`);
  ok(`Secret ${cfg.secret.slice(0, 4)}…`);

  if (cfg.aesKey.length !== 43) {
    bad(`EncodingAESKey 长度 ${cfg.aesKey.length}，应为 43`);
    process.exit(1);
  }
  ok('EncodingAESKey 43 位');
  if (!/^[A-Za-z0-9]{1,32}$/.test(cfg.token)) {
    bad('Token 应是英文数字且 ≤32 位');
    process.exit(1);
  }
  ok('Token 格式正确');

  // ── 2. 密码学自检 ──
  console.log(`\n${b}2. 加密算法自检${x}`);
  const cryptoMod = await import(pathToFileURL(path.join(ROOT, 'qa/wecom-crypto.js')).href);
  const probe = `<xml><Content><![CDATA[自检 ${Date.now()}]]></Content></xml>`;
  try {
    const enc = cryptoMod.encryptMessage(probe, cfg.aesKey, cfg.corpId);
    const dec = cryptoMod.decryptMessage(enc, cfg.aesKey, cfg.corpId);
    if (dec.message !== probe) throw new Error('往返结果不一致');
    ok('加解密往返正常（密钥和实现都对得上）');
  } catch (e) {
    bad(`加解密失败：${e.message}`);
    process.exit(1);
  }

  // ── 3. 本地服务 ──
  console.log(`\n${b}3. 本地服务${x}`);
  const port = process.env.PORT || 8787;
  const local = `http://127.0.0.1:${port}`;
  try {
    const resp = await fetch(`${local}/health`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) ok(`服务在跑：${local}`);
    else bad(`服务返回 ${resp.status}`);
  } catch {
    bad(`连不上 ${local} —— 先跑 ${c}npm run serve${x}`);
    console.log('');
  }

  // ── 4. 模拟一次真实回调（最能说明问题）──
  console.log(`\n${b}4. 模拟企微 URL 校验${x}`);
  const echostr = crypto.randomBytes(16).toString('hex');
  const encryptedEcho = cryptoMod.encryptMessage(echostr, cfg.aesKey, cfg.corpId);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = String(Math.floor(Math.random() * 1e9));
  const sig = cryptoMod.signatureOf(cfg.token, timestamp, nonce, encryptedEcho);

  const qs = new URLSearchParams({
    msg_signature: sig,
    timestamp,
    nonce,
    echostr: encryptedEcho,
  });

  try {
    const resp = await fetch(`${local}/hook/kf?${qs}`, { signal: AbortSignal.timeout(5000) });
    const text = await resp.text();
    if (resp.status === 200 && text === echostr) {
      ok('本地 URL 校验通过（签名 + 解密 + 回显全对）');
    } else if (resp.status === 401) {
      bad('签名被拒 —— .env 里的 KF_TOKEN 和后台填的不一致');
    } else if (resp.status === 400) {
      bad('解密失败 —— .env 里的 KF_AES_KEY 和后台填的不一致');
    } else {
      bad(`期望回显 ${echostr.slice(0, 8)}…，实际 ${resp.status} / ${text.slice(0, 40)}`);
    }
  } catch (e) {
    bad(`请求失败：${e.message}`);
  }

  // ── 5. 公网可达性 ──
  if (baseUrl) {
    console.log(`\n${b}5. 公网可达性（${baseUrl}）${x}`);
    const base = baseUrl.replace(/\/+$/, '');
    let reachable = false;
    try {
      const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) });
      if (resp.ok) {
        ok(`${base}/health 可访问`);
        reachable = true;
      } else {
        bad(`${base}/health 返回 ${resp.status}`);
      }
    } catch (e) {
      bad(`连不上：${e.message}`);
      warn('检查：DNS 解析、防火墙、nginx 反代、证书');
    }

    if (reachable) {
      try {
        const resp = await fetch(`${base}/hook/kf?${qs}`, { signal: AbortSignal.timeout(8000) });
        const text = await resp.text();
        if (resp.status === 200 && text === echostr) {
          ok('公网 URL 校验通过 —— 可以把回调地址填进企微后台了');
        } else {
          bad(`公网校验失败：${resp.status} / ${text.slice(0, 60)}`);
          warn('常见原因：反代吞了 query 参数，或 body 被改写');
        }
      } catch (e) {
        bad(`公网校验请求失败：${e.message}`);
      }
    }
  } else {
    console.log(`\n${b}5. 公网可达性${x}`);
    warn('未提供域名，跳过。加一个参数可测：');
    console.log(`    ${c}node scripts/check-webhook.js https://你的域名${x}`);
  }

  console.log('');
}

main().catch((e) => {
  console.error(`${r}✗${x}`, e.message);
  process.exit(1);
});
