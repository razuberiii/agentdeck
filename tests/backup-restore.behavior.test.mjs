import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const repo = new URL('..', import.meta.url).pathname;

test('backup manifest covers every entry and preserves provider executable mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentdeck-backup-behavior-'));
  const data = join(root, 'data'), extract = join(root, 'extract');
  mkdirSync(join(data, 'provider-tools/bin'), { recursive: true }); mkdirSync(extract);
  const provider = join(data, 'provider-tools/bin/provider');
  writeFileSync(provider, '#!/bin/sh\nexit 0\n'); chmodSync(provider, 0o755);
  execFileSync(process.execPath, ['-e', `const D=require('better-sqlite3');for(const f of process.argv.slice(1)){const d=new D(f);d.exec('create table marker(v)');d.close()}`, join(data,'agentdeck.sqlite3'), join(data,'agentdeck-runtime.sqlite3')], { cwd: repo });
  try {
    const archive = execFileSync('bash', ['-c', `source "$1/scripts/agentdeckctl"; run_backup 0`, '_', repo], {
      encoding: 'utf8', env: { ...process.env, AGENTDECK_ROOT: root, AGENTDECK_SOURCE_ROOT: repo, AGENTDECK_DEPLOY_STATE_DIR: join(root,'state'), AGENTDECK_ENV_DIR: join(root,'env'), AGENTDECK_BACKUP_DIR: join(root,'backups'), DATA_DIR: data },
    }).trim();
    execFileSync('tar', ['--zstd', '-xf', archive, '-C', extract]);
    const manifest = JSON.parse(readFileSync(join(extract, 'manifest.json'), 'utf8'));
    const entry = manifest.entries.find(e => e.path === 'data/provider-tools/bin/provider');
    assert.deepEqual({ type: entry.type, mode: entry.mode }, { type: 'file', mode: '755' });
    assert.equal(statSync(join(extract, entry.path)).mode & 0o777, 0o755);
    assert.ok(manifest.entries.some(e => e.type === 'directory' && e.path === 'data/provider-tools/bin'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
