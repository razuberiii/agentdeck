import assert from 'node:assert/strict';
import test from 'node:test';

function parseGeminiGoogleLogin(output) {
  const text = stripAnsi(output).replace(/\r/g, '').replace(/[^\S\n]+/g, ' ');
  const requiresCodeInput = /Enter the authorization code|authorization code|authcode|paste .*code/i.test(text);
  const loginUrlResult = extractGeminiUserCodeLoginUrl(text, requiresCodeInput);
  const failureMatch = text.match(/(Error authenticating:[^\n]+|FatalAuthenticationError:[^\n]+|Manual authorization is required[^\n]+|authentication failed[^\n]*|invalid_grant[^\n]*)/i);
  const success = /authenticated successfully|authentication completed successfully|login successful/i.test(text);
  return { loginUrl: loginUrlResult.loginUrl, invalidReason: loginUrlResult.invalidReason, requiresCodeInput, success, failure: failureMatch?.[1] || null };
}

function stripAnsi(text) {
  return String(text).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

const GEMINI_USER_CODE_REDIRECT_URI = 'https://codeassist.google.com/authcode';

function extractGeminiUserCodeLoginUrl(text, complete) {
  const marker = 'Please visit the following URL to authorize the application:';
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return {};
  let tail = text.slice(markerIndex + marker.length);
  const promptIndex = tail.search(/Enter the authorization code/i);
  if (promptIndex >= 0) tail = tail.slice(0, promptIndex);
  const start = tail.indexOf('https://accounts.google.com/');
  if (start < 0) return complete ? { invalidReason:'Gemini CLI 未输出完整 Google 授权 URL' } : {};
  const compact = tail.slice(start).replace(/\s+/g, '');
  const rawUrl = compact.match(/^https:\/\/accounts\.google\.com\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/)?.[0]?.replace(/[),.]+$/, '');
  if (!rawUrl) return complete ? { invalidReason:'Gemini CLI 输出的 Google 授权 URL 无法解析' } : {};
  return validateGeminiUserCodeLoginUrl(rawUrl, complete);
}

function validateGeminiUserCodeLoginUrl(rawUrl, complete) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return complete ? { invalidReason:'Gemini CLI 输出的 Google 授权 URL 无效' } : {}; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'accounts.google.com') return { invalidReason:'Gemini CLI 输出的授权 URL 不是 Google OAuth 地址' };
  if (!/^\/o\/oauth2\/v2\/auth\/?$/.test(parsed.pathname)) return { invalidReason:'Gemini CLI 输出的授权 URL 不是手工授权码流程' };
  const required = ['client_id','redirect_uri','response_type','scope','state','code_challenge'];
  const missing = required.filter(key => !parsed.searchParams.get(key));
  if (missing.length) return complete ? { invalidReason:`Gemini CLI 输出的授权 URL 缺少参数：${missing.join(', ')}` } : {};
  if (parsed.searchParams.get('redirect_uri') !== GEMINI_USER_CODE_REDIRECT_URI) return { invalidReason:'Gemini CLI 授权 URL redirect_uri 不是手工授权码地址' };
  if (parsed.searchParams.get('response_type') !== 'code') return { invalidReason:'Gemini CLI 授权 URL response_type 不是 code' };
  if (!parsed.searchParams.get('prompt')) parsed.searchParams.set('prompt', 'select_account');
  return { loginUrl: parsed.toString() };
}

class FakePty {
  constructor() {
    this.writes = [];
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.killed = false;
  }
  onData(fn) { this.dataHandlers.push(fn); }
  onExit(fn) { this.exitHandlers.push(fn); }
  write(value) { this.writes.push(value); }
  kill() { this.killed = true; }
  emitData(value) { for (const fn of this.dataHandlers) fn(value); }
  emitExit(exitCode = 0) { for (const fn of this.exitHandlers) fn({ exitCode }); }
}

