import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runtime = readFileSync(new URL('../server/src/agentdeck-runtime.ts', import.meta.url), 'utf8');
const deploy = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8');
const ctl = readFileSync(new URL('../scripts/agentdeckctl', import.meta.url), 'utf8');

test('runtime exposes lifecycle draining and rejects new work while draining', () => {
  assert.match(runtime, /type RuntimeLifecycle = 'starting' \| 'accepting' \| 'draining' \| 'stopping'/);
  assert.match(runtime, /app\.post\('\/drain\/start'/);
  assert.match(runtime, /app\.get\('\/drain\/status'/);
  assert.match(runtime, /app\.post\('\/drain\/cancel'/);
  assert.match(runtime, /app\.get\('\/admin\/runtime\/state'/);
  assert.match(runtime, /app\.post\('\/admin\/runtime\/drain'/);
  assert.match(runtime, /app\.post\('\/admin\/runtime\/undrain'/);
  assert.match(runtime, /app\.get\('\/admin\/runtime\/active-turns'/);
  assert.match(runtime, /code:'runtime_draining'/);
  assert.match(runtime, /RUNTIME_MODE === 'candidate'/);
  assert.match(runtime, /retryable:true/);
  assert.match(runtime, /app\.post\('\/sessions\/:id\/turns'[\s\S]{0,240}isDraining\(\)/);
  assert.match(runtime, /app\.post\('\/codex\/sessions'[\s\S]{0,240}isDraining\(\)/);
  assert.match(runtime, /app\.post\('\/gemini\/sessions'[\s\S]{0,240}isDraining\(\)/);
});

test('draining waits for active turns, submitting turns, and pending event pushes', () => {
  assert.match(runtime, /activeTurnCount/);
  assert.match(runtime, /submittingTurnCount/);
  assert.match(runtime, /pendingEventWriteCount:diagnostics\.runtimePendingPushCount/);
  assert.match(runtime, /waitForDrain/);
  assert.match(runtime, /process\.once\('SIGTERM'/);
});

test('deploy supports component scoped web runtime provider and changed modes', () => {
  assert.match(deploy, /--components web,runtime\|--changed/);
  assert.match(deploy, /agentdeckctl/);
  assert.match(deploy, /changed_components\(\)/);
  assert.match(ctl, /worker_deploy\(\)/);
  assert.match(ctl, /start_candidate_web/);
  assert.match(ctl, /start_candidate_runtime/);
  assert.match(ctl, /drain_runtime/);
  assert.match(ctl, /wait_drain/);
  assert.match(ctl, /worker_rollback\(\)/);
});

test('web-only deploy does not restart runtime or providers', () => {
  const workerBody = ctl.slice(ctl.indexOf('worker_deploy()'), ctl.indexOf('worker_rollback()'));
  assert.match(workerBody, /if \[ "\$target" = "web" \] \|\| \[ "\$target" = "all" \]/);
  assert.match(workerBody, /systemctl restart agentdeck-web\.service/);
  assert.match(workerBody, /else\s+switch_current "\$release_id"/);
  assert.doesNotMatch(workerBody, /agentdeck-app-server/);
  assert.doesNotMatch(workerBody, /check_active_turns/);
});

test('runtime-only deploy drains and does not restart web or providers', () => {
  const runtimeBody = ctl.slice(ctl.indexOf('if [ "$target" = "runtime" ] || [ "$target" = "all" ]; then'), ctl.indexOf('else', ctl.indexOf('if [ "$target" = "runtime" ] || [ "$target" = "all" ]; then')));
  assert.match(runtimeBody, /drain_runtime/);
  assert.match(runtimeBody, /systemctl restart agentdeck-runtime\.service/);
  assert.doesNotMatch(runtimeBody, /agentdeck-app-server/);
});
