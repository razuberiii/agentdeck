import 'dotenv/config';
import Fastify from 'fastify';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Db } from './db.js';
import { WsJsonRpcClient } from './ws-json-rpc.js';
import { GeminiAcpRuntime, GeminiModelSwitchUnsupportedError } from './acp/gemini-runtime.js';
import { ClaudeRuntimeManager } from './claude/claude-runtime-manager.js';
import { ClaudeProfileStore } from './claude/claude-profile-store.js';
import type { ClaudeProfile } from './claude/claude-types.js';
import { DurableEventStore } from './event-store.js';
import { EventSubscriptions } from './event-subscriptions.js';
import { runMigrations } from './migration-runner.js';
import { deleteSessionRelations } from './session-lifecycle.js';

const execFileAsync = promisify(execFile);
const DEFAULT_HOME = process.env.HOME || os.homedir();
const DATA_DIR = process.env.RUNTIME_DATA_DIR || process.env.DATA_DIR || '/var/lib/agentdeck';
const DB_FILE = process.env.RUNTIME_DB || path.join(DATA_DIR, 'agentdeck-runtime.sqlite3');
const HOST = process.env.RUNTIME_HOST || '127.0.0.1';
const PORT = Number(process.env.RUNTIME_PORT || 3852);
const RUNTIME_TOKEN = process.env.RUNTIME_TOKEN || '';
const RUNTIME_MODE = process.env.RUNTIME_MODE === 'candidate' ? 'candidate' : 'active';
const RELEASE_INFO = releaseMetadata();
const RELEASE_ID = process.env.AGENTDECK_RELEASE_ID || RELEASE_INFO.releaseId;
const RELEASE_COMMIT = process.env.AGENTDECK_RELEASE_COMMIT || RELEASE_INFO.commit;
const CODEX_PORT_BASE = Number(process.env.CODEX_APP_SERVER_PORT_BASE || 4520);
const DEFAULT_CODEX_APP_SERVER_PORT = Number(process.env.CODEX_APP_SERVER_DEFAULT_PORT || 4668);
const INSTANCE_ID = process.env.RUNTIME_INSTANCE_ID || `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || path.join(DEFAULT_HOME, '.codex');
const DEFAULT_WORKDIR = process.env.RUNTIME_DEFAULT_CWD || process.cwd();
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const APP_SERVER_USER = process.env.CODEX_APP_SERVER_USER || 'ubuntu';
const APP_SERVER_GROUP = process.env.CODEX_APP_SERVER_GROUP || APP_SERVER_USER;
const SHARED_CODEX_DIR = RUNTIME_MODE === 'candidate' ? path.join(DATA_DIR, 'candidate-shared') : path.join(DATA_DIR, 'shared');
const SHARED_SESSIONS_DIR = path.join(SHARED_CODEX_DIR, 'sessions');
const SHARED_GENERATED_IMAGES_DIR = path.join(SHARED_CODEX_DIR, 'generated_images');
const RECOVERY_CONTEXT_MARKER = '[[AGENT_RUNTIME_RECOVERY_CONTEXT]]';
function isLoopbackHost(host:string) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
if (!isLoopbackHost(HOST) && !RUNTIME_TOKEN) {
  throw new Error('RUNTIME_TOKEN is required when RUNTIME_HOST is not loopback');
}
if (RUNTIME_MODE === 'active') mkdirSync('/run/agentdeck', { recursive:true });

type Account = { id:string; provider:string; codex_home:string; runtime_instance_id:string | null };
type StructuredRuntimeErrorBody = {
  code:string;
  layer:string;
  message:string;
  safeDetail:string;
  requestId?:string;
};
type RuntimeSession = {
  id:string;
  codex_thread_id:string | null;
  account_id:string | null;
  provider:string;
  upstream_thread_id:string | null;
  upstream_generation:string | null;
  upstream_status:string | null;
  active_turn_id:string | null;
  status:string;
  project_dir:string;
  title:string;
  permission_mode:string;
  approval_policy:string;
  sandbox_mode:string;
  model:string | null;
  provider_id?: string | null;
  provider_session_id?: string | null;
  creator_profile_id?: string | null;
  selected_profile_id?: string | null;
  executing_profile_id?: string | null;
  upstream_binding_profile_id?: string | null;
  last_execution_account_id?: string | null;
  current_upstream_account_id?: string | null;
  account_snapshot_json?: string | null;
  created_at:number;
  updated_at:number;
  last_sequence:number;
  interruption_reason:string | null;
};

class CodexAccountRuntime extends EventEmitter {
  private client: WsJsonRpcClient | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  constructor(private account:Account, private port:number, private db:Db) { super(); }

  updateAccount(account:Account) {
    this.account = account;
  }

  async ensureConnected() {
    await ensureCodexAppServer(this.account, this.port, this.db);
    if (this.client?.isConnected() && this.initialized) return;
    if (!this.connecting) this.connecting = this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async request(method:string, params?:any, timeoutMs = 120_000) {
    const startedAt = Date.now();
    diagnostics.activeRuntimeRpcCount++;
    try {
      await this.ensureConnected();
      const result = await this.client!.request(method, params, timeoutMs);
      app.log.info({ operation:`runtime ${method}`, durationMs:Date.now() - startedAt, activeRuntimeRpcCount:diagnostics.activeRuntimeRpcCount }, 'runtime rpc completed');
      return result;
    } finally {
      diagnostics.activeRuntimeRpcCount = Math.max(0, diagnostics.activeRuntimeRpcCount - 1);
    }
  }

  async restartAppServer() {
    this.client?.close();
    this.client = null;
    this.initialized = false;
    await execFileAsync('sudo', ['systemctl', 'restart', systemdUnitName(this.account.id)], { maxBuffer:1024 * 1024 });
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15_000) {
      if (await readyz(this.port)) {
        await this.connect();
        return;
      }
      await sleep(250);
    }
    throw new Error(`codex app-server did not become ready after restart on ${this.port}`);
  }

  respond(id:number|string, result:any) {
    this.client?.respond(id, result);
  }

  private async connect() {
    const client = new WsJsonRpcClient('127.0.0.1', this.port);
    client.on('notification', msg => this.emit('notification', msg));
    client.on('request', msg => this.emit('request', msg));
    client.on('close', () => {
      this.initialized = false;
      if (this.client === client) this.client = null;
      this.emit('disconnect', { accountId:this.account.id, at:Date.now() });
      this.scheduleReconnect();
    });
    client.on('error', err => this.emit('error', err));
    await client.connect();
    const init = await client.request('initialize', {
      clientInfo: { name:'agentdeck-runtime', title:'Agent Runtime', version:'1.0.0' },
      capabilities: { experimentalApi:true, requestAttestation:false },
    }, 30_000);
    client.notify('initialized');
    this.client = client;
    this.initialized = true;
    await this.db.run('UPDATE runtime_instances SET pid=?1, heartbeat_at=?2 WHERE instance_id=?3', [await pidForPort(this.port), Date.now(), runtimeInstanceId(this.account.id)]);
    this.emit('connect', { accountId:this.account.id, init, at:Date.now() });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.ensureConnected();
        this.emit('reconnect', { accountId:this.account.id, at:Date.now() });
      } catch (e) {
        this.emit('error', e);
        this.scheduleReconnect();
      }
    }, 1500);
  }

}

const db = new Db(DB_FILE);
await db.init();
await runMigrations(db,'runtime',[{version:1,name:'runtime_schema_baseline',statements:process.env.AGENTDECK_TEST_BAD_MIGRATION==='1'?['THIS IS INVALID SQL']:[]}]);
await initRuntimeSchema();
const claudeProfileStore = new ClaudeProfileStore(db, DATA_DIR, process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude'));
class GeminiRuntimeManager {
  private runtimes = new Map<string, GeminiAcpRuntime>();
  private inFlight = new Map<string, Promise<GeminiAcpRuntime>>();

  async get(profileId:string) {
    const id = normalizeGeminiProfileId(profileId);
    const existing = this.runtimes.get(id);
    if (existing) return existing;
    const pending = this.inFlight.get(id);
    if (pending) return pending;
    const promise = this.create(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, promise);
    return promise;
  }

  async status(profileId = 'default') {
    const id = normalizeGeminiProfileId(profileId);
    const runtime = this.runtimes.get(id);
    if (runtime) return runtime.status();
    return {
      installed: existsSync(process.env.GEMINI_BIN || '/usr/bin/gemini'),
      command: process.env.GEMINI_BIN || '/usr/bin/gemini',
      acpArgs: (process.env.GEMINI_ACP_ARGS || '--acp').split(/\s+/).filter(Boolean),
      connected: false,
      initialized: false,
      authenticated: false,
      authMethods: [],
      capabilities: null,
      agentInfo: null,
      profileId:id,
      lastError: null,
    };
  }

  async initialize(profileId:string) {
    const runtime = await this.get(profileId);
    await runtime.ensureInitialized();
    return runtime.status();
  }

  async forceReinitialize(profileId:string) {
    const id = normalizeGeminiProfileId(profileId);
    const previous = this.runtimes.get(id);
    const previousPid = previous?.status()?.childPid || null;
    const started = Date.now();
    this.inFlight.delete(id);
    if (previous) await previous.dispose('Gemini profile force reinitialize');
    this.runtimes.delete(id);
    const runtime = await this.get(id);
    await runtime.ensureInitialized();
    const status = runtime.status();
    return {
      ...status,
      forceReinitialized:true,
      oldInstance:!!previous,
      oldChildPid:previousPid,
      newChildPid:status.childPid || null,
      disposeCompleted:true,
      elapsedMs:Date.now() - started,
    };
  }

  async authenticate(profileId:string, methodId:string) {
    const runtime = await this.get(profileId);
    return runtime.authenticate(methodId);
  }

  async logout(profileId:string) {
    const runtime = await this.get(profileId);
    return runtime.logout();
  }

  async restart(profileId:string) {
    const runtime = await this.get(profileId);
    await runtime.restart();
    return runtime.status();
  }

  async dispose(profileId:string) {
    const id = normalizeGeminiProfileId(profileId);
    const runtime = this.runtimes.get(id);
    if (runtime) await runtime.dispose('Gemini profile disposed');
    this.runtimes.delete(id);
    this.inFlight.delete(id);
    return { ok:true, profileId:id };
  }

  answerPermission(requestId:string, optionId:string|null) {
    for (const runtime of this.runtimes.values()) {
      if (runtime.answerPermission(requestId, optionId)) return true;
    }
    return false;
  }

  private async create(profileId:string) {
    const profileDir = geminiProfileDir(profileId);
    await mkdir(profileDir, { recursive:true, mode:0o700 });
    await chmod(profileDir, 0o700).catch(()=>{});
    return new GeminiAcpRuntime({
      db,
      dataDir: DATA_DIR,
      defaultCwd: DEFAULT_WORKDIR,
      profileId,
      profileDir,
      profileEnv: await readGeminiProfileEnv(profileDir),
      logger: {
        info: (obj:any, msg?:string) => app.log.info(obj, msg),
        warn: (obj:any, msg?:string) => app.log.warn(obj, msg),
        error: (obj:any, msg?:string) => app.log.error(obj, msg),
      },
      appendEvent,
      updateSession: updateRuntimeSession,
    });
  }
}

const geminiManager = new GeminiRuntimeManager();
const claudeManager = new ClaudeRuntimeManager(db, claudeProfileStore, {
  appendEvent,
  updateSession: updateRuntimeSession,
  logger: {
    info: (obj:any, msg?:string) => app.log.info(obj, msg),
    warn: (obj:any, msg?:string) => app.log.warn(obj, msg),
    error: (obj:any, msg?:string) => app.log.error(obj, msg),
  },
});

const runtimes = new Map<string, CodexAccountRuntime>();
const runtimeForAccountInFlight = new Map<string, Promise<CodexAccountRuntime>>();
const codexAppServerEnsureInFlight = new Map<string, Promise<void>>();
const resumeInFlight = new Map<string, Promise<{ threadId:string; recovered:boolean }>>();
const reconcileInFlight = new Map<string, Promise<void>>();
const lastReconcileAt = new Map<string, number>();
const threadSessionCache = new Map<string, RuntimeSession>();
const diagnostics = {
  startedAt: Date.now(),
  sseConnections: 0,
  sseReconnects: 0,
  threadResumeCalls: 0,
  threadStartCalls: 0,
  deltasReceived: 0,
  deltasSsePushed: 0,
  sqliteBatches: 0,
  sqliteRows: 0,
  sqliteMs: 0,
  activeRuntimeRpcCount: 0,
  sseReconnectCount: 0,
  runtimePendingPushCount: 0,
};
type RuntimeLifecycle = 'starting' | 'accepting' | 'draining' | 'stopping';
let runtimeLifecycle:RuntimeLifecycle = 'starting';
let drainStartedAt:number | null = null;
let drainExpiresAt:number | null = null;
const DRAIN_TIMEOUT_MS = Number(process.env.RUNTIME_DRAIN_TIMEOUT_MS || 10 * 60 * 1000);
const DRAIN_LEASE_MS = Number(process.env.RUNTIME_DRAIN_LEASE_MS || 2 * 60 * 1000);
const STALE_RUNNING_MS = Number(process.env.STALE_RUNNING_MS || 30 * 60 * 1000);
const RUNTIME_GENERATION = INSTANCE_ID;
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
const app = Fastify({ logger:{ redact:['req.headers.authorization','token','secret','password'] }, bodyLimit:25 * 1024 * 1024 });
const subscriptions = new EventSubscriptions({
  maxBuffer:Number(process.env.RUNTIME_SSE_REPLAY_BUFFER_MAX || 2048),
  maxPendingPushes:Number(process.env.RUNTIME_SSE_PENDING_PUSH_MAX || 4096),
  logger:(level,data,message)=>app.log[level](data,message),
});
const eventStore = new DurableEventStore(db,RUNTIME_GENERATION,{
  windowMs:Number(process.env.RUNTIME_DELTA_FLUSH_MS || 32),
  maxEvents:Number(process.env.RUNTIME_DELTA_FLUSH_EVENTS || 128),
  maxBytes:Number(process.env.RUNTIME_DELTA_FLUSH_BYTES || 262144),
  onCommitted:event=>subscriptions.publish(event),
});
app.setErrorHandler((err:any, req, reply) => {
  if (err instanceof StructuredRuntimeError) {
    const body = { ...err.body, requestId:String(req.id || '') };
    req.log.warn({ requestId:body.requestId, code:body.code, layer:body.layer, safeDetail:body.safeDetail }, err.message);
    return reply.code(err.statusCode).send(body);
  }
  req.log.error({ requestId:req.id, err }, 'runtime request failed');
  return reply.code(500).send({
    code:'runtime_internal_error',
    layer:'runtime',
    message:'Runtime 请求失败',
    safeDetail:'Runtime 处理请求时发生未知错误',
    requestId:String(req.id || ''),
  });
});
app.addHook('preHandler', async (req, reply) => {
  if (!RUNTIME_TOKEN) return;
  const authorization = String(req.headers.authorization || '');
  if (authorization !== `Bearer ${RUNTIME_TOKEN}`) return reply.code(401).send({ error:'unauthorized' });
});

app.get('/healthz', async () => ({ ok:true, instanceId:INSTANCE_ID, pid:process.pid, now:Date.now(), lifecycle:runtimeLifecycle, mode:RUNTIME_MODE, releaseId:RELEASE_ID, commit:RELEASE_COMMIT }));
app.get('/admin/runtime/state', async () => runtimeAdminState());
app.post('/admin/runtime/drain', async (req:any) => startRuntimeDrain(req));
app.post('/admin/runtime/undrain', async () => cancelRuntimeDrain());
app.get('/admin/runtime/active-turns', async () => activeTurnDetails());
app.get('/diagnostics', async () => ({
  ...diagnostics,
  lifecycle:runtimeLifecycle,
  drainStartedAt,
  drainTimeoutMs:DRAIN_TIMEOUT_MS,
  drainState:await drainState(),
  activeSseSubscribers:subscriptions.snapshot(),
  activeSseSubscriberTotal:subscriptions.count(),
  activeRuntimeRpcCount:diagnostics.activeRuntimeRpcCount,
  activeSseSubscriberCount:subscriptions.count(),
  sseReconnectCount:diagnostics.sseReconnectCount,
  resumeInFlightCount:resumeInFlight.size,
  runtimePendingPushCount:diagnostics.runtimePendingPushCount,
  runtimeCount:runtimes.size,
  eventLoopDelayMs:{
    mean:Number.isFinite(eventLoopDelay.mean) ? eventLoopDelay.mean / 1e6 : 0,
    max:eventLoopDelay.max / 1e6,
    p99:eventLoopDelay.percentile(99) / 1e6,
  },
}));
app.post('/drain/start', async (req:any) => startRuntimeDrain(req));
app.get('/drain/status', async () => {
  expireRuntimeDrain();
  return { lifecycle:runtimeLifecycle, drainStartedAt, drainExpiresAt, drainTimeoutMs:DRAIN_TIMEOUT_MS, drainLeaseMs:DRAIN_LEASE_MS, ...(await drainState()) };
});
app.post('/drain/cancel', async () => cancelRuntimeDrain());
app.get('/schema', async () => ({ tables: await db.all("SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('accounts','sessions','events','runtime_instances') ORDER BY name") }));
app.get('/gemini/status', async (req:any) => geminiManager.status(String(req.query?.profileId || 'default')));
app.get('/gemini/profiles/:id/status', async (req:any) => geminiManager.status(String(req.params.id)));
app.post('/gemini/profiles/:id/initialize', async (req:any) => geminiManager.initialize(String(req.params.id)));
app.post('/gemini/profiles/:id/force-initialize', async (req:any) => geminiManager.forceReinitialize(String(req.params.id)));
app.post('/gemini/profiles/:id/authenticate', async (req:any, reply) => {
  const methodId = String(req.body?.methodId || '').trim();
  if (!methodId) return reply.code(400).send({ error:'methodId required' });
  return geminiManager.authenticate(String(req.params.id), methodId);
});
app.post('/gemini/profiles/:id/logout', async (req:any) => geminiManager.logout(String(req.params.id)));
app.post('/gemini/profiles/:id/restart', async (req:any) => geminiManager.restart(String(req.params.id)));
app.post('/gemini/profiles/:id/dispose', async (req:any) => geminiManager.dispose(String(req.params.id)));
app.post('/gemini/approvals/:id', async (req:any, reply) => {
  const optionId = typeof req.body?.optionId === 'string' ? req.body.optionId : null;
  if (!geminiManager.answerPermission(String(req.params.id), optionId)) return reply.code(404).send({ error:'approval request not found' });
  return { ok:true };
});
app.post('/claude/approvals/:id', async (req:any, reply) => {
  const decision = req.body?.decision === 'accept_session' ? 'accept_session' : req.body?.decision === 'decline' ? 'decline' : 'accept';
  if (!await claudeManager.answerApproval(String(req.params.id), decision)) return reply.code(404).send({ error:'approval request not found' });
  return { ok:true };
});

app.get('/sessions', async (req:any) => {
  const requestId = req.id;
  const startedAt = Date.now();
  const archived = String(req.query?.archived || '') === '1' ? 1 : 0;
  const sqliteStartedAt = Date.now();
  const sessions = await db.all('SELECT * FROM sessions WHERE archived=?1 ORDER BY updated_at DESC LIMIT 500', [archived]);
  app.log.info({ requestId, operation:'GET /sessions', sqliteDurationMs:Date.now() - sqliteStartedAt, totalDurationMs:Date.now() - startedAt }, 'runtime sessions listed from sqlite');
  return { sessions };
});

app.post('/codex/accounts/default', async () => {
  const account = await ensureAccount('default', DEFAULT_CODEX_HOME);
  await (await runtimeForAccount(account.id)).ensureConnected();
  return { account, port:portForAccount(account.id), runtimeInstanceId:runtimeInstanceId(account.id) };
});

app.post('/codex/accounts/default/restart', async (req:any) => {
  const codexHome = String(req.body?.codexHome || DEFAULT_CODEX_HOME);
  const previous = await getAccount('default') || await ensureAccount('default', DEFAULT_CODEX_HOME);
  const runtime = await runtimeForAccount(previous.id);
  await runtime.restartAppServer();
  const read = await runtime.request('account/read', { refreshToken:false });
  const account = await ensureAccount('default', codexHome);
  runtime.updateAccount(account);
  return { account, port:portForAccount(account.id), runtimeInstanceId:runtimeInstanceId(account.id), read };
});

app.get('/codex/account', async (req:any) => {
  const account = await ensureAccount(String(req.query?.accountId || 'default'), String(req.query?.codexHome || DEFAULT_CODEX_HOME));
  const runtime = await runtimeForAccount(account.id);
  return runtime.request('account/read', { refreshToken:false });
});

app.get('/codex/rate-limits', async (req:any) => {
  const account = await ensureAccount(String(req.query?.accountId || 'default'), String(req.query?.codexHome || DEFAULT_CODEX_HOME));
  const runtime = await runtimeForAccount(account.id);
  return runtime.request('account/rateLimits/read');
});

app.get('/codex/models', async (req:any) => {
  const account = await ensureAccount(String(req.query?.accountId || 'default'), String(req.query?.codexHome || DEFAULT_CODEX_HOME));
  const runtime = await runtimeForAccount(account.id);
  const includeHidden = String(req.query?.hidden || '') === '1';
  const [models, config] = await Promise.allSettled([
    runtime.request('model/list', { includeHidden, limit:200 }),
    runtime.request('config/read', { cwd:String(req.query?.cwd || DEFAULT_WORKDIR), includeLayers:false }),
  ]);
  return {
    models: models.status === 'fulfilled' ? models.value : { data:[] },
    config: config.status === 'fulfilled' ? config.value : null,
    errors: {
      models: models.status === 'rejected' ? models.reason?.message || String(models.reason) : null,
      config: config.status === 'rejected' ? config.reason?.message || String(config.reason) : null,
    },
  };
});

app.post('/codex/sessions', async (req:any, reply) => {
  if (isCandidateMode()) return reply.code(503).header('Retry-After', '5').send(runtimeUnavailableBody(req, 'runtime_candidate'));
  if (isDraining()) return reply.code(503).send(runtimeDrainingBody(req));
  const body = req.body || {};
  const account = await ensureAccount(String(body.accountId || 'default'), String(body.codexHome || DEFAULT_CODEX_HOME));
  const runtime = await runtimeForAccount(account.id);
  const opts = turnOptions(body);
  let started:any;
  try {
    started = await runtime.request('thread/start', withModel({ cwd:String(body.cwd || DEFAULT_WORKDIR), approvalPolicy:opts.approvalPolicy, sandbox:opts.sandboxMode }, opts));
  } catch (e:any) {
    throw new StructuredRuntimeError(502, {
      code:'codex_session_create_failed',
      layer:'runtime_session_service',
      message:'Codex 会话初始化失败',
      safeDetail:redactRuntimeError(e?.message || String(e)),
    });
  }
  const thread = started.thread;
  const now = Date.now();
  const title = cleanTitle(body.title || thread.name || thread.preview, thread.cwd);
  await db.run(
    `INSERT INTO sessions (id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,model,archived,created_at,updated_at,provider_id,account_id,model_id,workspace_path,provider_session_id,provider,upstream_thread_id,active_turn_id,last_sequence,interruption_reason,creator_profile_id,selected_profile_id,executing_profile_id,upstream_binding_profile_id,last_execution_account_id,current_upstream_account_id,account_snapshot_json)
     VALUES (?1,?1,?2,?3,'idle',?4,?5,?6,?7,0,?8,?8,'codex',?9,?7,?2,?1,'codex',?1,NULL,0,NULL,?9,?9,?9,?9,?9,?9,?10)
     ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`,
    [thread.id, thread.cwd, title, opts.permissionMode, opts.approvalPolicy, opts.sandboxMode, opts.model || null, now, account.id, JSON.stringify(body.accountSnapshot || null)]
  );
  await appendEvent(String(thread.id), 'thread/start', { thread, source:'runtime' });
  if (title) await runtime.request('thread/name/set', { threadId:thread.id, name:title }).catch(()=>{});
  return { session: await getSession(String(thread.id)), thread };
});

app.post('/gemini/sessions', async (req:any, reply) => {
  if (isCandidateMode()) return reply.code(503).header('Retry-After', '5').send(runtimeUnavailableBody(req, 'runtime_candidate'));
  if (isDraining()) return reply.code(503).send(runtimeDrainingBody(req));
  const body = req.body || {};
  const cwd = String(body.cwd || DEFAULT_WORKDIR);
  const localSessionId = String(body.sessionId || crypto.randomUUID());
  const accountId = String(body.accountId || 'default');
  const now = Date.now();
  const opts = turnOptions(body);
  await db.run(
    `INSERT INTO sessions (id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,model,archived,created_at,updated_at,provider_id,account_id,model_id,workspace_path,provider_session_id,provider,upstream_thread_id,active_turn_id,last_sequence,interruption_reason,provider_profile_id,last_execution_account_id,current_upstream_account_id,account_snapshot_json)
     VALUES (?1,?1,?2,?3,'initializing',?4,?5,?6,?7,0,?8,?8,'gemini',?9,?7,?2,NULL,'gemini',NULL,NULL,0,NULL,?9,?9,?9,?10)
     ON CONFLICT(id) DO UPDATE SET project_dir=excluded.project_dir,title=excluded.title,provider_id='gemini',provider='gemini',updated_at=excluded.updated_at`,
    [localSessionId, cwd, cleanTitle(body.title || path.basename(cwd), cwd), opts.permissionMode, opts.approvalPolicy, opts.sandboxMode, opts.model || null, now, accountId, JSON.stringify(body.accountSnapshot || null)]
  );
  try {
    const gemini = await geminiManager.get(accountId);
    const state = await gemini.createSession({ localSessionId, cwd, mode:opts.permissionMode, model:opts.model || null });
    return { session: await getSession(localSessionId), providerSessionId:state.providerSessionId, gemini:gemini.status() };
  } catch (e:any) {
    const message = e?.message || String(e);
    await db.run('DELETE FROM sessions WHERE id=?1 AND provider_session_id IS NULL AND last_sequence=0', [localSessionId]).catch(()=>{});
    const classified = classifyGeminiSessionCreateError(e);
    app.log.warn({ provider:'gemini', accountId, localSessionId, error:classified.safeDetail, code:classified.code }, 'gemini session create failed');
    return reply.code(classified.statusCode).send({
      code:classified.code,
      error:classified.code,
      layer:'gemini_acp_session_new',
      message:classified.message,
      safeDetail:classified.safeDetail,
      detail:classified.safeDetail,
      gemini:await geminiManager.status(accountId),
    });
  }
});

app.post('/claude/sessions', async (req:any, reply) => {
  if (isCandidateMode()) return reply.code(503).header('Retry-After', '5').send(runtimeUnavailableBody(req, 'runtime_candidate'));
  if (isDraining()) return reply.code(503).send(runtimeDrainingBody(req));
  const body = req.body || {};
  const cwd = String(body.cwd || DEFAULT_WORKDIR);
  const localSessionId = String(body.sessionId || crypto.randomUUID());
  const profile = validateClaudeProfileForRuntime(body.profile, body.accountId);
  const now = Date.now();
  const opts = turnOptions(body);
  await db.run(
    `INSERT INTO sessions (id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,model,archived,created_at,updated_at,provider_id,account_id,model_id,workspace_path,provider_session_id,provider,upstream_thread_id,active_turn_id,last_sequence,interruption_reason,provider_profile_id,last_execution_account_id,current_upstream_account_id,account_snapshot_json,creator_profile_id,selected_profile_id,executing_profile_id,upstream_binding_profile_id)
     VALUES (?1,?1,?2,?3,'idle',?4,?5,?6,?7,0,?8,?8,'claude',?9,?7,?2,NULL,'claude',NULL,NULL,0,NULL,?9,?9,?9,?10,?9,?9,?9,?9)
     ON CONFLICT(id) DO UPDATE SET project_dir=excluded.project_dir,title=excluded.title,provider_id='claude',provider='claude',updated_at=excluded.updated_at`,
    [localSessionId, cwd, cleanTitle(body.title || path.basename(cwd), cwd), opts.permissionMode, opts.approvalPolicy, opts.sandboxMode, opts.model || null, now, profile.id, JSON.stringify(body.accountSnapshot || null)]
  );
  await appendEvent(localSessionId, 'claude/session_created', { provider:'claude', profileId:profile.id, cwd });
  return { session: await getSession(localSessionId), providerSessionId:null };
});

app.post('/gemini/sessions/:id/model', async (req:any, reply) => {
  const session = await getSession(String(req.params.id));
  if (!session || (session.provider_id !== 'gemini' && session.provider !== 'gemini')) return reply.code(404).send({ error:'not found' });
  const accountId = String(session.current_upstream_account_id || session.account_id || req.body?.accountId || 'default');
  const model = cleanModel(req.body?.model) || null;
  try {
    const gemini = await geminiManager.get(accountId);
    const result = await gemini.setSessionModel(String(session.id), model);
    return { ok:true, session:await getSession(String(session.id)), ...result };
  } catch (e:any) {
    const message = e?.message || String(e);
    const statusCode = e instanceof GeminiModelSwitchUnsupportedError || e?.code === 'gemini_model_switch_unsupported'
      ? 409
      : Number(e?.statusCode || 502);
    return reply.code(statusCode).send({
      error:e?.code || 'gemini_model_switch_failed',
      supported:false,
      message: statusCode === 409 ? '当前 Gemini CLI ACP 未公开可切换模型，继续使用 CLI 默认配置。' : 'Gemini 模型切换失败',
      detail:redactRuntimeError(message),
    });
  }
});

app.post('/codex/sessions/resume', async (req:any, reply) => {
  if (isCandidateMode()) return reply.code(503).header('Retry-After', '5').send(runtimeUnavailableBody(req, 'runtime_candidate'));
  if (isDraining()) return reply.code(503).send(runtimeDrainingBody(req));
  const body = req.body || {};
  const threadId = String(body.threadId || '').trim();
  if (!threadId) return reply.code(400).send({ error:'threadId required' });
  const account = await ensureAccount(String(body.accountId || 'default'), String(body.codexHome || DEFAULT_CODEX_HOME));
  const runtime = await runtimeForAccount(account.id);
  const opts = turnOptions(body);
  let read:any;
  try {
    read = await runtime.request('thread/resume', withModel({
      threadId,
      cwd:String(body.cwd || DEFAULT_WORKDIR),
      approvalPolicy:opts.approvalPolicy,
      sandbox:opts.sandboxMode,
    }, opts));
  } catch (e:any) {
    return reply.code(409).send({ error:`旧会话无法迁移到 runtime：${e?.message || e}` });
  }
  const thread = read.thread;
  const now = Date.now();
  await db.run(
    `INSERT INTO sessions (id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,model,archived,created_at,updated_at,provider_id,account_id,model_id,workspace_path,provider_session_id,provider,upstream_thread_id,active_turn_id,last_sequence,interruption_reason)
     VALUES (?1,?1,?2,?3,?4,?5,?6,?7,?8,0,?9,?9,'codex',?10,?8,?2,?1,'codex',?1,NULL,0,NULL)
     ON CONFLICT(id) DO UPDATE SET project_dir=excluded.project_dir,title=excluded.title,status=excluded.status,account_id=excluded.account_id,updated_at=excluded.updated_at`,
    [threadId, thread.cwd || body.cwd || DEFAULT_WORKDIR, cleanTitle(body.title || thread.name || thread.preview, thread.cwd || body.cwd || DEFAULT_WORKDIR), statusName(thread.status), opts.permissionMode, opts.approvalPolicy, opts.sandboxMode, opts.model || null, now, account.id]
  );
  await appendEvent(threadId, 'thread/read', { source:'legacy_resume', thread });
  return { session: await getSession(threadId), thread };
});

app.get('/sessions/:id', async (req:any, reply) => {
  const requestId = req.id;
  const startedAt = Date.now();
  const sqliteStartedAt = Date.now();
  const session = await getSession(String(req.params.id));
  if (!session) return reply.code(404).send({ error:'not found' });
  const thread = await threadFromSnapshot(session);
  const sqliteDurationMs = Date.now() - sqliteStartedAt;
  const fresh = await getSession(String(session.id)) || session;
  scheduleThreadReconcile(fresh, 'api_background_thread_read');
  app.log.info({
    requestId,
    localSessionId:fresh.id,
    upstreamThreadId:fresh.upstream_thread_id || fresh.id,
    operation:'GET /sessions/:id',
    sqliteDurationMs,
    totalDurationMs:Date.now() - startedAt,
  }, 'runtime session snapshot returned');
  return { session:fresh, thread, snapshot:{ generation:RUNTIME_GENERATION, coveredSequence:Number(fresh.last_sequence || 0), error:fresh.upstream_status === 'missing' ? 'upstream_missing' : null } };
});

app.patch('/sessions/:id', async (req:any, reply) => {
  const session = await getSession(String(req.params.id));
  if (!session) return reply.code(404).send({ error:'not found' });
  if(typeof req.body?.archived==='boolean'){
    await db.run('UPDATE sessions SET archived=?1,archived_at=?2,updated_at=?3 WHERE id=?4',[req.body.archived?1:0,req.body.archived?Date.now():null,Date.now(),session.id]);
    return{ok:true,session:await getSession(session.id)};
  }
  const title = cleanTitle(req.body?.title, session.project_dir);
  if (!title) return reply.code(400).send({ error:'title required' });
  const account = await getAccount(String(session.current_upstream_account_id || session.last_execution_account_id || session.executing_profile_id || session.account_id || ''));
  if (!account) return reply.code(409).send({ error:'account not found' });
  const runtime = await runtimeForAccount(account.id);
  const threadId = String(session.upstream_thread_id || session.id);
  await db.run('UPDATE sessions SET title=?1, updated_at=?2 WHERE id=?3 OR upstream_thread_id=?3 OR codex_thread_id=?3', [title, Date.now(), session.id]);
  await runtime.request('thread/name/set', { threadId, name:title }).catch(()=>{});
  return { ok:true, session: await getSession(session.id) };
});
app.delete('/sessions/:id',async(req:any,reply)=>{const session=await getSession(String(req.params.id));if(!session)return reply.code(404).send({error:'not found'});if(session.active_turn_id||['running','submitting','planning'].includes(session.status))return reply.code(409).send({error:'turn_running'});deleteSessionRelations(db,session.id);return{ok:true};});

app.get('/sessions/:id/events', async (req:any) => {
  const after = Number(req.query?.after || 0);
  const sessionId = String(req.params.id);
  const events = await eventsAfter(sessionId, after, String(req.query?.includeDeltas || '') === '1');
  const latestSequence = await latestEventSequence(sessionId);
  const nextSequence = events.reduce((max:number, event:any) => Math.max(max, Number(event.sequence || 0)), after);
  return { events, latestSequence, nextSequence, hasMore:nextSequence < latestSequence };
});

app.get('/sessions/:id/subscribe', async (req:any, reply) => {
  const sessionId = String(req.params.id);
  const after = Number(req.query?.after || 0);
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Runtime-Generation':RUNTIME_GENERATION,
  });
  diagnostics.sseConnections++;
  app.log.info({ sessionId, after, activeSubscribers:subscriptions.count(sessionId)+1 }, 'runtime sse subscriber connected');
  reply.raw.on('close', () => {
    diagnostics.sseReconnectCount++;
    app.log.info({ sessionId, activeSubscribers:subscriptions.count(sessionId) }, 'runtime sse subscriber closed');
  });
  await subscriptions.subscribe(sessionId,reply.raw,after,()=>latestEventSequence(sessionId),async (cursor,through)=>(await eventsAfter(sessionId,cursor,true)).filter(event=>Number(event.sequence)<=through) as any);
});

app.post('/sessions/:id/turns', async (req:any, reply) => {
  if (isCandidateMode()) return reply.code(503).header('Retry-After', '5').send(runtimeUnavailableBody(req, 'runtime_candidate'));
  if (isDraining()) return reply.code(503).send(runtimeDrainingBody(req));
  const session = await getSession(String(req.params.id));
  if (!session) return reply.code(404).send({ error:'not found' });
  if (session.provider_id === 'gemini' || session.provider === 'gemini') {
    const body = req.body || {};
    const accountId = String(body.accountId || session.current_upstream_account_id || session.account_id || 'default');
    const previousAccountId = String(session.current_upstream_account_id || session.last_execution_account_id || session.account_id || '');
    const accountSwitched = !!previousAccountId && previousAccountId !== accountId;
    try {
      const input = Array.isArray(body.input) ? body.input : [{ type:'text', text:String(body.text || '') }];
      const prompt = input.map(geminiContentBlock).filter(Boolean);
      if (!prompt.length) return reply.code(400).send({ error:'empty message' });
      const gemini = await geminiManager.get(accountId);
      if (accountSwitched) {
        const context = await geminiRecoveryContextInput(session, previousAccountId, accountId);
        await gemini.createSession({ localSessionId:session.id, cwd:String(body.cwd || session.project_dir), mode:body.permissionMode || session.permission_mode, model:body.model || session.model || null });
        await appendEvent(session.id, 'system', { text:'已切换 Gemini 账户，上游会话已在新账户下重建。', previousAccountId, accountId });
        await db.run('UPDATE sessions SET current_upstream_account_id=?1,last_execution_account_id=?1,account_snapshot_json=?2,updated_at=?3 WHERE id=?4', [accountId, JSON.stringify(body.accountSnapshot || null), Date.now(), session.id]);
        prompt.unshift(context as any);
      } else {
        await gemini.recoverSession(session.id, session.provider_session_id || null, String(body.cwd || session.project_dir),String(body.permissionMode || session.permission_mode));
        await db.run('UPDATE sessions SET current_upstream_account_id=?1,last_execution_account_id=?1,account_snapshot_json=COALESCE(?2,account_snapshot_json),updated_at=?3 WHERE id=?4', [accountId, body.accountSnapshot ? JSON.stringify(body.accountSnapshot) : null, Date.now(), session.id]);
      }
      await appendEvent(session.id, 'user', { input, clientMessageId:String(body.clientMessageId || '') });
      const running = gemini.prompt(session.id, prompt as any[]);
      running.catch(e => app.log.warn({ err:e, sessionId:session.id }, 'gemini prompt failed'));
      return { ok:true, provider:'gemini' };
    } catch (e:any) {
      const message = e?.message || String(e);
      await db.run('UPDATE sessions SET status=?1, active_turn_id=NULL, interruption_reason=?2, updated_at=?3 WHERE id=?4', ['interrupted', 'gemini_turn_start_failed', Date.now(), session.id]);
      await appendEvent(session.id, 'turn/failed', { provider:'gemini', error:{ message } });
      return reply.code(isGeminiAuthenticationErrorMessage(message) ? 409 : 500).send({ error:message, gemini:await geminiManager.status(accountId) });
    }
  }
  if (session.provider_id === 'claude' || session.provider === 'claude') {
    const body = req.body || {};
    const profile = validateClaudeProfileForRuntime(body.profile, body.accountId || session.current_upstream_account_id || session.account_id);
    const previousProfileId = String(session.current_upstream_account_id || session.last_execution_account_id || session.account_id || '');
    const profileSwitched = !!previousProfileId && previousProfileId !== profile.id;
    const input = Array.isArray(body.input) ? body.input : [{ type:'text', text:String(body.text || '') }];
    const text = String(body.text || input.map((x:any)=>x?.text || '').filter(Boolean).join('\n\n'));
    if (!text.trim() && !input.length) return reply.code(400).send({ error:'empty message' });
    const turnId = String(body.turnId || crypto.randomUUID());
    await db.run('UPDATE sessions SET selected_profile_id=?1,executing_profile_id=?1,current_upstream_account_id=?1,last_execution_account_id=?1,account_snapshot_json=COALESCE(?2,account_snapshot_json),updated_at=?3 WHERE id=?4', [profile.id, body.accountSnapshot ? JSON.stringify(body.accountSnapshot) : null, Date.now(), session.id]);
    await appendEvent(session.id, 'user', { input, clientMessageId:String(body.clientMessageId || ''), provider:'claude', profileId:profile.id, profileSwitched });
    if (profileSwitched) await appendEvent(session.id, 'system', { provider:'claude', text:'已切换 Claude Code profile；下一轮使用本地历史在新 profile 下继续。', previousProfileId, profileId:profile.id });
    const permissionMode = claudePermissionMode(body.permissionMode || session.permission_mode);
    const task = claudeManager.startTurn({
      localSessionId:session.id,
      cwd:String(body.cwd || session.project_dir),
      text,
      input,
      model:body.model || session.model || null,
      permissionMode,
      resume:profileSwitched ? null : session.provider_session_id || session.upstream_thread_id || null,
      profile,
      turnId,
    });
    task.catch(e => app.log.warn({ provider:'claude', sessionId:session.id, error:e?.message || String(e) }, 'claude turn failed'));
    return { ok:true, provider:'claude' };
  }
  const body = req.body || {};
  const accountId = String(body.accountId || '').trim();
  if (!accountId) return reply.code(409).send({ code:'codex_executing_profile_required', message:'Codex 继续会话需要明确的 executingProfileId', canContinueSession:false });
  const previousAccountId = String(session.current_upstream_account_id || session.last_execution_account_id || session.account_id || '');
  const accountSwitched = !!previousAccountId && previousAccountId !== accountId;
  const account = await getOrEnsureCodexTurnAccount(accountId, body.codexHome);
  if (!account) return reply.code(409).send({ code:'codex_executing_profile_not_found', message:'当前 Codex 账户无法执行会话', canContinueSession:false });
  const runtime = await runtimeForAccount(account.id);
  const opts = turnOptions({ ...session, ...body });
  const input = Array.isArray(body.input) ? body.input : [{ type:'text', text:String(body.text || ''), text_elements:[] }];
  const cwd = String(body.cwd || session.project_dir);
  app.log.info({
    localSessionId:session.id,
    creatorProfileId:session.creator_profile_id || session.account_id || null,
    selectedProfileId:body.executionContext?.selectedProfileId || accountId,
    executingProfileId:accountId,
    upstreamBindingProfileId:session.upstream_binding_profile_id || session.current_upstream_account_id || null,
    providerSessionId:session.provider_session_id || session.upstream_thread_id || session.codex_thread_id || session.id,
    appServerUnit:systemdUnitName(accountId),
    endpoint:`ws://127.0.0.1:${portForAccount(accountId)}`,
    codexHome:account.codex_home,
    account:body.accountSnapshot || null,
    accountSwitched,
  }, 'codex runtime turn execution profile resolved');
  const live = await ensureLiveThread(session, runtime, opts, cwd, accountSwitched);
  const threadId = live.threadId;
  const codexInput = live.recovered ? [await recoveryContextInput(session), ...input] : input;
  await db.run(
    `UPDATE sessions
     SET selected_profile_id=?1,executing_profile_id=?2,upstream_binding_profile_id=?2,last_execution_account_id=?2,current_upstream_account_id=?2,account_snapshot_json=COALESCE(?3,account_snapshot_json),updated_at=?4
     WHERE id=?5`,
    [body.executionContext?.selectedProfileId || accountId, accountId, body.accountSnapshot ? JSON.stringify(body.accountSnapshot) : null, Date.now(), session.id]
  );
  await appendEvent(session.id, 'user', {
    input,
    clientMessageId:String(body.clientMessageId || ''),
    selectedProfileId:body.executionContext?.selectedProfileId || accountId,
    executingProfileId:accountId,
    upstreamBindingProfileId:accountId,
    providerThreadId:threadId,
    appServerUnit:systemdUnitName(accountId),
    endpoint:`ws://127.0.0.1:${portForAccount(accountId)}`,
    accountSnapshot:body.accountSnapshot || null,
    accountSwitched,
  });
  await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE id=?3', ['running', Date.now(), session.id]);
  let turn:any;
  try {
    turn = await runtime.request('turn/start', withModel({
      threadId,
      cwd,
      approvalPolicy:opts.approvalPolicy,
      sandboxPolicy:{ type:sandboxPolicyType(opts.sandboxMode) },
      input:codexInput,
    }, opts));
  } catch (e:any) {
    const message = e?.message || String(e);
    if (isMissingUpstreamThreadError(message)) {
      await markUpstreamMissing(session, threadId, message);
      const rebuilt = await createReplacementThread(session, runtime, opts, cwd, threadId, message);
      const retryInput = rebuilt.recovered ? [await recoveryContextInput(session), ...input] : input;
      try {
        turn = await runtime.request('turn/start', withModel({
          threadId:rebuilt.threadId,
          cwd,
          approvalPolicy:opts.approvalPolicy,
          sandboxPolicy:{ type:sandboxPolicyType(opts.sandboxMode) },
          input:retryInput,
        }, opts));
      } catch (retryError:any) {
        const retryMessage = retryError?.message || String(retryError);
        await db.run('UPDATE sessions SET status=?1, active_turn_id=NULL, interruption_reason=?2, updated_at=?3 WHERE id=?4', ['interrupted', 'turn_start_failed', Date.now(), session.id]);
        await appendEvent(session.id, 'turn/failed', { threadId:rebuilt.threadId, error:{ message:retryMessage }, source:'runtime' });
        return reply.code(500).send({ error:retryMessage });
      }
    } else {
    await db.run('UPDATE sessions SET status=?1, active_turn_id=NULL, interruption_reason=?2, updated_at=?3 WHERE id=?4', ['interrupted', 'turn_start_failed', Date.now(), session.id]);
    await appendEvent(session.id, 'turn/failed', { threadId, error:{ message }, source:'runtime' });
    return reply.code(message.includes('thread not found') ? 409 : 500).send({ error:message });
    }
  }
  if (turn?.turn?.id) await db.run('UPDATE sessions SET active_turn_id=?1, status=?2, updated_at=?3 WHERE id=?4', [String(turn.turn.id), 'running', Date.now(), session.id]);
  await appendEvent(session.id, 'turn/start', { result:turn, source:'runtime' });
  return { turn };
});

