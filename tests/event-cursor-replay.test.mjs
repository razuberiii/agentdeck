import assert from 'node:assert/strict';
import test from 'node:test';

class ClientCursorHarness {
  constructor(appliedSequence = 0) {
    this.clientAppliedSequence = appliedSequence;
    this.snapshotCoveredSequence = 0;
    this.seen = new Set();
    this.live = [];
  }
  loadSnapshot(coveredSequence) {
    this.snapshotCoveredSequence = Math.max(this.snapshotCoveredSequence, coveredSequence);
    return this.clientAppliedSequence;
  }
  accept(msg) {
    const seq = Number(msg.runtimeSequence || 0);
    if (!seq) return true;
    const key = `${msg.runtimeGeneration || 'legacy'}:${seq}:${msg.type || ''}:${msg.method || msg.status || ''}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
  apply(msg) {
    if (!this.accept(msg)) return false;
    this.live.push(msg);
    const seq = Number(msg.runtimeSequence || 0);
    if (seq > this.clientAppliedSequence) this.clientAppliedSequence = seq;
    return true;
  }
}

class SubscriptionHarness {
  constructor() {
    this.subscriptions = new Map();
    this.clients = new Map();
    this.log = [];
  }
  ensureSessionSubscription(sessionId, threadId) {
    const existing = this.subscriptions.get(threadId);
    if (existing?.connected || existing?.connecting) return existing;
    const state = { sessionId, threadId, connecting: true, connected: false, lastSequence: existing?.lastSequence || 0 };
    this.subscriptions.set(threadId, state);
    this.log.push({ type: 'ensure', sessionId, threadId });
    return state;
  }
  join(sessionId, threadId, connectionId) {
    const set = this.clients.get(threadId) || new Set();
    set.add(connectionId);
    this.clients.set(threadId, set);
    return this.ensureSessionSubscription(sessionId, threadId);
  }
  reconnectRuntime() {
    for (const [threadId, clients] of this.clients.entries()) {
      if (clients.size) this.ensureSessionSubscription(threadId, threadId);
    }
  }
  broadcast(threadId, event) {
    const count = this.clients.get(threadId)?.size || 0;
    if (!count) this.log.push({ type: 'no_subscriber', threadId, eventType: event.method || event.type });
    return count;
  }
}

test('HTTP snapshot coveredSequence does not advance browser acknowledgement cursor', () => {
  const h = new ClientCursorHarness(222);

  assert.equal(h.loadSnapshot(517), 222);
  assert.equal(h.clientAppliedSequence, 222);

  assert.equal(h.apply({ type: 'codex', method: 'item/agentMessage/delta', runtimeSequence: 223, runtimeGeneration: 'g1' }), true);
  assert.equal(h.clientAppliedSequence, 223);
});

test('replayed events at or below snapshot coveredSequence are still accepted once', () => {
  const h = new ClientCursorHarness(222);
  h.loadSnapshot(517);

  const msg = { type: 'codex', method: 'item/agentMessage/delta', runtimeSequence: 246, runtimeGeneration: 'g1' };
  assert.equal(h.apply(msg), true);
  assert.equal(h.apply(msg), false);
  assert.equal(h.live.length, 1);
});

test('lost ACK causes duplicate replay, not permanent event loss', () => {
  const h = new ClientCursorHarness(10);
  assert.equal(h.apply({ type: 'codex', method: 'item/agentMessage/delta', runtimeSequence: 11, runtimeGeneration: 'g1' }), true);

  const afterReconnect = new ClientCursorHarness(10);
  assert.equal(afterReconnect.apply({ type: 'codex', method: 'item/agentMessage/delta', runtimeSequence: 11, runtimeGeneration: 'g1' }), true);
  assert.equal(afterReconnect.clientAppliedSequence, 11);
});

test('join, sendTurn preflight, and runtime reconnect share idempotent subscription state', () => {
  const h = new SubscriptionHarness();
  const a = h.join('session-1', 'thread-1', 'conn-1');
  const b = h.ensureSessionSubscription('session-1', 'thread-1');

  assert.equal(a, b);
  assert.equal(h.subscriptions.size, 1);

  a.connected = false;
  a.connecting = false;
  h.reconnectRuntime();

  assert.equal(h.subscriptions.size, 1);
  assert.equal(h.log.filter(x => x.type === 'ensure').length, 2);
});

test('runtime push without websocket subscribers is explicit', () => {
  const h = new SubscriptionHarness();
  assert.equal(h.broadcast('thread-1', { type: 'codex', method: 'item/completed' }), 0);
  assert.deepEqual(h.log[0], { type: 'no_subscriber', threadId: 'thread-1', eventType: 'item/completed' });
});
