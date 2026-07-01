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
  const refs = db.prepare("SELECT COUNT(*) count FROM sessions WHERE provider_id='gemini' AND account_id=?").get(id).count;
  if (refs > 0) {
    db.prepare("UPDATE gemini_profiles SET active=0,status='disabled' WHERE id=?").run(id);
    return { hidden: true, references: refs };
  }
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

test('referenced profile is disabled and hidden instead of rejected', () => {
  const db = setup();
  db.prepare("INSERT INTO gemini_profiles VALUES ('default','Gemini Account','/tmp/default',NULL,1,'bootstrap',1,1)").run();
  db.prepare("INSERT INTO sessions VALUES ('s1','gemini','default','idle')").run();

  assert.deepEqual(deleteProfile(db, 'default'), { hidden: true, references: 1 });
  assert.deepEqual(visibleProfiles(db), []);
  assert.equal(db.prepare("SELECT status,active FROM gemini_profiles WHERE id='default'").get().status, 'disabled');
});
