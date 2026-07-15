import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  AntigravityProcessError,
  DEFAULT_ANTIGRAVITY_TURN_TIMEOUT_MS,
  finalizeAntigravityTurn,
  runAntigravityChild,
  stableAntigravityAssistantId,
} from '../server/dist/antigravity-turn.js';
import { Db } from '../server/dist/db.js';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedWith = [];
  kill(signal) {
    this.killedWith.push(signal);
    return true;
  }
}

const clean = value => String(value).trim();

test('default Antigravity turn timeout is two hours', () => {
  assert.equal(DEFAULT_ANTIGRAVITY_TURN_TIMEOUT_MS, 2 * 60 * 60 * 1000);
});

async function processResult(sequence) {
  const child = new FakeChild();
  const states = [];
  const deltas = [];
  const promise = runAntigravityChild(child, {
    timeoutMs:1000,
    cleanOutput:clean,
    onDelta:delta=>deltas.push(delta),
    onState:state=>states.push(state),
  });
  await sequence(child);
  return { result:await promise, states, deltas };
}

test('normal short Antigravity output is assembled through close', async () => {
  const { result, states } = await processResult(async child => {
    child.stdout.write('short reply');
    child.emit('exit', 0, null);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);
  });
  assert.equal(result.output, 'short reply');
  assert.deepEqual(states, ['output_draining','completed']);
});

test('exit/completed-like signal before late stdout does not lose final content', async () => {
  const { result, deltas } = await processResult(async child => {
    child.stdout.write('first ');
    child.emit('exit', 0, null);
    child.stdout.write('late final');
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);
  });
  assert.equal(result.output, 'first late final');
  assert.equal(deltas.join(''), 'first late final');
});

test('non-zero exit preserves code, signal-safe stderr summary and failed state', async () => {
  const child = new FakeChild();
  const promise = runAntigravityChild(child, { timeoutMs:1000, cleanOutput:clean });
  child.stderr.write('request failed token=super-secret');
  child.emit('exit', 7, null);
  child.stdout.end();
  child.stderr.end();
  child.emit('close', 7, null);
  await assert.rejects(promise, error => {
    assert.ok(error instanceof AntigravityProcessError);
    assert.equal(error.result.code, 7);
    assert.equal(error.kind, 'exit');
    assert.match(error.message, /code 7/);
    assert.doesNotMatch(error.message, /super-secret/);
    return true;
  });
});

test('spawn errors and timeouts are explicit terminal failures', async () => {
  const spawnChild = new FakeChild();
  const spawnPromise = runAntigravityChild(spawnChild, { timeoutMs:1000, cleanOutput:clean });
  spawnChild.emit('error', Object.assign(new Error('spawn ENOENT'), { code:'ENOENT' }));
  spawnChild.stdout.end();
  spawnChild.stderr.end();
  spawnChild.emit('close', null, null);
  await assert.rejects(spawnPromise, error => error instanceof AntigravityProcessError && error.kind === 'spawn');

  const timeoutChild = new FakeChild();
  const timeoutPromise = runAntigravityChild(timeoutChild, { timeoutMs:5, cleanOutput:clean, onTimeout:()=>timeoutChild.kill('SIGTERM') });
  await new Promise(resolve=>setTimeout(resolve, 15));
  timeoutChild.emit('exit', null, 'SIGTERM');
  timeoutChild.stdout.end();
  timeoutChild.stderr.end();
  timeoutChild.emit('close', null, 'SIGTERM');
  await assert.rejects(timeoutPromise, error => {
    assert.ok(error instanceof AntigravityProcessError);
    assert.equal(error.kind, 'timeout');
    assert.equal(error.result.timedOut, true);
    assert.deepEqual(timeoutChild.killedWith, ['SIGTERM'], 'the caller-provided strategy owns timeout termination');
    return true;
  });
});

test('normal finalization persists before displaying the answer and completion', async () => {
  const order = [];
  await finalizeAntigravityTurn({
    assistantId:'stable-normal',
    text:'short reply',
    status:'completed',
    persistAssistant:async()=>{ order.push('persist'); },
    updateSession:async status=>{ order.push(`status:${status}`); },
    notify:message=>{ order.push(message.method); },
  });
  assert.deepEqual(order, ['persist','status:idle','item/completed','turn/completed']);
});

test('final output persists with zero subscribers and reconnect snapshot sees it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-antigravity-'));
  const db = new Db(path.join(dir, 'db.sqlite3'));
  await db.init();
  const sessionId = 'session-long-disconnect';
  const assistantId = stableAntigravityAssistantId(sessionId, 'turn-1');
  await db.run("INSERT INTO sessions (id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,created_at,updated_at) VALUES (?1,?1,'/tmp','test','running','yolo','never','danger-full-access',1,1)", [sessionId]);
  const persistAssistant = (id, text) => db.run(
    "INSERT INTO agent_messages (id,session_id,role,text,created_at) VALUES (?1,?2,'assistant',?3,1) ON CONFLICT(id) DO UPDATE SET text=excluded.text",
    [id, sessionId, text],
  ).then(()=>{});
  const updateSession = status => db.run('UPDATE sessions SET status=?1 WHERE id=?2', [status, sessionId]).then(()=>{});
  try {
    await finalizeAntigravityTurn({
      assistantId,
      text:'long final answer',
      status:'completed',
      persistAssistant,
      updateSession,
      notify:()=>{},
    });
    const snapshot = await db.all('SELECT id,text FROM agent_messages WHERE session_id=?1', [sessionId]);
    assert.deepEqual(snapshot, [{ id:assistantId, text:'long final answer' }]);
    assert.equal((await db.get('SELECT status FROM sessions WHERE id=?1', [sessionId])).status, 'idle');

    await finalizeAntigravityTurn({
      assistantId,
      text:'long final answer',
      status:'completed',
      persistAssistant,
      updateSession,
      notify:()=>{},
    });
    assert.equal((await db.get('SELECT count(*) AS count FROM agent_messages WHERE session_id=?1', [sessionId])).count, 1);
  } finally {
    db.close();
    await rm(dir, { recursive:true, force:true });
  }
});

test('failed finalization persists error before failed terminal notification', async () => {
  const order = [];
  await finalizeAntigravityTurn({
    assistantId:'stable',
    text:'Antigravity 执行失败：exited with code 2',
    status:'failed',
    error:'exited with code 2',
    persistAssistant:async()=>{ order.push('persist'); },
    updateSession:async status=>{ order.push(`status:${status}`); },
    notify:message=>{ order.push(message.method); },
  });
  assert.deepEqual(order, ['persist','status:failed','item/completed','turn/failed']);
});
