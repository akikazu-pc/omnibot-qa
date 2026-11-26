#!/usr/bin/env node
/**
 * omnibot-qa 服务
 *
 * 一条完整链路：收到客户消息 → 落库 → AI 生成回复 → 发回客户 → 落库 → 配对 QA。
 *
 * 两种运行模式：
 * 1. 收集模式（默认）：只收集，回复由人工或外部系统负责，通过 /api/reply 回报
 * 2. 自动回复模式（AUTO_REPLY=1）：收到消息后自动用 AI 回复，回复内容自动落库
 *    需要配置 OPENAI_API_KEY（+ 企业微信凭据才能真发出去）
 *
 * 路由：
 *   GET  /health                 健康检查
 *   POST /hook/wecom             企业微信自建应用回调
 *   POST /hook/wecombot          企业微信智能机器人回调
 *   POST /hook/xhs               小红书回调
 *   POST /api/message            通用消息入口（平台无关，供外部插件调用）
 *   POST /api/reply              回报我方发出的消息（配对答案的关键）
 *   POST /api/ask                AI 生成一条回复但不发送（调试/预览用）
 *   POST /api/import             粘贴导入聊天记录（客户加好友场景的兜底路径）
 *   GET  /api/stats              统计
 *   GET  /api/qa                 列出 QA
 *   POST /api/qa/:id/approve     确认
 *   POST /api/qa/:id/reject      驳回
 *   GET  /api/export             导出已确认 QA（JSONL）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './collector/store.js';
import { pairAll } from './qa/pair.js';
import { fromWecom, recordOutbound } from './adapters/wecom.js';
import { sendText, isWecomConfigured } from './adapters/wecom-send.js';
import { fromXhs, normalizeWebhookBody } from './adapters/xhs.js';
import { connectBot, isBotConfigured } from './adapters/wecom-bot.js';
import { parsePastedChat, importMessages } from './adapters/paste.js';
import { createMessage, Direction } from './collector/message.js';
import { generateReply, isLlmConfigured } from './qa/agent.js';
import { matchSnippet, validateSnippets } from './qa/snippets.js';
import { checkCardWidth } from './qa/card.js';
import { buildPriceReply, explainPriceReply } from './qa/price-reply.js';

const PORT = Number(process.env.PORT || 8787);
const DB = process.env.OMNIBOT_DB || 'data/omnibot.db';
const SHARED_SECRET = process.env.OMNIBOT_SECRET || '';
const AUTO_REPLY = process.env.AUTO_REPLY === '1';
const PERSONA = process.env.BOT_PERSONA || '';
const BUSINESS = process.env.BOT_BUSINESS || '';
/** 是否启动企业微信智能机器人长连接 */
const BOT_WS_ENABLED = process.env.WECOM_BOT_WS === '1' || isBotConfigured();
/** 话术库文件（报价、发票这类必须一字不差的回复） */
const SNIPPETS_FILE = process.env.OMNIBOT_SNIPPETS || 'data/snippets.json';
/** 问价时发价格页卡片（设成 0 可关掉，退回纯话术/LLM） */
const PRICE_REPLY_ENABLED = process.env.OMNIBOT_PRICE_CARD !== '0';

const store = new Store(DB);
const log = (...a) => console.log(new Date().toISOString(), ...a);

/**
 * 加载话术库。文件不存在就返回空数组（不报错），
 * 这样没配话术的人跟以前行为完全一致。
 */
function loadSnippets() {
  try {
    const raw = fs.readFileSync(path.resolve(SNIPPETS_FILE), 'utf8');
    const obj = JSON.parse(raw);
    const list = Array.isArray(obj) ? obj : obj.snippets || [];
    const problems = validateSnippets(list);
    if (problems.length) {
      log('⚠️  话术库有问题，已忽略：');
      for (const p of problems) log(`     ${p}`);
      return [];
    }
    return list;
  } catch (err) {
    if (err.code !== 'ENOENT') log(`⚠️  读取话术库失败：${err.message}`);
    return [];
  }
}

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

/** 取全部已审核 QA 作为知识库（每次现取，保证审核后立即生效） */
function loadKnowledge() {
  return store.listQa({ status: 'approved', limit: 5000 });
}

/** 取最近的历史回复作为风格样本来源 */
function loadStyleMessages(limit = 300) {
  return store.db
    .prepare(`SELECT * FROM messages WHERE direction = 'outbound' ORDER BY timestamp DESC LIMIT ?`)
    .all(limit);
}