app.post('/sessions/:id/stop', async (req:any, reply) => {
  const session = await getSession(String(req.params.id));
  if (!session) return reply.code(404).send({ error:'not found' });
  if (session.provider_id === 'gemini' || session.provider === 'gemini') return (await geminiManager.get(String(session.current_upstream_account_id || session.last_execution_account_id || session.account_id || 'default'))).cancel(session.id);
  if (session.provider_id === 'claude' || session.provider === 'claude') return claudeManager.cancel(session.id);
  if (!session.active_turn_id) return { ok:true, alreadyStopped:true };
  const account = await getAccount(String(session.current_upstream_account_id || session.last_execution_account_id || session.executing_profile_id || session.account_id || ''));
  if (!account) return reply.code(409).send({ error:'account not found' });
  const runtime = await runtimeForAccount(account.id);
  const turnId = session.active_turn_id;
  let warning:string|null = null;
  try {
    await runtime.request('turn/interrupt', { threadId:session.upstream_thread_id || session.id, turnId }, 10_000);
  } catch (e:any) {
    warning = e?.message || String(e);
  }
  await db.run('UPDATE sessions SET status=?1, active_turn_id=NULL, interruption_reason=?2, updated_at=?3 WHERE id=?4', ['interrupted', 'manual_stop', Date.now(), session.id]);
  await appendEvent(session.id, 'turn/interrupted', { reason:'manual_stop', turnId, warning });
  return { ok:true, interrupted:!warning, warning };
});

