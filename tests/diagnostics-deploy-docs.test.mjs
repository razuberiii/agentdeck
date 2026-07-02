import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const indexSource = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
const deploySource = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8');
const installUnitsSource = readFileSync(new URL('../deploy/install-units.sh', import.meta.url), 'utf8');
const cutoverSource = readFileSync(new URL('../deploy/cutover.sh', import.meta.url), 'utf8');
const gitignoreSource = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');

test('diagnostics endpoint and page expose safe runtime ownership fields', () => {
  assert.match(indexSource, /app\.get\('\/api\/diagnostics'/);
  assert.match(indexSource, /creatorProfileId/);
  assert.match(indexSource, /executingProfileId/);
  assert.match(indexSource, /runtimeLatestSequence/);
  assert.match(indexSource, /snapshotCoveredSequence/);
  assert.match(clientSource, /function DiagnosticsView/);
  assert.match(clientSource, /#\/diagnostics/);
  assert.doesNotMatch(clientSource, /auth\.json|OAuth code|消息正文/);
});

test('deploy entrypoint supports check deploy rollback without restarting on check', () => {
  const mode = statSync(new URL('../scripts/deploy.sh', import.meta.url)).mode;
  assert.ok(mode & 0o111, 'scripts/deploy.sh must be executable');
  assert.match(deploySource, /--check\|--deploy \[--components web,runtime\|--changed\]\|--rollback/);
  assert.match(deploySource, /npm run typecheck/);
  assert.match(deploySource, /npm run build/);
  assert.match(deploySource, /npm test/);
  assert.match(deploySource, /npm run test:e2e/);
  const checkBody = deploySource.slice(deploySource.indexOf('run_check()'), deploySource.indexOf('health_web()'));
  assert.doesNotMatch(checkBody, /systemctl restart|systemctl stop|cutover\.sh|rollback\.sh/);
});

test('deploy preserves the external production env dir and does not remount /etc', () => {
  assert.match(deploySource, /ENV_DIR="\$\{AGENTDECK_ENV_DIR:-\$\{ENV_DIR:-\$DATA_DIR\}\}"/);
  assert.match(deploySource, /check_env_dir\(\)/);
  assert.match(installUnitsSource, /ENV_DIR=\$\{AGENTDECK_ENV_DIR:-\$\{ENV_DIR:-\$DATA_DIR\}\}/);
  assert.match(cutoverSource, /env dir is not writable before cutover/);
  assert.doesNotMatch(installUnitsSource, /mount -o remount/);
  assert.doesNotMatch(cutoverSource, /mount -o remount/);
});

test('architecture docs and ADRs are present', () => {
  const docs = [
    'docs/architecture.md',
    'docs/adr/001-runtime-source-of-truth.md',
    'docs/adr/002-account-and-login-attempt.md',
    'docs/adr/003-codex-app-server-lifecycle.md',
    'docs/adr/004-provider-adapter.md',
    'docs/adr/005-session-execution-profile.md',
    'docs/adr/006-event-sequence-and-replay.md',
    'docs/adr/007-deployment-unit.md',
  ];
  for (const doc of docs) assert.ok(existsSync(new URL(`../${doc}`, import.meta.url)), `${doc} is missing`);
  const architecture = readFileSync(new URL('../docs/architecture.md', import.meta.url), 'utf8');
  assert.match(architecture, /Runtime-owned/);
  assert.match(architecture, /Web-owned/);
  assert.match(architecture, /Deprecated duplicate/);
  assert.match(architecture, /Canonical user messages/);
  assert.match(architecture, /Artifacts are owned by the turn/);
  assert.match(architecture, /Runtime draining/);
  assert.match(architecture, /gemini_client_unsupported/);
  assert.match(architecture, /\/opt\/data\/agentdeck\/backups\//);
  assert.match(gitignoreSource, /^\.backups\/$/m);
});