/**
 * 客户提问 → AI 回复 → 落库 → 发送。
 *
 * @param {Object} p
 * @param {string} p.platform
 * @param {string} p.conversationId
 * @param {string} p.senderId
 * @param {string} p.content
 * @param {boolean} [p.isGroup]
 * @param {string} [p.chatId]
 * @param {string} [p.agentId]
 * @param {boolean} [p.dryRun] 只生成不发送
 * @returns {Promise<{answer:string, sent:boolean, error?:string, references:number, usedStyle:number}>}
 */
async function replyTo({ platform, conversationId, senderId, content, isGroup, chatId, agentId, dryRun }) {
  const history = store.getConversation(platform, conversationId, { limit: 20 });

  // ── 第一步：话术库优先 ──────────────────────────────
  // 报价、发票、试用这类回复必须一字不差，绝不能让模型改写。
  // 命中就直接发，不调模型：零延迟、零成本、不会编出根本不存在的价格。
  const hit = matchSnippet(content, loadSnippets());
  if (hit) {
    log(`[snippet] 命中「${hit.label || hit.id}」→ 直接回复`);
    const outbound = recordOutbound(isGroup ? chatId : senderId, hit.reply, {
      platform,
      isGroup,
      chatId,
      agentId,
    });
    store.insertMessage(outbound);

    if (dryRun) {
      return { answer: hit.reply, sent: false, references: 0, usedStyle: 0, snippet: hit.id };
    }
    if (platform !== 'wecom' || isGroup || !isWecomConfigured()) {
      return {
        answer: hit.reply,
        sent: false,
        references: 0,
        usedStyle: 0,
        snippet: hit.id,
        error: '话术已生成并落库，但当前无法自动发送（需自建应用凭据且非群聊）',
      };
    }
    const r = await sendText({ toUser: senderId, content: hit.reply });
    log(`[snippet] → ${senderId} ${hit.reply.slice(0, 40)}`);
    return {
      answer: hit.reply,
      sent: Boolean(r.ok),
      references: 0,
      usedStyle: 0,
      snippet: hit.id,
      ...(r.ok ? {} : { error: r.error }),
    };
  }

  // ── 第二步：没有话术就交给模型 ──────────────────────
  if (!isLlmConfigured()) {
    throw new Error('LLM 未配置：请设置 OPENAI_API_KEY（及可选 OPENAI_BASE_URL / OPENAI_MODEL）');
  }

  const gen = await generateReply({
    question: content,
    history,
    knowledge: loadKnowledge(),
    styleMessages: loadStyleMessages(),
    persona: PERSONA || undefined,
    business: BUSINESS || undefined,
  });

  // 无论是否发送成功，都先落库，避免 QA 配对丢答案
  const outbound = recordOutbound(isGroup ? chatId : senderId, gen.text, {
    platform,
    isGroup,
    chatId,
    agentId,
  });
  store.insertMessage(outbound);

  if (dryRun) {
    return { answer: gen.text, sent: false, references: gen.references.length, usedStyle: gen.usedStyle };
  }

  // 目前只有企业微信有发送实现
  if (platform !== 'wecom') {
    return {
      answer: gen.text,
      sent: false,
      error: `${platform} 暂未实现自动发送，回复已落库`,
      references: gen.references.length,
      usedStyle: gen.usedStyle,
    };
  }

  if (isGroup) {
    // 群聊场景：群机器人接口不同，先只落库不发送
    return {
      answer: gen.text,
      sent: false,
      error: '群聊自动回复暂未支持，回复已落库',
      references: gen.references.length,
      usedStyle: gen.usedStyle,
    };
  }

  if (!isWecomConfigured()) {
    return {
      answer: gen.text,
      sent: false,
      error: '企业微信凭据未配置，回复已落库但未发送',
      references: gen.references.length,
      usedStyle: gen.usedStyle,
    };
  }

  const r = await sendText({ toUser: senderId, content: gen.text });
  if (!r.ok) {
    return { answer: gen.text, sent: false, error: r.error, references: gen.references.length, usedStyle: gen.usedStyle };
  }

  log(`[auto] → ${senderId} ${gen.text.slice(0, 50)}`);
  return { answer: gen.text, sent: true, references: gen.references.length, usedStyle: gen.usedStyle };
}

