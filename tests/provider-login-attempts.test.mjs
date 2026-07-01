import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';

const serverSource = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
const dbSource = readFileSync(new URL('../server/src/db.ts', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');

test('provider login attempts have a dedicated table separate from formal profiles', () => {
  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS provider_login_attempts/);
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS provider_login_attempts/);
  assert.match(serverSource, /type ProviderLoginAttemptStatus = 'starting'\|'waiting_authorization'\|'waiting_code'\|'verifying'\|'failed'\|'cancelled'\|'done'/);
});

test('new Codex login starts as LoginAttempt instead of inserting a formal profile', () => {
  const codexCreateRoute = serverSource.slice(
    serverSource.indexOf("app.post('/api/profiles'"),
    serverSource.indexOf("app.post('/api/profiles/:id/switch'")
  );
  assert.match(codexCreateRoute, /createProviderLoginAttempt\('codex'/);
  assert.doesNotMatch(codexCreateRoute, /INSERT INTO codex_profiles/);
  assert.match(serverSource, /completeCodexLoginAttempt/);
  assert.match(serverSource, /INSERT INTO codex_profiles \(id,name,codex_home,active,status,created_at,updated_at\).*'authenticated'/s);
});

test('pending UI presents login jobs as tasks, not accounts', () => {
  assert.match(clientSource, /登录中的任务/);
  assert.doesNotMatch(clientSource, /登录中的账户/);
  assert.match(clientSource, /取消登录/);
  assert.match(clientSource, /deleteProfile\.isLoginAttempt\?'取消登录？':'删除 Codex 账户？'/);
  assert.match(clientSource, /deleteGeminiProfile\.isLoginAttempt\?'取消登录？':'删除 Gemini 账户？'/);
});

test('formal account queries exclude login attempts', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, provider TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE provider_login_attempts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, status TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO profiles VALUES ('codex-real','codex','authenticated')").run();
  db.prepare("INSERT INTO provider_login_attempts VALUES ('codex-login','codex','waiting_authorization')").run();

  const formal = db.prepare("SELECT id FROM profiles WHERE provider='codex' AND status='authenticated'").all().map(row => row.id);
  const attempts = db.prepare("SELECT id FROM provider_login_attempts WHERE provider='codex' AND status!='done'").all().map(row => row.id);

  assert.deepEqual(formal, ['codex-real']);
  assert.deepEqual(attempts, ['codex-login']);
});
