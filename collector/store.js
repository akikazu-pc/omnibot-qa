/**
 * 消息归档存储（SQLite，零依赖，Node 22 内置 node:sqlite）
 *
 * 表设计：
 * - messages      原始消息流水，只追加不改
 * - qa_pairs      配对出的 QA 候选，带审核状态
 *
 * 审核状态流转：pending → approved / rejected
 *   pending   自动配对出来的，待人工确认
 *   approved  人工确认可用，进知识库
 *   rejected  配对错误或答案不好，丢弃
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  platform        TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  sender_name     TEXT DEFAULT '',
  direction       TEXT NOT NULL,
  msg_type        TEXT NOT NULL,
  content         TEXT NOT NULL,
  timestamp       INTEGER NOT NULL,
  is_group        INTEGER DEFAULT 0,
  inserted_at     INTEGER NOT NULL,
  raw             TEXT
);

CREATE INDEX IF NOT EXISTS idx_msg_conv   ON messages(platform, conversation_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_msg_ts     ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(platform, sender_id);

CREATE TABLE IF NOT EXISTS qa_pairs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  platform        TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  question_msg_id TEXT,
  answer_msg_id   TEXT,
  asked_at        INTEGER,
  answered_at     INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending',
  note            TEXT DEFAULT '',
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qa_status ON qa_pairs(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_uniq ON qa_pairs(question_msg_id, answer_msg_id);

CREATE TABLE IF NOT EXISTS dedupe (
  key        TEXT PRIMARY KEY,
  seen_at    INTEGER NOT NULL
);
`;

export class Store {
  /** @param {string} dbPath 传 ':memory:' 则用内存库（测试用） */
  constructor(dbPath = 'data/omnibot.db') {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  /**
   * 幂等写入：同一 id 重复到达（平台重试）直接忽略。
   * @returns {boolean} 是否真正新增
   */
  insertMessage(msg) {
    const stmt = this.db.prepare(`
      INSERT INTO messages
        (id, platform, conversation_id, sender_id, sender_name, direction,
         msg_type, content, timestamp, is_group, inserted_at, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);
    const r = stmt.run(
      msg.id,
      msg.platform,
      msg.conversation_id,
      msg.sender_id,
      msg.sender_name || '',
      msg.direction,
      msg.msg_type,
      msg.content,
      msg.timestamp,
      msg.is_group ? 1 : 0,
      Date.now(),
      msg.raw ? JSON.stringify(msg.raw) : null
    );
    return r.changes > 0;
  }

  /** 批量写入，返回新增条数 */
  insertMessages(list) {
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const m of list) if (this.insertMessage(m)) n++;
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return n;
  }

  /** 取某个会话的消息，按时间升序 */
  getConversation(platform, conversationId, { limit = 200 } = {}) {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE platform = ? AND conversation_id = ?
         ORDER BY timestamp ASC
         LIMIT ?`
      )
      .all(platform, conversationId, limit);
  }

  /** 统计 */
  stats() {
    const msg = this.db.prepare('SELECT platform, COUNT(*) n FROM messages GROUP BY platform').all();
    const qa = this.db.prepare('SELECT status, COUNT(*) n FROM qa_pairs GROUP BY status').all();
    return { messages: msg, qa };
  }

  /** 保存一对 QA 候选 */
  saveQaPair(pair) {
    const stmt = this.db.prepare(`
      INSERT INTO qa_pairs
        (platform, conversation_id, question, answer, question_msg_id,
         answer_msg_id, asked_at, answered_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(question_msg_id, answer_msg_id) DO NOTHING
    `);
    const r = stmt.run(
      pair.platform,
      pair.conversation_id,
      pair.question,
      pair.answer,
      pair.question_msg_id || null,
      pair.answer_msg_id || null,
      pair.asked_at || null,
      pair.answered_at || null,
      pair.status || 'pending',
      Date.now()
    );
    return r.changes > 0;
  }

  listQa({ status, platform, limit = 100 } = {}) {
    const where = [];
    const args = [];
    if (status) {
      where.push('status = ?');
      args.push(status);
    }
    if (platform) {
      where.push('platform = ?');
      args.push(platform);
    }
    const sql = `SELECT * FROM qa_pairs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit);
  }

  setQaStatus(id, status, note = '') {
    const r = this.db
      .prepare('UPDATE qa_pairs SET status = ?, note = ? WHERE id = ?')
      .run(status, note, id);
    return r.changes > 0;
  }

  close() {
    this.db.close();
  }
}
