#!/usr/bin/env node
/**
 * omnibot-qa 收集服务
 *
 * 提供 webhook 入口，接收各平台回调，归一化后落库。
 * 只做「收集」，不做自动回复 —— 回复由 LangBot 负责，
 * 但回复内容需要通过 /api/reply 回报给本服务，才能配出 QA。
 *
 * 路由：
 *   GET  /health                 健康检查
 *   POST /hook/wecom             企业微信自建应用回调
 *   POST /hook/wecombot          企业微信智能机器人回调
 *   POST /hook/xhs               小红书回调
 *   POST /api/reply              回报我方发出的消息（配对答案的关键）
 *   GET  /api/stats              统计
 *   GET  /api/qa                 列出 QA
 *   POST /api/qa/:id/approve     确认
 *   POST /api/qa/:id/reject      驳回
 *   GET  /api/export             导出已确认 QA（JSONL）
 */
import http from 'node:http';
import { Store } from './collector/store.js';
import { pairAll } from './qa/pair.js';
import { fromWecom, recordOutbound } from './adapters/wecom.js';
import { fromXhs, normalizeWebhookBody } from './adapters/xhs.js';

const PORT = Number(process.env.PORT || 8787);
const DB = process.env.OMNIBOT_DB || 'data/omnibot.db';
const SHARED_SECRET = process.env.OMNIBOT_SECRET || '';

const store = new Store(DB);
const log = (...a) => console.log(new Date().toISOString(), ...a);

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}

/** 简单鉴权：配置了 SECRET 时必须带 x-omnibot-secret 头 */
function authorized(req) {
  if (!SHARED_SECRET) return true;
  return req.headers['x-omnibot-secret'] === SHARED_SECRET;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (path === '/health') {
      return json(res, 200, { ok: true, db: DB, stats: store.stats() });
    }

    // ---------- 企业微信 ----------
    if (path === '/hook/wecom' || path === '/hook/wecombot') {
      if (req.method === 'GET') {
        // 企业微信 URL 校验由 LangBot 或独立加解密模块处理，这里只做占位
        return res.writeHead(200).end(String(url.searchParams.get('echostr') || ''));
      }
      const body = await readBody(req);
      let raw;
      try {
        raw = JSON.parse(body);
      } catch {
        // LangBot 已解密的场景直接传明文 JSON；若是加密 XML 则交给 LangBot
        return json(res, 400, { error: 'need plain JSON; decryption should happen upstream' });
      }

      const msg = await fromWecom(raw, {
        platform: path === '/hook/wecombot' ? 'wecom' : 'wecom',
        resolveUser: async (uid) => {
          const r = store.db
            .prepare("SELECT sender_name FROM messages WHERE platform='wecom' AND sender_id=? AND sender_name<>'' LIMIT 1")
            .get(uid);
          return r ? { name: r.sender_name } : null;
        },
      });

      const added = store.insertMessage(msg);
      log(`[wecom] ${added ? '新增' : '已存在'} ${msg.conversation_id} ${msg.content.slice(0, 50)}`);
      return json(res, 200, { ok: true, added });
    }

    // ---------- 小红书 ----------
    if (path === '/hook/xhs') {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(res, 400, { error: 'invalid json' });
      }

      // 小红书可能会推送 echo 校验
      if (parsed && parsed.challenge) {
        return json(res, 200, parsed);
      }

      const items = normalizeWebhookBody(parsed);
      const msgs = [];
      for (const item of items) {
        msgs.push(await fromXhs(item));
      }
      const n = store.insertMessages(msgs);
      log(`[xhs] 收到 ${items.length} 条，新增 ${n} 条`);
      return json(res, 200, { ok: true, received: items.length, added: n });
    }

    // ---------- 回报我方发出的消息 ----------
    if (path === '/api/reply' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const body = JSON.parse(await readBody(req));
      const { platform = 'wecom', to_user, content, is_group = false, chat_id, agent_id } = body;
      if (!to_user || !content) return json(res, 400, { error: 'to_user 和 content 必填' });

      const msg = recordOutbound(to_user, content, {
        platform,
        isGroup: is_group,
        chatId: chat_id,
        agentId: agent_id,
      });
      store.insertMessage(msg);
      log(`[reply] ${msg.conversation_id} ${content.slice(0, 50)}`);
      return json(res, 200, { ok: true, id: msg.id });
    }

    // ---------- 查询与审核 ----------
    if (path === '/api/stats') {
      return json(res, 200, store.stats());
    }

    if (path === '/api/qa') {
      const rows = store.listQa({
        status: url.searchParams.get('status') || undefined,
        platform: url.searchParams.get('platform') || undefined,
        limit: Number(url.searchParams.get('limit') || 100),
      });
      return json(res, 200, rows);
    }

    const m = path.match(/^\/api\/qa\/(\d+)\/(approve|reject)$/);
    if (m && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const id = Number(m[1]);
      const status = m[2] === 'approve' ? 'approved' : 'rejected';
      let note = '';
      try {
        const b = JSON.parse(await readBody(req));
        note = b.note || '';
      } catch {
        /* 允许空表 */
      }
      const ok = store.setQaStatus(id, status, note);
      return json(res, ok ? 200 : 404, { ok, id, status });
    }

    if (path === '/api/export') {
      const status = url.searchParams.get('status') || 'approved';
      const rows = store.listQa({ status, limit: 100000 });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      for (const r of rows) {
        res.write(
          JSON.stringify({ question: r.question, answer: r.answer, platform: r.platform, asked_at: r.asked_at }) + '\n'
        );
      }
      return res.end();
    }

    // ---------- 手动触发配对 ----------
    if (path === '/api/pair' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, pairAll(store));
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    log('❌', e.message);
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  log('─'.repeat(48));
  log(`📥 omnibot-qa 收集服务  http://127.0.0.1:${PORT}`);
  log(`   数据库: ${DB}`);
  log(`   鉴权: ${SHARED_SECRET ? '已启用' : '未启用（建议生产环境配置 OMNIBOT_SECRET）'}`);
  log('   回调入口: /hook/wecom  /hook/wecombot  /hook/xhs');
  log('─'.repeat(48));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('关闭中…');
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000);
  });
}
