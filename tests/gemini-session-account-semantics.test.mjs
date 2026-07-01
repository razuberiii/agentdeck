import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, active INTEGER NOT NULL, status TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      account_id TEXT,
      current_upstream_account_id TEXT,
      last_execution_account_id TEXT,
      provider_session_id TEXT,
      account_snapshot_json TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE events (session_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL);
  `);
  return db;
}

function activeProfile(db) {
  return db.prepare("SELECT * FROM profiles WHERE active=1 AND status='authenticated'").get();
}

function switchActive(db, id) {
  db.prepare('UPDATE profiles SET active=0').run();
  db.prepare("UPDATE profiles SET active=1 WHERE id=? AND status='authenticated'").run(id);
}

function sendGeminiTurn(db, sessionId, runtimeCalls) {
  const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
  const active = activeProfile(db);
  if (!active) return { error:'请先登录 Gemini' };
  const previous = session.current_upstream_account_id || session.last_execution_account_id || session.account_id;
  if (previous && previous !== active.id) {
    runtimeCalls.push(['createSession', active.id]);
    db.prepare("INSERT INTO events VALUES (?, 'system', ?)").run(sessionId, JSON.stringify({ text:'已切换 Gemini 账户，上游会话已在新账户下重建。' }));
    db.prepare('UPDATE sessions SET current_upstream_account_id=?, last_execution_account_id=?, provider_session_id=? WHERE id=?')
      .run(active.id, active.id, `upstream-${active.id}`, sessionId);
  } else {
    runtimeCalls.push(['recoverSession', active.id]);
    db.prepare('UPDATE sessions SET current_upstream_account_id=?, last_execution_account_id=? WHERE id=?').run(active.id, active.id, sessionId);
  }
  return { ok:true, sessionId, accountId:active.id };
}

function deleteGeminiProfile(db, id, runtimeCalls) {
  const running = db.prepare("SELECT id FROM sessions WHERE provider_id='gemini' AND (current_upstream_account_id=? OR (current_upstream_account_id IS NULL AND account_id=?)) AND status IN ('running','submitting','recovering')").get(id, id);
  if (running) return { code:409 };
  runtimeCalls.push(['cancelLogin', id]);
  runtimeCalls.push(['disposeGeminiProfile', id]);
  const profile = db.prepare('SELECT * FROM profiles WHERE id=?').get(id);
  db.prepare('UPDATE sessions SET account_snapshot_json=COALESCE(account_snapshot_json, ?) WHERE provider_id=? AND account_id=?')
    .run(JSON.stringify({ id, provider:'gemini', name:profile?.name || 'Gemini Account', timestamp:1 }), 'gemini', id);
  db.prepare('DELETE FROM profiles WHERE id=?').run(id);
  if (!activeProfile(db)) {
    const next = db.prepare("SELECT id FROM profiles WHERE status='authenticated' ORDER BY id LIMIT 1").get();
    if (next) switchActive(db, next.id);
  }
  return { ok:true };
}

test('Gemini AgentDeck session continues under the current active profile after account switch and old account deletion', () => {
  const db = setup();
  const calls = [];
  db.prepare("INSERT INTO profiles VALUES ('A',1,'authenticated','Gemini A')").run();
  db.prepare("INSERT INTO profiles VALUES ('B',0,'authenticated','Gemini B')").run();
  db.prepare("INSERT INTO sessions VALUES ('s1','gemini','A','A','A','upstream-A',NULL,'idle')").run();

  switchActive(db, 'B');
  assert.deepEqual(sendGeminiTurn(db, 's1', calls), { ok:true, sessionId:'s1', accountId:'B' });
  assert.equal(db.prepare("SELECT current_upstream_account_id FROM sessions WHERE id='s1'").get().current_upstream_account_id, 'B');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM events WHERE event_type='system'").get().count, 1);

  assert.deepEqual(deleteGeminiProfile(db, 'A', calls), { ok:true });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM profiles WHERE id='A'").get().count, 0);
  assert.deepEqual(sendGeminiTurn(db, 's1', calls), { ok:true, sessionId:'s1', accountId:'B' });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM events WHERE event_type='system'").get().count, 1);
});

test('Gemini delete path disposes ACP and never restarts the deleted profile', () => {
  const db = setup();
  const calls = [];
  db.prepare("INSERT INTO profiles VALUES ('A',1,'authenticated','Gemini A')").run();
  db.prepare("INSERT INTO sessions VALUES ('s1','gemini','A',NULL,NULL,'upstream-A',NULL,'idle')").run();

  assert.deepEqual(deleteGeminiProfile(db, 'A', calls), { ok:true });
  assert.ok(calls.some(call => call[0] === 'disposeGeminiProfile'));
  assert.equal(calls.some(call => call[0] === 'restartGeminiProfile'), false);
});

test('Gemini delete returns conflict only for the currently running upstream account', () => {
  const db = setup();
  const calls = [];
  db.prepare("INSERT INTO profiles VALUES ('A',1,'authenticated','Gemini A')").run();
  db.prepare("INSERT INTO sessions VALUES ('s1','gemini','A','A','A','upstream-A',NULL,'running')").run();

  assert.deepEqual(deleteGeminiProfile(db, 'A', calls), { code:409 });
  assert.equal(calls.length, 0);
});
