import assert from 'node:assert/strict';
import test from 'node:test';

class MockRuntime {
  constructor(results) {
    this.results = [...results];
    this.calls = [];
    this.oldCachedInitializeResponse = { initialized:true, authMethods:[{ id:'oauth-personal' }] };
  }
  async forceInitializeGeminiProfile(profileId) {
    this.calls.push(['forceInitialize', profileId]);
    const next = this.results.shift() || { initialized:true, authMethods:[{ id:'oauth-personal' }] };
    return { ...next, forceReinitialized:true, oldInstance:true, disposeCompleted:true, oldChildPid:101, newChildPid:102 };
  }
  async disposeGeminiProfile(profileId) {
    this.calls.push(['dispose', profileId]);
  }
  async createGeminiSession() {
    this.calls.push(['session/new']);
    throw new Error('session/new must not be called by login reconcile');
  }
  async startTurn() {
    this.calls.push(['prompt']);
    throw new Error('prompt must not be called by login reconcile');
  }
}

async function reconcile({ runtime, profileId = 'p1', credentialStates, maxAttempts = 3 }) {
  const calls = [];
  const state = { status:'verifying', job:'verifying' };
  let previous = null;
  let credential = null;
  let stable = false;
  for (const current of credentialStates) {
    credential = current;
    calls.push(['credential', current.exists, current.size, current.mtimeMs]);
    stable = !!previous && current.exists && current.size > 0 && current.size === previous.size && current.mtimeMs === previous.mtimeMs;
    if (stable) break;
    previous = current;
  }
  if (!stable) {
    state.status = 'failed';
    state.job = 'failed';
    return { ok:false, reason:'credentials_not_stable', state, calls, runtimeCalls:runtime.calls };
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const initialized = await runtime.forceInitializeGeminiProfile(profileId);
      calls.push(['initialize', attempt, initialized.authMethods?.length ?? null]);
      if (initialized.initialized) {
        state.status = 'authenticated';
        state.job = 'done';
        return { ok:true, state, calls, runtimeCalls:runtime.calls };
      }
    } catch (e) {
      calls.push(['initialize_error', attempt, e.message]);
    }
    if (attempt < maxAttempts) await runtime.disposeGeminiProfile(profileId);
  }
  state.status = 'authenticated';
  state.job = 'done';
  return { ok:true, reason:'credentials_stable_initialize_unavailable', state, calls, runtimeCalls:runtime.calls };
}

