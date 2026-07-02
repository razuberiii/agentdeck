import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      auth_type TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      account_id TEXT,
      status TEXT NOT NULL,
      provider_session_id TEXT,
      interruption_reason TEXT,
      last_sequence INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function activeGeminiProfile(db) {
  return db.prepare("SELECT * FROM profiles WHERE active=1 AND status='authenticated' LIMIT 1").get();
}

async function createGeminiSession(db, runtime) {
  const profile = activeGeminiProfile(db);
  if (!profile) return { status:409, body:{ error:'gemini_needs_login', message:'请先登录 Gemini' } };
  const id = 'local-session-1';
  try {
    const created = await runtime.createGeminiSession({ sessionId:id, accountId:profile.id });
    db.prepare("INSERT INTO sessions VALUES (?,?,'gemini',?,'idle',?,NULL,0)").run(id, 'Default Workspace', profile.id, created.providerSessionId);
    return { status:200, body:{ id, provider_session_id:created.providerSessionId } };
  } catch (e) {
    return {
      status:e.statusCode === 409 ? 409 : 502,
      body:{
        error:e.body?.code || e.body?.error || 'gemini_session_create_failed',
        code:e.body?.code || e.body?.error || 'gemini_session_create_failed',
        message:e.body?.message || 'Gemini 会话初始化失败',
        detail:e.body?.safeDetail || e.body?.detail || e.message,
        safeDetail:e.body?.safeDetail || e.body?.detail || e.message,
        layer:e.body?.layer || 'web_session_api',
      },
    };
  }
}

function visibleSessions(db) {
  return db.prepare('SELECT * FROM sessions ORDER BY id').all().filter(row => !isHiddenGeminiUtilitySession(row));
}

function isHiddenGeminiUtilitySession(row) {
  if (row.provider_id !== 'gemini') return false;
  if (row.interruption_reason === 'gemini_session_new_failed' && !row.provider_session_id && Number(row.last_sequence || 0) === 0) return true;
  return String(row.id).startsWith('gemini-login-verify-') || String(row.id).startsWith('gemini-smoke-') || row.title === 'Gemini login verification' || row.title === 'Gemini smoke test';
}

function quota(db) {
  const profile = activeGeminiProfile(db);
  const providerStatus = {
    id:'gemini',
    auth:profile ? 'authenticated' : 'unauthenticated',
    accountSummary:profile ? { profileId:profile.id, email:profile.email, authType:profile.auth_type } : null,
    canQueryQuota:false,
  };
  return {
    provider:'gemini',
    supported:false,
    providerStatus,
    account:profile ? { id:profile.id, email:profile.email, name:profile.name, authType:profile.auth_type } : null,
    message:'Gemini ACP 暂未提供稳定的独立实时剩余额度查询。',
    errors:{},
  };
}

function finishLoginJob(job, profile) {
  if (profile.status === 'authenticated') {
    job.status = 'done';
    job.error = undefined;
    job.loginUrl = undefined;
    job.requiresCodeInput = false;
    job.codeSubmitted = false;
    return { completed:true, job };
  }
  return { job };
}

test('active authenticated Gemini profile creates a session without prompt', async () => {
  const db = setup();
  db.prepare("INSERT INTO profiles VALUES ('g1','Gemini Account','user@example.com',1,'authenticated','oauth-personal')").run();
  const runtime = {
    calls:[],
    async createGeminiSession(body) {
      this.calls.push(['session/new', body.accountId]);
      return { providerSessionId:'upstream-1' };
    },
  };

  const response = await createGeminiSession(db, runtime);

  assert.equal(response.status, 200);
  assert.equal(response.body.provider_session_id, 'upstream-1');
  assert.deepEqual(runtime.calls, [['session/new', 'g1']]);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sessions").get().count, 1);
});

test('non-empty authMethods metadata does not locally block create', async () => {
  const db = setup();
  db.prepare("INSERT INTO profiles VALUES ('g1','Gemini Account','user@example.com',1,'authenticated','oauth-personal')").run();
  const runtime = {
    authMethods:[{ id:'oauth-personal' }, { id:'api-key' }, { id:'vertex-ai' }, { id:'gateway' }],
    async createGeminiSession() { return { providerSessionId:'upstream-1' }; },
  };

  const response = await createGeminiSession(db, runtime);

  assert.equal(response.status, 200);
  assert.equal(runtime.authMethods.length, 4);
});