await app.listen({ host:HOST, port:PORT });
runtimeLifecycle = 'accepting';
app.log.info({ host:HOST, port:PORT, db:DB_FILE, instanceId:INSTANCE_ID, lifecycle:runtimeLifecycle }, 'agentdeck-runtime listening');
process.once('SIGTERM', () => { shutdownGracefully('SIGTERM').catch(e => { app.log.error({ err:e }, 'runtime graceful shutdown failed'); process.exit(1); }); });
process.once('SIGINT', () => { shutdownGracefully('SIGINT').catch(e => { app.log.error({ err:e }, 'runtime graceful shutdown failed'); process.exit(1); }); });
if (process.env.SKIP_RUNTIME_BOOTSTRAP !== '1') {
  setTimeout(() => bootstrapRuntimeRecovery().catch(e => app.log.error({ err:e }, 'runtime bootstrap recovery failed')), 50);
}
setInterval(() => {
  db.run('UPDATE runtime_instances SET heartbeat_at=?1 WHERE instance_id=?2', [Date.now(), INSTANCE_ID]).catch(()=>{});
}, 5000).unref();

async function initRuntimeSchema() {
  await db.run('CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, codex_home TEXT, runtime_instance_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
  await db.run('CREATE TABLE IF NOT EXISTS runtime_instances (instance_id TEXT PRIMARY KEY, pid INTEGER, started_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL)');
  await db.run("CREATE TABLE IF NOT EXISTS claude_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, profile_dir TEXT NOT NULL UNIQUE, config_dir TEXT NOT NULL UNIQUE, type TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'not_configured', credential_summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.run("CREATE TABLE IF NOT EXISTS plan_tasks (plan_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, original_user_task TEXT NOT NULL, approved_plan_text TEXT, plan_assistant_message_id TEXT, execution_turn_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, approved_at INTEGER, executed_at INTEGER, cancelled_at INTEGER, provider TEXT, model TEXT, diff_summary TEXT, changed_files_json TEXT, policy_violation TEXT)").catch(()=>{});
  await db.run('CREATE INDEX IF NOT EXISTS plan_tasks_session_status ON plan_tasks(session_id,status,created_at)').catch(()=>{});
  await db.run('INSERT INTO runtime_instances (instance_id,pid,started_at,heartbeat_at) VALUES (?1,?2,?3,?3) ON CONFLICT(instance_id) DO UPDATE SET pid=excluded.pid, heartbeat_at=excluded.heartbeat_at', [INSTANCE_ID, process.pid, Date.now()]);
  await db.run('ALTER TABLE sessions ADD COLUMN provider_id TEXT NOT NULL DEFAULT \'codex\'').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN account_id TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN model_id TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN workspace_path TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN provider_session_id TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN provider TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN upstream_thread_id TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN upstream_generation TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN upstream_status TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN active_turn_id TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN last_sequence INTEGER NOT NULL DEFAULT 0').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN interruption_reason TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN archived_at INTEGER').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN provider_profile_id TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN provider_capabilities TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN provider_metadata TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN last_execution_account_id TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN current_upstream_account_id TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN account_snapshot_json TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN creator_profile_id TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN selected_profile_id TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN executing_profile_id TEXT').catch(()=>{});
  await db.run('ALTER TABLE sessions ADD COLUMN upstream_binding_profile_id TEXT').catch(()=>{});
  await db.run('UPDATE sessions SET archived_at=updated_at WHERE archived=1 AND archived_at IS NULL').catch(()=>{});
  await db.run('ALTER TABLE events ADD COLUMN sequence INTEGER').catch(()=>{});
  await db.run('ALTER TABLE events ADD COLUMN event_type TEXT').catch(()=>{});
  await db.run('ALTER TABLE events ADD COLUMN payload_json TEXT').catch(()=>{});
  await db.run('ALTER TABLE events ADD COLUMN created_at INTEGER').catch(()=>{});
  await db.run('ALTER TABLE events ADD COLUMN event_key TEXT').catch(()=>{});
  await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_sequence ON events(session_id, sequence)');
  await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_key ON events(session_id, event_key)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_events_session_type_sequence ON events(session_id, event_type, sequence)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_upstream_thread_id ON sessions(upstream_thread_id)');
}

function validateClaudeProfileForRuntime(raw:any, fallbackId?:any): ClaudeProfile {
  const id = String(raw?.id || fallbackId || '').trim();
  const profileDir = String(raw?.profileDir || raw?.profile_dir || '').trim();
  const configDir = String(raw?.configDir || raw?.config_dir || '').trim();
  if (!/^[a-f0-9]{16}$/i.test(id) && id !== 'default') throw new Error('bad Claude profile id');
  if (!profileDir || !configDir) throw new Error('Claude profile details required');
  return {
    id,
    name:String(raw?.name || 'Claude Code Account'),
    profileDir,
    configDir,
    type:['existing_cli','setup_token','api_key'].includes(String(raw?.type)) ? raw.type : 'existing_cli',
    active:!!raw?.active,
    status:['not_installed','not_configured','authenticated','invalid_credentials','runtime_unavailable','capability_limited'].includes(String(raw?.status)) ? raw.status : 'authenticated',
    credentialSummary:raw?.credentialSummary || raw?.credential_summary || null,
    createdAt:Number(raw?.createdAt || raw?.created_at || 0),
    updatedAt:Number(raw?.updatedAt || raw?.updated_at || 0),
  };
}

function claudePermissionMode(mode:any) {
  const v = String(mode || '');
  if (v === 'read-only') return 'default';
  if (v === 'workspace-write') return 'acceptEdits';
  if (v === 'plan') return 'plan';
  if (v === 'yolo') return 'bypassPermissions';
  return 'default';
}

function normalizeGeminiProfileId(value:string) {
  const id = String(value || 'default');
  if (id === 'default' || /^[a-f0-9]{16}$/i.test(id)) return id;
  throw new Error('invalid Gemini profile id');
}

function geminiProfileDir(profileId:string) {
  const id = normalizeGeminiProfileId(profileId);
  if (id === 'default') return process.env.GEMINI_PROFILE_ROOT || path.join(DATA_DIR, 'gemini', 'profiles', 'default');
  return path.join(DATA_DIR, 'gemini', 'profiles', id, 'home');
}

async function readGeminiProfileEnv(profileDir:string) {
  const allowed = new Set(['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_CLOUD_PROJECT','GOOGLE_CLOUD_LOCATION','GOOGLE_APPLICATION_CREDENTIALS']);
  const file = path.join(profileDir, 'agentdeck.env');
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch { return {}; }
  const env:Record<string,string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!allowed.has(key)) continue;
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key === 'GOOGLE_APPLICATION_CREDENTIALS') {
      const resolved = path.resolve(profileDir, value);
      const root = realpathSync(profileDir);
      const parent = realpathSync(path.dirname(resolved));
      if (!(parent === root || parent.startsWith(root + path.sep))) continue;
      value = resolved;
    }
    if (value) env[key] = value;
  }
  return env;
}

