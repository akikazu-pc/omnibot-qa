#!/usr/bin/env node
/**
 * 端到端验证：「粘贴导入 → QA 配对 → 审核 → 检索 → 模仿口吻生成草稿」
 *
 * 这条链路是「客户扫码加我企微好友」场景的**不付费可用路径**：
 *   拿不到聊天 API → 手动全选复制 → 导入 → 沉淀 QA → AI 按我的口吻出草稿 → 我点发送
 *
 * 跑法：
 *   node scripts/e2e-import.js            # 用内置假 LLM，验证全链路不报错
 *   OPENAI_API_KEY=sk-xxx node scripts/e2e-import.js --live   # 用真模型看输出质量
 *
 * 全程用临时数据库，不污染 data/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../collector/store.js';
import { parsePastedChat, importMessages } from '../adapters/paste.js';
import { pairAll } from '../qa/pair.js';
import { search } from '../qa/knowledge.js';
import { generateReply } from '../qa/agent.js';
import { isLlmConfigured } from '../llm/provider.js';
import { Direction } from '../collector/message.js';

const LIVE = process.argv.includes('--live');

/** 假 API Key 让 provider 的配置检查通过，实际请求被 fetchImpl 拦下 */
const FAKE_KEY = process.env.OPENAI_API_KEY || 'sk-fake-for-local-e2e';

/** 模拟一段真实客服对话，格式与企微客户端「全选复制」一致 */
const SAMPLE_CHAT = `2026-11-20
王小明 10:23
你们支持私有化部署吗
我们是金融行业，数据不能出内网

小王 10:25
支持的，可以装到你们自己的服务器上，我们提供 docker 镜像和离线安装包。

王小明 10:26
那价格怎么算
王小明 10:26
和 SaaS 版一样吗

小王 10:31
私有化版本 39800 起，含一年维护。比 SaaS 贵一些，因为要单独部署和实施。

王小明 10:35
实施要多久

小王 10:37
一般 3-5 个工作日，我们有标准实施手册，你们那边出一个人对接就行。

王小明 10:40
能做等保三级吗

小王 10:42
这个我确认下再回复您`;

const SAMPLE_QA = [
  // 第二段对话，补充一条「正常答复」用于检索命中
  {
    text: `2026-11-21
李雷 09:10
你们私有化部署支持国产化环境吗
小王 09:15
支持，麒麟、统信、达梦都适配过。`,
    selfName: '小王',
  },
];

function line(s = '') {
  console.log(s);
}

function hr(title) {
  console.log(`\n${'─'.repeat(60)}\n${title}\n${'─'.repeat(60)}`);
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibot-e2e-'));
  const dbPath = path.join(tmpDir, 'e2e.db');
  const store = new Store(dbPath);

  try {
    // ── 1. 导入 ───────────────────────────────────────────
    hr('1. 粘贴导入');
    const parsed = parsePastedChat(SAMPLE_CHAT, { selfName: '小王', customerName: '王小明' });
    line(`解析到 ${parsed.messages.length} 条，说话人：${parsed.speakers.join(' / ')}`);
    line(`我方=${parsed.self}  客户=${parsed.customer}`);
    if (parsed.warnings.length) parsed.warnings.forEach((w) => line(`  ⚠️  ${w}`));

    const imp = importMessages(store, parsed.messages);
    line(`写入：新增 ${imp.added}，跳过 ${imp.skipped}`);

    for (const s of SAMPLE_QA) {
      const p = parsePastedChat(s.text, { selfName: s.selfName });
      importMessages(store, p.messages);
    }

    // ── 2. 配对 ───────────────────────────────────────────
    hr('2. QA 配对');
    const paired = pairAll(store);
    line(`会话 ${paired.conversations} 个，新增 QA ${paired.newPairs} 条，未答 ${paired.unanswered} 条`);

    const pending = store.listQa({ status: 'pending', limit: 100 });
    for (const q of pending) {
      line(`\n  #${q.id} 问：${q.question.replace(/\n/g, ' / ')}`);
      line(`        答：${q.answer.replace(/\n/g, ' / ').slice(0, 80)}`);
    }

    // ── 3. 审核 ───────────────────────────────────────────
    hr('3. 审核通过');
    for (const q of pending) store.setQaStatus(q.id, 'approved');
    const approved = store.listQa({ status: 'approved', limit: 100 });
    line(`已审核 ${approved.length} 条`);

    const knowledge = approved.map((q) => ({ question: q.question, answer: q.answer, status: q.status }));

    // ── 4. 检索 ───────────────────────────────────────────
    hr('4. 检索命中（决定 AI 有没有依据）');
    const probes = [
      '你们能私有化部署吗',
      '私有化多少钱',
      '能等保三级吗',
      '你们老板叫什么', // 故意问一个库里没有的
    ];
    for (const q of probes) {
      const hits = search(q, knowledge, { topK: 2, minScore: 1.2 });
      const tag = hits.length ? `命中 ${hits.length}` : '无依据 → 应拒答';
      line(`  「${q}」 ${tag}${hits.length ? `  最高分 ${hits[0].score.toFixed(2)}` : ''}`);
    }

    // ── 5. 生成 ───────────────────────────────────────────
    hr('5. 模仿口吻生成回复');
    const useLive = LIVE && isLlmConfigured();
    line(useLive ? '模式：真实模型' : '模式：假 LLM（结构验证）');

    // 风格样本：我方历史发言（这就是「模仿我说话」的来源）
    const styleMessages = store.messagesByDirection?.(Direction.OUTBOUND) || [];

    const askList = ['你们能私有化部署吗', '私有化多少钱', '你们老板叫什么'];
    for (const question of askList) {
      const r = await generateReply({
        question,
        knowledge,
        styleMessages,
        business: '我们是做企业级 SaaS 的，提供公有云和私有化两种交付方式。',
        llmConfig: useLive ? undefined : { apiKey: FAKE_KEY },
        fetchImpl: useLive ? undefined : fakeLlm(question, knowledge),
      });
      line(`\n  客户：${question}`);
      line(`  草稿：${r.text.replace(/\n/g, ' ')}`);
      line(`  （引用 ${r.references.length} 条知识，风格样本 ${r.usedStyle} 条）`);
    }

    hr('完成');
    line('这条链路的产出是「AI 草稿」，最终由你点发送 —— 官方没有开放代外部客户发消息的接口。');
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});

/**
 * 假 LLM：模拟「有依据就答、没依据就拒答」的正确行为，
 * 用来验证 prompt 里的事实边界真的生效，而不是模型自觉。
 */
function fakeLlm(question, knowledge) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const system = body.messages.find((m) => m.role === 'system')?.content || '';
    const noEvidence = system.includes('没有检索到相关问答');

    const text = noEvidence ? '这个我确认下再回复您' : pickAnswer(question, knowledge);

    // 模拟网络延迟，让输出顺序更接近真实情况
    await new Promise((r) => setTimeout(r, 80));

    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: text } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
    };
  };
}

function pickAnswer(question, knowledge) {
  const hits = search(question, knowledge, { topK: 1, minScore: 1.2 });
  return hits.length ? hits[0].doc.answer : '这个我确认下再回复您';
}