test('missing or unauthenticated active profile returns readable 409', async () => {
  const db = setup();
  assert.deepEqual(await createGeminiSession(db, {}), { status:409, body:{ error:'gemini_needs_login', message:'请先登录 Gemini' } });

  db.prepare("INSERT INTO profiles VALUES ('g1','Gemini Account',NULL,1,'needs_login','oauth-personal')").run();
  assert.deepEqual(await createGeminiSession(db, {}), { status:409, body:{ error:'gemini_needs_login', message:'请先登录 Gemini' } });
});

test('runtime profile missing or create failure returns structured error and leaves no empty session', async () => {
  const db = setup();
  db.prepare("INSERT INTO profiles VALUES ('g1','Gemini Account','user@example.com',1,'authenticated','oauth-personal')").run();
  const error = new Error('profile not found');
  error.statusCode = 502;
  error.body = { error:'gemini_session_create_failed', detail:'profile not found' };

  const response = await createGeminiSession(db, { async createGeminiSession() { throw error; } });

  assert.equal(response.status, 502);
  assert.equal(response.body.error, 'gemini_session_create_failed');
  assert.equal(response.body.code, 'gemini_session_create_failed');
  assert.equal(response.body.message, 'Gemini 会话初始化失败');
  assert.equal(response.body.detail, 'profile not found');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sessions").get().count, 0);
});

test('unsupported Gemini Code Assist client is reported as structured non-auth failure', async () => {
  const db = setup();
  db.prepare("INSERT INTO profiles VALUES ('g1','Gemini Account','user@example.com',1,'authenticated','oauth-personal')").run();
  const error = new Error('This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google');
  error.statusCode = 409;
  error.body = {
    code:'gemini_client_unsupported',
    layer:'gemini_acp_session_new',
    message:'当前 Gemini CLI 不再支持该个人账号创建会话',
    safeDetail:error.message,
  };

  const response = await createGeminiSession(db, { async createGeminiSession() { throw error; } });

  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'gemini_client_unsupported');
  assert.equal(response.body.layer, 'gemini_acp_session_new');
  assert.match(response.body.safeDetail, /no longer supported/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sessions").get().count, 0);
});

test('login verification and failed empty Gemini sessions are hidden from normal session list', () => {
  const db = setup();
  db.prepare("INSERT INTO sessions VALUES ('gemini-login-verify-a','Gemini login verification','gemini','g1','interrupted',NULL,'gemini_session_new_failed',0)").run();
  db.prepare("INSERT INTO sessions VALUES ('s1','Default Workspace','gemini','g1','interrupted',NULL,'gemini_session_new_failed',0)").run();
  db.prepare("INSERT INTO sessions VALUES ('s2','Real Session','gemini','g1','idle','upstream-1',NULL,0)").run();

  assert.deepEqual(visibleSessions(db).map(row => row.id), ['s2']);
});

test('quota uses active authenticated profile and reports unsupported as information', () => {
  const db = setup();
  db.prepare("INSERT INTO profiles VALUES ('g1','Gemini Account','razuberiiii2139@gmail.com',1,'authenticated','oauth-personal')").run();

  const response = quota(db);

  assert.equal(response.supported, false);
  assert.equal(response.providerStatus.auth, 'authenticated');
  assert.equal(response.providerStatus.accountSummary.email, 'razuberiiii2139@gmail.com');
  assert.equal(response.account.email, 'razuberiiii2139@gmail.com');
  assert.equal(response.message, 'Gemini ACP 暂未提供稳定的独立实时剩余额度查询。');
  assert.deepEqual(response.errors, {});
});

test('completed login job clears URL and authorization code UI state', () => {
  const job = {
    status:'verifying',
    loginUrl:'https://accounts.google.com/o/oauth2/v2/auth',
    requiresCodeInput:true,
    codeSubmitted:true,
    error:'old error',
  };
  const profile = { status:'authenticated' };

  const result = finishLoginJob(job, profile);

  assert.equal(result.completed, true);
  assert.equal(job.status, 'done');
  assert.equal(job.loginUrl, undefined);
  assert.equal(job.requiresCodeInput, false);
  assert.equal(job.codeSubmitted, false);
  assert.equal(job.error, undefined);
});
