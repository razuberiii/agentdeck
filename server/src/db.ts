import Database from 'better-sqlite3';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export type Row = Record<string, string | number | null>;

export class Db {
  private conn: Database.Database | null = null;
  constructor(private file: string) {}

  async init() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const db = this.open();
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, codex_thread_id TEXT UNIQUE, project_dir TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, permission_mode TEXT NOT NULL, approval_policy TEXT NOT NULL, sandbox_mode TEXT NOT NULL, model TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, anchor_item_id TEXT, turn_id TEXT, relative_path TEXT, content_hash TEXT, modified_at INTEGER, UNIQUE(session_id, path));
CREATE TABLE IF NOT EXISTS artifact_baselines (session_id TEXT NOT NULL, turn_id TEXT NOT NULL, project_dir TEXT NOT NULL, manifest_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session_id, turn_id));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS codex_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, codex_home TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'authenticated', email TEXT, display_name TEXT, metadata_status TEXT NOT NULL DEFAULT 'pending', metadata_error TEXT, metadata_updated_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS gemini_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, home_dir TEXT NOT NULL UNIQUE, auth_type TEXT, active INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'configured', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS provider_login_attempts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, profile_id TEXT, temp_home TEXT, method_id TEXT, status TEXT NOT NULL, error TEXT, metadata_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, client_message_id TEXT, turn_id TEXT, original_text TEXT, attachments_json TEXT, status TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS agent_messages_session_client_message ON agent_messages(session_id,client_message_id) WHERE client_message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS interactive_requests (request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, provider_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, options_json TEXT NOT NULL, allow_free_text INTEGER NOT NULL DEFAULT 0, default_option_id TEXT, status TEXT NOT NULL, answer_json TEXT, metadata_json TEXT, created_at INTEGER NOT NULL, answered_at INTEGER);
CREATE INDEX IF NOT EXISTS interactive_requests_session_status ON interactive_requests(session_id,status,created_at);
CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
  }

  async run(sql: string, params: unknown[] = []) {
    const db = this.open();
    if (!params.length && this.isMultiStatement(sql)) {
      db.exec(sql);
      return { changes: 0, lastInsertRowid: 0 };
    }
    const info = db.prepare(sql).run(this.bind(sql, params));
    return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
  }

  async get(sql: string, params: unknown[] = []): Promise<Row | null> {
    return (this.open().prepare(sql).get(this.bind(sql, params)) as Row | undefined) ?? null;
  }

  async all(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.open().prepare(sql).all(this.bind(sql, params)) as Row[];
  }

  transaction<T>(fn: () => T): T {
    return this.open().transaction(fn)();
  }

  transactionRun(statements:Array<{ sql:string; params?:unknown[] }>) {
    const db = this.open();
    return db.transaction(() => {
      for (const statement of statements) {
        db.prepare(statement.sql).run(this.bind(statement.sql, statement.params || []));
      }
    })();
  }

  close() {
    if (!this.conn) return;
    this.conn.pragma('wal_checkpoint(TRUNCATE)');
    this.conn.close();
    this.conn = null;
  }

  private open() {
    if (!this.conn) this.conn = new Database(this.file);
    return this.conn;
  }

  private isMultiStatement(sql: string) {
    return sql.split(';').filter(part => part.trim()).length > 1;
  }

  private bind(sql: string, params: unknown[]) {
    if (!params.length) return [];
    if (!/\?\d+/.test(sql)) return params;
    const bound: Record<string, unknown> = {};
    params.forEach((value, index) => { bound[String(index + 1)] = value; });
    return bound;
  }
}