async function ensureAccount(id:string, codexHome:string) {
  const now = Date.now();
  await db.run(
    `INSERT INTO accounts (id,provider,codex_home,runtime_instance_id,created_at,updated_at)
     VALUES (?1,'codex',?2,?3,?4,?4)
     ON CONFLICT(id) DO UPDATE SET codex_home=excluded.codex_home, runtime_instance_id=excluded.runtime_instance_id, updated_at=excluded.updated_at`,
    [id, codexHome, runtimeInstanceId(id), now]
  );
  return getAccount(id) as Promise<Account>;
}

async function getOrEnsureCodexTurnAccount(id:string, codexHome:any) {
  const existing = await getAccount(id);
  const nextHome = typeof codexHome === 'string' && codexHome.trim() ? String(codexHome) : '';
  if (existing && (!nextHome || existing.codex_home === nextHome)) return existing;
  if (nextHome) return ensureAccount(id, nextHome);
  return null;
}

async function bootstrapRuntimeRecovery() {
  const rows = await db.all(
    `SELECT DISTINCT accounts.*
     FROM accounts
     LEFT JOIN sessions ON sessions.account_id=accounts.id
     WHERE accounts.id='default'
        OR sessions.status IN ('running','active')
        OR sessions.active_turn_id IS NOT NULL
     ORDER BY accounts.updated_at DESC`
  );
  const accounts = rows.length ? rows : [await ensureAccount('default', DEFAULT_CODEX_HOME)];
  for (const row of accounts) {
    const account = row as Account;
    runtimeForAccount(account.id).catch(e => app.log.warn({ err:e, accountId:account.id }, 'account bootstrap failed'));
  }
}

