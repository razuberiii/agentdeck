import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const helper = path.join(repo, 'scripts/sqlite-backup.cjs');

test('bounded SQLite backup verifies then atomically publishes a readable copy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-sqlite-backup-'));
  try {
    const source = path.join(root, 'source.sqlite3');
    const destination = path.join(root, 'backup.sqlite3');
    const sourceDb = new Database(source);
    sourceDb.exec('CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES (\'ok\')');
    sourceDb.close();
    execFileSync(process.execPath, [helper, source, destination], { cwd: repo });
    const backup = new Database(destination, { readonly: true });
    assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(backup.prepare('SELECT value FROM marker').pluck().get(), 'ok');
    backup.close();
    assert.deepEqual((await readdir(root)).filter(name => name.includes('.partial.')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed SQLite backup removes its partial output and agentdeckctl applies an outer deadline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-sqlite-backup-fail-'));
  try {
    const source = path.join(root, 'invalid.sqlite3');
    const destination = path.join(root, 'backup.sqlite3');
    await writeFile(source, 'not sqlite');
    const result = spawnSync(process.execPath, [helper, source, destination], { cwd: repo, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.deepEqual((await readdir(root)).filter(name => name.includes('.partial.')), []);
    const ctl = await import('node:fs/promises').then(({ readFile }) => readFile(path.join(repo, 'scripts/agentdeckctl'), 'utf8'));
    assert.match(ctl, /timeout --kill-after=10s 310s node "\$SOURCE_ROOT\/scripts\/sqlite-backup\.cjs"/);
    assert.match(ctl, /AGENTDECK_CANDIDATE_DB_MODE:-minimal/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
