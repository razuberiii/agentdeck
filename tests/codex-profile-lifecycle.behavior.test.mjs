import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateCodexProfileAtomically,
  evaluateCodexProfileReadiness,
} from '../server/dist/codex-profile-lifecycle.js';

const authenticated = {
  id:'new',
  codex_home:'/profiles/new/.codex',
  status:'authenticated',
  active:1,
  login:{ ok:true },
};

test('authenticated Codex profile without email or display identity is ready', () => {
  assert.deepEqual(evaluateCodexProfileReadiness(authenticated), { ok:true, profile:authenticated });
  assert.equal(evaluateCodexProfileReadiness({ ...authenticated, name:'Codex Account' }).ok, true);
});

test('non-authenticated Codex states cannot create sessions', () => {
  for (const status of ['draft','authenticating','verifying','failed','disabled']) {
    const result = evaluateCodexProfileReadiness({ ...authenticated, status });
    assert.equal(result.ok, false, status);
    assert.equal(result.code, 'codex_profile_not_authenticated', status);
  }
  assert.equal(evaluateCodexProfileReadiness({ ...authenticated, login:{ ok:false } }).ok, false);
});

test('runtime activation failure does not authenticate or activate a new login', async () => {
  const db = { old:{ status:'authenticated', active:1 }, new:null };
  let runtimeActive = 'old';
  await assert.rejects(
    activateCodexProfileAtomically({
      target:{ ...authenticated, status:'verifying', active:0 },
      previous:{ id:'old', codex_home:'/profiles/old/.codex', status:'authenticated', active:1 },
      verifyCredentials:async () => true,
      activateRuntime:async target => {
        runtimeActive = String(target.id);
        throw new Error('app-server failed');
      },
      restoreRuntime:async previous => { runtimeActive = String(previous.id); },
      commit:async () => {
        db.old.active = 0;
        db.new = { status:'authenticated', active:1 };
      },
    }),
    /runtime activation failed/,
  );
  assert.deepEqual(db, { old:{ status:'authenticated', active:1 }, new:null });
  assert.equal(runtimeActive, 'old');
});

test('failed account switch preserves old DB active profile and runtime account', async () => {
  const db = { active:'old' };
  let runtimeActive = 'old';
  await assert.rejects(activateCodexProfileAtomically({
    target:authenticated,
    previous:{ id:'old', codex_home:'/profiles/old/.codex', status:'authenticated', active:1 },
    verifyCredentials:async () => true,
    activateRuntime:async () => {
      runtimeActive = 'new';
      throw new Error('restart failed');
    },
    restoreRuntime:async previous => { runtimeActive = String(previous.id); },
    commit:async () => { db.active = 'new'; },
  }));
  assert.equal(db.active, 'old');
  assert.equal(runtimeActive, 'old');
});

test('successful activation commits matching Web and runtime active profiles', async () => {
  const db = { active:'old' };
  let runtimeActive = 'old';
  await activateCodexProfileAtomically({
    target:authenticated,
    previous:{ id:'old', codex_home:'/profiles/old/.codex', status:'authenticated', active:1 },
    verifyCredentials:async () => true,
    activateRuntime:async target => { runtimeActive = String(target.id); },
    restoreRuntime:async previous => { runtimeActive = String(previous.id); },
    commit:async () => { db.active = 'new'; },
  });
  assert.equal(db.active, 'new');
  assert.equal(runtimeActive, db.active);
});
