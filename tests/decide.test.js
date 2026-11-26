import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { decide } from '../qa/decide.js';

const SNIPPETS = [
  {
    id: 'invoice',
    label: '发票',
    priority: 80,
    keywords: ['发票', '开票'],
    reply: '可以开发票。',
  },
];

describe('decide: 三层递进', () => {
  test('问价优先于话术', async () => {
    const d = await decide({
      content: '多少钱',
      snippets: SNIPPETS,
      generate: async () => ({ text: 'LLM答案', references: [{ id: 1 }], usedStyle: 3 }),
      isLlmReady: () => true,
    });
    assert.equal(d.kind, 'price');
    assert.ok(d.price.url.includes('/zh-CN/service'));
    // 问价不能碰 LLM
    assert.equal(d.text.includes('LLM答案'), false);
  });

  test('问价能被关掉', async () => {
    const d = await decide({
      content: '多少钱',
      enablePrice: false,
      snippets: [],
      generate: async () => ({ text: 'LLM答案', references: [{ id: 1 }], usedStyle: 3 }),
      isLlmReady: () => true,
    });
    assert.equal(d.kind, 'llm');
  });

  test('命中话术时不调模型', async () => {
    let called = false;
    const d = await decide({
      content: '怎么开发票',
      snippets: SNIPPETS,
      generate: async () => {
        called = true;
        return { text: 'LLM', references: [{ id: 1 }], usedStyle: 1 };
      },
      isLlmReady: () => true,
    });
    assert.equal(d.kind, 'snippet');
    assert.equal(d.snippetId, 'invoice');
    assert.equal(d.text, '可以开发票。');
    assert.equal(called, false, '话术命中时不应该调用模型');
  });

  test('都没命中才走模型', async () => {
    const d = await decide({
      content: '你们的保修期是多久',
      snippets: SNIPPETS,
      generate: async () => ({ text: '保修一年', references: [{ id: 1 }], usedStyle: 5 }),
      isLlmReady: () => true,
    });
    assert.equal(d.kind, 'llm');
    assert.equal(d.text, '保修一年');
    assert.equal(d.usedStyle, 5);
  });

  test('模型没有依据就不回复', async () => {
    const d = await decide({
      content: '你们老板叫什么',
      snippets: SNIPPETS,
      generate: async () => ({ text: '我确认下再回复您', references: [], usedStyle: 2 }),
      isLlmReady: () => true,
    });
    assert.equal(d.kind, 'none');
    assert.equal(d.text, '');
    assert.equal(d.reason, 'no-knowledge-hit');
  });

  test('模型没配置就直说', async () => {
    const d = await decide({
      content: '随便问一句',
      snippets: [],
      isLlmReady: () => false,
    });
    assert.equal(d.kind, 'none');
    assert.equal(d.reason, 'llm-not-configured');
  });

  test('模型抛异常不炸掉整个流程', async () => {
    const d = await decide({
      content: '随便问一句',
      snippets: [],
      generate: async () => {
        throw new Error('网络超时');
      },
      isLlmReady: () => true,
    });
    assert.equal(d.kind, 'none');
    assert.ok(d.reason.includes('generate-failed'));
  });

  test('空消息直接不处理', async () => {
    const d = await decide({ content: '   ' });
    assert.equal(d.kind, 'none');
    assert.equal(d.reason, 'empty');
  });
});

describe('decide: 多语言问价', () => {
  test('英文问价走 en-US 页面', async () => {
    const d = await decide({ content: 'How much is assembly', snippets: [] });
    assert.equal(d.kind, 'price');
    assert.equal(d.price.lang, 'en-US');
    assert.ok(d.price.url.includes('/en-US/service/desktop?item=assembly'));
  });

  test('繁体问价走 zh-TW 页面', async () => {
    const d = await decide({ content: '你們組裝多少錢', snippets: [] });
    assert.equal(d.kind, 'price');
    assert.equal(d.price.lang, 'zh-TW');
    assert.ok(d.price.url.includes('/zh-TW/'));
  });

  test('日语问价不带语言前缀', async () => {
    const d = await decide({ content: '組立の料金', snippets: [] });
    assert.equal(d.kind, 'price');
    assert.equal(d.price.lang, 'ja');
    assert.ok(!d.price.url.includes('/ja/'));
    assert.ok(d.price.url.includes('akikazu.co.jp/service/'));
  });

  test('强制指定语言会覆盖自动识别', async () => {
    const d = await decide({ content: '多少钱', lang: 'en-US', snippets: [] });
    assert.equal(d.price.lang, 'en-US');
  });
});
