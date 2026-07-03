import crypto from 'node:crypto';
import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Db } from '../db.js';
import type { ClaudeProfile, ClaudeProfileType } from './claude-types.js';
import { maskSecret } from './claude-redaction.js';

const ENV_FILE = 'env.json';

export class ClaudeProfileStore {
  constructor(
    private db: Db,
    private dataDir: string,
    private allowedExternalConfigDir?: string | null,
  ) {}

  root() {
    return process.env.CLAUDE_PROFILE_ROOT || path.join(this.dataDir, 'claude', 'profiles');
  }

  async initSchema() {
    await this.db.run("CREATE TABLE IF NOT EXISTS claude_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, profile_dir TEXT NOT NULL UNIQUE, config_dir TEXT NOT NULL UNIQUE, type TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'not_configured', credential_summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  }

  async list() {
    await this.initSchema();
    const rows = await this.db.all('SELECT * FROM claude_profiles ORDER BY active DESC, updated_at DESC');
    return rows.map(row => this.dto(row));
  }

  async active() {
    await this.initSchema();
    const row = await this.db.get('SELECT * FROM claude_profiles WHERE active=1 ORDER BY updated_at DESC LIMIT 1');
    return row ? this.dto(row) : null;
  }

  async get(id: string) {
    await this.initSchema();
    if (!/^[a-f0-9]{16}$/i.test(id) && id !== 'default') return null;
    const row = await this.db.get('SELECT * FROM claude_profiles WHERE id=?1', [id]);
    return row ? this.dto(row) : null;
  }

  async create(input: { name?: string; type: ClaudeProfileType; token?: string; apiKey?: string; existingConfigDir?: string }) {
    await this.initSchema();
    const id = crypto.randomBytes(8).toString('hex');
    const profileDir = path.join(this.root(), id);
    const configDir = input.type === 'existing_cli'
      ? await this.resolveExistingConfigDir(input.existingConfigDir || process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude'))
      : path.join(profileDir, 'config');
    await mkdir(profileDir, { recursive:true, mode:0o700 });
    await chmod(profileDir, 0o700);
    if (input.type !== 'existing_cli') {
      await mkdir(configDir, { recursive:true, mode:0o700 });
      await chmod(configDir, 0o700);
    }
    const env: Record<string, string> = {};
    let summary = '';
    if (input.type === 'setup_token') {
      if (!input.token || !/^.{20,4096}$/.test(input.token)) throw new Error('bad Claude setup token');
      env.CLAUDE_CODE_OAUTH_TOKEN = input.token;
      summary = maskSecret(input.token);
    }
    if (input.type === 'api_key') {
      if (!input.apiKey || !/^sk-ant-[A-Za-z0-9._-]{20,}$/.test(input.apiKey)) throw new Error('bad Anthropic API key');
      env.ANTHROPIC_API_KEY = input.apiKey;
      summary = maskSecret(input.apiKey);
    }
    if (Object.keys(env).length) await this.writeEnv(profileDir, env);
    const now = Date.now();
    const active = (await this.list()).length ? 0 : 1;
    const status = input.type === 'existing_cli' ? 'not_configured' : 'authenticated';
    await this.db.run(
      "INSERT INTO claude_profiles (id,name,profile_dir,config_dir,type,active,status,credential_summary,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
      [id, input.name || 'Claude Code Account', profileDir, configDir, input.type, active, status, summary || null, now]
    );
    return this.get(id);
  }

  async switch(id: string) {
    const profile = await this.get(id);
    if (!profile) throw new Error('Claude profile not found');
    await this.db.run('UPDATE claude_profiles SET active=0');
    await this.db.run('UPDATE claude_profiles SET active=1, updated_at=?1 WHERE id=?2', [Date.now(), id]);
    return this.get(id);
  }

  async rename(id: string, name: string) {
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) throw new Error('name required');
    await this.db.run('UPDATE claude_profiles SET name=?1, updated_at=?2 WHERE id=?3', [clean, Date.now(), id]);
    return this.get(id);
  }

  async delete(id: string) {
    const profile = await this.get(id);
    if (!profile) return false;
    await this.db.run('DELETE FROM claude_profiles WHERE id=?1', [id]);
    if (profile.profileDir.startsWith(path.join(this.root(), id))) await rm(profile.profileDir, { recursive:true, force:true }).catch(()=>{});
    const next = (await this.list())[0];
    if (next && !(await this.active())) await this.switch(next.id);
    return true;
  }

  async readEnv(profile: ClaudeProfile) {
    try {
      const parsed = JSON.parse(await readFile(path.join(profile.profileDir, ENV_FILE), 'utf8'));
      const env: Record<string, string> = {};
      for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) if (typeof parsed[key] === 'string') env[key] = parsed[key];
      return env;
    } catch {
      return {};
    }
  }

  async markStatus(id: string, status: ClaudeProfile['status']) {
    await this.db.run('UPDATE claude_profiles SET status=?1, updated_at=?2 WHERE id=?3', [status, Date.now(), id]);
  }

  private async writeEnv(profileDir: string, env: Record<string, string>) {
    const file = path.join(profileDir, ENV_FILE);
    await writeFile(file, JSON.stringify(env), { mode:0o600 });
    await chmod(file, 0o600);
  }

  private async resolveExistingConfigDir(input: string) {
    const allowed = this.allowedExternalConfigDir || process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude');
    if (!input) throw new Error('Claude config dir required');
    if (input.includes('..')) throw new Error('Claude config dir cannot contain ..');
    const base = realpathSync(allowed);
    const resolved = existsSync(input) ? realpathSync(input) : path.resolve(input);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('Claude config dir is outside allowed root');
    return resolved;
  }

  private dto(row: any): ClaudeProfile {
    return {
      id:String(row.id),
      name:String(row.name),
      profileDir:String(row.profile_dir),
      configDir:String(row.config_dir),
      type:String(row.type) as ClaudeProfileType,
      active:Number(row.active || 0) === 1,
      status:String(row.status || 'not_configured') as ClaudeProfile['status'],
      credentialSummary:row.credential_summary ? String(row.credential_summary) : null,
      createdAt:Number(row.created_at || 0),
      updatedAt:Number(row.updated_at || 0),
    };
  }
}
