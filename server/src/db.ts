import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const execFileAsync = promisify(execFile);
export type Row = Record<string, string | number | null>;
export class Db {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private file: string) {}
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
  async init() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await this.run(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, codex_thread_id TEXT UNIQUE, project_dir TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, permission_mode TEXT NOT NULL, approval_policy TEXT NOT NULL, sandbox_mode TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, anchor_item_id TEXT, UNIQUE(session_id, path));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS codex_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, codex_home TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
  }
  async run(sql: string, params: unknown[] = []) { return this.enqueue(async () => { await execFileAsync('sqlite3', ['-batch', this.file, '-cmd', '.timeout 5000', ...this.bind(params), sql], { maxBuffer: 1024 * 1024 * 20 }); }); }
  async get(sql: string, params: unknown[] = []): Promise<Row | null> { const rows = await this.all(sql, params); return rows[0] ?? null; }
  async all(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.enqueue(async () => {
      const { stdout } = await execFileAsync('sqlite3', ['-json', this.file, '-cmd', '.timeout 5000', ...this.bind(params), sql], { maxBuffer: 1024 * 1024 * 20 });
      const text = stdout.trim(); return text ? JSON.parse(text) : [];
    });
  }
  private bind(params: unknown[]) { return params.flatMap((v, i) => ['-cmd', `.parameter set ?${i + 1} ${this.quote(v)}`]); }
  private quote(v: unknown) { if (v === null || v === undefined) return 'null'; if (typeof v === 'number') return String(v); return `'${String(v).replaceAll("'", "''")}'`; }
}
