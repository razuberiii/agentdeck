import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runtime = readFileSync(new URL('../server/src/agentdeck-runtime.ts', import.meta.url), 'utf8');
const deploy = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8');

test('runtime exposes lifecycle draining and rejects new work while draining', () => {
  assert.match(runtime, /type RuntimeLifecycle = 'starting' \| 'accepting' \| 'draining' \| 'stopping'/);
  assert.match(runtime, /app\.post\('\/drain\/start'/);
  assert.match(runtime, /app\.get\('\/drain\/status'/);
  assert.match(runtime, /app\.post\('\/drain\/cancel'/);
  assert.match(runtime, /code:'runtime_draining'/);
  assert.match(runtime, /retryable:true/);
  assert.match(runtime, /app\.post\('\/sessions\/:id\/turns'[\s\S]{0,120}isDraining\(\)/);
  assert.match(runtime, /app\.post\('\/codex\/sessions'[\s\S]{0,120}isDraining\(\)/);
  assert.match(runtime, /app\.post\('\/gemini\/sessions'[\s\S]{0,120}isDraining\(\)/);
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
  assert.match(deploy, /deploy_web\(\)/);
  assert.match(deploy, /deploy_runtime\(\)/);
  assert.match(deploy, /deploy_provider\(\)/);
  assert.match(deploy, /changed_components\(\)/);
  assert.match(deploy, /runtime_drain_start/);
  assert.match(deploy, /runtime_drain_wait/);
  assert.match(deploy, /rollback_components\(\)/);
});

test('web-only deploy does not restart runtime or providers', () => {
  const webBody = deploy.slice(deploy.indexOf('deploy_web()'), deploy.indexOf('deploy_runtime()'));
  assert.match(webBody, /systemctl restart agentdeck-web\.service/);
  assert.doesNotMatch(webBody, /agentdeck-runtime\.service/);
  assert.doesNotMatch(webBody, /agentdeck-app-server/);
  assert.doesNotMatch(webBody, /check_active_turns/);
});

test('runtime-only deploy drains and does not restart web or providers', () => {
  const runtimeBody = deploy.slice(deploy.indexOf('deploy_runtime()'), deploy.indexOf('deploy_provider()'));
  assert.match(runtimeBody, /runtime_drain_start/);
  assert.match(runtimeBody, /systemctl restart agentdeck-runtime\.service/);
  assert.doesNotMatch(runtimeBody, /agentdeck-web\.service/);
  assert.doesNotMatch(runtimeBody, /agentdeck-app-server/);
});