class WorkerHarness {
  constructor({ profileId = 'p1', homeDir = '/profiles/p1/home', verifyOk = true } = {}) {
    this.profileId = profileId;
    this.homeDir = homeDir;
    this.child = new FakePty();
    this.verifyOk = verifyOk;
    this.job = {
      id: 'job1',
      profileId,
      methodId: 'oauth',
      status: 'preparing',
      output: [],
      startedAt: Date.now(),
    };
    this.env = {
      HOME: homeDir,
      GEMINI_CONFIG_DIR: `${homeDir}/.gemini`,
      NO_BROWSER: 'true',
      CI: undefined,
      CONTINUOUS_INTEGRATION: undefined,
    };
    this.child.onData(value => this.handleOutput(value));
    this.child.onExit(({ exitCode }) => this.handleExit(exitCode));
  }
  handleOutput(value) {
    this.job.output.push(stripAnsi(value));
    const parsed = parseGeminiGoogleLogin(this.job.output.join('\n'));
    if (parsed.invalidReason) {
      this.job.status = 'error';
      this.job.error = parsed.invalidReason;
      this.child.kill();
      return;
    }
    if (parsed.loginUrl) {
      this.job.loginUrl = parsed.loginUrl;
      this.job.status = 'waiting_user';
    }
    if (parsed.requiresCodeInput) this.job.requiresCodeInput = true;
    if (parsed.failure) {
      this.job.status = 'error';
      this.job.error = parsed.failure;
      this.child.kill();
    }
  }
  input(code) {
    if (!this.job.requiresCodeInput) throw new Error('not waiting for code');
    this.child.write(`${code}\n`);
    this.job.codeSubmitted = true;
    this.job.status = 'verifying';
  }
  verifyWithoutExit({ credentialsOk = true, smokeOk = true } = {}) {
    if (credentialsOk && smokeOk) {
      this.job.status = 'done';
      this.child.kill();
    } else {
      this.job.status = 'failed';
      this.job.error = credentialsOk ? 'smoke failed' : 'invalid_grant';
      this.job.codeSubmitted = false;
    }
  }
  handleExit(exitCode) {
    if (this.job.status === 'cancelled' || this.job.status === 'error') return;
    if (exitCode === 0 && this.verifyOk) this.job.status = 'done';
    else {
      this.job.status = 'error';
      this.job.error = exitCode === 0 ? 'verification failed' : `Gemini 登录进程退出，code=${exitCode}`;
    }
  }
  cancel() {
    this.child.kill();
    this.job.status = 'cancelled';
  }
  timeout() {
    this.child.kill();
    this.job.status = 'error';
    this.job.error = 'Gemini Google 登录超时，登录进程已清理。';
  }
}

const realGemini049Output = `
Please visit the following URL to authorize the application:

https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&access_type=offline&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform&code_challenge_method=S256&code_challenge=challenge&state=abc123&response_type=code&client_id=681255809395-example.apps.googleusercontent.com

Enter the authorization code:
`;

const wrappedAnsiGemini049Output = `\x1b[2J\x1b[HPlease visit the following URL to authorize the application:\r
\r
\x1b[32mhttps://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&access_type=offline&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform&code_challenge_method=S256&code_challenge=chall\r
enge&state=abc123&response_type=code&client_id=681255809395-example.apps.googleusercontent.com\x1b[0m\r
\r
Enter the authorization code:`;

