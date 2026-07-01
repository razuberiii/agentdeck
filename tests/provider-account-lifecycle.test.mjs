import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

function db() {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, provider TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'authenticated');
    CREATE TABLE sessions (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, account_id TEXT, status TEXT NOT NULL);
  `);
  return d;
}

function visibleAccounts(d, provider) {
  return d.prepare("SELECT id FROM profiles WHERE provider=? AND status='authenticated' ORDER BY active DESC, id").all(provider).map(x => x.id);
}

function pendingAccounts(d, provider) {
  return d.prepare("SELECT id FROM profiles WHERE provider=? AND status IN ('draft','authenticating','verifying','failed') ORDER BY id").all(provider).map(x => x.id);
}

function deleteAccount(d, provider, id) {
  const running = d.prepare("SELECT id FROM sessions WHERE provider_id=? AND account_id=? AND status IN ('running','submitting','recovering')").get(provider, id);
  if (running) return { error:'该账户仍有正在运行的任务，请停止任务后再删除。' };
  const refs = d.prepare('SELECT COUNT(*) count FROM sessions WHERE provider_id=? AND account_id=?').get(provider, id).count;
  if (refs > 0) {
    d.prepare("UPDATE profiles SET active=0,status='disabled' WHERE provider=? AND id=?").run(provider, id);
    ensureActive(d, provider);
    return { hidden:true };
  }
  d.prepare('DELETE FROM profiles WHERE provider=? AND id=?').run(provider, id);
  ensureActive(d, provider);
  return { deleted:true };
}

function ensureActive(d, provider) {
  const active = d.prepare("SELECT id FROM profiles WHERE provider=? AND active=1 AND status='authenticated'").get(provider);
  if (active) return;
  d.prepare('UPDATE profiles SET active=0 WHERE provider=?').run(provider);
  const next = d.prepare("SELECT id FROM profiles WHERE provider=? AND status='authenticated' ORDER BY id LIMIT 1").get(provider);
  if (next) d.prepare('UPDATE profiles SET active=1 WHERE provider=? AND id=?').run(provider, next.id);
}

test('unverified Gemini profile is pending, not a formal account', () => {
  const d = db();
  d.prepare("INSERT INTO profiles VALUES ('g1','gemini',0,'draft')").run();
  d.prepare("INSERT INTO profiles VALUES ('g2','gemini',1,'authenticated')").run();

  assert.deepEqual(visibleAccounts(d, 'gemini'), ['g2']);
  assert.deepEqual(pendingAccounts(d, 'gemini'), ['g1']);
});

test('deleting active account selects the next authenticated account', () => {
  const d = db();
  d.prepare("INSERT INTO profiles VALUES ('a','gemini',1,'authenticated')").run();
  d.prepare("INSERT INTO profiles VALUES ('b','gemini',0,'authenticated')").run();

  assert.deepEqual(deleteAccount(d, 'gemini', 'a'), { deleted:true });
  assert.equal(d.prepare("SELECT active FROM profiles WHERE id='b'").get().active, 1);
});

test('deleting the only active account leaves no active account', () => {
  const d = db();
  d.prepare("INSERT INTO profiles VALUES ('a','codex',1,'authenticated')").run();

  assert.deepEqual(deleteAccount(d, 'codex', 'a'), { deleted:true });
  assert.equal(d.prepare("SELECT COUNT(*) count FROM profiles WHERE provider='codex' AND active=1").get().count, 0);
});

test('historical references tombstone an account without breaking history', () => {
  const d = db();
  d.prepare("INSERT INTO profiles VALUES ('a','antigravity',1,'authenticated')").run();
  d.prepare("INSERT INTO sessions VALUES ('s1','antigravity','a','idle')").run();

  assert.deepEqual(deleteAccount(d, 'antigravity', 'a'), { hidden:true });
  assert.equal(d.prepare("SELECT status FROM profiles WHERE id='a'").get().status, 'disabled');
  assert.equal(d.prepare("SELECT COUNT(*) count FROM sessions WHERE account_id='a'").get().count, 1);
});

test('running account deletion returns the unified explicit error', () => {
  const d = db();
  d.prepare("INSERT INTO profiles VALUES ('a','codex',1,'authenticated')").run();
  d.prepare("INSERT INTO sessions VALUES ('s1','codex','a','running')").run();

  assert.deepEqual(deleteAccount(d, 'codex', 'a'), { error:'该账户仍有正在运行的任务，请停止任务后再删除。' });
});