async function getAccount(id:string) {
  return db.get('SELECT * FROM accounts WHERE id=?1', [id]) as Promise<Account | null>;
}

async function runtimeForAccount(accountId:string) {
  const pending = runtimeForAccountInFlight.get(accountId);
  if (pending) return pending;
  const promise = runtimeForAccountOnce(accountId).finally(() => runtimeForAccountInFlight.delete(accountId));
  runtimeForAccountInFlight.set(accountId, promise);
  return promise;
}

async function runtimeForAccountOnce(accountId:string) {
  const account = await getAccount(accountId) || await ensureAccount(accountId, DEFAULT_CODEX_HOME);
  let runtime = runtimes.get(account.id);
  if (!runtime) {
    runtime = new CodexAccountRuntime(account, portForAccount(account.id), db);
    runtime.on('notification', (msg:any) => handleCodexNotification(account, msg).catch(e => app.log.error({ err:e }, 'notification handling failed')));
    runtime.on('request', (msg:any) => handleCodexRequest(runtime!, msg).catch(error => {
      app.log.warn({ err:error, method:msg?.method }, 'codex request guard failed');
      runtime!.respond(msg.id, approvalResponse(String(msg.method || '')));
    }));
    runtime.on('connect', () => setTimeout(() => recoverAccount(account).catch(e => app.log.error({ err:e }, 'initial recovery failed')), 50));
    runtime.on('disconnect', () => markAccountDisconnect(account).catch(()=>{}));
    runtime.on('reconnect', () => recoverAccount(account).catch(e => app.log.error({ err:e }, 'recovery failed')));
    runtime.on('error', e => app.log.warn({ err:e }, 'codex account runtime error'));
    runtimes.set(account.id, runtime);
  }
  await runtime.ensureConnected();
  return runtime;
}

async function handleCodexNotification(account:Account, msg:any) {
  const upstreamThreadId = String(msg.params?.threadId || msg.params?.thread?.id || '');
  if (!upstreamThreadId) return;
  const session = await sessionForThread(upstreamThreadId);
  if (!session) return;
  if (String(msg.method || '').endsWith('/delta') || String(msg.method || '').endsWith('/outputDelta')) diagnostics.deltasReceived++;
  appendEvent(session.id, msg.method, msg).catch(e => app.log.error({ err:e }, 'event append failed'));
  if (msg.method === 'turn/started' && msg.params?.turn?.id) {
    await db.run('UPDATE sessions SET active_turn_id=?1,status=?2,updated_at=?3 WHERE id=?4', [String(msg.params.turn.id), 'running', Date.now(), session.id]);
  }
  if (msg.method === 'thread/status/changed') {
    const rawStatus = rawStatusName(msg.params?.status);
    const nextStatus = rawStatus === 'active' && session.active_turn_id ? 'running' : statusName(rawStatus);
    const nextActiveTurnId = nextStatus === 'running' ? session.active_turn_id : null;
    await db.run('UPDATE sessions SET status=?1,active_turn_id=?2,updated_at=?3 WHERE id=?4', [nextStatus, nextActiveTurnId, Date.now(), session.id]);
  }
  if (msg.method === 'turn/completed') {
    const nextStatus = turnTerminalStatus(msg.params?.turn);
    await db.run('UPDATE sessions SET active_turn_id=NULL,status=?1,interruption_reason=?2,updated_at=?3 WHERE id=?4', [nextStatus, nextStatus === 'interrupted' ? 'turn_failed_or_interrupted' : null, Date.now(), session.id]);
  }
  if (msg.method === 'item/completed' && isFinalAnswerItem(msg.params?.item)) {
    await db.run('UPDATE sessions SET active_turn_id=NULL,status=?1,updated_at=?2 WHERE id=?3', ['idle', Date.now(), session.id]);
  }
}

async function handleCodexRequest(runtime:CodexAccountRuntime, msg:any) {
  const method = String(msg.method || '');
  const threadId = String(msg.params?.threadId || msg.params?.thread?.id || '');
  const session = threadId ? await sessionForThread(threadId) : null;
  if (String(session?.status || '') === 'planning') {
    await db.run(
      `UPDATE plan_tasks
       SET policy_violation=COALESCE(policy_violation || char(10), '') || ?1
       WHERE plan_id=(SELECT plan_id FROM plan_tasks WHERE session_id=?2 AND status='planning' ORDER BY created_at DESC LIMIT 1)`,
      [`Plan mode is read-only. Blocked ${method || 'approval request'}.`, session!.id]
    ).catch(()=>{});
    runtime.respond(msg.id, approvalResponse(method, 'decline'));
    await appendEvent(session!.id, 'system', { text:'Plan mode is read-only. This action is blocked.', provider:'codex', method });
    return;
  }
  runtime.respond(msg.id, approvalResponse(method));
}

async function markAccountDisconnect(account:Account) {
  const rows = await db.all("SELECT id FROM sessions WHERE account_id=?1 AND provider='codex' AND status='running'", [account.id]);
  for (const row of rows) await appendEvent(String(row.id), 'runtime/disconnect', { accountId:account.id, at:Date.now() });
}

async function recoverAccount(account:Account) {
  const runtime = await runtimeForAccount(account.id);
  await reconcileStaleRunningSessions();
  const rows = await db.all("SELECT * FROM sessions WHERE account_id=?1 AND provider='codex' AND (active_turn_id IS NOT NULL OR status NOT IN ('idle','completed','interrupted','archived'))", [account.id]);
  for (const row of rows) {
    const session = row as RuntimeSession;
    const gapStart = Date.now();
    let read:any;
    try {
      const opts = turnOptions(session);
      diagnostics.threadResumeCalls++;
      read = await runtime.request('thread/resume', withModel({
        threadId:session.upstream_thread_id || session.id,
        cwd:session.project_dir,
        approvalPolicy:opts.approvalPolicy,
        sandbox:opts.sandboxMode,
      }, opts));
    } catch (e:any) {
      await db.run('UPDATE sessions SET status=?1, active_turn_id=NULL, interruption_reason=?2, updated_at=?3 WHERE id=?4', ['interrupted', 'runtime_reconnect_failed', Date.now(), session.id]);
      await appendEvent(session.id, 'turn/interrupted', { threadId:session.upstream_thread_id || session.id, turnId:session.active_turn_id || null, reason:`runtime reconnect failed: ${e?.message || e}` });
      continue;
    }
    await appendEvent(session.id, 'runtime/recovering', { accountId:account.id, at:gapStart });
    await reconcileThread(session, read.thread, 'reconnect_thread_read', true);
  }
}

async function reconcileThread(session:RuntimeSession, thread:any, source:string, publishSnapshot = false) {
  const turns = thread?.turns || [];
  const lastTurn = turns[turns.length - 1];
  const hasFinalAnswer = lastTurnHasFinalAnswer(lastTurn);
  const status = reconciledThreadStatus(thread, lastTurn, hasFinalAnswer);
  const activeTurnId = !hasFinalAnswer && lastTurn?.status === 'inProgress' && lastTurn?.id ? String(lastTurn.id) : null;
  const finalStatus = status === 'active' ? 'running' : status;
  await db.run('UPDATE sessions SET status=?1, active_turn_id=?2, interruption_reason=?3, updated_at=?4 WHERE id=?5', [finalStatus, activeTurnId, finalStatus === 'interrupted' ? source : null, Date.now(), session.id]);
  await appendEvent(session.id, publishSnapshot ? 'thread_snapshot' : 'thread/read', { source, thread, status:finalStatus, activeTurnId });
}

function lastTurnHasFinalAnswer(turn:any) {
  return (turn?.items || []).some((item:any) => isFinalAnswerItem(item));
}

function reconciledThreadStatus(thread:any, lastTurn:any, hasFinalAnswer:boolean) {
  if (!lastTurn) return statusName(thread?.status);
  if (hasFinalAnswer) return statusName(thread?.status) === 'running' ? 'idle' : statusName(thread?.status);
  const turnStatus = String(lastTurn.status || '');
  if (turnStatus === 'inProgress') return 'running';
  return 'interrupted';
}

function turnTerminalStatus(turn:any) {
  const status = String(turn?.status || '');
  return status === 'failed' || status === 'interrupted' ? 'interrupted' : 'idle';
}

async function reconcileStaleRunningSessions(id?:string) {
  const cutoff = Date.now() - STALE_RUNNING_MS;
  const rows = await db.all(
    id
      ? "SELECT * FROM sessions WHERE (id=?1 OR upstream_thread_id=?1 OR codex_thread_id=?1) AND provider='codex' AND (active_turn_id IS NOT NULL OR status IN ('running','active'))"
      : "SELECT * FROM sessions WHERE provider='codex' AND (active_turn_id IS NOT NULL OR status IN ('running','active'))",
    id ? [id] : []
  );
  for (const row of rows) {
    const final = await db.get(
      "SELECT sequence FROM events WHERE session_id=?1 AND event_type='item/completed' AND payload_json LIKE '%\"phase\":\"final_answer\"%' ORDER BY sequence DESC LIMIT 1",
      [String(row.id)]
    );
    if (final) {
      await db.run('UPDATE sessions SET status=?1, active_turn_id=NULL, updated_at=?2 WHERE id=?3', ['idle', Date.now(), row.id]);
      continue;
    }
    const last = await db.get('SELECT MAX(created_at) AS ts FROM events WHERE session_id=?1', [String(row.id)]);
    const lastEventAt = Number(last?.ts || row.updated_at || 0);
    if (lastEventAt > cutoff) continue;
    await db.run('UPDATE sessions SET status=?1, active_turn_id=NULL, interruption_reason=?2, updated_at=?3 WHERE id=?4', ['interrupted', 'stale_running_timeout', Date.now(), row.id]);
    await appendEvent(String(row.id), 'turn/interrupted', { threadId:row.upstream_thread_id || row.id, turnId:row.active_turn_id || null, reason:'stale_running_timeout' }).catch(()=>{});
  }
}

async function sessionForThread(upstreamThreadId:string) {
  const cached = threadSessionCache.get(upstreamThreadId);
  if (cached) return cached;
  const row = await db.get('SELECT * FROM sessions WHERE id=?1 OR upstream_thread_id=?1 OR codex_thread_id=?1', [upstreamThreadId]) as RuntimeSession | null;
  if (row) {
    threadSessionCache.set(String(row.id), row);
    if (row.upstream_thread_id) threadSessionCache.set(String(row.upstream_thread_id), row);
    if (row.codex_thread_id) threadSessionCache.set(String(row.codex_thread_id), row);
  }
  return row;
}

async function getSession(id:string) {
  const row = await db.get('SELECT * FROM sessions WHERE id=?1 OR upstream_thread_id=?1 OR codex_thread_id=?1', [id]) as RuntimeSession | null;
  if (row) {
    threadSessionCache.set(String(row.id), row);
    if (row.upstream_thread_id) threadSessionCache.set(String(row.upstream_thread_id), row);
    if (row.codex_thread_id) threadSessionCache.set(String(row.codex_thread_id), row);
  }
  return row;
}

