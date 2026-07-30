import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { adoptExistingCodexAuth } from '../server/dist/codex-auth-bootstrap.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-auth-bootstrap-'));
  const userHome = path.join(root, 'home');
  const managedHome = path.join(root, 'managed');
  await mkdir(path.join(userHome, '.codex'), { recursive:true });
  return { root, userHome, managedHome };
}

test('imports an existing Codex login into an empty managed profile', async t => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive:true, force:true }));
  const auth = JSON.stringify({ tokens:{ access_token:'test-token' } });
  await writeFile(path.join(paths.userHome, '.codex', 'auth.json'), auth, { mode:0o600 });

  assert.equal(await adoptExistingCodexAuth(paths.userHome, paths.managedHome), true);
  assert.equal(await readFile(path.join(paths.managedHome, 'auth.json'), 'utf8'), auth);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(paths.managedHome, 'auth.json'))).mode & 0o777, 0o600);
  }
});

test('never overwrites credentials already stored in the managed profile', async t => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive:true, force:true }));
  await mkdir(paths.managedHome, { recursive:true });
  await writeFile(path.join(paths.userHome, '.codex', 'auth.json'), '{"source":true}');
  await writeFile(path.join(paths.managedHome, 'auth.json'), '{"managed":true}');

  assert.equal(await adoptExistingCodexAuth(paths.userHome, paths.managedHome), false);
  assert.equal(await readFile(path.join(paths.managedHome, 'auth.json'), 'utf8'), '{"managed":true}');
});

test('does nothing when the system user has no existing Codex login', async t => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive:true, force:true }));
  await rm(path.join(paths.userHome, '.codex', 'auth.json'), { force:true });

  assert.equal(await adoptExistingCodexAuth(paths.userHome, paths.managedHome), false);
});

test('does not import malformed credentials', async t => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive:true, force:true }));
  await writeFile(path.join(paths.userHome, '.codex', 'auth.json'), 'not-json');

  assert.equal(await adoptExistingCodexAuth(paths.userHome, paths.managedHome), false);
});
