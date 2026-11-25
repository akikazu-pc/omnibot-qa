/**
 * 一键演示：不接任何真实平台，把「客户问 → AI 答 → 落库 → 配对 QA」整条链路跑一遍。
 *
 * 不依赖网络：内建一个假的 LLM，纯本地跑，方便验证部署是否正常。
 *
 * 用法：node cli.js demo2   （或 node scripts/demo.js）
 */
import { Store } from '../collector/store.js';
import { createMessage, Direction } from '../collector/message.js';
import { pairConversation } from '../qa/pair.js';
import { search } from '../qa/knowledge.js';
import { collectStyleSamples, buildSystemPrompt } from '../qa/agent.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const store = new Store(':memory:');
const now = Date.now();

// ---------- 1. 人工回复历史（将来从企业微信回调真实采集）----------
const humanReplies = [
  '这个我们支持的哈，走年度合同就行',
  '发票可以开，专票普票都行，你告诉我要哪种',
  '价格这块我发你个报价单，你看下哪个套餐合适',
  '部署方式有两种，公有云开箱即用，私有化我们给 docker 镜像',
];

console.log(C.bold('\n① 采集历史对话'));
const conv = 'user:zhangsan';
let t = now - 3600_000;
const history = [
  { dir: Direction.INBOUND, text: '你们支持私有化部署吗' },
  { dir: Direction.OUTBOUND, text: '部署方式有两种，公有云开箱即用，私有化我们给 docker 镜像' },
  { dir: Direction.INBOUND, text: '价格怎么算' },
  { dir: Direction.OUTBOUND, text: '价格这块我发你个报价单，你看下哪个套餐合适' },
];

for (const h of history) {
  store.insertMessage(
    createMessage({
      platform: 'wecom',
      conversation_id: conv,
      sender_id: h.dir === Direction.INBOUND ? 'zhangsan' : 'agent:self',
      direction: h.dir,
      content: h.text,
      timestamp: (t += 60_000),
    })
  );
}
// 额外几条散落的回复，作为风格来源
for (const [i, r] of humanReplies.entries()) {
  store.insertMessage(
    createMessage({
      platform: 'wecom',
      conversation_id: 'user:other',
      sender_id: 'agent:self',
      direction: Direction.OUTBOUND,
      content: r,
      timestamp: now - (10 - i) * 60_000,
    })
  );
}
console.log(C.dim(`   写入 ${history.length + humanReplies.length} 条消息`));

// ---------- 2. 配对 QA ----------
console.log(C.bold('\n② 配对 QA'));
const msgs = store.getConversation('wecom', conv, { limit: 100 });
const { pairs, unanswered } = pairConversation(msgs);
for (const p of pairs) {
  store.saveQaPair({ ...p, platform: 'wecom', conversation_id: conv, status: 'approved' });
  console.log(C.green('   ✓ ') + C.dim('Q: ') + p.question);
  console.log('     ' + C.dim('A: ') + p.answer);
}
console.log(C.dim(`   配对 ${pairs.length} 对，未答 ${unanswered.length} 条`));

// ---------- 3. 新客户提问，检索 + 组装 prompt ----------
console.log(C.bold('\n③ 新客户提问 → 检索知识库'));
const question = '能不能私有化部署啊';
const knowledge = store.listQa({ status: 'approved' });
const refs = search(question, knowledge, { topK: 3 });

console.log(C.dim(`   客户：`) + C.blue(question));
if (refs.length === 0) {
  console.log(C.yellow('   ⚠ 未命中知识库，AI 会礼貌地表示要确认'));
} else {
  for (const r of refs) {
    console.log(C.green(`   ✓ 命中 (${r.score.toFixed(2)}) `) + r.doc.question);
  }
}

// ---------- 4. 组装 prompt，展示「模仿说话方式」怎么实现 ----------
console.log(C.bold('\n④ 组装 system prompt（含人设 + 参考问答 + 风格样本）'));
const styleMsgs = store.db
  .prepare(`SELECT * FROM messages WHERE direction='outbound' ORDER BY timestamp DESC LIMIT 300`)
  .all();
const style = collectStyleSamples(styleMsgs, { limit: 4 });
const prompt = buildSystemPrompt({
  persona: '你是公司的客服小助手，负责解答客户咨询。',
  business: '我们提供 SaaS 客服系统，支持公有云和私有化部署。',
  references: refs,
  styleSamples: style,
});

console.log(C.dim('   ┌─ system prompt 预览 ─────────────'));
for (const line of prompt.split('\n').slice(0, 22)) console.log(C.dim('   │ ') + line);
if (prompt.split('\n').length > 22) console.log(C.dim('   │ ...'));
console.log(C.dim('   └──────────────────────────────────'));
console.log(C.dim(`   抽到 ${style.length} 条风格样本，${refs.length} 条参考问答`));

// ---------- 5. 说明下一步 ----------
console.log(C.bold('\n⑤ 下一步'));
console.log('   这里用假 LLM 演示。配好真实模型即可自动回复：');
console.log(C.dim('   export OPENAI_API_KEY=sk-xxx        # 任何 OpenAI 兼容服务都行'));
console.log(C.dim('   export OPENAI_BASE_URL=...           # 可选，默认 OpenAI 官方'));
console.log(C.dim('   export AUTO_REPLY=1                  # 开启自动回复'));
console.log(C.dim('   node server.js'));
console.log('');
console.log(C.bold('   想知道真实模型会怎么答？直接问：'));
console.log(C.dim('   curl -X POST localhost:8787/api/ask -d \'{"question":"能不能私有化部署"}\''));
console.log('');

store.close();
