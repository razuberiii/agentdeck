import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE gemini_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      home_dir TEXT NOT NULL UNIQUE,
      auth_type TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'configured',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      account_id TEXT,
      current_upstream_account_id TEXT,
      account_snapshot_json TEXT,
      status TEXT NOT NULL
    );
  `);
  return db;
}

function visibleProfiles(db) {
  return db.prepare("SELECT id,status,active FROM gemini_profiles WHERE status NOT IN ('bootstrap','disabled') ORDER BY active DESC, updated_at DESC").all();
}

function reusableBootstrap(db) {
  const visible = db.prepare("SELECT id FROM gemini_profiles WHERE status NOT IN ('bootstrap','disabled') LIMIT 1").get();
  if (visible) return null;
  return db.prepare("SELECT * FROM gemini_profiles WHERE id='default' AND status='bootstrap'").get();
}

function deleteProfile(db, id) {
  const running = db.prepare("SELECT id FROM sessions WHERE provider_id='gemini' AND (current_upstream_account_id=? OR (current_upstream_account_id IS NULL AND account_id=?)) AND status IN ('running','submitting','recovering')").get(id, id);
  if (running) return { conflict: true };
  const profile = db.prepare("SELECT * FROM gemini_profiles WHERE id=?").get(id);
  const snapshot = JSON.stringify({ id, provider:'gemini', name:profile?.name || 'Gemini Account', timestamp:1 });
  db.prepare("UPDATE sessions SET account_snapshot_json=COALESCE(account_snapshot_json, ?) WHERE provider_id='gemini' AND account_id=?").run(snapshot, id);
  db.prepare('DELETE FROM gemini_profiles WHERE id=?').run(id);
  return { deleted: true };
}

test('bootstrap profile is hidden and first login reuses it', () => {
  const db = setup();
  db.prepare("INSERT INTO gemini_profiles VALUES ('default','Gemini Account','/tmp/default',NULL,0,'bootstrap',1,1)").run();
  db.prepare("INSERT INTO gemini_profiles VALUES ('abcd','Gemini Account','/tmp/abcd',NULL,0,'bootstrap',1,2)").run();

  assert.deepEqual(visibleProfiles(db), []);
  assert.equal(reusableBootstrap(db).id, 'default');

  db.prepare("UPDATE gemini_profiles SET status='configured', name='Gemini Account' WHERE id='default'").run();
  assert.deepEqual(visibleProfiles(db).map(p => p.id), ['default']);
});

test('unreferenced bootstrap can be hard deleted without regenerating a visible account', () => {
  const db = setup();
  db.prepare("INSERT INTO gemini_profiles VALUES ('default','Gemini Account','/tmp/default',NULL,0,'bootstrap',1,1)").run();

  assert.deepEqual(deleteProfile(db, 'default'), { deleted: true });
  assert.deepEqual(visibleProfiles(db), []);
});

test('referenced Gemini profile is deleted while history keeps a display snapshot', () => {
  const db = setup();
  db.prepare("INSERT INTO gemini_profiles VALUES ('default','Gemini Account','/tmp/default',NULL,1,'bootstrap',1,1)").run();
  db.prepare("INSERT INTO sessions VALUES ('s1','gemini','default',NULL,NULL,'idle')").run();

  assert.deepEqual(deleteProfile(db, 'default'), { deleted: true });
  assert.deepEqual(visibleProfiles(db), []);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM gemini_profiles WHERE id='default'").get().count, 0);
  assert.match(db.prepare("SELECT account_snapshot_json FROM sessions WHERE id='s1'").get().account_snapshot_json, /Gemini Account/);
});

test('currently running Gemini upstream account cannot be deleted', () => {
  const db = setup();
  db.prepare("INSERT INTO gemini_profiles VALUES ('a','Gemini A','/tmp/a',NULL,1,'authenticated',1,1)").run();
  db.prepare("INSERT INTO sessions VALUES ('s1','gemini','old','a',NULL,'running')").run();

  assert.deepEqual(deleteProfile(db, 'a'), { conflict: true });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM gemini_profiles WHERE id='a'").get().count, 1);
});
