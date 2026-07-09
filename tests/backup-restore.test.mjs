import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ctl = readFileSync(new URL('../scripts/agentdeckctl', import.meta.url), 'utf8');

function block(start, end) {
  const from = ctl.indexOf(start);
  assert.notEqual(from, -1, `${start} not found`);
  const to = ctl.indexOf(end, from);
  assert.notEqual(to, -1, `${end} not found after ${start}`);
  return ctl.slice(from, to);
}

test('agentdeckctl exposes backup and restore commands', () => {
  assert.match(ctl, /backup \[--include-secrets\]/);
  assert.match(ctl, /restore <backup\.tar\.zst> \[--dry-run\] \[--force\]/);
  assert.match(ctl, /backup\) run_backup "\$INCLUDE_SECRETS"/);
  assert.match(ctl, /restore\) run_restore "\$TARGET" "\$DRY_RUN" "\$FORCE"/);
});

test('backup creates required manifest and default portable archive name', () => {
  const runBackup = block('run_backup() {', 'restore_usage() {');
  assert.match(runBackup, /agentdeck-backup-\$stamp\.tar\.zst/);
  assert.match(ctl, /version:pkg\.version/);
  assert.match(ctl, /commit,/);
  assert.match(ctl, /created_at:new Date\(\)\.toISOString\(\)/);
  assert.match(ctl, /profile:profile \|\| 'personal'/);
  assert.match(ctl, /data_dir:dataDir/);
  assert.match(ctl, /included_secrets:includeSecrets === '1'/);
});

test('backup includes core data by default and secrets only when explicit', () => {
  const runBackup = block('run_backup() {', 'restore_usage() {');
  assert.match(runBackup, /sqlite_file_backup "\$DATA_DIR\/agentdeck\.sqlite3"/);
  assert.match(runBackup, /sqlite_file_backup "\$\{RUNTIME_DB:-\$DATA_DIR\/agentdeck-runtime\.sqlite3\}"/);
  assert.match(runBackup, /for rel in attachments artifacts shared\/generated_images/);
  assert.match(runBackup, /if \[ "\$include_secrets" = "1" \]/);
  assert.match(runBackup, /for rel in profiles claude\/profiles gemini\/profiles antigravity-profiles shared\/sessions/);
  assert.match(runBackup, /WARNING: --include-secrets will include provider tokens/);
  assert.match(runBackup, /redacted_env_summary "\$tmp\/redacted-env-summary\.json"/);
});

test('restore dry-run reports contents and force is required before overwrite', () => {
  const runRestore = block('run_restore() {', 'start_candidate_runtime() {');
  assert.match(runRestore, /Backup manifest:/);
  assert.match(runRestore, /Will restore:/);
  assert.match(runRestore, /if \[ "\$dry_run" = "1" \]/);
  assert.match(runRestore, /target data exists in \$DATA_DIR; rerun with --force to overwrite/);
  assert.match(runRestore, /restore requires --force/);
  assert.match(runRestore, /Restore complete/);
});

