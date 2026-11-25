#!/usr/bin/env node
/**
 * omnibot-qa CLI
 *
 * 用法：
 *   node cli.js pair                 扫描全部会话，配对 QA
 *   node cli.js list [--status pending] [--platform wecom] [--limit 50]
 *   node cli.js approve <id> [备注]   确认一条 QA
 *   node cli.js reject <id> [原因]    驳回一条 QA
 *   node cli.js stats                查看统计
 *   node cli.js export [--out qa.jsonl] [--status approved]
 *                                   导出知识库（JSONL，可直接喂给 LangBot/RAG）
 *   node cli.js demo                 用假数据跑一遍，验证链路
 */
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './collector/store.js';
import { pairAll } from './qa/pair.js';
import { createMessage, Platform, Direction } from './collector/message.js';

const DB = process.env.OMNIBOT_DB || 'data/omnibot.db';
const args = process.argv.slice(2);
const cmd = args[0];

/** 解析 --key value */
function opt(name, def = undefined) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false });
}

function printQa(rows) {
  if (!rows.length) {
    console.log('  （无数据）');
    return;
  }
  for (const r of rows) {
    console.log(`\n  #${r.id}  [${r.platform}]  ${r.status}  ${fmtTime(r.asked_at)}`);
    console.log(`  问：${r.question}`);
    console.log(`  答：${r.answer.slice(0, 300)}${r.answer.length > 300 ? '…' : ''}`);
    if (r.note) console.log(`  注：${r.note}`);
  }
  console.log('');
}

function main() {
  const store = new Store(DB);

  switch (cmd) {
    case 'pair': {
      const r = pairAll(store);
      console.log(`扫描 ${r.conversations} 个会话，新增 QA ${r.newPairs} 条，未答问题 ${r.unanswered} 条`);
      break;
    }

    case 'list': {
      const rows = store.listQa({
        status: opt('status'),
        platform: opt('platform'),
        limit: Number(opt('limit', 50)),
      });
      printQa(rows);
      break;
    }

    case 'approve': {
      const id = Number(args[1]);
      if (!id) throw new Error('需要 QA id');
      const ok = store.setQaStatus(id, 'approved', args[2] || '');
      console.log(ok ? `#${id} 已确认` : `#${id} 不存在`);
      break;
    }

    case 'reject': {
      const id = Number(args[1]);
      if (!id) throw new Error('需要 QA id');
      const ok = store.setQaStatus(id, 'rejected', args[2] || '');
      console.log(ok ? `#${id} 已驳回` : `#${id} 不存在`);
      break;
    }

    case 'stats': {
      const s = store.stats();
      console.log('\n消息：');
      if (!s.messages.length) console.log('  （无）');
      for (const m of s.messages) console.log(`  ${m.platform.padEnd(12)} ${m.n}`);
      console.log('\nQA：');
      if (!s.qa.length) console.log('  （无）');
      for (const q of s.qa) console.log(`  ${q.status.padEnd(12)} ${q.n}`);
      console.log('');
      break;
    }

    case 'export': {
      const out = opt('out', 'data/qa-export.jsonl');
      const rows = store.listQa({ status: opt('status', 'approved'), limit: 100000 });
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      const lines = rows.map((r) =>
        JSON.stringify({
          question: r.question,
          answer: r.answer,
          platform: r.platform,
          asked_at: r.asked_at,
        })
      );
      fs.writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
      console.log(`导出 ${rows.length} 条到 ${out}`);
      break;
    }

    case 'demo': {
      runDemo(store);
      break;
    }

    default:
      console.log(`omnibot-qa — 多平台客服 QA 沉淀工具

  pair                     扫描会话，配对 QA
  list [--status s]        列出 QA（pending/approved/rejected）
  approve <id> [备注]      确认
  reject <id> [原因]       驳回
  stats                    统计
  export [--out file]      导出已确认 QA 为 JSONL
  demo                     跑一遍演示数据
`);
  }

  store.close();
}

/** 演示：造两段对话，验证配对逻辑 */
function runDemo(store) {
  console.log('插入演示数据…');
  const base = Date.now() - 3600_000;
  const msgs = [
    // 会话 1：正常问答
    createMessage({
      platform: Platform.WECOM, conversation_id: 'user:zhangsan', sender_id: 'zhangsan',
      sender_name: '张三', direction: Direction.INBOUND, content: '你好，请问你们的服务支持跨平台吗',
      timestamp: base,
    }),
    createMessage({
      platform: Platform.WECOM, conversation_id: 'user:zhangsan', sender_id: 'agent:self',
      sender_name: '我方客服', direction: Direction.OUTBOUND,
      content: '支持的，企业微信、小红书、抖音都可以接入，消息会统一归档到一个地方。',
      timestamp: base + 60_000,
    }),
    // 会话 2：客户连发两条 + 追问，最终一条答案
    createMessage({
      platform: Platform.XHS, conversation_id: 'xhs:s001', sender_id: 'u1001',
      sender_name: '小红薯用户', direction: Direction.INBOUND, content: '这个多少钱',
      timestamp: base + 120_000,
    }),
    createMessage({
      platform: Platform.XHS, conversation_id: 'xhs:s001', sender_id: 'u1001',
      sender_name: '小红薯用户', direction: Direction.INBOUND, content: '有优惠吗',
      timestamp: base + 130_000,
    }),
    createMessage({
      platform: Platform.XHS, conversation_id: 'xhs:s001', sender_id: 'agent:self',
      sender_name: '我方客服', direction: Direction.OUTBOUND,
      content: '基础版 299/月，年付 2990，现在新客首月 1 折。',
      timestamp: base + 200_000,
    }),
    // 会话 3：问了没人答（高价值缺口）
    createMessage({
      platform: Platform.WECOM, conversation_id: 'user:lisi', sender_id: 'lisi',
      sender_name: '李四', direction: Direction.INBOUND, content: '你们能开发票吗？专票还是普票',
      timestamp: base + 300_000,
    }),
  ];

  const n = store.insertMessages(msgs);
  console.log(`新增 ${n} 条消息`);

  const r = pairAll(store);
  console.log(`配对：新增 ${r.newPairs} 条 QA，未答问题 ${r.unanswered} 条\n`);

  console.log('待审核 QA：');
  printQa(store.listQa({ status: 'pending' }));

  console.log('统计：');
  const s = store.stats();
  for (const m of s.messages) console.log(`  ${m.platform.padEnd(12)} 消息 ${m.n}`);
  for (const q of s.qa) console.log(`  ${q.status.padEnd(12)} QA ${q.n}`);
}

try {
  main();
} catch (e) {
  console.error('错误：', e.message);
  process.exit(1);
}