async function ensureLiveThread(session:RuntimeSession, runtime:CodexAccountRuntime, opts:ReturnType<typeof turnOptions>, cwd:string, forceResume = false):Promise<{ threadId:string; recovered:boolean }> {
  const key = `${String(session.upstream_thread_id || session.id)}:${forceResume ? 'force' : 'normal'}`;
  const existing = resumeInFlight.get(key);
  if (existing) return existing;
  const task = ensureLiveThreadUnlocked(session, runtime, opts, cwd, forceResume).finally(() => { resumeInFlight.delete(key); });
  resumeInFlight.set(key, task);
  return task;
}

async function ensureLiveThreadUnlocked(session:RuntimeSession, runtime:CodexAccountRuntime, opts:ReturnType<typeof turnOptions>, cwd:string, forceResume = false):Promise<{ threadId:string; recovered:boolean }> {
  const threadId = String(session.upstream_thread_id || session.id);
  if (!forceResume && session.upstream_status !== 'missing' && session.upstream_generation === RUNTIME_GENERATION) return { threadId, recovered:false };
  if (session.upstream_status === 'missing') return createReplacementThread(session, runtime, opts, cwd, threadId, 'upstream previously marked missing');
  try {
    diagnostics.threadResumeCalls++;
    await runtime.request('thread/resume', withModel({
      threadId,
      cwd,
      approvalPolicy:opts.approvalPolicy,
      sandbox:opts.sandboxMode,
    }, opts));
    await db.run('UPDATE sessions SET upstream_generation=?1, upstream_status=?2, updated_at=?3 WHERE id=?4 AND COALESCE(upstream_thread_id,id)=?5', [RUNTIME_GENERATION, 'attached', Date.now(), session.id, threadId]);
    return { threadId, recovered:false };
  } catch (e:any) {
    const message = e?.message || String(e);
    if (!isMissingUpstreamThreadError(message)) throw e;
    await markUpstreamMissing(session, threadId, message);
    return createReplacementThread(session, runtime, opts, cwd, threadId, message);
  }
}

async function markUpstreamMissing(session:RuntimeSession, threadId:string, reason:string) {
  await db.run('UPDATE sessions SET upstream_status=?1, interruption_reason=?2, updated_at=?3 WHERE id=?4 AND COALESCE(upstream_thread_id,id)=?5', ['missing', 'upstream_missing', Date.now(), session.id, threadId]);
  app.log.warn({ localSessionId:session.id, oldUpstreamThreadId:threadId, fallbackReason:reason, upstreamStatus:'missing' }, 'upstream thread marked missing');
}

async function createReplacementThread(session:RuntimeSession, runtime:CodexAccountRuntime, opts:ReturnType<typeof turnOptions>, cwd:string, oldThreadId:string, reason:string) {
  const fresh = await getSession(session.id);
  const currentThreadId = String(fresh?.upstream_thread_id || session.upstream_thread_id || session.id);
  if (currentThreadId !== oldThreadId && fresh?.upstream_status !== 'missing') return { threadId:currentThreadId, recovered:false };
  diagnostics.threadStartCalls++;
  const started = await runtime.request('thread/start', withModel({
    cwd,
    approvalPolicy:opts.approvalPolicy,
    sandbox:opts.sandboxMode,
  }, opts));
  const nextThreadId = String(started?.thread?.id || '');
  if (!nextThreadId) throw new Error(`replacement thread/start did not return a thread id after ${reason}`);
  const now = Date.now();
  const updated = await db.get(
    `UPDATE sessions
     SET upstream_thread_id=?1, upstream_generation=?2, upstream_status=?3, updated_at=?4
     WHERE id=?5 AND (COALESCE(upstream_thread_id,id)=?6 OR upstream_status='missing')
     RETURNING upstream_thread_id`,
    [nextThreadId, RUNTIME_GENERATION, 'rebuilt', now, session.id, oldThreadId]
  );
  if (!updated) {
    const latest = await getSession(session.id);
    return { threadId:String(latest?.upstream_thread_id || oldThreadId), recovered:false };
  }
  threadSessionCache.delete(oldThreadId);
  threadSessionCache.set(nextThreadId, { ...(fresh || session), upstream_thread_id:nextThreadId, upstream_generation:RUNTIME_GENERATION, upstream_status:'rebuilt' } as RuntimeSession);
  app.log.warn({
    localSessionId:session.id,
    oldUpstreamThreadId:oldThreadId,
    newUpstreamThreadId:nextThreadId,
    fallbackReason:reason,
    upstreamStatus:'rebuilt',
  }, 'upstream thread replacement persisted');
  await appendEvent(session.id, 'thread_recovered_with_new_upstream', {
    oldUpstreamThreadId:oldThreadId,
    newUpstreamThreadId:nextThreadId,
    fallbackReason:reason,
    upstreamStatus:'rebuilt',
    warning:'上游会话已重建，部分模型上下文可能丢失',
  });
  return { threadId:nextThreadId, recovered:true };
}

async function recoveryContextInput(session:RuntimeSession) {
  const recent = await recentConversationSummary(session.id, 12);
  return {
    type:'text',
    text:[
      RECOVERY_CONTEXT_MARKER,
      'The upstream Codex thread was recreated because its rollout was unavailable.',
      'Continue the same local mobile session using this recovery context. Do not repeat this context verbatim to the user.',
      `Project path: ${session.project_dir}`,
      `Local session title: ${session.title}`,
      recent ? `Recent visible conversation:\n${recent}` : 'No prior visible conversation could be reconstructed from runtime events.',
    ].join('\n\n'),
    text_elements:[],
  };
}

async function geminiRecoveryContextInput(session:RuntimeSession, previousAccountId:string, accountId:string) {
  const recent = await recentConversationSummary(session.id, 16);
  return {
    type:'text',
    text:[
      RECOVERY_CONTEXT_MARKER,
      'The AgentDeck Gemini upstream ACP session was recreated because the current execution account changed.',
      'Continue the same local AgentDeck conversation using this local visible history. Do not repeat this context verbatim to the user.',
      `Project path: ${session.project_dir}`,
      `Local session title: ${session.title}`,
      `Previous execution account id: ${previousAccountId}`,
      `Current execution account id: ${accountId}`,
      recent ? `Recent visible conversation:\n${recent}` : 'No prior visible conversation could be reconstructed from runtime events.',
    ].join('\n\n'),
    text_elements:[],
  };
}

async function recentConversationSummary(sessionId:string, limit:number) {
  const rows = await db.all(
    `SELECT event_type,payload_json FROM events
     WHERE session_id=?1
       AND event_type IN ('user','item/completed')
     ORDER BY sequence DESC
     LIMIT ?2`,
    [sessionId, limit * 3]
  );
  const lines:string[] = [];
  for (const row of rows.reverse()) {
    let payload:any = {};
    try { payload = JSON.parse(String(row.payload_json || '{}')); } catch {}
    if (row.event_type === 'user') {
      const text = visibleInputText(payload.input || []);
      if (text) lines.push(`User: ${text.slice(0, 1200)}`);
    }
    const item = payload?.params?.item;
    if (row.event_type === 'item/completed' && item?.type === 'agentMessage' && item?.phase === 'final_answer') {
      const text = String(item.text || '').trim();
      if (text) lines.push(`Assistant: ${text.slice(0, 1600)}`);
    }
  }
  return lines.slice(-limit).join('\n\n');
}

async function readAuthoritativeThread(session:RuntimeSession) {
  const account = await getAccount(String(session.current_upstream_account_id || session.last_execution_account_id || session.executing_profile_id || session.account_id || ''));
  if (!account) throw new Error('account not found');
  const runtime = await runtimeForAccount(account.id);
  const threadId = String(session.upstream_thread_id || session.id);
  try {
    return await runtime.request('thread/read', { threadId, includeTurns:true }, 30_000);
  } catch {
    const opts = turnOptions(session);
    await runtime.request('thread/resume', withModel({
      threadId,
      cwd:session.project_dir,
      approvalPolicy:opts.approvalPolicy,
      sandbox:opts.sandboxMode,
    }, opts), 30_000);
    return runtime.request('thread/read', { threadId, includeTurns:true }, 30_000);
  }
}

function threadFromSession(session:RuntimeSession) {
  return {
    id: session.upstream_thread_id || session.id,
    name: session.title,
    preview: session.title,
    cwd: session.project_dir,
    status: { type: session.status || 'idle' },
    createdAt: Math.floor(Number(session.created_at || Date.now()) / 1000),
    updatedAt: Math.floor(Number(session.updated_at || Date.now()) / 1000),
    turns: [],
    path: null,
  };
}

async function threadFromSnapshot(session:RuntimeSession) {
  const rows = await eventsAfter(session.id, 0, false);
  const items:any[] = [];
  for (const event of rows) {
    const eventType = String(event.event_type || '');
    let payload:any = {};
    try { payload = JSON.parse(String(event.payload_json || '{}')); } catch {}
    if (eventType === 'user') {
      const input = Array.isArray(payload?.input) ? payload.input : [];
      const content = input
        .filter((item:any) => item?.type === 'text' && String(item.text || '').trim())
        .map((item:any) => ({ type:'text', text:stripProviderOnlyRecoveryText(String(item.text || '')).trim() }))
        .filter((item:any) => item.text);
      if (content.length) items.push({ id:`user-${event.sequence}`, type:'userMessage', content });
      continue;
    }
    if (eventType === 'item/completed') {
      const item = payload?.params?.item || payload?.item;
      if (item && ['userMessage','agentMessage','imageView','imageGeneration','artifact'].includes(String(item.type))) items.push(compactSnapshotItem(item));
      continue;
    }
    if (eventType === 'turn/failed' || eventType === 'turn/interrupted') {
      const reason = payload?.reason || payload?.params?.reason || payload?.error?.message || payload?.params?.error?.message || '';
      items.push({ id:`${eventType}-${event.sequence}`, type:'agentMessage', text:eventType === 'turn/failed' ? `请求失败：${reason || 'turn failed'}` : '已停止生成', phase:'final_answer' });
      continue;
    }
    if (eventType === 'thread_recovered_with_new_upstream') {
      items.push({ id:`upstream-rebuilt-${event.sequence}`, type:'agentMessage', text:String(payload?.warning || '上游会话已重建，部分模型上下文可能丢失'), phase:'final_answer' });
    }
  }
  return { ...threadFromSession(session), turns:items.length ? [{ id:`snapshot-${session.id}`, items }] : [] };
}

function compactSnapshotItem(item:any) {
  if (!item || typeof item !== 'object') return item;
  const next = { ...item };
  if (next.type === 'userMessage' && Array.isArray(next.content)) {
    next.content = next.content
      .map((part:any) => typeof part?.text === 'string' ? { ...part, text:stripProviderOnlyRecoveryText(part.text) } : part)
      .filter((part:any) => typeof part?.text !== 'string' || part.text.trim());
  }
  if (typeof next.text === 'string' && next.text.length > 80_000) next.text = `${next.text.slice(0, 80_000)}\n\n[output truncated for mobile snapshot]`;
  if (Array.isArray(next.content)) {
    next.content = next.content.map((part:any) => typeof part?.text === 'string' && part.text.length > 80_000 ? { ...part, text:`${part.text.slice(0, 80_000)}\n\n[output truncated for mobile snapshot]` } : part);
  }
  return next;
}

function scheduleThreadReconcile(session:RuntimeSession, source:string) {
  if (session.upstream_status === 'missing') return;
  const key = String(session.id);
  const now = Date.now();
  if ((lastReconcileAt.get(key) || 0) + 15_000 > now) return;
  if (reconcileInFlight.has(key)) return;
  lastReconcileAt.set(key, now);
  const task = (async () => {
    try {
      const read = await readAuthoritativeThread(session);
      if (read?.thread) await reconcileThread(session, read.thread, source, true);
    } catch (e:any) {
      const message = e?.message || String(e);
      if (isMissingUpstreamThreadError(message)) {
        await markUpstreamMissing(session, String(session.upstream_thread_id || session.id), message);
        return;
      }
      app.log.warn({ localSessionId:session.id, upstreamThreadId:session.upstream_thread_id || session.id, error:message }, 'background thread reconcile failed');
    }
  })().finally(() => { reconcileInFlight.delete(key); });
  reconcileInFlight.set(key, task);
}

async function appendEvent(sessionId:string, eventType:string, payload:any) {
  const startedAt = Date.now();
  if (isProviderOnlyRecoveryEvent(eventType, payload)) {
    app.log.warn({ sessionId, eventType }, 'provider-only recovery context event suppressed');
    return { session_id:sessionId, sequence:await latestEventSequence(sessionId), event_type:eventType, payload_json:'{}', created_at:Date.now(), suppressed:true };
  }
  const eventKey = eventKeyFor(eventType, payload);
  if (eventKey) {
    const existing = await db.get('SELECT sequence FROM events WHERE session_id=?1 AND event_key=?2', [sessionId, eventKey]);
    if (existing) return { session_id:sessionId, sequence:Number(existing.sequence || 0), event_type:eventType, payload_json:JSON.stringify(payload), created_at:Date.now(), duplicate:true };
  }
  const event = await eventStore.append(sessionId,eventType,payload,eventKey,isCriticalEvent(eventType),isDeltaEvent(eventType));
  diagnostics.sqliteBatches=eventStore.metrics.sqliteBatches;
  diagnostics.sqliteRows=eventStore.metrics.sqliteRows;
  diagnostics.sqliteMs=eventStore.metrics.sqliteMs;
  diagnostics.runtimePendingPushCount=subscriptions.pendingPushCount;
  if (isDeltaEvent(eventType)) diagnostics.deltasSsePushed += subscriptions.count(sessionId);
  if (isDeltaEvent(eventType) || eventType === 'turn/completed' || eventType === 'item/completed') {
    app.log.info({ localSessionId:sessionId, operation:'runtime durable append and SSE push', eventType, runtimePendingPushCount:subscriptions.pendingPushCount, activeSseSubscriberCount:subscriptions.count(sessionId), durationMs:Date.now() - startedAt }, 'runtime event committed');
  }
  return event;
}

