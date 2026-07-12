import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runtime = readFileSync(new URL('../server/src/agentdeck-runtime.ts', import.meta.url), 'utf8');
const deploy = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8');
const ctl = readFileSync(new URL('../scripts/agentdeckctl', import.meta.url), 'utf8');
const runtimeUnit = readFileSync(new URL('../deploy/systemd/agentdeck-runtime.service', import.meta.url), 'utf8');

test('runtime exposes lifecycle draining and rejects new work while draining', () => {
  assert.match(runtime, /type RuntimeLifecycle = 'starting' \| 'accepting' \| 'draining' \| 'stopping'/);
  assert.match(runtime, /app\.post\('\/drain\/start'/);
  assert.match(runtime, /app\.get\('\/drain\/status'/);
  assert.match(runtime, /app\.post\('\/drain\/cancel'/);
  assert.match(runtime, /app\.get\('\/admin\/runtime\/state'/);
  assert.match(runtime, /app\.post\('\/admin\/runtime\/drain'/);
  assert.match(runtime, /app\.post\('\/admin\/runtime\/undrain'/);
  assert.match(runtime, /app\.get\('\/admin\/runtime\/active-turns'/);
  assert.match(runtime, /DRAIN_LEASE_MS/);
  assert.match(runtime, /expireRuntimeDrain/);
  assert.match(runtime, /drainExpiresAt/);
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
  assert.match(runtime, /pendingEventWriteCount/);
  assert.match(runtime, /deltaQueueEventCount:eventStore\.metrics\.deltaQueueEventCount/);
  assert.match(runtime, /pendingSqliteWriteCount:eventStore\.metrics\.pendingSqliteWriteCount/);
  assert.match(runtime, /claudeActiveTurnCount=claudeManager\.activeTurnCount\(\)/);
  assert.match(runtime, /geminiActivePromptCount=geminiManager\.activePromptCount\(\)/);
  assert.match(runtime, /subscriberPendingBufferCount/);
  assert.match(runtime, /waitForDrain/);
  assert.match(runtime, /process\.once\('SIGTERM'/);
  assert.match(ctl, /drain_status/);
  assert.match(ctl, /drained_from_json/);
  assert.match(ctl, /missing drained boolean/);
  assert.match(ctl, /DRAIN_LEASE_SECONDS/);
  assert.match(ctl, /ttlMs/);
  assert.match(ctl, /DRAIN_LEASE_SECONDS \* 1000/);
  assert.match(ctl, /refusing unsafe restart/);
  assert.doesNotMatch(ctl, /active-turns" 2>\/dev\/null \|\| echo '\{"activeTurnCount":0/);
});

test('Codex final answer does not terminate a turn before a terminal turn notification',()=>{const handler=runtime.slice(runtime.indexOf('async function handleCodexNotification'),runtime.indexOf('async function handleCodexRequest'));assert.doesNotMatch(handler,/isFinalAnswerItem[\s\S]*active_turn_id=NULL/);assert.match(handler,/turn\/completed'.*turn\/failed'.*turn\/interrupted'/s);});

test('runtime systemd stop timeout exceeds the application drain timeout',()=>{const seconds=Number(runtimeUnit.match(/^TimeoutStopSec=(\d+)$/m)?.[1]||0);assert.ok(seconds>7200);});

test('deploy supports component scoped web runtime provider and changed modes', () => {
  assert.match(deploy, /--components web,runtime\|--changed/);
  assert.match(deploy, /agentdeckctl/);
  assert.match(deploy, /changed_components\(\)/);
  assert.match(deploy, /No deployable changes; nothing to deploy/);
  assert.match(deploy, /unknown component set/);
  assert.match(ctl, /SOURCE_ROOT="\$\{AGENTDECK_SOURCE_ROOT:-\$CONTROL_ROOT\}"/);
  assert.match(ctl, /worker_deploy\(\)/);
  assert.match(ctl, /start_candidate_web/);
  assert.match(ctl, /start_candidate_runtime/);
  assert.match(ctl, /drain_runtime/);
  assert.match(ctl, /wait_drain/);
  assert.match(ctl, /worker_rollback\(\)/);
});

test('candidate runtime sqlite backup is bounded and fails closed', () => {
  assert.match(ctl, /sqlite backup stalled for 30 seconds/);
  assert.match(ctl, /live sqlite backup failed; candidate validation cancelled/);
});

test('web-only deploy does not restart runtime or providers', () => {
  const workerBody = ctl.slice(ctl.indexOf('worker_deploy()'), ctl.indexOf('worker_rollback()'));
  assert.match(workerBody, /if \[ "\$target" = "web" \] \|\| \[ "\$target" = "all" \]/);
  assert.match(workerBody, /systemctl restart agentdeck-web\.service/);
  assert.match(workerBody, /else\s+switch_component web "\$release_id"/);
  assert.doesNotMatch(workerBody, /agentdeck-app-server/);
  assert.doesNotMatch(workerBody, /check_active_turns/);
});

test('runtime-only deploy drains and does not restart web or providers', () => {
  const runtimeBody = ctl.slice(ctl.indexOf('if [ "$target" = "runtime" ] || [ "$target" = "all" ]; then'), ctl.indexOf('else', ctl.indexOf('if [ "$target" = "runtime" ] || [ "$target" = "all" ]; then')));
  assert.match(runtimeBody, /drain_runtime/);
  assert.match(runtimeBody, /systemctl restart agentdeck-runtime\.service/);
  assert.doesNotMatch(runtimeBody, /agentdeck-app-server/);
});
