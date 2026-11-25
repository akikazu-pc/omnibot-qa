import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, search } from '../qa/knowledge.js';
import { collectStyleSamples, buildSystemPrompt, generateReply } from '../qa/agent.js';
import { chat, loadLlmConfig, isLlmConfigured } from '../llm/provider.js';
import { Direction, createMessage } from '../collector/message.js';

// ---------- tokenize ----------

describe('keyword: tokenize', () => {
  test('中文二元切分', () => {
    const t = tokenize('支持私有化部署吗');
    assert.ok(t.includes('支持'));
    assert.ok(t.includes('部署'));
    assert.ok(!t.includes('吗'), '停用词应被过滤');
  });

  test('英文按词切分', () => {
    const t = tokenize('支持 API 对接吗');
    assert.ok(t.includes('api'));
  });

  test('空输入返回空数组', () => {
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize(null), []);
  });
});

// ---------- BM25 检索 ----------

describe('keyword: search', () => {
  const docs = [
    { question: '你们支持私有化部署吗', answer: '支持，可以部署到你们自己的服务器' },
    { question: '价格怎么算', answer: '按年付费，基础版 9999 一年' },
    { question: '可以开发票吗', answer: '可以，支持增值税专票和普票' },
  ];

  test('命中语义相近的问题', () => {
    const r = search('能不能私有化部署', docs);
    assert.ok(r.length > 0, '应该有结果');
    assert.match(r[0].doc.question, /私有化/);
  });

  test('不相关问题返回空', () => {
    const r = search('今天天气怎么样', docs, { minScore: 2 });
    assert.equal(r.length, 0);
  });

  test('topK 限制生效', () => {
    const r = search('价格 发票 部署', docs, { topK: 2, minScore: 0 });
    assert.ok(r.length <= 2);
  });

  test('空文档集不报错', () => {
    assert.deepEqual(search('测试', []), []);
    assert.deepEqual(search('测试', null), []);
  });
});

// ---------- 风格样本抽取 ----------

describe('agent: collectStyleSamples', () => {
  const mk = (content, ts, direction = Direction.OUTBOUND) =>
    createMessage({
      platform: 'wecom',
      conversation_id: 'user:1',
      sender_id: '1',
      direction,
      content,
      timestamp: ts,
    });

  test('只取我方回复', () => {
    const msgs = [
      mk('客户的问题', 1, Direction.INBOUND),
      mk('我们这边支持私有化部署的', 2),
    ];
    const s = collectStyleSamples(msgs);
    assert.deepEqual(s, ['我们这边支持私有化部署的']);
  });

  test('过滤太短和纯链接', () => {
    const msgs = [mk('好', 1), mk('https://example.com/abc', 2), mk('这个是正常的回复内容', 3)];
    const s = collectStyleSamples(msgs);
    assert.deepEqual(s, ['这个是正常的回复内容']);
  });

  test('去重', () => {
    const msgs = [mk('相同的回复内容啊', 1), mk('相同的回复内容啊', 2)];
    assert.equal(collectStyleSamples(msgs).length, 1);
  });

  test('limit 生效且按时间正序返回', () => {
    const msgs = [mk('第一条回复内容', 1), mk('第二条回复内容', 2), mk('第三条回复内容', 3)];
    const s = collectStyleSamples(msgs, { limit: 2 });
    assert.equal(s.length, 2);
    assert.equal(s[s.length - 1], '第三条回复内容');
  });
});

// ---------- system prompt ----------

describe('agent: buildSystemPrompt', () => {
  test('包含人设、参考问答、风格', () => {
    const p = buildSystemPrompt({
      persona: '你是某某公司的客服',
      business: '卖 SaaS 软件',
      references: [{ doc: { question: 'Q1', answer: 'A1' } }],
      styleSamples: ['这个我们支持的'],
    });
    assert.match(p, /某某公司的客服/);
    assert.match(p, /卖 SaaS 软件/);
    assert.match(p, /Q1/);
    assert.match(p, /这个我们支持的/);
  });

  test('无参考时不出现空段落', () => {
    const p = buildSystemPrompt({});
    assert.ok(!p.includes('过往真实问答'));
    assert.ok(!p.includes('你的说话风格'));
  });
});

// ---------- LLM 调用 ----------

