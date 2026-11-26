/**
 * 读 .env 到 process.env
 *
 * 为什么自己写：Node 的 --env-file 要 20.6+，而且不会和已有的 env 合并
 * （命令行里已经 export 的变量优先级更高，这点要保持）。
 * 这里只补没设置过的键，不覆盖已有值。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 解析 .env 文本 */
export function parseEnv(text = '') {
  const out = {};
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
      (v.startsWith("'") && v.endsWith("'") && v.length > 1)
    ) {
      v = v.slice(1, -1);
    } else {
      // 行尾注释：KEY=value  # 说明
      const hash = v.indexOf(' #');
      if (hash > 0) v = v.slice(0, hash).trim();
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * 把 .env 灌进 target（默认 process.env）。已有的键不覆盖。
 * @returns {string[]} 实际写入的键
 */
export function loadEnvFile(file, target = process.env) {
  if (!file || !fs.existsSync(file)) return [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const parsed = parseEnv(text);
  const applied = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (target[k] === undefined || target[k] === '') {
      target[k] = v;
      applied.push(k);
    }
  }
  return applied;
}

/** 默认位置：项目根 .env */
export function defaultEnvPath(root) {
  return path.join(root, '.env');
}