function isProviderOnlyRecoveryEvent(eventType:string, payload:any) {
  if (eventType === 'user') return inputHasProviderOnlyRecovery(payload?.input);
  if (eventType === 'item/completed') {
    const item = payload?.params?.item || payload?.item;
    return item?.type === 'userMessage' && itemHasProviderOnlyRecovery(item);
  }
  return false;
}

function inputHasProviderOnlyRecovery(input:any) {
  return Array.isArray(input) && input.some((item:any) => item?.type === 'text' && isProviderOnlyRecoveryText(item.text));
}

function itemHasProviderOnlyRecovery(item:any) {
  if (isProviderOnlyRecoveryText(item?.text)) return true;
  return Array.isArray(item?.content) && item.content.some((part:any) => part?.type === 'text' && isProviderOnlyRecoveryText(part.text));
}

function isProviderOnlyRecoveryText(text:any) {
  return String(text || '').includes(RECOVERY_CONTEXT_MARKER);
}

function stripProviderOnlyRecoveryText(text:string) {
  return isProviderOnlyRecoveryText(text) ? '' : String(text || '');
}

function visibleInputText(input:any) {
  return (Array.isArray(input) ? input : [])
    .filter((x:any)=>x?.type === 'text')
    .map((x:any)=>stripProviderOnlyRecoveryText(String(x.text || '')).trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function flushDeltaEvents(sessionId:string) {
  await eventStore.flush(sessionId);
}

function isDeltaEvent(eventType:string) {
  return eventType === 'item/agentMessage/delta' || eventType === 'item/commandExecution/outputDelta';
}

function isCriticalEvent(eventType:string) {
  return eventType === 'user'
    || eventType === 'turn/start'
    || eventType === 'turn/started'
    || eventType === 'turn/completed'
    || eventType === 'turn/failed'
    || eventType === 'turn/interrupted'
    || eventType === 'thread/status/changed'
    || eventType === 'thread_snapshot'
    || eventType === 'runtime/disconnect'
    || eventType === 'runtime/recovering'
    || eventType === 'thread_recovered_with_new_upstream'
    || eventType === 'output_gap'
    || eventType === 'item/completed';
}

function isTerminalEvent(eventType:string) {
  return eventType === 'turn/completed'
    || eventType === 'turn/failed'
    || eventType === 'turn/interrupted'
    || eventType === 'item/completed';
}

async function ensureCodexHomeSharedDirs(codexHome:string) {
  await mkdir(codexHome, { recursive:true });
  realpathSync(codexHome);
  realpathSync(DATA_DIR);
  await mkdir(SHARED_SESSIONS_DIR, { recursive:true });
  await mkdir(SHARED_GENERATED_IMAGES_DIR, { recursive:true });
  await ensureSharedDirLink(codexHome, 'sessions', SHARED_SESSIONS_DIR);
  await ensureSharedDirLink(codexHome, 'generated_images', SHARED_GENERATED_IMAGES_DIR);
}

async function ensureSharedDirLink(codexHome:string, name:string, sharedDir:string) {
  const localDir = path.join(codexHome, name);
  const existing = await lstat(localDir).catch(()=>null);
  if (existing?.isSymbolicLink()) {
    let target = '';
    try { target = realpathSync(localDir); } catch {}
    if (target === realpathSync(sharedDir)) return;
    const linkTarget = await readlink(localDir).catch(()=>'');
    app.log.warn({ codexHome, name, linkTarget, expected:sharedDir }, 'repairing codex shared directory symlink');
    await rm(localDir, { force:true });
  } else if (existing?.isDirectory()) {
    if (realpathSync(localDir) === realpathSync(sharedDir)) return;
    await cp(localDir, sharedDir, { recursive:true, force:false, errorOnExist:false }).catch(()=>{});
    await rm(localDir, { recursive:true, force:true });
  } else if (existing) {
    await rm(localDir, { force:true });
  }
  await symlink(sharedDir, localDir, 'dir');
}

function q(value:any) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}
function eventKeyFor(eventType:string, payload:any) {
  if (eventType === 'item/commandExecution/outputDelta' || eventType === 'item/agentMessage/delta') return null;
  const item = payload?.params?.item || payload?.item;
  const threadId = payload?.params?.threadId || payload?.threadId || payload?.thread?.id || '';
  const turnId = payload?.params?.turnId || payload?.params?.turn?.id || payload?.turn?.id || '';
  if (eventType === 'turn/interrupted') return `${eventType}:${threadId}:${turnId || payload?.turnId || ''}`;
  if (item?.id) return `${eventType}:${threadId}:${turnId}:${item.id}:${item.type || ''}`;
  if (eventType === 'turn/started' || eventType === 'turn/completed' || eventType === 'turn/failed') return `${eventType}:${threadId}:${turnId}`;
  if (eventType === 'thread/status/changed') return null;
  if (eventType === 'thread/read' || eventType === 'output_gap') return null;
  return null;
}

async function eventsAfter(sessionId:string, after:number, includeDeltas = false) {
  const decorate = (rows:any[]) => rows.map(row => ({ ...row, threadId:sessionId, generation:RUNTIME_GENERATION }));
  if (after <= 0) {
    return decorate(await db.all(
      `SELECT session_id,sequence,event_type,payload_json,created_at
       FROM (
         SELECT session_id,sequence,event_type,payload_json,created_at FROM (
           SELECT session_id,sequence,event_type,payload_json,created_at
           FROM events
           WHERE session_id=?1
             AND event_type IN ('user','turn/failed','turn/interrupted','thread_recovered_with_new_upstream','runtime/disconnect','runtime/recovering','thread_snapshot')
           ORDER BY sequence DESC
           LIMIT 80
         )
         UNION ALL
         SELECT session_id,sequence,event_type,payload_json,created_at FROM (
           SELECT session_id,sequence,event_type,payload_json,created_at
           FROM events
           WHERE session_id=?1
             AND event_type='item/completed'
             AND length(payload_json)<300000
             AND (
               payload_json LIKE '%"type":"agentMessage"%'
               OR payload_json LIKE '%"type":"userMessage"%'
               OR payload_json LIKE '%"type":"imageView"%'
               OR payload_json LIKE '%"type":"imageGeneration"%'
               OR payload_json LIKE '%"type":"artifact"%'
             )
           ORDER BY sequence DESC
           LIMIT 80
         )
         UNION ALL
         SELECT session_id,sequence,event_type,payload_json,created_at FROM (
           SELECT session_id,sequence,event_type,payload_json,created_at
           FROM events
           WHERE ?2=1
             AND session_id=?1
             AND event_type IN ('item/agentMessage/delta','turn/completed','turn/started')
           ORDER BY sequence DESC
           LIMIT 80
         )
       )
       ORDER BY sequence ASC`,
      [sessionId, includeDeltas ? 1 : 0]
    ));
  }
  return decorate(await db.all(
    `SELECT session_id,sequence,event_type,payload_json,created_at
     FROM events
     WHERE session_id=?1
       AND COALESCE(sequence,0)>?2
       AND event_type<>'thread/read'
     ORDER BY sequence ASC
     LIMIT 1000`,
    [sessionId, after]
  ));
}
async function latestEventSequence(sessionId:string) {
  const row = await db.get('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE session_id=?1', [sessionId]);
  return Number(row?.sequence || 0);
}

function turnOptions(body:any) {
  const permissionMode = normalizeMode(body.permission_mode || body.permissionMode || body.mode) || 'yolo';
  if (String(body.planMode || '') === 'plan') {
    return {
      permissionMode:'read-only',
      approvalPolicy:'on-request',
      sandboxMode:'read-only',
      model:cleanModel(body.model),
    };
  }
  const fields = modeFields(permissionMode);
  return {
    permissionMode,
    approvalPolicy:String(body.approvalPolicy || body.approval_policy || fields.approval_policy),
    sandboxMode:String(body.sandboxMode || body.sandbox_mode || fields.sandbox_mode),
    model:cleanModel(body.model),
  };
}

function withModel<T extends Record<string, any>>(params:T, opts:{ model?:string | null }) {
  if (opts.model) (params as any).model = opts.model;
  return params;
}

function modeFields(mode:string) {
  if (mode === 'read-only') return { approval_policy:'on-request', sandbox_mode:'read-only' };
  if (mode === 'workspace-write') return { approval_policy:'on-request', sandbox_mode:'workspace-write' };
  return { approval_policy:'never', sandbox_mode:'danger-full-access' };
}

function normalizeMode(value:any) {
  const v = String(value || '');
  return ['read-only','workspace-write','yolo'].includes(v) ? v : null;
}

function sandboxPolicyType(mode:string) {
  if (mode === 'read-only') return 'readOnly';
  if (mode === 'workspace-write') return 'workspaceWrite';
  return 'dangerFullAccess';
}

function statusName(status:any) {
  if (!status) return 'idle';
  const value = rawStatusName(status);
  return value === 'active' ? 'idle' : value;
}

function rawStatusName(status:any) {
  if (!status) return 'idle';
  return typeof status === 'string' ? status : status.type || 'idle';
}

function isMissingUpstreamThreadError(message:string) {
  return /no rollout found|thread not found|invalid thread id/i.test(message);
}

function isFinalAnswerItem(item:any) {
  return item?.type === 'agentMessage' && item?.phase === 'final_answer' && String(item?.text || '').trim();
}

function approvalResponse(method:string, decision:'accept'|'decline' = 'accept') {
  if (method.includes('permissions')) return decision === 'decline'
    ? { permissions:{}, scope:'turn' }
    : { permissions:{ network:null, fileSystem:null }, scope:'session' };
  if (method.includes('fileChange')) return { decision };
  return { decision };
}

function cleanModel(value:any) {
  const v = String(value || '').trim();
  return /^[A-Za-z0-9_.:/@+\-() ]{1,120}$/.test(v) ? v : null;
}

function cleanTitle(value:any, cwd:string) {
  const raw = String(value || '').split(/\r?\n/)[0].trim();
  return (raw || path.basename(cwd)).slice(0, 120);
}

async function updateRuntimeSession(sessionId:string, values:Record<string, string | number | null>) {
  const entries = Object.entries(values);
  if (!entries.length) return;
  const assignments = entries.map(([key], index) => `${key}=?${index + 1}`).join(',');
  await db.run(`UPDATE sessions SET ${assignments} WHERE id=?${entries.length + 1} OR codex_thread_id=?${entries.length + 1}`, [...entries.map(([, value]) => value), sessionId]);
}

function geminiContentBlock(item:any) {
  if (item?.type === 'text') return { type:'text', text:String(item.text || '') };
  if (item?.type === 'localImage' && item.path) {
    const filePath = String(item.path);
    const mimeType = mimeFromPath(filePath) || 'application/octet-stream';
    if (mimeType.startsWith('image/')) {
      try {
        return { type:'image', data:readFileSync(filePath).toString('base64'), mimeType, uri:`file://${filePath}` };
      } catch {
        return { type:'resource_link', name:path.basename(filePath), uri:`file://${filePath}`, mimeType };
      }
    }
    return { type:'resource_link', name:path.basename(filePath), uri:`file://${filePath}`, mimeType };
  }
  return null;
}

function isGeminiAuthenticationErrorMessage(message:string) {
  return /\b(unauthenticated|unauthorized|authentication required|not authenticated|not logged in|login required|requires login|invalid credentials|invalid_grant|api key.*invalid|permission denied)\b/i.test(String(message || ''));
}

function classifyGeminiSessionCreateError(e:any) {
  const safeDetail = redactRuntimeError(e?.message || String(e));
  if (/no longer supported|migrate to the Antigravity suite|Gemini Code Assist for individuals/i.test(safeDetail)) {
    return {
      statusCode: 409,
      code: 'gemini_client_unsupported',
      message: '当前 Gemini CLI 不再支持该个人账号创建会话',
      safeDetail,
    };
  }
  if (isGeminiAuthenticationErrorMessage(safeDetail)) {
    return {
      statusCode: 409,
      code: 'gemini_needs_login',
      message: '请先登录 Gemini',
      safeDetail,
    };
  }
  return {
    statusCode: 502,
    code: 'gemini_session_create_failed',
    message: 'Gemini 会话初始化失败',
    safeDetail,
  };
}

function redactRuntimeError(message:string) {
  return String(message || 'Gemini request failed')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-api-key]')
    .replace(/(access_token|refresh_token|id_token|client_secret|authorization code)\s*[:=]\s*[^\s]+/ig, '$1=[redacted]');
}
function isDraining() {
  expireRuntimeDrain();
  return runtimeLifecycle === 'draining' || runtimeLifecycle === 'stopping';
}
function isCandidateMode() {
  return RUNTIME_MODE === 'candidate';
}
function runtimeDrainingBody(req:any) {
  return {
    error:'runtime_draining',
    code:'runtime_draining',
    retryable:true,
    lifecycle:runtimeLifecycle,
    message:'Runtime 正在准备重启，请稍后重试。',
    requestId:String(req?.id || ''),
  };
}
function runtimeUnavailableBody(req:any, code:string) {
  return {
    error:code,
    code,
    retryable:true,
    mode:RUNTIME_MODE,
    lifecycle:runtimeLifecycle,
    message:code === 'runtime_candidate' ? '候选 Runtime 不接收真实任务。' : 'Runtime 当前不可接收新任务。',
    requestId:String(req?.id || ''),
  };
}
function expireRuntimeDrain() {
  if (runtimeLifecycle === 'draining' && drainExpiresAt && Date.now() >= drainExpiresAt) {
    runtimeLifecycle = 'accepting';
    app.log.warn({ drainStartedAt, drainExpiresAt }, 'runtime drain lease expired; accepting new turns');
    drainStartedAt = null;
    drainExpiresAt = null;
  }
}
async function startRuntimeDrain(req?:any) {
  expireRuntimeDrain();
  if (runtimeLifecycle === 'stopping') return { lifecycle:runtimeLifecycle, ...(await drainState()) };
  const requestedTtlMs = Number(req?.body?.ttlMs || req?.body?.leaseMs || 0);
  const ttlMs = Number.isFinite(requestedTtlMs) && requestedTtlMs > 0 ? Math.min(requestedTtlMs, DRAIN_TIMEOUT_MS) : DRAIN_LEASE_MS;
  runtimeLifecycle = 'draining';
  drainStartedAt = drainStartedAt || Date.now();
  drainExpiresAt = Date.now() + ttlMs;
  app.log.info({ lifecycle:runtimeLifecycle, drainStartedAt, drainExpiresAt, ttlMs }, 'runtime draining started');
  return { lifecycle:runtimeLifecycle, ...(await drainState()) };
}
async function cancelRuntimeDrain() {
  if (runtimeLifecycle === 'draining') runtimeLifecycle = 'accepting';
  drainStartedAt = null;
  drainExpiresAt = null;
  return { lifecycle:runtimeLifecycle, ...(await drainState()) };
}
async function runtimeAdminState() {
  expireRuntimeDrain();
  const drain = await drainState();
  return {
    mode:RUNTIME_MODE,
    state:runtimeLifecycle === 'accepting' ? 'running' : runtimeLifecycle,
    lifecycle:runtimeLifecycle,
    acceptingNewTurns:runtimeLifecycle === 'accepting' && RUNTIME_MODE === 'active',
    activeTurnCount:drain.activeTurnCount,
    submittingTurnCount:drain.submittingTurnCount,
    instanceId:INSTANCE_ID,
    releaseId:RELEASE_ID,
    commit:RELEASE_COMMIT,
    pid:process.pid,
    port:PORT,
    database:DB_FILE,
    drainStartedAt,
    drainExpiresAt,
    drainTimeoutMs:DRAIN_TIMEOUT_MS,
    drainLeaseMs:DRAIN_LEASE_MS,
  };
}
async function activeTurnDetails() {
  expireRuntimeDrain();
  const rows = await db.all(
    `SELECT id, provider, provider_id, active_turn_id, status, updated_at, created_at
     FROM sessions
     WHERE status IN ('running','active','submitting','planning','waiting_plan_approval','executing_approved_plan') OR active_turn_id IS NOT NULL
     ORDER BY updated_at DESC`
  ).catch(()=>[]);
  return {
    activeTurnCount:rows.length,
    turns:rows.map((row:any) => ({
      sessionId:String(row.id),
      turnId:row.active_turn_id ? String(row.active_turn_id) : null,
      provider:String(row.provider_id || row.provider || 'codex'),
      status:String(row.status || 'unknown'),
      runningMs:Date.now() - Number(row.updated_at || row.created_at || Date.now()),
      updatedAt:Number(row.updated_at || 0),
    })),
  };
}
async function drainState() {
  expireRuntimeDrain();
  const row = await db.get(
    `SELECT
       SUM(CASE WHEN status IN ('running','active','planning','executing_approved_plan','output_draining','cancelling') THEN 1 ELSE 0 END) AS activeTurnCount,
       SUM(CASE WHEN status='submitting' THEN 1 ELSE 0 END) AS submittingTurnCount
     FROM sessions`
  ).catch(()=>null);
  return {
    activeTurnCount:Number(row?.activeTurnCount || 0),
    submittingTurnCount:Number(row?.submittingTurnCount || 0),
    appendQueueCount:eventStore.metrics.appendQueueCount,
    deltaQueueEventCount:eventStore.metrics.deltaQueueEventCount,
    deltaQueueBytes:eventStore.metrics.deltaQueueBytes,
    pendingSqliteWriteCount:eventStore.metrics.pendingSqliteWriteCount,
    subscriberPendingBufferCount:subscriptions.pendingBufferCount,
    pendingEventWriteCount:eventStore.metrics.appendQueueCount+eventStore.metrics.deltaQueueEventCount+eventStore.metrics.pendingSqliteWriteCount+subscriptions.pendingPushCount,
    accepting:runtimeLifecycle === 'accepting',
    drained:Number(row?.activeTurnCount || 0) === 0 && Number(row?.submittingTurnCount || 0) === 0 && eventStore.metrics.appendQueueCount === 0 && eventStore.metrics.deltaQueueEventCount === 0 && eventStore.metrics.pendingSqliteWriteCount === 0 && subscriptions.pendingPushCount === 0,
  };
}
function releaseMetadata() {
  const manifestPath = path.join(process.cwd(), 'deploy-manifest.json');
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return {
      releaseId:String(manifest.releaseId || path.basename(process.cwd())),
      commit:String(manifest.sourceCommit || manifest.commit || ''),
    };
  } catch {
    return { releaseId:path.basename(process.cwd()), commit:'' };
  }
}
async function waitForDrain(timeoutMs = DRAIN_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await drainState();
    if (state.drained) return state;
    await sleep(500);
  }
  throw new Error('runtime drain timed out');
}
async function shutdownGracefully(signal:string) {
  if (runtimeLifecycle === 'stopping') return;
  runtimeLifecycle = 'draining';
  drainStartedAt = drainStartedAt || Date.now();
  app.log.info({ signal, lifecycle:runtimeLifecycle }, 'runtime graceful shutdown requested');
  try {
    await waitForDrain(DRAIN_TIMEOUT_MS);
  } catch (e:any) {
    app.log.warn({ signal, error:e?.message || String(e), drainState:await drainState().catch(()=>null) }, 'runtime drain timed out before shutdown');
  }
  runtimeLifecycle = 'stopping';
  await eventStore.drain();
  await subscriptions.drain();
  subscriptions.closeAll();
  await app.close().catch(()=>{});
  db.close();
  process.exit(0);
}

