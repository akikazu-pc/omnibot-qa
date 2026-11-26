import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseEnv, loadEnvFile } from '../qa/env.js';
import { checkShape, mask, readEnv, writeEnv } from '../scripts/setup-bot.js';

describe('env: 解析 .env', () => {
  test('基本的 KEY=VALUE', () => {
    assert.deepEqual(parseEnv('A=1\nB=two'), { A: '1', B: 'two' });
  });

  test('忽略注释和空行', () => {
    assert.deepEqual(parseEnv('# 注释\n\nA=1'), { A: '1' });
  });

  test('引号包裹保留内部空格', () => {
    assert.deepEqual(parseEnv('A="x y"\nB=\'p q\''), { A: 'x y', B: 'p q' });
  });

  test('行尾注释被去掉', () => {
    assert.deepEqual(parseEnv('A=abc # 说明'), { A: 'abc' });
  });

  test('支持 export 前缀', () => {
    assert.deepEqual(parseEnv('export A=1'), { A: '1' });
  });

  test('Secret 里的等号不被截断', () => {
    const v = parseEnv('S=abc=def=').S;
    assert.equal(v, 'abc=def=');
  });
});

describe('env: 灌进 process.env', () => {
  test('已有值不被覆盖', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibot-env-'));
    const f = path.join(dir, '.env');
    fs.writeFileSync(f, 'A=fromfile\nB=fromfile\n');
    const target = { A: 'fromshell' };
    const applied = loadEnvFile(f, target);
    assert.equal(target.A, 'fromshell', '命令行优先');
    assert.equal(target.B, 'fromfile');
    assert.deepEqual(applied, ['B']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('文件不存在时安静返回', () => {
    assert.deepEqual(loadEnvFile('/nonexistent/.env', {}), []);
  });

  test('空字符串也算未设置，会被填上', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibot-env-'));
    const f = path.join(dir, '.env');
    fs.writeFileSync(f, 'A=x\n');
    const target = { A: '' };
    loadEnvFile(f, target);
    assert.equal(target.A, 'x');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('setup-bot: 凭据形态校验', () => {
  test('正常凭据不报问题', () => {
    assert.deepEqual(checkShape('bot_abc123', 's'.repeat(40)), []);
  });

  test('空值被指出', () => {
    const p = checkShape('', '');
    assert.equal(p.length, 2);
  });

  test('ww 开头更像 CorpID', () => {
    const p = checkShape('ww1234567890abcdef', 's'.repeat(40));
    assert.ok(p.some((x) => x.includes('CorpID')));
  });

  test('43 位更像 EncodingAESKey', () => {
    const p = checkShape('bot_x', 'k'.repeat(43));
    assert.ok(p.some((x) => x.includes('EncodingAESKey')));
  });

  test('带空格提示复制多了', () => {
    const p = checkShape(' bot_x', 's s');
    assert.ok(p.some((x) => x.includes('空格')));
  });
});

describe('setup-bot: 打码', () => {
  test('短的整个盖掉', () => {
    assert.equal(mask('abc'), '****');
  });

  test('长的留头尾', () => {
    const m = mask('abcdefghijklmnop');
    assert.ok(m.startsWith('abcd'));
    assert.ok(m.endsWith('mnop'));
    assert.ok(m.includes('*'));
  });

  test('空值显示未设置', () => {
    assert.equal(mask(''), '(未设置)');
  });
});

describe('setup-bot: 写入 .env', () => {
  test('写入后可原样读回', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibot-env-'));
    const f = path.join(dir, '.env');
    writeEnv({ WECOM_BOT_ID: 'bot_1', WECOM_BOT_SECRET: 'sec=with=eq' }, f);
    const back = readEnv(f);
    assert.equal(back.WECOM_BOT_ID, 'bot_1');
    assert.equal(back.WECOM_BOT_SECRET, 'sec=with=eq');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('文件权限是 600', () => {
    if (process.platform === 'win32') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibot-env-'));
    const f = path.join(dir, '.env');
    writeEnv({ A: '1' }, f);
    const mode = fs.statSync(f).mode & 0o777;
    assert.equal(mode, 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
