import assert from 'node:assert/strict';
import test from 'node:test';

class RuntimeConnectionHarness {
  constructor() {
    this.sessionGeneration = 0;
    this.connectionGeneration = 0;
    this.runtimeConnection = 'unknown';
    this.notice = false;
  }
  mount() {
    this.sessionGeneration += 1;
    this.runtimeConnection = 'checking';
    return this.sessionGeneration;
  }
  connect(sessionGeneration) {
    this.connectionGeneration += 1;
    this.runtimeConnection = 'checking';
    return { sessionGeneration, connectionGeneration: this.connectionGeneration };
  }
  joined(token, status = 'connected') {
    if (!this.current(token)) return;
    this.runtimeConnection = status || 'connected';
  }
  load(sessionGeneration, snapshot = {}) {
    if (sessionGeneration !== this.sessionGeneration) return;
    if (snapshot.error && this.runtimeConnection !== 'connected') this.runtimeConnection = 'recovering';
  }
  turnCompleted() {
    this.turnStatus = 'completed';
  }
  joinTimeout(token) {
    if (!this.current(token)) return;
    if (this.runtimeConnection === 'checking') this.runtimeConnection = 'unavailable';
  }
  current(token) {
    return token.sessionGeneration === this.sessionGeneration && token.connectionGeneration === this.connectionGeneration;
  }
  checkingNotice(turnStatus = 'running') {
    return this.runtimeConnection === 'checking' && turnStatus === 'running';
  }
}

test('late HTTP load does not overwrite joined connected runtime state', () => {
  const h = new RuntimeConnectionHarness();
  const gen = h.mount();
  const token = h.connect(gen);
  assert.equal(h.runtimeConnection, 'checking');

  h.joined(token, 'connected');
  h.load(gen, {});

  assert.equal(h.runtimeConnection, 'connected');
  assert.equal(h.checkingNotice('running'), false);
});

test('manual refresh and turn completion do not downgrade connected to checking', () => {
  const h = new RuntimeConnectionHarness();
  const gen = h.mount();
  const token = h.connect(gen);
  h.joined(token, 'connected');

  h.load(gen, {});
  h.turnCompleted();
  h.load(gen, {});

  assert.equal(h.runtimeConnection, 'connected');
});

test('stale session load cannot overwrite the active session state', () => {
  const h = new RuntimeConnectionHarness();
  const staleGen = h.mount();
  h.connect(staleGen);
  const freshGen = h.mount();
  const freshToken = h.connect(freshGen);
  h.joined(freshToken, 'connected');

  h.load(staleGen, { error: true });

  assert.equal(h.runtimeConnection, 'connected');
});

test('join timeout moves checking to unavailable when no connection event arrives', () => {
  const h = new RuntimeConnectionHarness();
  const gen = h.mount();
  const token = h.connect(gen);

  h.joinTimeout(token);

  assert.equal(h.runtimeConnection, 'unavailable');
});