test('PTY output URL is parsed and exposed on the job', () => {
  const h = new WorkerHarness();
  h.child.emitData(realGemini049Output);

  assert.equal(h.job.status, 'waiting_user');
  assert.match(h.job.loginUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  const url = new URL(h.job.loginUrl);
  for (const key of ['client_id','redirect_uri','response_type','scope','state','code_challenge']) assert.ok(url.searchParams.get(key), key);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://codeassist.google.com/authcode');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.equal(h.job.requiresCodeInput, true);
});

test('ANSI and terminal-wrapped PTY URL is reconstructed before validation', () => {
  const h = new WorkerHarness();
  h.child.emitData(wrappedAnsiGemini049Output);

  assert.equal(h.job.status, 'waiting_user');
  const url = new URL(h.job.loginUrl);
  assert.equal(url.searchParams.get('code_challenge'), 'challenge');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://codeassist.google.com/authcode');
});

test('incomplete user-code URL is rejected after the code prompt appears', () => {
  const h = new WorkerHarness();
  h.child.emitData(`Please visit the following URL to authorize the application:

https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&response_type=code&client_id=client

Enter the authorization code:`);

  assert.equal(h.job.status, 'error');
  assert.match(h.job.error, /缺少参数/);
  assert.equal(h.child.killed, true);
});

test('authorization code input is written back to the PTY with a newline', () => {
  const h = new WorkerHarness();
  h.child.emitData(realGemini049Output);

  h.input('4/0AbCdEf');

  assert.deepEqual(h.child.writes, ['4/0AbCdEf\n']);
  assert.equal(h.job.codeSubmitted, true);
  assert.equal(h.job.status, 'verifying');
});

test('successful PTY exit only marks done after ACP verification succeeds', () => {
  const h = new WorkerHarness({ verifyOk: true });
  h.child.emitData(realGemini049Output);
  h.input('code-ok');
  h.child.emitExit(0);

  assert.equal(h.job.status, 'done');
});

test('authorization code verification can finish before PTY exit', () => {
  const h = new WorkerHarness({ verifyOk: true });
  h.child.emitData(realGemini049Output);
  h.input('code-ok');

  h.verifyWithoutExit({ credentialsOk: true, smokeOk: true });

  assert.equal(h.job.status, 'done');
  assert.equal(h.child.killed, true);
});

test('invalid authorization code enters failed and can accept another code', () => {
  const h = new WorkerHarness();
  h.child.emitData(realGemini049Output);
  h.input('bad-code');

  h.verifyWithoutExit({ credentialsOk: false });

  assert.equal(h.job.status, 'failed');
  assert.equal(h.job.codeSubmitted, false);
  h.job.status = 'waiting_user';
  h.input('good-code');
  assert.deepEqual(h.child.writes, ['bad-code\n', 'good-code\n']);
});

test('successful PTY exit remains error when ACP verification fails', () => {
  const h = new WorkerHarness({ verifyOk: false });
  h.child.emitData(realGemini049Output);
  h.child.emitExit(0);

  assert.equal(h.job.status, 'error');
  assert.equal(h.job.error, 'verification failed');
});

test('error output terminates the login worker without authenticating', () => {
  const h = new WorkerHarness();
  h.child.emitData('Error authenticating: FatalAuthenticationError: invalid_grant');

  assert.equal(h.job.status, 'error');
  assert.match(h.job.error, /FatalAuthenticationError|Error authenticating/);
  assert.equal(h.child.killed, true);
});

test('cancel terminates the PTY and does not authenticate', () => {
  const h = new WorkerHarness();
  h.child.emitData(realGemini049Output);

  h.cancel();
  h.child.emitExit(0);

  assert.equal(h.child.killed, true);
  assert.equal(h.job.status, 'cancelled');
});

test('timeout cleans up the child and returns an explicit error', () => {
  const h = new WorkerHarness();

  h.timeout();

  assert.equal(h.child.killed, true);
  assert.equal(h.job.status, 'error');
  assert.match(h.job.error, /超时/);
});

test('login worker environment is isolated per profile', () => {
  const a = new WorkerHarness({ profileId: 'a', homeDir: '/data/gemini/profiles/a/home' });
  const b = new WorkerHarness({ profileId: 'b', homeDir: '/data/gemini/profiles/b/home' });

  assert.equal(a.env.HOME, '/data/gemini/profiles/a/home');
  assert.equal(a.env.GEMINI_CONFIG_DIR, '/data/gemini/profiles/a/home/.gemini');
  assert.equal(a.env.CI, undefined);
  assert.equal(a.env.CONTINUOUS_INTEGRATION, undefined);
  assert.equal(b.env.HOME, '/data/gemini/profiles/b/home');
  assert.equal(b.env.GEMINI_CONFIG_DIR, '/data/gemini/profiles/b/home/.gemini');
  assert.notEqual(a.env.GEMINI_CONFIG_DIR, b.env.GEMINI_CONFIG_DIR);
});