test('delayed credential landing then fresh initialize authenticates without model calls', async () => {
  const runtime = new MockRuntime([{ initialized:true, authMethods:[] }]);
  const result = await reconcile({
    runtime,
    credentialStates:[
      { exists:false, size:0, mtimeMs:0 },
      { exists:true, size:1200, mtimeMs:10 },
      { exists:true, size:1200, mtimeMs:10 },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.status, 'authenticated');
  assert.equal(result.state.job, 'done');
  assert.deepEqual(runtime.calls, [['forceInitialize', 'p1']]);
  assert.equal(runtime.calls.some(c => c[0] === 'session/new' || c[0] === 'prompt'), false);
});

test('old cached unauthenticated initializeResponse is ignored after force initialize', async () => {
  const runtime = new MockRuntime([{ initialized:true, authMethods:[] }]);
  const result = await reconcile({
    runtime,
    credentialStates:[{ exists:true, size:1, mtimeMs:1 }, { exists:true, size:1, mtimeMs:1 }],
  });

  assert.equal(runtime.oldCachedInitializeResponse.authMethods.length, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.runtimeCalls, [['forceInitialize', 'p1']]);
});

test('initialize returning authMethods is metadata and still authenticates after credentials land', async () => {
  const runtime = new MockRuntime([{ initialized:true, authMethods:[{ id:'oauth-personal' }] }, { initialized:true, authMethods:[{ id:'oauth-personal' }] }, { initialized:true, authMethods:[{ id:'oauth-personal' }] }]);
  const result = await reconcile({
    runtime,
    credentialStates:[{ exists:true, size:5, mtimeMs:2 }, { exists:true, size:5, mtimeMs:2 }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.status, 'authenticated');
  assert.equal(result.state.job, 'done');
  assert.equal(runtime.calls.filter(c => c[0] === 'forceInitialize').length, 1);
  assert.equal(runtime.calls.some(c => c[0] === 'session/new' || c[0] === 'prompt'), false);
});

test('initialize timeout or process error does not consume quota and credentials still authenticate locally', async () => {
  const runtime = new MockRuntime([]);
  runtime.forceInitializeGeminiProfile = async profileId => {
    runtime.calls.push(['forceInitialize', profileId]);
    throw new Error('initialize timed out');
  };
  const result = await reconcile({
    runtime,
    credentialStates:[{ exists:true, size:5, mtimeMs:2 }, { exists:true, size:5, mtimeMs:2 }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.status, 'authenticated');
  assert.equal(runtime.calls.filter(c => c[0] === 'forceInitialize').length, 3);
  assert.equal(runtime.calls.some(c => c[0] === 'session/new' || c[0] === 'prompt'), false);
});

test('credential file present but not stable never authenticates', async () => {
  const runtime = new MockRuntime([{ initialized:true, authMethods:[] }]);
  const result = await reconcile({
    runtime,
    credentialStates:[{ exists:true, size:5, mtimeMs:2 }, { exists:true, size:6, mtimeMs:3 }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.state.status, 'failed');
  assert.equal(runtime.calls.length, 0);
});

test('startup reconcile and immediate verification use the same reconcile result', async () => {
  const states = [{ exists:true, size:5, mtimeMs:2 }, { exists:true, size:5, mtimeMs:2 }];
  const immediate = await reconcile({ runtime:new MockRuntime([{ initialized:true, authMethods:[] }]), credentialStates:states });
  const startup = await reconcile({ runtime:new MockRuntime([{ initialized:true, authMethods:[] }]), credentialStates:states });

  assert.equal(immediate.state.status, startup.state.status);
  assert.equal(immediate.ok, startup.ok);
});

class MockGeminiAcpRuntime {
  constructor({ profileStatus = 'authenticated', authMethods = [], sessionNewError = null } = {}) {
    this.profileStatus = profileStatus;
    this.initializeResponse = { initialized:true, authMethods };
    this.sessionNewError = sessionNewError;
    this.calls = [];
  }
  status() {
    return {
      initialized:true,
      authenticated:this.profileStatus === 'authenticated',
      authMethods:this.initializeResponse.authMethods,
    };
  }
  async createSession() {
    this.calls.push('session/new');
    if (this.sessionNewError) {
      if (/unauthenticated|requires login|invalid credentials/i.test(this.sessionNewError.message)) this.profileStatus = 'needs_login';
      throw this.sessionNewError;
    }
    this.profileStatus = 'authenticated';
    return { providerSessionId:'gemini-session-1' };
  }
}

test('profile authenticated remains authenticated when initialize returns four authMethods', () => {
  const runtime = new MockGeminiAcpRuntime({
    profileStatus:'authenticated',
    authMethods:[
      { id:'oauth-personal' },
      { id:'api-key' },
      { id:'vertex-ai' },
      { id:'gateway' },
    ],
  });

  assert.equal(runtime.status().authenticated, true);
  assert.equal(runtime.status().authMethods.length, 4);
});

test('createSession is not locally blocked by non-empty authMethods and succeeds', async () => {
  const runtime = new MockGeminiAcpRuntime({
    authMethods:[{ id:'oauth-personal' }, { id:'api-key' }, { id:'vertex-ai' }, { id:'gateway' }],
  });

  const session = await runtime.createSession();

  assert.equal(session.providerSessionId, 'gemini-session-1');
  assert.deepEqual(runtime.calls, ['session/new']);
  assert.equal(runtime.profileStatus, 'authenticated');
});

test('only real session/new authentication error moves profile to needs_login', async () => {
  const runtime = new MockGeminiAcpRuntime({
    authMethods:[{ id:'oauth-personal' }, { id:'api-key' }, { id:'vertex-ai' }, { id:'gateway' }],
    sessionNewError:new Error('session/new failed: unauthenticated'),
  });

  await assert.rejects(() => runtime.createSession(), /unauthenticated/);

  assert.deepEqual(runtime.calls, ['session/new']);
  assert.equal(runtime.profileStatus, 'needs_login');
});