async function ensureCodexAppServer(account:Account, port:number, db:Db) {
  const key = account.id;
  const pending = codexAppServerEnsureInFlight.get(key);
  if (pending) return pending;
  const promise = ensureCodexAppServerOnce(account, port, db).finally(() => codexAppServerEnsureInFlight.delete(key));
  codexAppServerEnsureInFlight.set(key, promise);
  return promise;
}

async function ensureCodexAppServerOnce(account:Account, port:number, db:Db) {
  await ensureCodexHomeSharedDirs(account.codex_home);
  const unit = systemdUnitName(account.id);
  const listen = `ws://127.0.0.1:${port}`;
  if (await readyz(port)) {
    await recordRuntimeInstance(db, account.id, port);
    return;
  }

  const state = await systemdUnitState(unit);
  if (state.activeState === 'activating') {
    app.log.info({ accountId:account.id, unit, listen }, 'codex app-server activating; waiting');
    await waitForAppServerReady(account.id, port, db, 15_000);
    return;
  }

  if (state.activeState === 'active') {
    app.log.warn({ accountId:account.id, unit, listen, subState:state.subState }, 'codex app-server active but not ready; waiting');
    await waitForAppServerReady(account.id, port, db, 10_000);
    return;
  }

  app.log.warn({ accountId:account.id, unit, listen, activeState:state.activeState, fragmentPath:state.fragmentPath }, 'codex app-server not ready; starting');
  if (account.id === 'default' || isPersistentSystemdFragment(state.fragmentPath)) {
    await mapAppServerStartError(execFileAsync('sudo', ['systemctl', 'start', unit], { maxBuffer:1024 * 1024 }));
  } else {
    await validateAppServerRunUser(APP_SERVER_USER, APP_SERVER_GROUP);
    await mapAppServerStartError(execFileAsync('sudo', ['systemd-run', ...codexSystemdRunArgs(account, unit, listen)], { maxBuffer:1024 * 1024 }));
  }
  await waitForAppServerReady(account.id, port, db, 10_000);
}

function codexSystemdRunArgs(account:Account, unit:string, listen:string) {
  return [
    '--unit', unit,
    '--uid', APP_SERVER_USER,
    '--gid', APP_SERVER_GROUP,
    '--property', `WorkingDirectory=${DEFAULT_WORKDIR}`,
    '--property', 'Restart=on-failure',
    '--property', 'RestartSec=5',
    '--property', 'StartLimitIntervalSec=60',
    '--property', 'StartLimitBurst=3',
    '--setenv', `HOME=${DEFAULT_HOME}`,
    '--setenv', `CODEX_HOME=${account.codex_home}`,
    '--collect',
    CODEX_BIN, 'app-server', '--listen', listen,
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_mode="danger-full-access"',
  ];
}

async function waitForAppServerReady(accountId:string, port:number, db:Db, timeoutMs:number) {
  const listen = `ws://127.0.0.1:${port}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await readyz(port)) {
      await recordRuntimeInstance(db, accountId, port);
      return;
    }
    await sleep(250);
  }
  throw new Error(`codex app-server did not become ready on ${listen}`);
}

async function recordRuntimeInstance(db:Db, accountId:string, port:number) {
  await db.run(
    'INSERT INTO runtime_instances (instance_id,pid,started_at,heartbeat_at) VALUES (?1,?2,?3,?3) ON CONFLICT(instance_id) DO UPDATE SET pid=excluded.pid, heartbeat_at=excluded.heartbeat_at',
    [runtimeInstanceId(accountId), await pidForPort(port), Date.now()]
  );
}

function isPersistentSystemdFragment(fragmentPath:string | null) {
  return !!fragmentPath && !fragmentPath.startsWith('/run/systemd/transient/');
}

async function systemdUnitState(unit:string) {
  try {
    const { stdout } = await execFileAsync('systemctl', ['show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'FragmentPath', '--no-pager'], { maxBuffer:128 * 1024 });
    const values:Record<string,string> = {};
    for (const line of stdout.split(/\r?\n/)) {
      const idx = line.indexOf('=');
      if (idx > 0) values[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return {
      loadState:values.LoadState || 'not-found',
      activeState:values.ActiveState || 'inactive',
      subState:values.SubState || '',
      fragmentPath:values.FragmentPath || null,
    };
  } catch {
    return { loadState:'not-found', activeState:'inactive', subState:'', fragmentPath:null };
  }
}

class StructuredRuntimeError extends Error {
  constructor(public statusCode:number, public body:StructuredRuntimeErrorBody) {
    super(body.message);
  }
}

function codexAppServerInvalidRunUserError(): StructuredRuntimeError {
  return new StructuredRuntimeError(500, {
    code:'codex_app_server_invalid_run_user',
    layer:'codex_app_server_manager',
    message:'Codex 后台服务运行用户配置无效',
    safeDetail:'配置的服务运行用户不存在或无法解析',
  });
}

async function validateAppServerRunUser(user:string, group:string) {
  const [userOk, groupOk] = await Promise.all([
    commandSucceeds('getent', ['passwd', user]),
    commandSucceeds('getent', ['group', group]),
  ]);
  if (!userOk || !groupOk) throw codexAppServerInvalidRunUserError();
}

async function mapAppServerStartError<T>(promise:Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (e:any) {
    const text = `${e?.message || ''}\n${e?.stdout || ''}\n${e?.stderr || ''}`;
    if (/217\/USER|Failed to determine user credentials|No such process|user credentials/i.test(text)) {
      throw codexAppServerInvalidRunUserError();
    }
    throw e;
  }
}

async function commandSucceeds(command:string, args:string[]) {
  try {
    await execFileAsync(command, args, { maxBuffer:64 * 1024 });
    return true;
  } catch {
    return false;
  }
}

function mimeFromPath(filePath:string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.txt' || ext === '.md' || ext === '.log' || ext === '.patch' || ext === '.diff') return 'text/plain';
  if (ext === '.json') return 'application/json';
  if (ext === '.pdf') return 'application/pdf';
  return null;
}

function portForAccount(accountId:string) {
  if (accountId === 'default') return DEFAULT_CODEX_APP_SERVER_PORT;
  const hash = crypto.createHash('sha256').update(accountId).digest();
  return CODEX_PORT_BASE + (hash.readUInt16BE(0) % 200);
}

function runtimeInstanceId(accountId:string) { return `agentdeck-${safeUnitPart(accountId)}`; }
function systemdUnitName(accountId:string) { return accountId === 'default' ? 'agentdeck-app-server@default.service' : `agentdeck-app-server-${safeUnitPart(accountId)}.service`; }
function safeUnitPart(value:string) { return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64) || 'default'; }
function sleep(ms:number) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function readyz(port:number) {
  return new Promise<boolean>(resolve => {
    const req = http.get({ hostname:'127.0.0.1', port, path:'/readyz', timeout:1000 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function pidForPort(port:number) {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-af', `codex app-server --listen ws://127.0.0.1:${port}`]);
    const line = stdout.trim().split(/\r?\n/)[0] || '';
    return Number(line.split(/\s+/)[0]) || null;
  } catch {
    return null;
  }
}