function mockFetch(responses) {
  let i = 0;
  return async () => {
    const r = responses[i++];
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      text: async () => JSON.stringify(r.body),
      json: async () => r.body,
    };
  };
}

describe('llm: chat', () => {
  test('成功返回文本', async () => {
    const f = mockFetch([{ body: { choices: [{ message: { content: '  你好  ' } }], model: 'm', usage: { total_tokens: 5 } } }]);
    const r = await chat([{ role: 'user', content: 'hi' }], { config: { apiKey: 'k' }, fetchImpl: f });
    assert.equal(r.text, '你好');
    assert.equal(r.usage.total_tokens, 5);
  });

  test('缺少 apiKey 报错', async () => {
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hi' }], { config: { apiKey: '', baseUrl: 'http://x' } }),
      /OPENAI_API_KEY/
    );
  });

  test('HTTP 错误抛出', async () => {
    const f = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hi' }], { config: { apiKey: 'k' }, fetchImpl: f }),
      /LLM HTTP 401/
    );
  });

  test('返回结构异常抛出', async () => {
    const f = mockFetch([{ body: { foo: 'bar' } }]);
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hi' }], { config: { apiKey: 'k' }, fetchImpl: f }),
      /返回结构异常/
    );
  });

  test('空 messages 报错', async () => {
    await assert.rejects(() => chat([], { config: { apiKey: 'k' } }), /messages/);
  });

  test('loadLlmConfig 默认值', () => {
    const c = loadLlmConfig({});
    assert.equal(c.baseUrl, 'https://api.openai.com/v1');
    assert.equal(c.model, 'gpt-4o-mini');
    assert.equal(isLlmConfigured({}), false);
    assert.equal(isLlmConfigured({ OPENAI_API_KEY: 'k' }), true);
  });
});

// ---------- 端到端生成 ----------

describe('agent: generateReply', () => {
  test('拼出正确请求并返回答案', async () => {
    let captured;
    const f = async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: '支持私有化部署的' } }] }),
      };
    };

    const r = await generateReply({
      question: '能私有化部署吗',
      knowledge: [{ question: '支持私有化部署吗', answer: '支持，部署到你们服务器' }],
      styleMessages: [
        createMessage({
          platform: 'wecom',
          conversation_id: 'user:1',
          sender_id: '1',
          direction: Direction.OUTBOUND,
          content: '支持私有化部署的',
          timestamp: 1,
        }),
      ],
      llmConfig: { apiKey: 'k', baseUrl: 'http://fake' },
      fetchImpl: f,
    });

    assert.equal(r.text, '支持私有化部署的');
    assert.equal(r.references.length, 1);
    assert.equal(r.usedStyle, 1);
    assert.equal(captured.body.messages[0].role, 'system');
    assert.match(captured.body.messages[0].content, /支持私有化部署吗/);
    assert.equal(captured.body.messages.at(-1).content, '能私有化部署吗');
  });

  test('带上历史上下文', async () => {
    let captured;
    const f = async (url, init) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
    };

    const history = [
      createMessage({
        platform: 'wecom',
        conversation_id: 'user:1',
        sender_id: '1',
        direction: Direction.INBOUND,
        content: '你们卖什么',
        timestamp: 1,
      }),
      createMessage({
        platform: 'wecom',
        conversation_id: 'user:1',
        sender_id: 'agent:1',
        direction: Direction.OUTBOUND,
        content: '我们卖 SaaS',
        timestamp: 2,
      }),
    ];

    await generateReply({
      question: '多少钱',
      history,
      llmConfig: { apiKey: 'k', baseUrl: 'http://fake' },
      fetchImpl: f,
    });

    const roles = captured.messages.map((m) => m.role);
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']);
  });

  test('末尾不重复当前问题', async () => {
    let captured;
    const f = async (url, init) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
    };

    const history = [
      createMessage({
        platform: 'wecom',
        conversation_id: 'user:1',
        sender_id: '1',
        direction: Direction.INBOUND,
        content: '多少钱',
        timestamp: 1,
      }),
    ];

    await generateReply({
      question: '多少钱',
      history,
      llmConfig: { apiKey: 'k', baseUrl: 'http://fake' },
      fetchImpl: f,
    });

    const users = captured.messages.filter((m) => m.role === 'user');
    assert.equal(users.length, 1, '当前问题不应重复出现');
  });
});