/**
 * 企业微信智能机器人长连接消息处理。
 *
 * 与 HTTP 回调不同：这里的「我方回复」直接通过同一帧回给企业微信，
 * 不需要额外的发送接口，也不需要 access_token。
 *
 * @param {object} raw 已归一化的 raw 结构
 * @returns {Promise<string>} 要回复给客户的内容（空字符串表示不回复）
 */
async function handleBotMessage(raw) {
  const isGroup = Boolean(raw.ChatId && raw.ChatType === 'group');
  const conversationId = isGroup ? `group:${raw.ChatId}` : `user:${raw.FromUserName}`;
  const content = raw.Content || '';

  if (!content) return '';

  const msg = await fromWecom(raw, {
    platform: 'wecom',
    resolveUser: async (uid) => {
      const r = store.db
        .prepare("SELECT sender_name FROM messages WHERE platform='wecom' AND sender_id=? AND sender_name<>'' LIMIT 1")
        .get(uid);
      return r ? { name: r.sender_name } : null;
    },
  });

  const added = store.insertMessage(msg);
  log(`[bot] ${added ? '新' : '重'} ${conversationId} ${content.slice(0, 50)}`);

  if (!added) return ''; // 重复推送，忽略
  if (!AUTO_REPLY) return '';

  // 问价 → 直接发对应语言的价格页卡片。
  // 放在话术之前：价格只在网站上维护一份，机器人不复述数字，
  // 避免两边价格不一致（改了网站忘了改话术是最常见的翻车方式）。
  if (PRICE_REPLY_ENABLED) {
    const price = buildPriceReply(content);
    if (price) {
      log(`[bot] 报价卡片 ${price.lang} → ${price.url}`);
      store.insertMessage(
        recordOutbound(isGroup ? raw.ChatId : raw.FromUserName, price.plain, {
          platform: 'wecom',
          isGroup,
          chatId: raw.ChatId,
          agentId: 'bot',
        })
      );
      // 返回对象形式 → 适配器发 template_card，而不是 markdown
      return { card: price.card };
    }
  }

  // 话术优先：报价、发票这类必须一字不差，而且不需要 LLM 也能跑
  const hit = matchSnippet(content, loadSnippets());
  if (hit) {
    log(`[bot] 话术命中「${hit.label || hit.id}」`);
    store.insertMessage(
      recordOutbound(isGroup ? raw.ChatId : raw.FromUserName, hit.reply, {
        platform: 'wecom',
        isGroup,
        chatId: raw.ChatId,
        agentId: 'bot',
      })
    );
    return hit.reply;
  }

  if (!isLlmConfigured()) return '';

  try {
    const gen = await generateReply({
      question: content,
      history: store.getConversation('wecom', conversationId, { limit: 20 }),
      knowledge: loadKnowledge(),
      styleMessages: loadStyleMessages(),
      persona: PERSONA || undefined,
      business: BUSINESS || undefined,
    });

    // 没有依据时 AI 只会说「这个我确认下再回复您」。
    // 这句话对一个机器人来说是噪音：它既没帮上客户，又占了一条回复，
    // 还让人误以为是真人接手了。所以没有引用就干脆不吭声，留给人工。
    if (!gen.references.length) {
      log(`[bot] 无依据，跳过自动回复：${content.slice(0, 30)}`);
      return '';
    }

    // 落库 outbound，供 QA 配对使用
    store.insertMessage(
      recordOutbound(isGroup ? raw.ChatId : raw.FromUserName, gen.text, {
        platform: 'wecom',
        isGroup,
        chatId: raw.ChatId,
        agentId: 'bot',
      })
    );

    log(`[bot] ← ${gen.text.slice(0, 50)}`);
    return gen.text;
  } catch (err) {
    log(`[bot] 生成回复失败: ${err.message}`);
    return '';
  }
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

      // 自动回复：仅在新增消息、且开启 AUTO_REPLY 时触发，避免平台重试导致重复回复
      let reply;
      if (AUTO_REPLY && added && msg.msg_type === 'text' && msg.content) {
        try {
          reply = await replyTo({
            platform: 'wecom',
            conversationId: msg.conversation_id,
            senderId: msg.sender_id,
            content: msg.content,
            isGroup: msg.is_group,
            chatId: msg.is_group ? msg.conversation_id.replace(/^group:/, '') : undefined,
          });
        } catch (e) {
          log('❌ 自动回复失败:', e.message);
          reply = { error: e.message };
        }
      }

      return json(res, 200, { ok: true, added, ...(reply ? { reply } : {}) });
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

    // ---------- 通用消息入口（LangBot 插件使用）----------
    // 平台无关：插件把归一化后的字段直接 POST 过来，落库后统一配对。
    if (path === '/api/message' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const b = JSON.parse(await readBody(req));
      const {
        platform = 'wecom',
        conversation_id,
        sender_id,
        sender_name = '',
        direction = 'inbound',
        content = '',
        timestamp,
        is_group = false,
        msg_type = 'text',
      } = b;

      if (!conversation_id || !sender_id) {
        return json(res, 400, { error: 'conversation_id 和 sender_id 必填' });
      }

      const msg = createMessage({
        id: `${platform}:${conversation_id}:${direction}:${timestamp || Date.now()}:${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        platform,
        conversation_id,
        sender_id,
        sender_name,
        direction,
        msg_type,
        content,
        timestamp: Number(timestamp) || Date.now(),
        is_group: Boolean(is_group),
        raw: b.reply_to ? { reply_to: b.reply_to } : undefined,
      });

      const added = store.insertMessage(msg);
      if (added) {
        log(`[msg] ${direction === 'outbound' ? '答' : '问'} ${conversation_id} ${String(content).slice(0, 50)}`);
      }

      let reply;
      if (AUTO_REPLY && added && direction === 'inbound' && msg_type === 'text' && content) {
        try {
          reply = await replyTo({
            platform,
            conversationId: conversation_id,
            senderId: sender_id,
            content,
            isGroup: Boolean(is_group),
            chatId: b.chat_id,
            agentId: b.agent_id,
          });
        } catch (e) {
          log('❌ 自动回复失败:', e.message);
          reply = { error: e.message };
        }
      }

      return json(res, 200, { ok: true, added, ...(reply ? { reply } : {}) });
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

    // ---------- 只生成不发送（调试/预览）----------
    if (path === '/api/ask' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const b = JSON.parse(await readBody(req));
      const { question, platform = 'wecom', conversation_id } = b;
      if (!question) return json(res, 400, { error: 'question 必填' });

      const history = conversation_id ? store.getConversation(platform, conversation_id, { limit: 20 }) : [];

      // 话术优先，和真实回复路径保持同一套逻辑，这样预览所见即所得
      const hit = matchSnippet(question, loadSnippets());
      if (hit) {
        return json(res, 200, {
          answer: hit.reply,
          source: 'snippet',
          snippet: { id: hit.id, label: hit.label || hit.id },
          references: [],
          usedStyle: 0,
          usage: null,
        });
      }

      // 未命中话术，要交给模型。没配 key 就直接告诉他，别等抛错变成 500。
      if (!isLlmConfigured()) {
        return json(res, 400, {
          error: '这条没命中任何话术，需要走 AI，但 OPENAI_API_KEY 未配置',
          hint: '要么在 data/snippets.json 里加一条对应话术，要么配置 OPENAI_API_KEY',
          matched: false,
        });
      }

      const gen = await generateReply({
        question,
        history,
        knowledge: loadKnowledge(),
        styleMessages: loadStyleMessages(),
        persona: PERSONA || undefined,
        business: BUSINESS || undefined,
      });

      return json(res, 200, {
        answer: gen.text,
        source: 'llm',
        references: gen.references.map((r) => ({ question: r.doc.question, score: Number(r.score.toFixed(3)) })),
        usedStyle: gen.usedStyle,
        usage: gen.usage,
      });
    }

    // ---------- 报价卡片预览（不需要 LLM key）----------
    // 客户问一句，看机器人会回哪张卡片、跳哪个页面。
    // 支持 ?lang= 强制指定语言，用来看多语言效果。
    if (path === '/api/price' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const b = JSON.parse(await readBody(req));
      const { text } = b;
      if (!text) return json(res, 400, { error: 'text 必填' });

      const result = buildPriceReply(text, { lang: b.lang || url.searchParams.get('lang') || '' });
      if (!result) {
        return json(res, 200, {
          text,
          matched: false,
          reason: 'not-a-price-question',
          hint: '这条不是问价，或是在抱怨价格，会走话术 / AI',
        });
      }
      return json(res, 200, {
        text,
        matched: true,
        lang: result.lang,
        page: result.key,
        url: result.url,
        reason: result.reason,
        services: result.services,
        card: result.card,
        preview: explainPriceReply(result),
      });
    }

    // ---------- 话术预览（不需要 LLM key）----------
    // 客户问一句，看会命中哪条话术；命中就返回渲染好的卡片文本。
    // 用来调关键词，改完 data/snippets.json 重启即可。
    if (path === '/api/snippet' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const b = JSON.parse(await readBody(req));
      const { text } = b;
      if (!text) return json(res, 400, { error: 'text 必填' });

      const all = loadSnippets();
      const hit = matchSnippet(text, all);
      const width = hit ? checkCardWidth(hit.reply, 34) : null;

      return json(res, 200, {
        text,
        matched: Boolean(hit),
        snippet: hit ? { id: hit.id, label: hit.label || hit.id, reply: hit.reply } : null,
        width: width ? { maxWidth: width.maxWidth, over: width.over } : null,
        total: all.length,
      });
    }

    // ---------- 粘贴导入（客户加好友场景的零门槛路径）----------
    // 客户扫码加企微好友后，官方 API 不推消息（会话存档要付费）。
    // 这里接收客户端「全选复制」的聊天记录文本，解析后落库并自动配对。
    if (path === '/api/import' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const b = JSON.parse(await readBody(req));
      const { text, self_name = '', customer_name = '', dry = false } = b;
      if (!text || !String(text).trim()) return json(res, 400, { error: 'text 必填' });

      const parsed = parsePastedChat(text, {
        selfName: self_name,
        customerName: customer_name,
      });

      const inb = parsed.messages.filter((m) => m.direction === 'inbound').length;
      const summary = {
        parsed: parsed.messages.length,
        speakers: parsed.speakers,
        self: parsed.self,
        customer: parsed.customer,
        inbound: inb,
        outbound: parsed.messages.length - inb,
        warnings: parsed.warnings,
      };

      if (dry) return json(res, 200, { ok: true, dry: true, ...summary });

      const { added, skipped } = importMessages(store, parsed.messages);
      const paired = pairAll(store);
      log(`[import] 新增 ${added} 条消息，配对 ${paired.newPairs} 条 QA`);

      return json(res, 200, {
        ok: true,
        ...summary,
        added,
        skipped,
        newPairs: paired.newPairs,
        unanswered: paired.unanswered,
      });
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
  log('─'.repeat(52));
  log(`📥 omnibot-qa 服务  http://127.0.0.1:${PORT}`);
  log(`   数据库: ${DB}`);
  log(`   鉴权: ${SHARED_SECRET ? '已启用' : '未启用（生产环境建议配置 OMNIBOT_SECRET）'}`);
  log(`   模式: ${AUTO_REPLY ? '🤖 自动回复' : '📦 仅收集'}`);
  if (AUTO_REPLY) {
    log(`   LLM: ${isLlmConfigured() ? '✅ 已配置' : '❌ 未配置（设置 OPENAI_API_KEY）'}`);
    log(`   企业微信发送: ${isWecomConfigured() ? '✅ 已配置' : '❌ 未配置（回复只落库不发送）'}`);
  }
  log('   回调入口: /hook/wecom  /hook/wecombot  /hook/xhs  /api/message');
  log('─'.repeat(52));
});

// ---------- 企业微信智能机器人长连接 ----------
let botClient = null;
if (BOT_WS_ENABLED) {
  if (!isBotConfigured()) {
    log('⚠️  企业微信长连接：未配置 WECOM_BOT_ID / WECOM_BOT_SECRET，跳过');
  } else {
    log('🔌 企业微信智能机器人长连接启动中…');
    botClient = connectBot({
      onMessage: handleBotMessage,
      onEvent: (body, ctx) => {
        // 用户首次进入会话，可用来发欢迎语（这里只记日志）
        log(`[ws] 事件 ${body.event_type || '(未知)'} from=${body.from?.userid || '-'} req=${ctx.reqId}`);
      },
      onState: (state, detail) => {
        const label = {
          idle: '待机',
          connecting: '连接中',
          handshaking: '握手鉴权中',
          connected: '✅ 已连接',
          reconnecting: `重连中（${detail?.delay ?? 0}ms 后，${detail?.reason || ''}）`,
          error: `❌ 出错：${detail?.error ?? ''}`,
          closed: '已关闭',
        }[state] || state;
        log(`[ws] ${label}`);
      },
    });
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('关闭中…');
    try {
      botClient?.close();
    } catch {
      /* 忽略 */
    }
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000);
  });
}
