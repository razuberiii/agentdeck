import assert from 'node:assert/strict';
import test from 'node:test';

function parseGeminiGoogleLogin(output) {
  const text = stripAnsi(output).replace(/[^\S\r\n]+/g, ' ');
  const compact = stripAnsi(output).replace(/\s+/g, '');
  const loginUrl = compact.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?.*?(?:client_id=[^&\s]+|state=[A-Za-z0-9._-]+)/i)?.[0]?.replace(/[),.]+$/, '')
    || text.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s)]+/i)?.[0]?.replace(/[),.]+$/, '');
  const requiresCodeInput = /Enter the authorization code|authorization code|authcode|paste .*code/i.test(text);
  const failureMatch = text.match(/(Error authenticating:[^\n]+|FatalAuthenticationError:[^\n]+|Manual authorization is required[^\n]+|authentication failed[^\n]*|invalid_grant[^\n]*)/i);
  const success = /authenticated successfully|authentication completed successfully|login successful/i.test(text);
  return { loginUrl, requiresCodeInput, success, failure: failureMatch?.[1] || null };
}

function stripAnsi(text) {
  return String(text).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
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
      status: 'starting',
      output: [],
      startedAt: Date.now(),
    };
    this.env = {
      HOME: homeDir,
      GEMINI_CONFIG_DIR: `${homeDir}/.gemini`,
      NO_BROWSER: 'true',
    };
    this.child.onData(value => this.handleOutput(value));
    this.child.onExit(({ exitCode }) => this.handleExit(exitCode));
  }
  handleOutput(value) {
    this.job.output.push(stripAnsi(value));
    const parsed = parseGeminiGoogleLogin(this.job.output.join('\n'));
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
    this.child.write(`${code}\r`);
    this.job.codeSubmitted = true;
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

test('PTY output URL is parsed and exposed on the job', () => {
  const h = new WorkerHarness();
  h.child.emitData(realGemini049Output);

  assert.equal(h.job.status, 'waiting_user');
  assert.match(h.job.loginUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.equal(h.job.requiresCodeInput, true);
});

test('authorization code input is written back to the PTY with a newline', () => {
  const h = new WorkerHarness();
  h.child.emitData(realGemini049Output);

  h.input('4/0AbCdEf');

  assert.deepEqual(h.child.writes, ['4/0AbCdEf\r']);
  assert.equal(h.job.codeSubmitted, true);
});

test('successful PTY exit only marks done after ACP verification succeeds', () => {
  const h = new WorkerHarness({ verifyOk: true });
  h.child.emitData(realGemini049Output);
  h.input('code-ok');
  h.child.emitExit(0);

  assert.equal(h.job.status, 'done');
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
  assert.equal(b.env.HOME, '/data/gemini/profiles/b/home');
  assert.equal(b.env.GEMINI_CONFIG_DIR, '/data/gemini/profiles/b/home/.gemini');
  assert.notEqual(a.env.GEMINI_CONFIG_DIR, b.env.GEMINI_CONFIG_DIR);
});
