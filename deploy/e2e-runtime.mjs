import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const runtime = process.env.AGENT_RUNTIME_URL || 'http://127.0.0.1:3852';
const cwd = process.env.E2E_CWD || '/opt/stacks/codex-mobile';

function request(method, path, body) {
  const url = new URL(path, runtime);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: payload ? { 'content-type':'application/json', 'content-length':String(payload.length) } : {},
      timeout: 180_000,
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(Buffer.from(d)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch {}
        if ((res.statusCode || 500) >= 400) reject(new Error(`${method} ${path} ${res.statusCode} ${text}`));
        else resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function pgrep(pattern) {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', pattern]);
    return stdout.trim().split(/\s+/).filter(Boolean)[0] || '';
  } catch {
    return '';
  }
}

async function systemctl(...args) {
  await execFileAsync('sudo', ['systemctl', ...args], { maxBuffer:1024 * 1024 });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function events(sessionId) {
  return (await request('GET', `/sessions/${sessionId}/events?after=0`)).events || [];
}

async function waitThread(sessionId, predicate, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await request('GET', `/sessions/${sessionId}`);
    if (predicate(last)) return last;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${sessionId}; last=${JSON.stringify(last?.session || null)}`);
}

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

function sequenceContinuous(items) {
  for (let i = 0; i < items.length; i++) if (Number(items[i].sequence) !== i + 1) return false;
  return true;
}

const result = { startedAt:new Date().toISOString(), checks:[] };
await request('POST', '/codex/accounts/default');
const appPid0 = await pgrep('codex app-server --listen ws://127.0.0.1:4668');
const runtimePid0 = await pgrep('node .*agent-runtime.js');
result.appPid0 = appPid0;
result.runtimePid0 = runtimePid0;
assert(appPid0, 'missing app-server pid before e2e');
assert(runtimePid0, 'missing runtime pid before e2e');

const created = await request('POST', '/codex/sessions', { accountId:'default', cwd, title:'production e2e long turn', mode:'yolo' });
const sessionId = created.session.id;
const threadId = created.thread.id;
result.sessionId = sessionId;
result.threadId = threadId;

const turnStart = await request('POST', `/sessions/${sessionId}/turns`, {
  text:'Run this shell command exactly: for i in $(seq 1 90); do echo production-e2e-$i; sleep 1; done. Then summarize the output.',
  mode:'yolo',
});
const turnId = turnStart.turn?.turn?.id;
result.turnId = turnId;
assert(turnId, 'missing turn id');
await sleep(8000);

await systemctl('restart', 'codex-mobile-web.service');
await sleep(4000);
const appPidAfterWeb = await pgrep('codex app-server --listen ws://127.0.0.1:4668');
const runtimePidAfterWeb = await pgrep('node .*agent-runtime.js');
result.appPidAfterWeb = appPidAfterWeb;
result.runtimePidAfterWeb = runtimePidAfterWeb;
assert(appPidAfterWeb === appPid0, 'web restart changed app-server pid');
assert(runtimePidAfterWeb === runtimePid0, 'web restart changed runtime pid');
result.checks.push('web_restart_preserved_pids');

await systemctl('restart', 'agent-runtime.service');
await sleep(5000);
await request('POST', '/codex/accounts/default');
const appPidAfterRuntime = await pgrep('codex app-server --listen ws://127.0.0.1:4668');
const runtimePidAfterRuntime = await pgrep('node .*agent-runtime.js');
result.appPidAfterRuntime = appPidAfterRuntime;
result.runtimePidAfterRuntime = runtimePidAfterRuntime;
assert(appPidAfterRuntime === appPid0, 'runtime restart changed app-server pid');
assert(runtimePidAfterRuntime && runtimePidAfterRuntime !== runtimePid0, 'runtime restart did not change runtime pid');
result.checks.push('runtime_restart_preserved_appserver');

const completed = await waitThread(sessionId, data => data.session.status === 'idle' || data.thread.turns?.at(-1)?.status === 'completed', 180_000);
const finalItems = completed.thread.turns.flatMap(t => t.items || []).filter(i => i.type === 'agentMessage' && i.phase === 'final_answer');
result.finalAnswers = finalItems.length;
assert(finalItems.length === 1, `expected exactly one final answer, got ${finalItems.length}`);
assert(completed.session.id === threadId, 'thread id changed');
result.checks.push('final_answer_once');

const ev = await events(sessionId);
result.eventCount = ev.length;
result.outputGap = ev.some(e => e.event_type === 'output_gap');
result.turnStarts = ev.filter(e => e.event_type === 'turn/start').length;
assert(sequenceContinuous(ev), 'event sequence is not continuous');
assert(result.turnStarts === 1, `expected one turn/start, got ${result.turnStarts}`);
result.checks.push('sequence_continuous');

const stopSession = await request('POST', '/codex/sessions', { accountId:'default', cwd, title:'production e2e stop turn', mode:'yolo' });
await request('POST', `/sessions/${stopSession.session.id}/turns`, {
  text:'Run this shell command exactly: for i in $(seq 1 60); do echo stop-e2e-$i; sleep 1; done. Then summarize the output.',
  mode:'yolo',
});
await sleep(6000);
await request('POST', `/sessions/${stopSession.session.id}/stop`);
await request('POST', `/sessions/${stopSession.session.id}/stop`);
const stopped = await request('GET', `/sessions/${stopSession.session.id}`);
result.stopStatus = stopped.session.status;
result.checks.push('stop_idempotent');

await systemctl('restart', 'codex-app-server@default.service');
await sleep(5000);
const appPidAfterAppRestart = await pgrep('codex app-server --listen ws://127.0.0.1:4668');
result.appPidAfterAppRestart = appPidAfterAppRestart;
assert(appPidAfterAppRestart && appPidAfterAppRestart !== appPid0, 'app-server restart did not change pid');
result.checks.push('appserver_restart_changes_pid');

result.finishedAt = new Date().toISOString();
console.log(JSON.stringify(result, null, 2));
