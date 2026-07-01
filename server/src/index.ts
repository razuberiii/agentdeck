import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import staticPlugin from '@fastify/static';
import multipart from '@fastify/multipart';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import * as pty from 'node-pty';
import { promisify } from 'node:util';
import { createWriteStream, realpathSync, existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Db } from './db.js';
import { CodexBridge } from './codex.js';
import { RuntimeClient } from './runtime-client.js';
import { AntigravityProvider, GeminiProvider, type AgentProviderId } from './providers.js';
import { existingRoots, validateProject, scanProjects, gitBranch, gitDiff } from './workspaces.js';
const execFileAsync = promisify(execFile);
const DEFAULT_HOME = process.env.HOME || os.homedir();
const DATA_DIR = process.env.DATA_DIR || '/var/lib/agentdeck';
const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || path.join(DEFAULT_HOME, '.codex');
const ANTIGRAVITY_BIN = process.env.ANTIGRAVITY_BIN || 'agy';
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const ANTIGRAVITY_PROFILES_DIR = path.join(DATA_DIR, 'antigravity-profiles');
const GEMINI_PROFILES_DIR = path.join(DATA_DIR, 'gemini', 'profiles');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const SHARED_CODEX_DIR = path.join(DATA_DIR, 'shared');
const SHARED_SESSIONS_DIR = path.join(SHARED_CODEX_DIR, 'sessions');
const SHARED_GENERATED_IMAGES_DIR = path.join(SHARED_CODEX_DIR, 'generated_images');
const MAX_ATTACHMENT_BYTES = Number(process.env.MAX_ATTACHMENT_BYTES || 32 * 1024 * 1024);
const MAX_ATTACHMENTS_PER_MESSAGE = Number(process.env.MAX_ATTACHMENTS_PER_MESSAGE || 10);
const MAX_TOTAL_ATTACHMENT_BYTES = Number(process.env.MAX_TOTAL_ATTACHMENT_BYTES || 64 * 1024 * 1024);
const ARCHIVED_SESSION_RETENTION_DAYS = Number(process.env.ARCHIVED_SESSION_RETENTION_DAYS || 30);
const ARCHIVED_SESSION_CLEANUP_INTERVAL_MS = Number(process.env.ARCHIVED_SESSION_CLEANUP_INTERVAL_MS || 6 * 60 * 60 * 1000);
const IMAGE_TYPES: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/pjpeg': '.jpg', 'image/webp': '.webp' };
const ARTIFACT_TYPES: Record<string, string> = { '.txt':'text/plain; charset=utf-8', '.log':'text/plain; charset=utf-8', '.json':'application/json; charset=utf-8', '.csv':'text/csv; charset=utf-8', '.patch':'text/plain; charset=utf-8', '.diff':'text/plain; charset=utf-8', '.zip':'application/zip', '.tar.gz':'application/gzip', '.conf':'application/x-wireguard-profile', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp' };
const ARTIFACT_SKIP_DIRS = new Set(['.git','node_modules','dist','build','.next','.vite','coverage','vendor']);
const MOBILE_CONTEXT_MARKER = '[[CODEX_MOBILE_CLIENT_CONTEXT]]';
const artifactScanStarts = new Map<string, number>();
const COOKIE_NAME = 'agentdeck_session';
const CSRF_COOKIE = 'agentdeck_csrf';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3842,http://127.0.0.1:3842').split(',').map(s=>s.trim()).filter(Boolean);
const db = new Db(path.join(DATA_DIR, 'agentdeck.sqlite3'));
const runtimeDb = new Db(process.env.RUNTIME_DB || path.join(DATA_DIR, 'agentdeck-runtime.sqlite3'));
const codex = new CodexBridge(DEFAULT_HOME, DEFAULT_CODEX_HOME);
const runtime = new RuntimeClient();
const USE_AGENT_RUNTIME = process.env.USE_AGENT_RUNTIME === '1';
const antigravity = new AntigravityProvider();
const geminiProvider = new GeminiProvider();
const clients = new Map<string, Set<any>>();
const pendingApprovals = new Map<string, { id:string|number; method:string; createdAt:number }>();
const activeTurns = new Map<string, string>();
const activeCodexSessions = new Set<string>();
type RuntimeSubscriptionState = { close:()=>void; connected:boolean; connecting:boolean; generation?:string; lastSequence:number; lastError?:string; lastStatus:'unknown'|'checking'|'recovering'|'connected'|'unavailable'|'disconnected' };
const runtimeSubscriptions = new Map<string, RuntimeSubscriptionState>();
const activeAntigravityTurns = new Map<string, any>();
const chunkedMessages = new Map<string, { sessionId:string; clientMessageId:string; chunks:string[]; size:number; createdAt:number }>();
const threadTokenUsage = new Map<string, any>();
const runtimeDiagnostics = { subscribeStarts:0, subscribeReconnects:0, subscribeEvents:0, broadcasts:0, replayCalls:0 };
type LoginJob = { id:string; profileId:string; output:string[]; status:'running'|'done'|'error'; code?:number|null; error?:string; startedAt:number; newProfile?:boolean; loginUrl?:string; deviceCode?:string };
const loginJobs = new Map<string, LoginJob>();
type AntigravityLoginJob = LoginJob & { providerId:'antigravity'; authCodePrompt?:boolean; codeSubmitted?:boolean };
const antigravityLoginJobs = new Map<string, AntigravityLoginJob>();
const antigravityLoginChildren = new Map<string, any>();
type GeminiLoginJob = {
  id:string;
  profileId:string;
  methodId:string;
  status:'preparing'|'waiting_user'|'verifying'|'done'|'error'|'cancelled'|'fallback';
  loginUrl?:string;
  deviceCode?:string;
  requiresCodeInput?:boolean;
  error?:string;
  fallbackCommand?:string;
  output?:string[];
  codeSubmitted?:boolean;
  startedAt:number;
};
const geminiLoginJobs = new Map<string, GeminiLoginJob>();
const geminiLoginProfiles = new Map<string, string>();
const geminiLoginWorkers = new Map<string, any>();
const GEMINI_LOGIN_TIMEOUT_MS = Number(process.env.GEMINI_LOGIN_TIMEOUT_MS || 5 * 60 * 1000);
const GEMINI_GOOGLE_AUTH_TYPE = 'oauth-personal';
const GEMINI_USER_CODE_REDIRECT_URI = 'https://codeassist.google.com/authcode';
const roots = await existingRoots((process.env.ALLOWED_WORKSPACES || `${process.cwd()},/opt/projects`).split(',').map(s=>s.trim()).filter(Boolean));
const DEFAULT_WORKSPACE_DIR = roots.find(r => r === process.cwd() || r.endsWith('/agentdeck')) || roots[0];
const PROJECTS_CACHE_MS = Number(process.env.PROJECTS_CACHE_MS || 30_000);
const CODEX_STATUS_CACHE_MS = Number(process.env.CODEX_STATUS_CACHE_MS || 60_000);
const PROVIDER_STATUS_OK_CACHE_MS = 5 * 60_000;
const PROVIDER_STATUS_FAIL_CACHE_MS = 30_000;
let projectsCache: { expiresAt:number; promise?:Promise<any[]>; value?:any[] } = { expiresAt: 0 };
let codexStatusCache: { expiresAt:number; promise?:Promise<any>; value?:any } = { expiresAt: 0 };
let antigravityStatusCache: { expiresAt:number; promise?:Promise<any>; value?:any } = { expiresAt: 0 };
let geminiStatusCache: { expiresAt:number; promise?:Promise<any>; value?:any } = { expiresAt: 0 };
let antigravityModelsCache: { key:string; expiresAt:number; promise?:Promise<any>; value?:any } = { key:'', expiresAt: 0 };
let shutdownRequested = false;
if (roots.length === 0) throw new Error('No allowed workspaces exist');
await db.init();
await db.run('ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0').catch(()=>{});
await db.run('ALTER TABLE sessions ADD COLUMN model TEXT').catch(()=>{});
await db.run("ALTER TABLE sessions ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'codex'").catch(()=>{});
await db.run('ALTER TABLE sessions ADD COLUMN account_id TEXT').catch(()=>{});
await db.run('ALTER TABLE sessions ADD COLUMN model_id TEXT').catch(()=>{});
await db.run('ALTER TABLE sessions ADD COLUMN workspace_path TEXT').catch(()=>{});
await db.run('ALTER TABLE sessions ADD COLUMN provider_session_id TEXT').catch(()=>{});
await db.run('ALTER TABLE sessions ADD COLUMN archived_at INTEGER').catch(()=>{});
await db.run('ALTER TABLE sessions ADD COLUMN provider_profile_id TEXT').catch(()=>{});
await db.run('ALTER TABLE sessions ADD COLUMN provider_capabilities TEXT').catch(()=>{});
await db.run('ALTER TABLE sessions ADD COLUMN provider_metadata TEXT').catch(()=>{});
await runtimeDb.run('ALTER TABLE sessions ADD COLUMN archived_at INTEGER').catch(()=>{});
await db.run("UPDATE sessions SET provider_id='codex' WHERE provider_id IS NULL OR provider_id=''").catch(()=>{});
await db.run('UPDATE sessions SET provider_session_id=codex_thread_id WHERE provider_session_id IS NULL AND codex_thread_id IS NOT NULL').catch(()=>{});
await db.run('UPDATE sessions SET workspace_path=project_dir WHERE workspace_path IS NULL').catch(()=>{});
await db.run('UPDATE sessions SET model_id=model WHERE model_id IS NULL AND model IS NOT NULL').catch(()=>{});
await db.run('UPDATE sessions SET archived_at=updated_at WHERE archived=1 AND archived_at IS NULL').catch(()=>{});
await runtimeDb.run('UPDATE sessions SET archived_at=updated_at WHERE archived=1 AND archived_at IS NULL').catch(()=>{});
await db.run('ALTER TABLE artifacts ADD COLUMN anchor_item_id TEXT').catch(()=>{});
await db.run('CREATE TABLE IF NOT EXISTS antigravity_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, home_dir TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)').catch(()=>{});
await db.run('CREATE TABLE IF NOT EXISTS gemini_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, home_dir TEXT NOT NULL UNIQUE, auth_type TEXT, active INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)').catch(()=>{});
await db.run("ALTER TABLE gemini_profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'configured'").catch(()=>{});
await db.run("UPDATE gemini_profiles SET status='bootstrap' WHERE id='default' AND auth_type IS NULL AND status='configured'").catch(()=>{});
await db.run("UPDATE gemini_profiles SET status='bootstrap', active=0 WHERE auth_type IS NULL AND name='Gemini Account' AND status='configured'").catch(()=>{});
await db.run('CREATE TABLE IF NOT EXISTS agent_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL)').catch(()=>{});
await db.run('UPDATE sessions SET status=?1 WHERE status=?2', ['interrupted', 'running']).catch(()=>{});
await ensureProfiles();
await ensureGeminiProfiles();
await ensureAdmin();
const app = Fastify({ bodyLimit: Number(process.env.BODY_LIMIT_BYTES || 25 * 1024 * 1024), logger: { redact: ['req.headers.authorization','req.headers.cookie','res.headers.set-cookie','password','token','secret'] } });
await app.register(cookie, { secret: process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex') });
await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
await app.register(websocket);
await app.register(multipart, { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_ATTACHMENTS_PER_MESSAGE } });
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
await app.register(staticPlugin, { root: publicDir, prefix: '/' });
app.addHook('preHandler', async (req, reply) => { if (['POST','PUT','PATCH','DELETE'].includes(req.method) && !['/api/login'].includes(req.url)) { const csrf = req.cookies[CSRF_COOKIE]; if (!csrf || req.headers['x-csrf-token'] !== csrf) return reply.code(403).send({error:'csrf'}); } });
function secureCookie() { return { httpOnly:true, secure:true, sameSite:'strict' as const, path:'/', maxAge: 60*60*24*14 }; }
function csrfCookie() { return { httpOnly:false, secure:true, sameSite:'strict' as const, path:'/', maxAge: 60*60*24*14 }; }
async function ensureAuth(req:any, reply:any) { const sid = req.cookies[COOKIE_NAME]; if (!sid) return reply.code(401).send({error:'unauthorized'}); try { const decoded = app.unsignCookie(sid); if (!decoded.valid) throw new Error('bad cookie'); } catch { return reply.code(401).send({error:'unauthorized'}); } }
function isAuthenticated(req:any) {
  const raw = req.cookies[COOKIE_NAME] || '';
  return !!raw && !!app.unsignCookie(raw).valid;
}
app.get('/api/auth/status', async (req) => ({ authenticated: isAuthenticated(req) }));
app.get('/api/status', async (req) => {
  const startedAt = Date.now();
  const authed = isAuthenticated(req);
  if (!authed) return { authed:false, authenticated:false, serverTime:Date.now(), capabilities:{} };
  const force = !!(req.query && typeof req.query === 'object' && (req.query as any).refresh === '1');
  const [
    settings,
    activeProfile,
    activeGeminiProfile,
    activeAntigravityProfile,
    codexStatus,
    antigravityStatus,
    geminiStatus,
    geminiRuntime,
  ] = await Promise.all([
    appSettings(),
    getActiveProfile(),
    getActiveGeminiProfile(),
    getActiveAntigravityProfile(),
    cachedCodexStatus(),
    cachedAntigravityStatus(force),
    cachedGeminiStatus(force),
    USE_AGENT_RUNTIME ? runtime.geminiStatus().catch((e:any)=>({ error:e?.message || String(e) })) : Promise.resolve({ error:'persistent runtime disabled' }),
    syncAntigravityProfilesFromDisk().catch(()=>{}),
  ]);
  app.log.info({ ms:Date.now() - startedAt }, 'api status computed');
  return { authed, authenticated:true, serverTime: Date.now(), codex: codexStatus, gemini: { ...geminiStatus, runtime:geminiRuntime }, antigravity: antigravityStatus, providers: [codexProviderStatus(codexStatus), { ...geminiStatus, runtime:geminiRuntime }, antigravityStatus], activeProvider: settings.activeProvider, roots, defaultWorkspace: DEFAULT_WORKSPACE_DIR, mode:modeLabel(settings.defaultMode), defaultMode:settings.defaultMode, defaultModel:settings.defaultModel, codexHome: codex.getCodexHome(), activeProfile, activeGeminiProfile, activeAntigravityProfile, capabilities: attachmentCapabilities(geminiRuntime) };
});
app.get('/api/runtime-diagnostics', { preHandler: ensureAuth }, async () => ({
  local: {
    ...runtimeDiagnostics,
    subscriptions:[...runtimeSubscriptions.entries()].map(([sessionId,state]) => ({ sessionId, connected:state.connected, lastSequence:state.lastSequence, generation:state.generation || null, clients:clients.get(sessionId)?.size || 0 })),
  },
  runtime: await runtime.diagnostics().catch((e:any)=>({ error:e?.message || String(e) })),
}));
app.post('/api/maintenance/cleanup-archived', { preHandler: ensureAuth }, async () => cleanupArchivedSessions('manual'));
app.get('/api/quota', { preHandler: ensureAuth }, async (req:any) => {
  const settings = await appSettings();
  const provider = normalizeProvider(req.query?.provider) || settings.activeProvider;
  if (provider === 'gemini') {
    const status = await cachedGeminiStatus();
    const runtimeStatus = USE_AGENT_RUNTIME ? await runtime.geminiStatus().catch((e:any)=>({ error:e?.message || String(e) })) : null;
    return {
      providerId: 'gemini',
      account: null,
      rateLimits: null,
      provider: { ...status, runtime: runtimeStatus },
      errors: {
        account: runtimeStatus?.authenticated ? null : 'Gemini CLI 未提供可用额度接口，且当前 profile 尚未完成登录或 API key 配置',
        rateLimits: 'Gemini CLI 未提供稳定的可机读额度接口',
      },
      checkedAt: Date.now(),
    };
  }
  if (provider === 'antigravity') {
    const status = await cachedAntigravityStatus();
    const activeProfile:any = await getActiveAntigravityProfile();
    const login = activeProfile?.home_dir ? await antigravityLoginStatus(String(activeProfile.home_dir)) : { ok:false, email:null };
    const usageText = status.ok && login.ok ? await antigravityUsage(String(activeProfile.home_dir)).catch(()=>null) : null;
    const email = login.email || activeProfile?.name || null;
    return {
      providerId: 'antigravity',
      account: email ? { email, type:'Google' } : null,
      rateLimits: usageText ? { usageText } : null,
      provider: status,
      errors: {
        account: status.ok && !email ? '请先登录 Antigravity Google 账户' : (status.ok ? null : status.error),
        rateLimits: status.ok && login.ok && !usageText ? 'Google Antigravity CLI 当前没有暴露稳定的可机读额度；交互式 /usage 在当前远程 PTY 下未返回可解析内容。' : (status.ok && login.ok ? null : (status.ok ? 'Antigravity 额度需要登录后通过 CLI 内置 /usage 读取' : status.error)),
      },
      checkedAt: Date.now(),
    };
  }
  const [account, limits] = await Promise.allSettled(USE_AGENT_RUNTIME ? [runtime.account(), runtime.rateLimits()] : [codex.account(), codex.rateLimits()]);
  return {
    providerId: 'codex',
    account: account.status === 'fulfilled' ? account.value : null,
    rateLimits: limits.status === 'fulfilled' ? limits.value : null,
    errors: {
      account: account.status === 'rejected' ? account.reason?.message || String(account.reason) : null,
      rateLimits: limits.status === 'rejected' ? limits.reason?.message || String(limits.reason) : null,
    },
    checkedAt: Date.now(),
  };
});
app.get('/api/settings', { preHandler: ensureAuth }, async (req:any) => {
  const force = req.query?.refresh === '1';
  const [
    settings,
    profiles,
    activeProfile,
    geminiProfiles,
    activeGeminiProfile,
    antigravityProfiles,
    activeAntigravityProfile,
    codexStatus,
    antigravityStatus,
    geminiStatus,
    geminiRuntime,
  ] = await Promise.all([
    appSettings(),
    listProfiles(),
    getActiveProfile(),
    listGeminiProfiles(),
    getActiveGeminiProfile(),
    listAntigravityProfiles(),
    getActiveAntigravityProfile(),
    cachedCodexStatus(),
    cachedAntigravityStatus(force),
    cachedGeminiStatus(force),
    USE_AGENT_RUNTIME ? runtime.geminiStatus().catch((e:any)=>({ error:e?.message || String(e) })) : Promise.resolve({ error:'persistent runtime disabled' }),
    syncAntigravityProfilesFromDisk().catch(()=>{}),
  ]);
  return { settings, profiles, activeProfile, geminiProfiles, activeGeminiProfile, antigravityProfiles, activeAntigravityProfile, codex: codexStatus, gemini:{...geminiStatus,runtime:geminiRuntime}, antigravity: antigravityStatus, providers: [codexProviderStatus(codexStatus), {...geminiStatus,runtime:geminiRuntime}, antigravityStatus] };
});
app.patch('/api/settings', { preHandler: ensureAuth }, async (req:any) => {
  const provider = normalizeProvider(req.body?.activeProvider);
  if (provider) await setSetting('activeProvider', provider);
  const mode = normalizeMode(req.body?.defaultMode);
  if (mode) await setSetting('defaultMode', mode);
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'defaultModel')) {
    const settings = await appSettings();
    const modelProvider = normalizeProvider(req.body?.provider) || provider || settings.activeProvider;
    const model = modelProvider === 'antigravity' || modelProvider === 'gemini' ? cleanAgentModel(req.body?.defaultModel) : cleanModel(req.body?.defaultModel);
    await setSetting(modelProvider === 'antigravity' ? 'defaultModelAntigravity' : modelProvider === 'gemini' ? 'defaultModelGemini' : 'defaultModelCodex', model || '');
  }
  return { settings: await appSettings() };
});
app.get('/api/models', { preHandler: ensureAuth }, async (req:any) => modelCatalog(req.query?.hidden === '1', normalizeProvider(req.query?.provider) || (await appSettings()).activeProvider));
app.get('/api/profiles', { preHandler: ensureAuth }, async () => ({ profiles: await listProfiles(), activeProfile: await getActiveProfile() }));
app.post('/api/profiles', { preHandler: ensureAuth }, async (req:any) => {
  const name = cleanProfileName(String(req.body?.name || 'Codex Account'));
  const id = crypto.randomBytes(8).toString('hex');
  const codexHome = path.join(PROFILES_DIR, id, '.codex');
  await mkdir(codexHome, { recursive:true });
  await ensureSharedCodexDirs(codexHome);
  await db.run('INSERT INTO codex_profiles (id,name,codex_home,active,created_at,updated_at) VALUES (?1,?2,?3,0,?4,?4)', [id, name, codexHome, Date.now()]);
  return { profile: await getProfile(id) };
});
app.post('/api/profiles/:id/switch', { preHandler: ensureAuth }, async (req:any) => {
  const profile = await getProfile(String(req.params.id));
  if (!profile) throw new Error('profile not found');
  await activateProfile(String(profile.id));
  let warning:string|null = null;
  if (USE_AGENT_RUNTIME) {
    await syncDefaultCodexAppServerEnv(String(profile.codex_home));
    await runtime.restartDefaultCodexAccount({ codexHome:String(profile.codex_home) }).catch((e:any) => { warning = e?.message || String(e); });
  } else {
    try { await codex.switchCodexHome(String(profile.codex_home)); }
    catch (e:any) { warning = e?.message || String(e); await codex.ensure().catch(()=>{}); }
  }
  await updateProfileEmailName(String(profile.id), String(profile.codex_home)).catch(()=>{});
  codexStatusCache = { expiresAt:0 };
  return { ok:!warning, warning, activeProfile: await getActiveProfile() };
});
app.delete('/api/profiles/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await getProfile(String(req.params.id));
  if (!profile) return reply.code(404).send({error:'profile not found'});
  if (Number(profile.active || 0)) return reply.code(409).send({error:'不能删除当前正在使用的账户，请先切换到其他账户'});
  await db.run('DELETE FROM codex_profiles WHERE id=?1', [String(profile.id)]);
  await deleteProfileDir(String(profile.codex_home)).catch(()=>{});
  return { ok:true };
});
app.get('/api/gemini/profiles', { preHandler: ensureAuth }, async () => ({ profiles: await listGeminiProfiles(), activeGeminiProfile: await getActiveGeminiProfile() }));
app.post('/api/gemini/profiles', { preHandler: ensureAuth }, async (req:any) => {
  const name = cleanProfileName(String(req.body?.name || 'Gemini Account'));
  const reusable = await getReusableGeminiBootstrapProfile();
  if (reusable?.id) {
    await db.run("UPDATE gemini_profiles SET name=?1, active=0, status='bootstrap', updated_at=?2 WHERE id=?3", [name, Date.now(), String(reusable.id)]);
    await mkdir(String(reusable.home_dir), { recursive:true, mode:0o700 });
    await chmod(String(reusable.home_dir), 0o700).catch(()=>{});
    return { profile: await getGeminiProfileDto(String(reusable.id), { includeHidden:true }) };
  }
  const id = crypto.randomBytes(8).toString('hex');
  const homeDir = geminiHomeForProfile(id);
  await mkdir(homeDir, { recursive:true, mode:0o700 });
  await chmod(path.dirname(homeDir), 0o700).catch(()=>{});
  await chmod(homeDir, 0o700).catch(()=>{});
  await db.run("INSERT INTO gemini_profiles (id,name,home_dir,auth_type,active,status,created_at,updated_at) VALUES (?1,?2,?3,NULL,0,'bootstrap',?4,?4)", [id, name, homeDir, Date.now()]);
  return { profile: await getGeminiProfileDto(id, { includeHidden:true }) };
});
app.post('/api/gemini/profiles/:id/switch', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await getGeminiProfile(String(req.params.id));
  if (!profile) return reply.code(404).send({error:'profile not found'});
  const login = await geminiLoginStatus(String(profile.home_dir), String(profile.auth_type || '') || null);
  if (!login.ok) return reply.code(409).send({error:'请先登录该 Gemini 账户'});
  await activateGeminiProfile(String(profile.id));
  return { ok:true, activeGeminiProfile: await getActiveGeminiProfile() };
});
app.post('/api/gemini/profiles/:id/refresh', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await getGeminiProfile(String(req.params.id));
  if (!profile) return reply.code(404).send({error:'profile not found'});
  const runtimeStatus = USE_AGENT_RUNTIME ? await runtime.initializeGeminiProfile(String(profile.id)).catch((e:any)=>({ error:safeGeminiError(e) })) : null;
  await refreshGeminiProfileName(String(profile.id), String(profile.home_dir), String(profile.auth_type || '') || null).catch(()=>{});
  return { profile: await getGeminiProfileDto(String(profile.id)), runtime: sanitizeGeminiRuntimeStatus(runtimeStatus) };
});
app.post('/api/gemini/profiles/:id/logout', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await getGeminiProfile(String(req.params.id));
  if (!profile) return reply.code(404).send({error:'profile not found'});
  const running = await db.get("SELECT id FROM sessions WHERE provider_id='gemini' AND account_id=?1 AND status IN ('running','submitting','recovering') LIMIT 1", [String(profile.id)]);
  if (running) return reply.code(409).send({error:'该 Gemini 账户仍有正在运行的会话，不能退出登录'});
  await runtime.logoutGeminiProfile(String(profile.id)).catch((e:any)=>{ throw new Error(safeGeminiError(e)); });
  await removeGeminiProfileSecret(String(profile.home_dir), 'GEMINI_API_KEY').catch(()=>{});
  await db.run("UPDATE gemini_profiles SET auth_type=NULL, active=0, status='configured', updated_at=?1 WHERE id=?2", [Date.now(), String(profile.id)]);
  await ensureGeminiActiveProfile();
  return { ok:true, profile: await getGeminiProfileDto(String(profile.id)) };
});
app.post('/api/gemini/profiles/:id/login', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await getGeminiProfile(String(req.params.id));
  if (!profile) return reply.code(404).send({error:'profile not found'});
  if (geminiLoginProfiles.has(String(profile.id))) return reply.code(409).send({error:'该 Gemini Profile 已有登录任务在运行'});
  const methodId = String(req.body?.methodId || '').trim();
  if (!methodId) return reply.code(400).send({error:'methodId required'});
  await db.run("UPDATE gemini_profiles SET status='configured', updated_at=?1 WHERE id=?2 AND status='bootstrap'", [Date.now(), String(profile.id)]).catch(()=>{});
  const job:GeminiLoginJob = { id:crypto.randomBytes(12).toString('base64url'), profileId:String(profile.id), methodId, status:'preparing', startedAt:Date.now() };
  geminiLoginJobs.set(job.id, job);
  geminiLoginProfiles.set(String(profile.id), job.id);
  runGeminiLoginJob(job, req.body || {}).catch((e:any) => {
    job.status = 'error';
    job.error = safeGeminiError(e);
  }).finally(() => {
    if (geminiLoginProfiles.get(job.profileId) === job.id) geminiLoginProfiles.delete(job.profileId);
  });
  return { job };
});
app.delete('/api/gemini/profiles/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await getGeminiProfile(String(req.params.id));
  if (!profile) return reply.code(404).send({error:'profile not found'});
  const running = await db.get("SELECT id FROM sessions WHERE provider_id='gemini' AND account_id=?1 AND status IN ('running','submitting','recovering') LIMIT 1", [String(profile.id)]);
  if (running) return reply.code(409).send({error:'该 Gemini 账户仍有正在运行的会话，不能删除'});
  if (geminiLoginProfiles.has(String(profile.id))) return reply.code(409).send({error:'该 Gemini 账户正在登录，取消或完成登录后再删除'});
  const state = geminiProfileState(profile);
  if (Number(profile.active || 0) && state === 'authenticated') return reply.code(409).send({error:'不能删除当前已登录的 Gemini 账户，请先切换到其他账户'});
  const refs = await geminiSessionReferenceCount(String(profile.id));
  if (refs > 0) {
    await db.run("UPDATE gemini_profiles SET active=0, status='disabled', updated_at=?1 WHERE id=?2", [Date.now(), String(profile.id)]);
    await ensureGeminiActiveProfile();
    return { ok:true, hidden:true, references:refs };
  }
  await db.run('DELETE FROM gemini_profiles WHERE id=?1', [String(profile.id)]);
  await deleteGeminiProfileDir(String(profile.home_dir)).catch(()=>{});
  await ensureGeminiActiveProfile();
  return { ok:true, deleted:true };
});
app.get('/api/gemini-login/:jobId', { preHandler: ensureAuth }, async (req:any, reply) => {
  const job = geminiLoginJobs.get(String(req.params.jobId));
  if (!job) return reply.code(404).send({error:'not found'});
  return { job };
});
app.post('/api/gemini-login/:jobId/input', { preHandler: ensureAuth }, async (req:any, reply) => {
  const job = geminiLoginJobs.get(String(req.params.jobId));
  if (!job) return reply.code(404).send({error:'not found'});
  const child = geminiLoginWorkers.get(job.id);
  if (!child || !['waiting_user','verifying'].includes(job.status)) return reply.code(409).send({error:'Gemini 登录进程未在等待授权码'});
  if (!job.requiresCodeInput) return reply.code(409).send({error:'当前 Gemini 登录流程未要求网页输入 code'});
  if (job.codeSubmitted) return reply.code(409).send({error:'授权码已提交，正在验证'});
  const code = String(req.body?.code || '').trim();
  if (!/^[A-Za-z0-9_./~+=-]{4,4096}$/.test(code)) return reply.code(400).send({error:'bad code'});
  child.write(code + '\n');
  job.codeSubmitted = true;
  job.status = 'verifying';
  return { ok:true, job:{ ...job, codeSubmitted:true } };
});
app.post('/api/gemini-login/:jobId/cancel', { preHandler: ensureAuth }, async (req:any, reply) => {
  const job = geminiLoginJobs.get(String(req.params.jobId));
  if (!job) return reply.code(404).send({error:'not found'});
  if (job.status === 'done' || job.status === 'error' || job.status === 'fallback') return { job };
  const child = geminiLoginWorkers.get(job.id);
  if (child) {
    try { child.kill(); } catch {}
    geminiLoginWorkers.delete(job.id);
  }
  job.status = 'cancelled';
  job.error = '登录已取消';
  if (geminiLoginProfiles.get(job.profileId) === job.id) geminiLoginProfiles.delete(job.profileId);
  return { job };
});
app.post('/api/profiles/:id/login/device', { preHandler: ensureAuth }, async (req:any) => {
  const profile = await getProfile(String(req.params.id));
  if (!profile) throw new Error('profile not found');
  const jobId = crypto.randomBytes(12).toString('base64url');
  const job: LoginJob = { id:jobId, profileId:String(profile.id), output:[], status:'running', code:null, startedAt:Date.now(), newProfile:req.body?.newProfile === true };
  loginJobs.set(jobId, job);
  const child = spawn('codex', ['login','--device-auth'], { env:{...process.env, HOME:DEFAULT_HOME, CODEX_HOME:String(profile.codex_home)}, stdio:['ignore','pipe','pipe'] });
  const push = (s:string) => {
    for (const line of s.split(/\r?\n/).filter(Boolean)) job.output.push(line.replace(/(token|secret|password)[^\n]*/ig, '$1=[redacted]'));
    job.output = job.output.slice(-80);
    const parsed = parseDeviceLogin(job.output.join('\n'));
    if (parsed.loginUrl) job.loginUrl = parsed.loginUrl;
    if (parsed.deviceCode) job.deviceCode = parsed.deviceCode;
  };
  child.stdout.on('data', d=>push(d.toString()));
  child.stderr.on('data', d=>push(d.toString()));
  child.on('exit', async code => {
    job.code = code;
    job.status = code === 0 ? 'done' : 'error';
    if (code !== 0) (job as any).error = `codex login exited ${code}`;
    if (code !== 0 && job.newProfile) {
      await db.run('DELETE FROM codex_profiles WHERE id=?1 AND active=0', [String(profile.id)]).catch(()=>{});
      await deleteProfileDir(String(profile.codex_home)).catch(()=>{});
    }
    if (code === 0) {
      await ensureSharedCodexDirs(String(profile.codex_home)).catch(()=>{});
      await updateProfileEmailName(String(profile.id), String(profile.codex_home)).catch(()=>{});
      await activateProfile(String(profile.id)).catch(()=>{});
      if (!USE_AGENT_RUNTIME) await codex.switchCodexHome(String(profile.codex_home)).catch(()=>{});
      codexStatusCache = { expiresAt:0 };
    }
  });
  return { jobId, job };
});
app.get('/api/profile-login/:jobId', { preHandler: ensureAuth }, async (req:any, reply) => {
  const job = loginJobs.get(String(req.params.jobId));
  if (!job) return reply.code(404).send({error:'not found'});
  return { job };
});
app.post('/api/antigravity/profiles/login', { preHandler: ensureAuth }, async () => {
  const id = crypto.randomBytes(8).toString('hex');
  const homeDir = path.join(ANTIGRAVITY_PROFILES_DIR, id, 'home');
  await mkdir(homeDir, { recursive:true });
  await chmod(path.dirname(homeDir), 0o700).catch(()=>{});
  await chmod(homeDir, 0o700).catch(()=>{});
  const jobId = crypto.randomBytes(12).toString('base64url');
  const job: AntigravityLoginJob = { id:jobId, providerId:'antigravity', profileId:id, output:[], status:'running', code:null, startedAt:Date.now(), newProfile:true };
  antigravityLoginJobs.set(jobId, job);
  const child = pty.spawn(ANTIGRAVITY_BIN, [], {
    name: 'xterm-256color',
    cols: 96,
    rows: 32,
    cwd: homeDir,
    env: { ...process.env, HOME:homeDir, XDG_CONFIG_HOME:path.join(homeDir,'.config'), XDG_CACHE_HOME:path.join(homeDir,'.cache') },
  });
  antigravityLoginChildren.set(jobId, child);
  let selectedLoginMethod = false;
  let finalized = false;
  const finishLogin = async (email?:string|null) => {
    if (finalized) return;
    finalized = true;
    await finishAntigravityLoginJob(job, email);
  };
  const failLogin = async (message?:string) => {
    if (finalized) return;
    finalized = true;
    await failAntigravityLoginJob(job, message);
  };
  const push = (s:string) => {
    for (const line of stripAnsi(s).split(/\r?\n/).map(x=>x.trim()).filter(Boolean)) job.output.push(redactLine(line));
    job.output = job.output.slice(-120);
    const text = job.output.join('\n');
    if (!selectedLoginMethod && /Select login method|Google OAuth/i.test(text)) {
      selectedLoginMethod = true;
      setTimeout(() => child.write('\r'), 50);
    }
    const parsed = parseAntigravityLogin(text);
    if (parsed.loginUrl) job.loginUrl = parsed.loginUrl;
    if (parsed.authCodePrompt) job.authCodePrompt = true;
    const email = parseAntigravityAuthenticatedEmail(text);
    if (email || /OAuth:\s*authenticated successfully|authentication completed successfully/i.test(text)) {
      finishLogin(email).catch((e:any)=>failLogin(e?.message || String(e)));
    }
  };
  child.onData((d:string)=>push(d));
  child.onExit(async ({ exitCode }) => {
    antigravityLoginChildren.delete(jobId);
    if (finalized || job.status !== 'running') return;
    job.code = exitCode;
    const login = await antigravityLoginStatus(homeDir);
    if (login.ok) {
      await finishLogin(login.email);
    } else {
      await failLogin(exitCode !== 0 ? `agy login exited ${exitCode}` : 'Antigravity login did not complete');
    }
  });
  return { job };
});
app.post('/api/antigravity-login/:jobId/input', { preHandler: ensureAuth }, async (req:any, reply) => {
  const job = antigravityLoginJobs.get(String(req.params.jobId));
  const child = antigravityLoginChildren.get(String(req.params.jobId));
  if (!job) return reply.code(404).send({error:'login job not found'});
  await maybeFinishAntigravityLoginJob(job).catch(()=>{});
  if (job.status !== 'running') return { ok:true, job };
  if (!child) return reply.code(404).send({error:'login job not running'});
  const code = String(req.body?.code || '').trim();
  if (!/^[A-Za-z0-9_./~+=-]{4,4096}$/.test(code)) return reply.code(400).send({error:'bad code'});
  job.codeSubmitted = true;
  child.write(code + '\r');
  setTimeout(() => { maybeFinishAntigravityLoginJob(job).catch(()=>{}); }, 1200);
  setTimeout(() => { maybeFinishAntigravityLoginJob(job).catch(()=>{}); }, 3000);
  return { ok:true };
});
app.post('/api/antigravity/profiles/:id/switch', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await getAntigravityProfile(String(req.params.id));
  if (!profile) return reply.code(404).send({error:'profile not found'});
  await activateAntigravityProfile(String(profile.id));
  return { activeProfile: await getActiveAntigravityProfile() };
});
app.delete('/api/antigravity/profiles/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await getAntigravityProfile(String(req.params.id));
  if (!profile) return reply.code(404).send({error:'profile not found'});
  await db.run('DELETE FROM antigravity_profiles WHERE id=?1', [String(profile.id)]);
  await deleteAntigravityProfileDir(String(profile.home_dir)).catch(()=>{});
  return { ok:true };
});
app.get('/api/antigravity-login/:jobId', { preHandler: ensureAuth }, async (req:any, reply) => {
  const job = antigravityLoginJobs.get(String(req.params.jobId));
  if (!job) return reply.code(404).send({error:'not found'});
  await maybeFinishAntigravityLoginJob(job).catch(()=>{});
  return { job };
});
app.post('/api/login', { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } }, async (req:any, reply) => { const { username, password } = req.body || {}; const row = await db.get('SELECT * FROM users WHERE username = ?1', [username || 'admin']); if (!row || typeof password !== 'string' || !(await argon2.verify(String(row.password_hash), password))) return reply.code(401).send({error:'invalid login'}); const sid = crypto.randomBytes(32).toString('base64url'); const csrf = crypto.randomBytes(24).toString('base64url'); reply.setCookie(COOKIE_NAME, sid, { ...secureCookie(), signed:true }); reply.setCookie(CSRF_COOKIE, csrf, csrfCookie()); return { ok:true, csrf }; });
app.post('/api/logout', { preHandler: ensureAuth }, async (_req, reply) => { reply.clearCookie(COOKIE_NAME, {path:'/'}); reply.clearCookie(CSRF_COOKIE, {path:'/'}); return {ok:true}; });
app.get('/api/projects', { preHandler: ensureAuth }, async (req:any) => ({ roots, projects: await cachedProjects(req.query?.refresh === '1') }));
app.get('/api/sessions', { preHandler: ensureAuth }, async (req:any) => ({ sessions: await listIndexedThreads(req.query?.archived === '1') }));
app.post('/api/sessions', { preHandler: ensureAuth }, async (req:any, reply) => {
  let projectDir:string;
  try { projectDir = await validateProject(req.body?.projectDir || DEFAULT_WORKSPACE_DIR, roots); }
  catch { return reply.code(400).send({error:'project path is outside allowed workspace roots'}); }
  const provider = normalizeProvider(req.body?.providerId) || (await appSettings()).activeProvider;
  const title = String(req.body?.title || path.basename(projectDir));
  const settings = await appSettings();
  const mode = normalizeMode(req.body?.mode) || settings.defaultMode;
  if (provider === 'antigravity') {
    const status = await cachedAntigravityStatus();
    if (!status.ok) return reply.code(409).send({error:'Antigravity CLI 不可用，不能创建 Antigravity 会话'});
    const activeProfile:any = await getActiveAntigravityProfile();
    if (!activeProfile?.home_dir) return reply.code(409).send({error:'请先登录 Antigravity'});
    const login = await antigravityLoginStatus(String(activeProfile.home_dir));
    if (!login.ok) return reply.code(409).send({error:'请先登录 Antigravity'});
    const id = crypto.randomUUID();
    const now = Date.now();
    const model = cleanAgentModel(req.body?.model) || cleanAgentModel(settings.defaultModels?.antigravity) || null;
    const fields = modeFields(mode);
    await db.run(
      'INSERT INTO sessions (id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,model,archived,created_at,updated_at,provider_id,account_id,model_id,workspace_path,provider_session_id) VALUES (?1,?1,?2,?3,?4,?5,?6,?7,?8,0,?9,?9,?10,?11,?8,?2,?1)',
      [id, projectDir, title, 'idle', fields.permission_mode, fields.approval_policy, fields.sandbox_mode, model, now, 'antigravity', activeProfile.id]
    );
    return rowSessionDto(await findSession(id));
  }
  if (provider === 'gemini') {
    if (!USE_AGENT_RUNTIME) return reply.code(409).send({error:'Gemini ACP 需要 persistent runtime'});
    const status = await cachedGeminiStatus();
    if (!status.ok) return reply.code(409).send({error:status.error || 'Gemini CLI 不可用'});
    const activeProfile:any = await getActiveGeminiProfile();
    if (!activeProfile?.id || activeProfile.status !== 'authenticated') return reply.code(409).send({error:'请先登录 Gemini'});
    if (!activeProfile.login?.ok) return reply.code(409).send({error:'当前 Gemini 账户需要重新登录'});
    const id = crypto.randomUUID();
    const model = cleanAgentModel(req.body?.model) || cleanAgentModel(settings.defaultModels?.gemini) || null;
    const opts = modeOptions(mode, model || undefined);
    const created = await runtime.createGeminiSession({
      sessionId:id,
      accountId: activeProfile.id,
      cwd: projectDir,
      title,
      mode,
      model,
      approvalPolicy: opts.approvalPolicy,
      sandboxMode: opts.sandboxMode,
    });
    return rowSessionDto(created.session);
  }
  const model = cleanModel(req.body?.model) || cleanModel(settings.defaultModels?.codex);
  const activeProfile:any = await getActiveProfile();
  const accountId = activeProfile?.id || null;
  const opts = modeOptions(mode, model);
  if (USE_AGENT_RUNTIME) {
    const created = await runtime.createCodexSession({
      accountId: accountId || 'default',
      codexHome: activeProfile?.codex_home || DEFAULT_CODEX_HOME,
      cwd: projectDir,
      title,
      mode,
      model,
      approvalPolicy: opts.approvalPolicy,
      sandboxMode: opts.sandboxMode,
    });
    await upsertThread(created.thread, { title, archived: 0, status:'idle', model, account_id: accountId, ...modeFields(mode) });
    return sessionDto(created.thread, { title, status:'idle', archived:0, model, account_id: accountId, ...modeFields(mode) });
  }
  const started = await codex.startThread(projectDir, opts);
  const thread = started.thread;
  await upsertThread(thread, { title, archived: 0, status:'idle', model, account_id: accountId, ...modeFields(mode) });
  await codex.setName(thread.id, title).catch(()=>{});
  return sessionDto(thread, { title, status:'idle', archived:0, model, account_id: accountId, ...modeFields(mode) });
});
app.get('/api/sessions/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const requestId = req.id;
  const startedAt = Date.now();
  let row = await findSession(req.params.id);
  if (!row && USE_AGENT_RUNTIME) row = await runtimeDb.get('SELECT * FROM sessions WHERE id=?1 OR codex_thread_id=?1 OR upstream_thread_id=?1', [String(req.params.id)]).catch(()=>null);
  if (row && normalizeProvider(row.provider_id) === 'antigravity') {
    if (!pathAllowed(String(row.project_dir))) return reply.code(403).send({error:'workspace not allowed'});
    const thread = await antigravityThread(row);
    return { session: rowSessionDto(row), thread, branch: await gitBranch(String(row.project_dir)), interrupted: (row?.status === 'interrupted') };
  }
  const threadId = String(row?.codex_thread_id || req.params.id);
  if (USE_AGENT_RUNTIME) {
    if (!row) return reply.code(404).send({error:'not found'});
    if (!pathAllowed(String(row.project_dir))) return reply.code(403).send({error:'workspace not allowed'});
    const sqliteStartedAt = Date.now();
    const runtimeRow = await runtimeDb.get('SELECT * FROM sessions WHERE id=?1 OR codex_thread_id=?1 OR upstream_thread_id=?1', [threadId]).catch(()=>null) || row;
    if (runtimeRow?.status && runtimeRow.status !== row.status) {
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3', [String(runtimeRow.status), Date.now(), threadId]).catch(()=>{});
    }
    const thread = await runtimeThreadFromEvents(threadId, runtimeRow);
    decorateThreadImages(thread, threadId, String(runtimeRow.project_dir || row.project_dir));
    const [branch] = await Promise.all([
      gitBranch(String(runtimeRow.project_dir || row.project_dir)).catch(()=>null),
      injectGeneratedImages(thread, threadId).catch(()=>{}),
      injectArtifacts(thread, threadId).catch(()=>{}),
    ]);
    sanitizeThreadForMobile(thread);
    const snapshot = { coveredSequence:Number(runtimeRow?.last_sequence || 0), generation:String(runtimeRow?.upstream_generation || '') || null };
    app.log.info({ requestId, localSessionId:threadId, upstreamThreadId:String(runtimeRow?.upstream_thread_id || threadId), operation:'GET /api/sessions/:id', sqliteDurationMs:Date.now() - sqliteStartedAt, totalDurationMs:Date.now() - startedAt }, 'web session snapshot returned');
    return { session: rowSessionDto(runtimeRow), thread, snapshot, branch, interrupted: (runtimeRow?.status === 'interrupted') };
  }
  let read:any;
  try { read = await codex.readThread(threadId, true); }
  catch { if (!row) return reply.code(404).send({error:'not found'}); await codex.resumeThread(threadId, String(row.project_dir)).catch(()=>null); read = await codex.readThread(threadId, true); }
  if (!pathAllowed(read.thread.cwd)) return reply.code(403).send({error:'workspace not allowed'});
  await upsertThread(read.thread, { status: statusName(read.thread.status) });
  decorateThreadImages(read.thread, threadId, String(row?.project_dir || read.thread.cwd));
  await injectGeneratedImages(read.thread, threadId);
  await injectArtifacts(read.thread, threadId);
  sanitizeThreadForMobile(read.thread);
  return { session: await indexedSession(read.thread), thread: read.thread, branch: await gitBranch(read.thread.cwd), interrupted: (row?.status === 'interrupted') };
});
app.patch('/api/sessions/:id', { preHandler: ensureAuth }, async (req:any) => { const row = await findSession(req.params.id); const threadId = String(row?.codex_thread_id || req.params.id); const provider = normalizeProvider(row?.provider_id) || 'codex'; const title = String(req.body?.title || '').trim(); const mode = normalizeMode(req.body?.mode); if (title) { if (provider === 'codex') { if (USE_AGENT_RUNTIME) await runtime.setSessionTitle(threadId, title).catch(()=>{}); else await codex.setName(threadId, title); } await db.run('UPDATE sessions SET title=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[title, Date.now(), threadId]); } if (mode) { const fields = modeFields(mode); await db.run('UPDATE sessions SET permission_mode=?1, approval_policy=?2, sandbox_mode=?3, updated_at=?4 WHERE codex_thread_id=?5 OR id=?5',[fields.permission_mode, fields.approval_policy, fields.sandbox_mode, Date.now(), threadId]); } if (Object.prototype.hasOwnProperty.call(req.body || {}, 'model')) { const model = provider === 'antigravity' || provider === 'gemini' ? cleanAgentModel(req.body?.model) : cleanModel(req.body?.model); await db.run('UPDATE sessions SET model=?1, model_id=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[model || null, Date.now(), threadId]); } return {ok:true}; });
app.post('/api/sessions/:id/archive', { preHandler: ensureAuth }, async (req:any) => {
  const row = await findSession(req.params.id);
  const threadId = String(row?.codex_thread_id || req.params.id);
  const now = Date.now();
  if (!USE_AGENT_RUNTIME) await codex.archive(threadId).catch((e:any)=>app.log.warn({err:e.message}, 'official thread archive failed; archiving local index only'));
  await db.run('UPDATE sessions SET archived=1, archived_at=?1, updated_at=?1 WHERE codex_thread_id=?2 OR id=?2 OR provider_session_id=?2', [now, threadId]);
  await runtimeDb.run('UPDATE sessions SET archived=1, archived_at=?1, updated_at=?1 WHERE codex_thread_id=?2 OR id=?2 OR provider_session_id=?2 OR upstream_thread_id=?2', [now, threadId]).catch(()=>{});
  return {ok:true};
});
app.post('/api/sessions/:id/unarchive', { preHandler: ensureAuth }, async (req:any) => {
  const row = await findSession(req.params.id);
  const threadId = String(row?.codex_thread_id || req.params.id);
  const now = Date.now();
  if (!USE_AGENT_RUNTIME) await codex.unarchive(threadId).catch((e:any)=>app.log.warn({err:e.message}, 'official thread unarchive failed; restoring local index only'));
  await db.run('UPDATE sessions SET archived=0, archived_at=NULL, updated_at=?1 WHERE codex_thread_id=?2 OR id=?2 OR provider_session_id=?2', [now, threadId]);
  await runtimeDb.run('UPDATE sessions SET archived=0, archived_at=NULL, updated_at=?1 WHERE codex_thread_id=?2 OR id=?2 OR provider_session_id=?2 OR upstream_thread_id=?2', [now, threadId]).catch(()=>{});
  return {ok:true};
});
app.post('/api/sessions/:id/fork', { preHandler: ensureAuth }, async (req:any, reply) => { if (USE_AGENT_RUNTIME) return reply.code(409).send({error:'runtime 模式暂不支持 Fork，未创建重复会话'}); const row = await findSession(req.params.id); const threadId = String(row?.codex_thread_id || req.params.id); const mode = sessionMode(row); const model = await effectiveModel(row); const forked = await codex.fork(threadId, row?.project_dir ? String(row.project_dir) : undefined, modeOptions(mode, model)); await upsertThread(forked.thread, { status:'idle', model, ...modeFields(mode) }); return sessionDto(forked.thread, { model, ...modeFields(mode) }); });
app.delete('/api/sessions/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const row = await findSession(req.params.id);
  const runtimeRow = await runtimeDb.get('SELECT * FROM sessions WHERE id=?1 OR codex_thread_id=?1 OR provider_session_id=?1 OR upstream_thread_id=?1', [String(req.params.id)]).catch(()=>null);
  if (!row && !runtimeRow) return reply.code(404).send({error:'not found'});
  const ids = sessionIdentitySet(row, runtimeRow, String(req.params.id));
  if (!USE_AGENT_RUNTIME) {
    const threadId = String(row?.codex_thread_id || row?.id || req.params.id);
    let filePath:string|null = null;
    try { const read = await codex.readThread(threadId, false); filePath = read.thread.path; await codex.archive(threadId).catch(()=>{}); } catch {}
    if (filePath) await deleteRollout(filePath);
  }
  const result = await hardDeleteSessionData(ids);
  return {ok:true, deleted:result};
});
app.get('/api/sessions/:id/diff', { preHandler: ensureAuth }, async (req:any, reply) => { const row = await findSession(req.params.id); if (!row) return reply.code(404).send({error:'not found'}); return { diff: await gitDiff(String(row.project_dir)) }; });
app.post('/api/sessions/:id/attachments', { preHandler: ensureAuth }, async (req:any, reply) => {
  const row = await findSession(req.params.id);
  if (!row) return reply.code(404).send({error:'not found'});
  if (req.isMultipart?.()) return uploadMultipartAttachment(req, reply, row);
  const type = String(req.body?.type || '');
  const name = cleanFileName(String(req.body?.name || 'image'));
  const data = String(req.body?.data || '');
  const ext = IMAGE_TYPES[type];
  if (!ext) return reply.code(415).send({error:'unsupported image type'});
  const buffer = Buffer.from(data.replace(/^data:[^,]+,/, ''), 'base64');
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) return reply.code(413).send({error:'image is empty or too large'});
  if (!looksLikeImage(buffer, type)) return reply.code(400).send({error:'image content does not match type'});
  const threadId = String(row.codex_thread_id || row.id);
  const attachmentId = crypto.randomBytes(16).toString('base64url');
  const dir = path.join(ATTACHMENTS_DIR, threadId, attachmentId);
  await mkdir(dir, { recursive: true, mode:0o700 });
  const filename = cleanFileName(name).replace(/\.[^.]+$/, '') + ext;
  const filePath = path.join(dir, filename);
  const meta = { id: attachmentId, sessionId: threadId, name, type, mime:type, kind:'image', size: buffer.length, path: filePath, storagePath:filePath, createdAt: Date.now() };
  await writeFile(filePath, buffer, { flag: 'wx' });
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return attachmentDto(meta);
});
app.get('/api/sessions/:id/attachments/:attachmentId', { preHandler: ensureAuth }, async (req:any, reply) => {
  const row = await findSession(req.params.id);
  if (!row) return reply.code(404).send({error:'not found'});
  const meta = await readAttachmentMeta(String(row.codex_thread_id || row.id), String(req.params.attachmentId)).catch(()=>null);
  if (!meta) return reply.code(404).send({error:'not found'});
  const buffer = await readFile(meta.path);
  reply.header('Cache-Control', 'private, max-age=86400');
  reply.header('X-Content-Type-Options', 'nosniff');
  if (!safeInlineMime(meta.type || meta.mime)) reply.header('Content-Disposition', `attachment; filename="${String(meta.name || 'download').replace(/"/g, '_')}"`);
  return reply.type(meta.type || meta.mime || 'application/octet-stream').send(buffer);
});
app.get('/api/sessions/:id/image-file/:token', { preHandler: ensureAuth }, async (req:any, reply) => {
  const row = await findSession(req.params.id);
  if (!row) return reply.code(404).send({error:'not found'});
  const filePath = verifyPathToken(String(req.params.token));
  if (!filePath || !imageFileAllowed(filePath, String(row.project_dir), String(row.codex_thread_id || row.id))) return reply.code(403).send({error:'forbidden'});
  const type = mimeFromPath(filePath);
  if (!type) return reply.code(415).send({error:'unsupported image type'});
  const buffer = await readFile(filePath);
  reply.header('Cache-Control', 'private, max-age=300');
  return reply.type(type).send(buffer);
});
app.get('/api/sessions/:id/generated-images/:file', { preHandler: ensureAuth }, async (req:any, reply) => {
  const row = await findSession(req.params.id);
  if (!row) return reply.code(404).send({error:'not found'});
  const threadId = String(row.codex_thread_id || row.id);
  const file = String(req.params.file || '');
  if (!/^ig_[A-Za-z0-9]+\.png$/.test(file)) return reply.code(400).send({error:'bad file'});
  const root = realpathSync(path.join(generatedImagesDir(), threadId));
  const filePath = path.join(root, file);
  const rp = realpathSync(filePath);
  if (!rp.startsWith(root + path.sep)) return reply.code(403).send({error:'forbidden'});
  reply.header('Cache-Control', 'private, max-age=86400');
  return reply.type('image/png').send(await readFile(rp));
});
app.get('/api/sessions/:id/files/:artifactId', { preHandler: ensureAuth }, async (req:any, reply) => {
  const row = await findSession(req.params.id);
  if (!row) return reply.code(404).send({error:'not found'});
  const artifact = await artifactForSession(String(row.codex_thread_id || row.id), String(req.params.artifactId));
  if (!artifact) return reply.code(404).send({error:'not found'});
  reply.header('Content-Disposition', `attachment; filename="${String(artifact.name).replace(/"/g, '_')}"`);
  reply.header('Cache-Control', 'private, max-age=86400');
  return reply.type(String(artifact.mime)).send(await readFile(String(artifact.path)));
});
app.post('/api/sessions/:id/stop', { preHandler: ensureAuth }, async (req:any) => { await stopTurn(String(req.params.id)); return {ok:true}; });
app.post('/api/approvals/:requestId', { preHandler: ensureAuth }, async (req:any, reply) => {
  cleanupPendingApprovals();
  const requestKey = String(req.params.requestId);
  if (requestKey.startsWith('gemini-')) {
    const decision = req.body?.decision === 'decline' ? 'decline' : 'accept';
    const options = Array.isArray(req.body?.options) ? req.body.options : [];
    const preferred = decision === 'accept'
      ? options.find((option:any) => String(option?.kind || '').startsWith('allow')) || options[0]
      : options.find((option:any) => String(option?.kind || '').startsWith('reject')) || options[0];
    await runtime.answerGeminiApproval(requestKey, { optionId: preferred?.optionId || null });
    return {ok:true};
  }
  const pending = pendingApprovals.get(requestKey);
  if (!pending) return reply.code(404).send({error:'approval request not found'});
  pendingApprovals.delete(requestKey);
  const decision = req.body?.decision === 'decline' ? 'decline' : 'accept';
  codex.respond(pending.id, approvalResponse(pending.method, decision));
  return {ok:true};
});
app.get('/api/wireguard/config/:name', { preHandler: ensureAuth }, async (req:any, reply) => {
  const name = String(req.params.name || '');
  if (!/^[A-Za-z0-9_.-]+\.conf$/.test(name)) return reply.code(404).send({error:'not found'});
  const filePath = path.join(DATA_DIR, 'wireguard', name);
  const root = realpathSync(path.join(DATA_DIR, 'wireguard'));
  const rp = realpathSync(filePath);
  if (!rp.startsWith(root + path.sep)) return reply.code(403).send({error:'forbidden'});
  reply.header('Content-Disposition', `attachment; filename="${name}"`);
  reply.header('Cache-Control', 'no-store');
  return reply.type('application/x-wireguard-profile').send(await readFile(rp));
});
app.get('/icons/:file', async (req:any, reply) => {
  const file = String(req.params.file || '');
  if (!/^[A-Za-z0-9_.-]+$/.test(file)) return reply.code(404).send({error:'not found'});
  return reply.sendFile(`icons/${file}`);
});
app.get('/ws', { websocket: true }, async (connection:any, req:any) => { const ws = connection.socket || connection; const origin = req.headers.origin; if (origin && !ALLOWED_ORIGINS.includes(origin)) return ws.close(1008, 'origin'); const sid = req.cookies?.[COOKIE_NAME]; if (!sid || !app.unsignCookie(sid).valid) return ws.close(1008, 'auth'); ws.on('message', async (raw:Buffer) => { try { const msg = JSON.parse(raw.toString()); if (msg.type === 'join') await joinAndResume(String(msg.sessionId), ws, Number(msg.lastSequence || 0)); if (msg.type === 'send') await sendTurn(String(msg.sessionId), String(msg.text || ''), Array.isArray(msg.attachments) ? msg.attachments : [], String(msg.clientMessageId || '')); if (msg.type === 'sendChunkStart') startChunkedMessage(msg); if (msg.type === 'sendChunk') appendChunkedMessage(msg); if (msg.type === 'sendChunkEnd') await finishChunkedMessage(msg); if (msg.type === 'stop') await stopTurn(String(msg.sessionId)); } catch (e:any) { ws.send(JSON.stringify({type:'error', error:e.message})); } }); ws.on('close', () => { for (const set of clients.values()) set.delete(ws); }); });
app.setNotFoundHandler(async (req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({error:'not found'}) : reply.sendFile('index.html'));
codex.on('notification', async (msg:any) => {
  const sid = await sessionIdForThread(msg.params?.threadId || msg.params?.thread?.id);
  if (sid) {
    if (msg.method === 'turn/started') {
      activeCodexSessions.add(sid);
      if (msg.params?.turn?.id) activeTurns.set(sid, String(msg.params.turn.id));
    }
    if (msg.method === 'thread/tokenUsage/updated') threadTokenUsage.set(sid, msg.params?.tokenUsage);
    if (shouldBroadcastCodexNotification(msg)) broadcast(sid, { type:'codex', method:msg.method, params:msg.params });
    if (msg.method === 'turn/completed') {
      activeCodexSessions.delete(sid);
      activeTurns.delete(sid);
      const row = await findSession(sid);
      const anchorItemId = row ? await latestAgentItemId(sid, String(row.project_dir)).catch(()=>null) : null;
      const found = row ? await scanArtifacts(sid, String(row.project_dir), artifactScanStarts.get(sid) || Date.now(), anchorItemId) : [];
      artifactScanStarts.delete(sid);
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['idle',Date.now(),sid]);
      if (found.length) broadcast(sid, { type:'codex', method:'item/completed', params:{ item:artifactMessageItem(found, Date.now()) } });
      maybeExitAfterDrain();
    }
    if (msg.method === 'thread/status/changed') await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[statusName(msg.params?.status),Date.now(),sid]).catch(()=>{});
  }
});
codex.on('request', async (msg:any) => {
  const sid = await sessionIdForThread(msg.params?.threadId);
  const row = sid ? await findSession(sid) : null;
  if (!row || sessionMode(row) === 'yolo') {
    codex.respond(msg.id, approvalResponse(msg.method, 'accept'));
    return;
  }
  pendingApprovals.set(String(msg.id), { id: msg.id, method: String(msg.method || ''), createdAt: Date.now() });
  cleanupPendingApprovals();
  if (sid) broadcast(sid, { type:'approval', requestId: msg.id, method: msg.method, params: msg.params });
});
codex.on('stderr', (line:string) => app.log.warn({ codex: line }));
if (USE_AGENT_RUNTIME) await runtime.ensureDefaultCodexAccount().catch((e:any) => app.log.warn({ err:e?.message || String(e) }, 'agent runtime is not ready'));
else await codex.ensure();
const host = process.env.HOST || '127.0.0.1'; const port = Number(process.env.PORT || 3842);
await app.listen({ host, port });
setTimeout(() => cleanupArchivedSessions('startup').catch(e => app.log.error({ err:e }, 'archived session cleanup failed')), 30_000).unref();
setInterval(() => cleanupArchivedSessions('scheduled').catch(e => app.log.error({ err:e }, 'archived session cleanup failed')), Math.max(60_000, ARCHIVED_SESSION_CLEANUP_INTERVAL_MS)).unref();
process.on('SIGTERM', () => requestGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => requestGracefulShutdown('SIGINT'));
function activeAgentTurnCount() { return activeCodexSessions.size + activeAntigravityTurns.size; }
function requestGracefulShutdown(signal:string) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  if (USE_AGENT_RUNTIME) {
    app.log.info({ signal }, 'runtime mode web shutdown; exiting without waiting for agent turns');
    process.exit(0);
  }
  const active = activeAgentTurnCount();
  if (!active) {
    app.log.info({ signal }, 'shutting down immediately');
    process.exit(0);
  }
  app.log.warn({ signal, activeCodex: activeCodexSessions.size, activeAntigravity: activeAntigravityTurns.size }, 'shutdown requested; waiting for active agent turns');
  for (const sessionId of new Set([...activeCodexSessions, ...activeAntigravityTurns.keys()])) {
    broadcast(sessionId, { type:'system', text:'服务将在当前回复完成后重启' });
  }
}
function maybeExitAfterDrain() {
  if (!shutdownRequested || activeAgentTurnCount()) return;
  app.log.info('active agent turns drained; exiting for restart');
  setTimeout(() => process.exit(0), 50);
}
async function ensureAdmin() { const row = await db.get('SELECT * FROM users WHERE username=?1',['admin']); if (row) return; const pw = process.env.ADMIN_PASSWORD; if (!pw || pw.length < 12) throw new Error('ADMIN_PASSWORD must be set and at least 12 chars'); const hash = await argon2.hash(pw, { type: argon2.argon2id }); await db.run('INSERT INTO users (username,password_hash,created_at) VALUES (?1,?2,?3)', ['admin', hash, Date.now()]); }
async function cachedProjects(force = false) {
  if (!force) return projectsCache.value || [];
  if (projectsCache.promise) return projectsCache.promise;
  projectsCache.promise = scanProjects(roots).then(projects => {
    projectsCache = { value: projects, expiresAt: Date.now() + PROJECTS_CACHE_MS };
    return projects;
  }).catch(err => {
    projectsCache.promise = undefined;
    throw err;
  });
  return projectsCache.promise;
}
async function cachedCodexStatus() {
  const now = Date.now();
  if (codexStatusCache.value && codexStatusCache.expiresAt > now) return codexStatusCache.value;
  if (codexStatusCache.promise) return codexStatusCache.promise;
  codexStatusCache.promise = codexStatus().then(status => {
    codexStatusCache = { value: status, expiresAt: Date.now() + CODEX_STATUS_CACHE_MS };
    return status;
  }).catch(err => {
    codexStatusCache.promise = undefined;
    throw err;
  });
  return codexStatusCache.promise;
}
async function cachedAntigravityStatus(force = false) {
  return cachedProviderStatus(
    antigravityStatusCache,
    cache => { antigravityStatusCache = cache; },
    'antigravity.status',
    force,
    () => antigravity.status()
  );
}
async function cachedGeminiStatus(force = false) {
  return cachedProviderStatus(
    geminiStatusCache,
    cache => { geminiStatusCache = cache; },
    'geminiProvider.status',
    force,
    () => geminiProvider.status({ forceAcpHelp: force })
  );
}
async function cachedProviderStatus(
  cache: { expiresAt:number; promise?:Promise<any>; value?:any },
  update: (cache:{ expiresAt:number; promise?:Promise<any>; value?:any }) => void,
  label: string,
  force: boolean,
  read: () => Promise<any>
) {
  const now = Date.now();
  if (!force && cache.value && cache.expiresAt > now) return cache.value;
  if (!force && cache.promise) return cache.promise;
  const startedAt = Date.now();
  const promise = read().then(status => {
    const ms = Date.now() - startedAt;
    app.log.info({ ms }, `${label} computed`);
    const ttl = status?.ok ? PROVIDER_STATUS_OK_CACHE_MS : PROVIDER_STATUS_FAIL_CACHE_MS;
    const next = { value: status, expiresAt: Date.now() + ttl };
    update(next);
    return status;
  }).catch(err => {
    app.log.info({ ms:Date.now() - startedAt }, `${label} failed`);
    update({ expiresAt: 0 });
    throw err;
  });
  update({ ...cache, promise });
  return promise;
}
async function ensureProfiles() {
  await mkdir(PROFILES_DIR, { recursive:true });
  const existing = await db.get('SELECT * FROM codex_profiles LIMIT 1');
  if (!existing) {
    const email = await readProfileEmail(DEFAULT_CODEX_HOME).catch(()=>null);
    await db.run('INSERT INTO codex_profiles (id,name,codex_home,active,created_at,updated_at) VALUES (?1,?2,?3,1,?4,?4)', ['default', email || 'Codex Account', DEFAULT_CODEX_HOME, Date.now()]);
  }
  const profiles = await db.all('SELECT codex_home FROM codex_profiles');
  for (const profile of profiles) await ensureSharedCodexDirs(String(profile.codex_home)).catch(err => console.warn('shared session setup failed', profile.codex_home, err?.message || err));
  const active:any = await getActiveProfile();
  if (!USE_AGENT_RUNTIME && active?.codex_home) await codex.switchCodexHome(String(active.codex_home));
  if (active?.id && active?.codex_home) await updateProfileEmailName(String(active.id), String(active.codex_home)).catch(()=>{});
  const settings = await appSettings();
  if (!settings.defaultMode) await setSetting('defaultMode', 'yolo');
}
async function ensureGeminiProfiles() {
  await mkdir(GEMINI_PROFILES_DIR, { recursive:true, mode:0o700 });
  await chmod(path.dirname(GEMINI_PROFILES_DIR), 0o700).catch(()=>{});
  await chmod(GEMINI_PROFILES_DIR, 0o700).catch(()=>{});
  const defaultHome = process.env.GEMINI_PROFILE_ROOT || path.join(GEMINI_PROFILES_DIR, 'default');
  if (existsSync(defaultHome)) {
    await mkdir(defaultHome, { recursive:true, mode:0o700 });
    await chmod(defaultHome, 0o700).catch(()=>{});
    const existing = await getGeminiProfile('default');
    const login = await geminiLoginStatus(defaultHome, existing?.auth_type ? String(existing.auth_type) : null).catch(()=>({ ok:false, email:null, text:'Not logged in', authType:null }));
    const name = login.email || existing?.name || 'Gemini Account';
    const state = login.ok ? 'authenticated' : (existing?.status || 'bootstrap');
    const active = login.ok ? Number(existing?.active || 0) : 0;
    await db.run(
      `INSERT INTO gemini_profiles (id,name,home_dir,auth_type,active,status,created_at,updated_at)
       VALUES ('default',?1,?2,?3,?4,?5,?6,?6)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, home_dir=excluded.home_dir, auth_type=COALESCE(gemini_profiles.auth_type, excluded.auth_type), active=excluded.active, status=CASE WHEN gemini_profiles.status='disabled' THEN 'disabled' ELSE excluded.status END, updated_at=excluded.updated_at`,
      [name, defaultHome, login.authType || existing?.auth_type || null, active, state, Date.now()]
    );
  }
  await ensureGeminiActiveProfile();
  await db.run("UPDATE sessions SET account_id='default' WHERE provider_id='gemini' AND (account_id IS NULL OR account_id='')").catch(()=>{});
  await runtimeDb.run("UPDATE sessions SET account_id='default' WHERE (provider_id='gemini' OR provider='gemini') AND (account_id IS NULL OR account_id='')").catch(()=>{});
}
async function ensureSharedCodexDirs(codexHome:string) {
  await mkdir(codexHome, { recursive:true });
  await mkdir(SHARED_SESSIONS_DIR, { recursive:true });
  await mkdir(SHARED_GENERATED_IMAGES_DIR, { recursive:true });
  await ensureSharedDirLink(codexHome, 'sessions', SHARED_SESSIONS_DIR);
  await ensureSharedDirLink(codexHome, 'generated_images', SHARED_GENERATED_IMAGES_DIR);
}
async function ensureSharedDirLink(codexHome:string, name:string, sharedDir:string) {
  const localDir = path.join(codexHome, name);
  const existing = await lstat(localDir).catch(()=>null);
  if (existing?.isSymbolicLink()) {
    try { if (realpathSync(localDir) === realpathSync(sharedDir)) return; } catch {}
    await rm(localDir, { force:true });
  } else if (existing?.isDirectory()) {
    try { if (realpathSync(localDir) === realpathSync(sharedDir)) return; } catch {}
    await copyDirContents(localDir, sharedDir);
    const backup = `${localDir}.local-${Date.now()}`;
    await rename(localDir, backup).catch(async () => { await rm(localDir, { recursive:true, force:true }); });
  } else if (existing) {
    await rm(localDir, { force:true });
  }
  await symlink(sharedDir, localDir, 'dir').catch(async (err:any) => {
    if (err?.code === 'EEXIST') return;
    throw err;
  });
}
async function copyDirContents(from:string, to:string) {
  let entries:any[] = [];
  try { entries = await readdir(from, { withFileTypes:true }); } catch { return; }
  await mkdir(to, { recursive:true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    await cp(src, dst, { recursive:true, force:false, errorOnExist:true }).catch((err:any) => {
      if (err?.code !== 'ERR_FS_CP_EEXIST' && err?.code !== 'EEXIST') throw err;
    });
  }
}
async function appSettings() {
  const rows = await db.all('SELECT key,value FROM settings');
  const map = Object.fromEntries(rows.map((r:any)=>[r.key, r.value]));
  const activeProvider = normalizeProvider(map.activeProvider) || 'codex';
  const legacyCodexModel = cleanModel(map.defaultModel) || '';
  const legacyAntigravityModel = legacyCodexModel ? '' : (cleanAgentModel(map.defaultModel) || '');
  const defaultModels = {
    codex: cleanModel(map.defaultModelCodex) || legacyCodexModel,
    gemini: cleanAgentModel(map.defaultModelGemini) || '',
    antigravity: cleanAgentModel(map.defaultModelAntigravity) || legacyAntigravityModel,
  };
  return {
    activeProvider,
    defaultMode: normalizeMode(map.defaultMode) || 'yolo',
    defaultModel: activeProvider === 'antigravity' ? defaultModels.antigravity : activeProvider === 'gemini' ? defaultModels.gemini : defaultModels.codex,
    defaultModels,
  };
}
async function setSetting(key:string, value:string) { await db.run('INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, value]); }
async function listProfiles() {
  const rows = await db.all('SELECT id,name,codex_home,active,created_at,updated_at FROM codex_profiles ORDER BY active DESC, updated_at DESC');
  return Promise.all(rows.map(async (p:any)=>{
    const login = await profileLoginStatus(String(p.codex_home));
    return { ...p, name: login.email || profileDisplayName(p.name), active:Number(p.active || 0), login };
  }));
}
async function getProfile(id:string) { return db.get('SELECT id,name,codex_home,active,created_at,updated_at FROM codex_profiles WHERE id=?1', [id]); }
async function getActiveProfile() {
  const p = await db.get('SELECT id,name,codex_home,active,created_at,updated_at FROM codex_profiles WHERE active=1 ORDER BY updated_at DESC LIMIT 1');
  if (!p) return null;
  const login = await profileLoginStatus(String(p.codex_home));
  return { ...p, name: login.email || profileDisplayName(p.name), active:Number(p.active || 0), login };
}
async function activateProfile(id:string) {
  await db.run('UPDATE codex_profiles SET active=0');
  await db.run('UPDATE codex_profiles SET active=1, updated_at=?1 WHERE id=?2', [Date.now(), id]);
}
async function syncDefaultCodexAppServerEnv(codexHome:string) {
  const file = path.join(DATA_DIR, 'agentdeck-app-server-default.env');
  const body = [
    `HOME=${DEFAULT_HOME}`,
    `CODEX_HOME=${codexHome}`,
    `CODEX_APP_SERVER_LISTEN=ws://127.0.0.1:${Number(process.env.CODEX_APP_SERVER_DEFAULT_PORT || 4668)}`,
    '',
  ].join('\n');
  await writeFile(file, body, { mode:0o600 });
  await chmod(file, 0o600).catch(()=>{});
}
async function deleteProfileDir(codexHome:string) {
  const root = realpathSync(PROFILES_DIR);
  if (!codexHome.startsWith(PROFILES_DIR + path.sep)) return;
  const parent = path.dirname(realpathSync(codexHome));
  if (!parent.startsWith(root + path.sep)) return;
  await rm(parent, { recursive:true, force:true });
}
function geminiHomeForProfile(id:string) {
  if (!/^[a-f0-9]{16}$/i.test(id)) throw new Error('invalid Gemini profile id');
  return path.join(GEMINI_PROFILES_DIR, id, 'home');
}
async function listGeminiProfiles() {
  const rows = await db.all("SELECT id,name,home_dir,auth_type,active,status,created_at,updated_at FROM gemini_profiles WHERE COALESCE(status,'configured') NOT IN ('bootstrap','disabled') ORDER BY active DESC, updated_at DESC");
  return Promise.all(rows.map((p:any) => geminiProfileDto(p)));
}
async function getGeminiProfile(id:string) {
  return db.get('SELECT id,name,home_dir,auth_type,active,status,created_at,updated_at FROM gemini_profiles WHERE id=?1', [id]);
}
async function getGeminiProfileDto(id:string, options:{ includeHidden?:boolean } = {}) {
  const row = await getGeminiProfile(id);
  if (!row) return null;
  const state = geminiProfileState(row);
  if (!options.includeHidden && (state === 'bootstrap' || state === 'disabled')) return null;
  return geminiProfileDto(row);
}
async function getActiveGeminiProfile() {
  const row = await db.get("SELECT id,name,home_dir,auth_type,active,status,created_at,updated_at FROM gemini_profiles WHERE active=1 AND COALESCE(status,'configured')='authenticated' ORDER BY updated_at DESC LIMIT 1");
  return row ? geminiProfileDto(row) : null;
}
async function activateGeminiProfile(id:string) {
  await db.run('UPDATE gemini_profiles SET active=0');
  await db.run('UPDATE gemini_profiles SET active=1, updated_at=?1 WHERE id=?2', [Date.now(), id]);
}
async function geminiProfileDto(row:any) {
  const login = await geminiLoginStatus(String(row.home_dir), String(row.auth_type || '') || null);
  const name = login.email || (String(row.name || '').trim() && row.name !== 'Gemini Account' ? row.name : 'Gemini Account');
  const state = geminiProfileState(row, login);
  return {
    id:String(row.id),
    name,
    active: state === 'authenticated' ? Number(row.active || 0) : 0,
    status: state,
    authType: row.auth_type || login.authType || null,
    login,
    created_at:Number(row.created_at || 0),
    updated_at:Number(row.updated_at || 0),
  };
}
function geminiProfileState(row:any, login?:any):'bootstrap'|'configured'|'authenticated'|'disabled' {
  const explicit = String(row?.status || '').trim();
  if (explicit === 'disabled') return 'disabled';
  if (login?.ok || explicit === 'authenticated') return 'authenticated';
  if (explicit === 'bootstrap') return 'bootstrap';
  return row?.auth_type ? 'configured' : 'configured';
}
async function getReusableGeminiBootstrapProfile() {
  const visible = await db.get("SELECT id FROM gemini_profiles WHERE COALESCE(status,'configured') NOT IN ('bootstrap','disabled') LIMIT 1");
  if (visible?.id) return null;
  return db.get("SELECT id,name,home_dir,auth_type,active,status,created_at,updated_at FROM gemini_profiles WHERE COALESCE(status,'bootstrap')='bootstrap' ORDER BY CASE WHEN id='default' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1");
}
async function ensureGeminiActiveProfile() {
  const active = await db.get("SELECT id FROM gemini_profiles WHERE active=1 AND COALESCE(status,'configured')='authenticated' LIMIT 1");
  if (active?.id) {
    await db.run("UPDATE gemini_profiles SET active=0 WHERE active=1 AND id<>?1", [String(active.id)]).catch(()=>{});
    return;
  }
  await db.run('UPDATE gemini_profiles SET active=0').catch(()=>{});
  const next = await db.get("SELECT id FROM gemini_profiles WHERE COALESCE(status,'configured')='authenticated' ORDER BY updated_at DESC LIMIT 1");
  if (next?.id) await db.run('UPDATE gemini_profiles SET active=1, updated_at=?1 WHERE id=?2', [Date.now(), String(next.id)]).catch(()=>{});
}
async function refreshGeminiProfileName(id:string, homeDir:string, authType:string|null) {
  const login = await geminiLoginStatus(homeDir, authType);
  if (login.email || login.authType) {
    await db.run("UPDATE gemini_profiles SET name=COALESCE(?1,name), auth_type=COALESCE(?2,auth_type), status=CASE WHEN ?5=1 THEN 'authenticated' ELSE status END, updated_at=?3 WHERE id=?4", [login.email || null, login.authType || null, Date.now(), id, login.ok ? 1 : 0]);
    if (login.ok) await activateGeminiProfile(id);
  }
}
async function geminiLoginStatus(homeDir:string, authType:string|null = null) {
  const secretFile = path.join(homeDir, 'agentdeck.env');
  const hasApiKey = await geminiSecretEnvHas(secretFile, 'GEMINI_API_KEY').catch(()=>false);
  const email = await scanGeminiEmail(homeDir).catch(()=>null);
  const detectedAuthType = authType || (hasApiKey ? 'api_key' : (email ? GEMINI_GOOGLE_AUTH_TYPE : null));
  const ok = hasApiKey || !!email;
  return { ok, email, text: ok ? 'Logged in' : 'Not logged in', authType: detectedAuthType };
}
async function geminiSecretEnvHas(file:string, key:string) {
  if (!existsSync(file)) return false;
  const text = await readFile(file, 'utf8');
  return text.split(/\r?\n/).some(line => line.trimStart().startsWith(`${key}=`) && line.split('=').slice(1).join('=').trim().length > 0);
}
async function scanGeminiEmail(homeDir:string) {
  const roots = [path.join(homeDir, '.gemini'), path.join(homeDir, '.config', 'gemini')];
  for (const root of roots) {
    const found = await limitedEmailScan(root, 0, { files:0 });
    if (found) return found;
  }
  return null;
}
async function limitedEmailScan(dir:string, depth:number, state:{ files:number }): Promise<string|null> {
  if (depth > 3 || state.files > 40) return null;
  let entries:any[] = [];
  try { entries = await readdir(dir, { withFileTypes:true }); } catch { return null; }
  for (const entry of entries) {
    if (state.files > 40) return null;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/^(config|oauth|auth|account|profiles?|\.gemini)$/i.test(entry.name) && depth > 0) continue;
      const found = await limitedEmailScan(p, depth + 1, state);
      if (found) return found;
    } else if (entry.isFile() && /^(settings|oauth|auth|account|credentials|projects)\.(json|toml|yaml|yml|txt)$/i.test(entry.name)) {
      const st = await stat(p).catch(()=>null);
      if (!st || st.size > 256 * 1024) continue;
      state.files++;
      const text = await readFile(p, 'utf8').catch(()=>'');
      const found = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0];
      if (found) return found.slice(0, 120);
    }
  }
  return null;
}
async function geminiSessionReferenceCount(profileId:string) {
  const web = await db.get("SELECT COUNT(*) count FROM sessions WHERE provider_id='gemini' AND account_id=?1", [profileId]).catch(()=>({ count:0 }));
  const runtime = await runtimeDb.get("SELECT COUNT(*) count FROM sessions WHERE (provider_id='gemini' OR provider='gemini') AND account_id=?1", [profileId]).catch(()=>({ count:0 }));
  return Number(web?.count || 0) + Number(runtime?.count || 0);
}
async function runGeminiLoginJob(job:GeminiLoginJob, body:any) {
  const profile:any = await getGeminiProfile(job.profileId);
  if (!profile) throw new Error('profile not found');
  if (job.status === 'cancelled') return;
  job.status = 'verifying';
  const method = job.methodId.toLowerCase();
  if (method === 'api_key' || method === 'apikey' || method.includes('api')) {
    const apiKey = String(body.apiKey || '').trim();
    if (!/^[A-Za-z0-9_.-]{20,}$/.test(apiKey)) throw new Error('Gemini API Key 格式不正确');
    await writeGeminiProfileSecret(String(profile.home_dir), { GEMINI_API_KEY: apiKey });
    await db.run("UPDATE gemini_profiles SET auth_type='api_key', status='configured', updated_at=?1 WHERE id=?2", [Date.now(), job.profileId]);
    await runtime.restartGeminiProfile(job.profileId).catch(()=>null);
    const status = await runtime.initializeGeminiProfile(job.profileId).catch((e:any)=>({ error:safeGeminiError(e) }));
    if (status?.error) throw new Error(String(status.error));
    await refreshGeminiProfileName(job.profileId, String(profile.home_dir), 'api_key').catch(()=>{});
    await db.run("UPDATE gemini_profiles SET status='authenticated', active=1, updated_at=?1 WHERE id=?2", [Date.now(), job.profileId]);
    await db.run('UPDATE gemini_profiles SET active=0 WHERE id<>?1', [job.profileId]).catch(()=>{});
    job.status = 'done';
    return;
  }
  if (method.includes('oauth') || method.includes('google')) {
    await runGeminiGoogleLoginWorker(job, String(profile.home_dir));
    return;
  }
  if (method.includes('vertex') || method.includes('gateway')) {
    job.status = 'error';
    job.error = '该 Gemini 登录方式需要额外的受控配置表单，本版本暂未在 Web 中启用。';
    return;
  }
  const initialized = await runtime.initializeGeminiProfile(job.profileId).catch((e:any)=>({ error:safeGeminiError(e) }));
  if (initialized?.error) throw new Error(String(initialized.error));
  const authMethods = Array.isArray(initialized?.authMethods) ? initialized.authMethods : [];
  const selected = authMethods.find((m:any) => String(m?.id || '') === job.methodId);
  if (!selected) throw new Error('Gemini ACP 未返回该登录方式');
  if (String(selected.type || '').toLowerCase() === 'terminal') {
    job.status = 'waiting_user';
    job.error = '当前 Gemini CLI 的 Google OAuth 通过终端交互完成；远程网页模式暂不桥接 loopback 登录。请通过 SSH 使用该 Profile 的 HOME/GEMINI_CONFIG_DIR 完成登录后点击重新检测。';
    return;
  }
  await runtime.authenticateGeminiProfile(job.profileId, job.methodId);
  await runtime.restartGeminiProfile(job.profileId).catch(()=>null);
  const verified = await runtime.initializeGeminiProfile(job.profileId).catch((e:any)=>({ error:safeGeminiError(e) }));
  if (verified?.error) throw new Error(String(verified.error));
  if (Array.isArray(verified?.authMethods) && verified.authMethods.length) throw new Error('Gemini 登录未完成，请重新检测或改用 API Key/Vertex');
  await refreshGeminiProfileName(job.profileId, String(profile.home_dir), null).catch(()=>{});
  await db.run("UPDATE gemini_profiles SET status='authenticated', active=1, updated_at=?1 WHERE id=?2", [Date.now(), job.profileId]);
  await db.run('UPDATE gemini_profiles SET active=0 WHERE id<>?1', [job.profileId]).catch(()=>{});
  job.status = 'done';
}
async function runGeminiGoogleLoginWorker(job:GeminiLoginJob, homeDir:string) {
  await ensureGeminiOAuthSettings(homeDir);
  const bin = process.env.GEMINI_BIN || '/usr/bin/gemini';
  const configDir = geminiConfigDir(homeDir);
  const fallbackCommand = `HOME=${shellQuote(homeDir)} GEMINI_CONFIG_DIR=${shellQuote(configDir)} NO_BROWSER=true ${shellQuote(bin)} --skip-trust`;
  job.fallbackCommand = fallbackCommand;
  job.output = [];
  let child:any = null;
  let finalized = false;
  let timeout:NodeJS.Timeout|null = null;
  let completeResolve:(()=>void)|null = null;
  let rawOutput = '';
  const complete = new Promise<void>(resolve => { completeResolve = resolve; });
  const finalize = async (fn:()=>Promise<void>|void) => {
    if (finalized) return;
    finalized = true;
    if (timeout) clearTimeout(timeout);
    geminiLoginWorkers.delete(job.id);
    await fn();
    completeResolve?.();
  };
  try {
    child = pty.spawn(bin, ['--skip-trust'], {
      name: 'xterm-256color',
      cols: 96,
      rows: 32,
      cwd: homeDir,
      env: geminiCliEnv(homeDir, { NO_BROWSER:'true' }),
    });
    geminiLoginWorkers.set(job.id, child);
  } catch (e:any) {
    job.status = 'fallback';
    job.error = `无法启动 Gemini Google 登录进程：${safeGeminiError(e)}。请通过 SSH 执行下面的完整命令完成登录，然后点击重新检测。`;
    return;
  }
  job.status = 'preparing';
  timeout = setTimeout(() => {
    finalize(async () => {
      try { child?.kill(); } catch {}
      if (job.status === 'done' || job.status === 'cancelled') return;
      job.status = 'error';
      job.error = 'Gemini Google 登录超时，登录进程已清理。';
    }).catch(()=>{});
  }, GEMINI_LOGIN_TIMEOUT_MS);
  const handleOutput = (chunk:string) => {
    rawOutput = (rawOutput + String(chunk || '')).slice(-12000);
    const sanitized = redactGeminiLoginOutput(chunk);
    for (const line of stripAnsi(sanitized).split(/\r?\n/).map(x=>x.trim()).filter(Boolean)) {
      job.output!.push(line);
    }
    job.output = job.output!.slice(-120);
    const parsed = parseGeminiGoogleLogin(rawOutput);
    if (parsed.invalidReason && job.status !== 'cancelled') {
      finalize(async () => {
        try { child?.kill(); } catch {}
        job.status = 'error';
        job.error = parsed.invalidReason;
      }).catch(()=>{});
      return;
    }
    if (parsed.loginUrl) {
      job.loginUrl = parsed.loginUrl;
      job.status = 'waiting_user';
      job.error = undefined;
    }
    if (parsed.requiresCodeInput) {
      job.requiresCodeInput = true;
      if (job.loginUrl) job.status = 'waiting_user';
    }
    if (parsed.failure && job.status !== 'cancelled') {
      finalize(async () => {
        try { child?.kill(); } catch {}
        job.status = 'error';
        job.error = parsed.failure || 'Gemini Google 登录失败';
      }).catch(()=>{});
    }
  };
  child.onData((d:string)=>handleOutput(d));
  child.onExit(async ({ exitCode }:any) => {
    await finalize(async () => {
      if (job.status === 'cancelled' || job.status === 'error' || job.status === 'done') return;
      try {
        const login = await geminiLoginStatus(homeDir, GEMINI_GOOGLE_AUTH_TYPE).catch(()=>({ ok:false }));
        if (exitCode === 0 && login.ok) {
          await finishGeminiGoogleLoginJob(job, homeDir);
        } else {
          job.status = 'error';
          job.error = exitCode === 0 ? 'Gemini 登录进程已退出，但未检测到有效 Google 登录。' : `Gemini 登录进程退出，code=${exitCode}`;
        }
      } catch (e:any) {
        job.status = 'error';
        job.error = safeGeminiError(e);
      }
    });
  });
  await complete;
}
async function finishGeminiGoogleLoginJob(job:GeminiLoginJob, homeDir:string) {
  job.status = 'verifying';
  await db.run("UPDATE gemini_profiles SET auth_type=?1, status='configured', updated_at=?2 WHERE id=?3", [GEMINI_GOOGLE_AUTH_TYPE, Date.now(), job.profileId]);
  await runtime.restartGeminiProfile(job.profileId).catch(()=>null);
  const initialized = await runtime.initializeGeminiProfile(job.profileId).catch((e:any)=>({ error:safeGeminiError(e) }));
  if (initialized?.error) throw new Error(String(initialized.error));
  const verifySessionId = `gemini-login-verify-${job.profileId}-${crypto.randomBytes(6).toString('hex')}`;
  await runtime.createGeminiSession({
    sessionId: verifySessionId,
    accountId: job.profileId,
    cwd: DEFAULT_WORKSPACE_DIR,
    title: 'Gemini login verification',
    permissionMode: 'read-only',
    approvalPolicy: 'never',
    sandboxMode: 'read-only',
  }).catch((e:any) => { throw new Error(safeGeminiError(e)); });
  const login = await geminiLoginStatus(homeDir, GEMINI_GOOGLE_AUTH_TYPE);
  if (!login.ok || !login.email) throw new Error('Gemini ACP 验证通过，但未读取到 Google 登录邮箱');
  await db.run("UPDATE gemini_profiles SET name=?1, auth_type=?2, status='authenticated', active=1, updated_at=?3 WHERE id=?4", [login.email, GEMINI_GOOGLE_AUTH_TYPE, Date.now(), job.profileId]);
  await db.run('UPDATE gemini_profiles SET active=0 WHERE id<>?1', [job.profileId]).catch(()=>{});
  job.status = 'done';
  delete job.error;
}
function geminiConfigDir(homeDir:string) {
  return path.join(homeDir, '.gemini');
}
function geminiCliEnv(homeDir:string, extra:Record<string,string> = {}) {
  const configDir = geminiConfigDir(homeDir);
  const env:Record<string,string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'CI' || key === 'CONTINUOUS_INTEGRATION' || key.startsWith('CI_')) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: homeDir,
    GEMINI_CONFIG_DIR: configDir,
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    XDG_CACHE_HOME: path.join(homeDir, '.cache'),
    ...extra,
  };
}
async function ensureGeminiOAuthSettings(homeDir:string) {
  await mkdir(homeDir, { recursive:true, mode:0o700 });
  await chmod(homeDir, 0o700).catch(()=>{});
  const configDir = geminiConfigDir(homeDir);
  await mkdir(configDir, { recursive:true, mode:0o700 });
  await chmod(configDir, 0o700).catch(()=>{});
  const settingsFile = path.join(configDir, 'settings.json');
  let settings:any = {};
  try { settings = JSON.parse(await readFile(settingsFile, 'utf8')); } catch { settings = {}; }
  settings.security = settings.security && typeof settings.security === 'object' ? settings.security : {};
  settings.security.auth = settings.security.auth && typeof settings.security.auth === 'object' ? settings.security.auth : {};
  settings.security.auth.selectedType = GEMINI_GOOGLE_AUTH_TYPE;
  await writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n', { mode:0o600 });
  await chmod(settingsFile, 0o600).catch(()=>{});
}
function parseGeminiGoogleLogin(output:string) {
  const text = stripAnsi(output).replace(/\r/g, '').replace(/[^\S\n]+/g, ' ');
  const requiresCodeInput = /Enter the authorization code|authorization code|authcode|paste .*code/i.test(text);
  const loginUrlResult = extractGeminiUserCodeLoginUrl(text, requiresCodeInput);
  const failureMatch = text.match(/(Error authenticating:[^\n]+|FatalAuthenticationError:[^\n]+|Manual authorization is required[^\n]+|authentication failed[^\n]*|invalid_grant[^\n]*)/i);
  const success = /authenticated successfully|authentication completed successfully|login successful/i.test(text);
  return { loginUrl: loginUrlResult.loginUrl, invalidReason: loginUrlResult.invalidReason, requiresCodeInput, success, failure: failureMatch?.[1] ? redactLine(failureMatch[1]).slice(0, 500) : null };
}
function extractGeminiUserCodeLoginUrl(text:string, complete:boolean): { loginUrl?:string; invalidReason?:string } {
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
function validateGeminiUserCodeLoginUrl(rawUrl:string, complete:boolean): { loginUrl?:string; invalidReason?:string } {
  let parsed:URL;
  try { parsed = new URL(rawUrl); } catch { return complete ? { invalidReason:'Gemini CLI 输出的 Google 授权 URL 无效' } : {}; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'accounts.google.com') {
    return { invalidReason:'Gemini CLI 输出的授权 URL 不是 Google OAuth 地址' };
  }
  if (!/^\/o\/oauth2\/v2\/auth\/?$/.test(parsed.pathname)) {
    return { invalidReason:'Gemini CLI 输出的授权 URL 不是手工授权码流程' };
  }
  const required = ['client_id','redirect_uri','response_type','scope','state','code_challenge'];
  const missing = required.filter(key => !parsed.searchParams.get(key));
  if (missing.length) return complete ? { invalidReason:`Gemini CLI 输出的授权 URL 缺少参数：${missing.join(', ')}` } : {};
  if (parsed.searchParams.get('redirect_uri') !== GEMINI_USER_CODE_REDIRECT_URI) {
    return { invalidReason:'Gemini CLI 授权 URL redirect_uri 不是手工授权码地址' };
  }
  if (parsed.searchParams.get('response_type') !== 'code') {
    return { invalidReason:'Gemini CLI 授权 URL response_type 不是 code' };
  }
  if (!parsed.searchParams.get('prompt')) parsed.searchParams.set('prompt', 'select_account');
  return { loginUrl: parsed.toString() };
}
function redactGeminiLoginOutput(text:string) {
  return String(text || '')
    .replace(/([?&](?:code|client_secret|token|refresh_token|access_token|id_token)=)[^&\s]+/ig, '$1[redacted]')
    .replace(/(authorization code\s*:?\s*)[A-Za-z0-9_./~+=-]{4,}/ig, '$1[redacted]')
    .replace(/(access_token|refresh_token|id_token|client_secret)\s*[:=]\s*[^\s]+/ig, '$1=[redacted]');
}
async function writeGeminiProfileSecret(homeDir:string, values:Record<string,string>) {
  await mkdir(homeDir, { recursive:true, mode:0o700 });
  await chmod(homeDir, 0o700).catch(()=>{});
  const allowed = new Set(['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_CLOUD_PROJECT','GOOGLE_CLOUD_LOCATION','GOOGLE_APPLICATION_CREDENTIALS']);
  const existing:Record<string,string> = await readGeminiSecretEnv(path.join(homeDir, 'agentdeck.env')).catch(()=>({} as Record<string,string>));
  const next:Record<string,string> = { ...existing };
  for (const [key, value] of Object.entries(values)) {
    if (allowed.has(key) && value) next[key] = value;
  }
  const body = Object.entries(next)
    .filter(([key]) => allowed.has(key))
    .map(([key, value]) => `${key}=${envFileQuote(value)}`)
    .join('\n') + '\n';
  const file = path.join(homeDir, 'agentdeck.env');
  await writeFile(file, body, { mode:0o600 });
  await chmod(file, 0o600).catch(()=>{});
}
async function removeGeminiProfileSecret(homeDir:string, key:string) {
  const file = path.join(homeDir, 'agentdeck.env');
  const existing:Record<string,string> = await readGeminiSecretEnv(file).catch(()=>({} as Record<string,string>));
  delete existing[key];
  const body = Object.entries(existing).map(([k, v]) => `${k}=${envFileQuote(v)}`).join('\n');
  await writeFile(file, body ? body + '\n' : '', { mode:0o600 });
  await chmod(file, 0o600).catch(()=>{});
}
async function readGeminiSecretEnv(file:string) {
  const allowed = new Set(['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_CLOUD_PROJECT','GOOGLE_CLOUD_LOCATION','GOOGLE_APPLICATION_CREDENTIALS']);
  const text = await readFile(file, 'utf8');
  const env:Record<string,string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!allowed.has(key)) continue;
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}
function envFileQuote(value:string) {
  return JSON.stringify(String(value || ''));
}
function sanitizeGeminiRuntimeStatus(status:any) {
  if (!status || typeof status !== 'object') return status;
  const { profileDir, ...rest } = status;
  return rest;
}
function safeGeminiError(e:any) {
  return redactLine(String(e?.message || e || 'Gemini request failed')).replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-api-key]');
}
async function deleteGeminiProfileDir(homeDir:string) {
  const root = realpathSync(GEMINI_PROFILES_DIR);
  const resolvedHome = realpathSync(homeDir);
  if (resolvedHome === root || !resolvedHome.startsWith(root + path.sep)) return;
  const parent = path.dirname(resolvedHome);
  if (parent === root || parent.startsWith(root + path.sep)) await rm(parent, { recursive:true, force:true });
}
async function listAntigravityProfiles() {
  await syncAntigravityProfilesFromDisk().catch(()=>{});
  const rows = await db.all('SELECT id,name,home_dir,active,created_at,updated_at FROM antigravity_profiles ORDER BY active DESC, updated_at DESC');
  const profiles = await Promise.all(rows.map(async (p:any)=>{
    const login = await antigravityLoginStatus(String(p.home_dir));
    const name = login.email || (String(p.name || '').trim() && p.name !== 'Google Account' ? p.name : 'Antigravity Account');
    return { ...p, name, active:Number(p.active || 0), login };
  }));
  return profiles.filter(Boolean);
}
async function getActiveAntigravityProfile() {
  await syncAntigravityProfilesFromDisk().catch(()=>{});
  const p = await db.get('SELECT id,name,home_dir,active,created_at,updated_at FROM antigravity_profiles WHERE active=1 ORDER BY updated_at DESC LIMIT 1');
  if (!p) return null;
  const login = await antigravityLoginStatus(String(p.home_dir));
  const name = login.email || (String(p.name || '').trim() && p.name !== 'Google Account' ? p.name : 'Antigravity Account');
  return { ...p, name, active:Number(p.active || 0), login };
}
async function getAntigravityProfile(id:string) { return db.get('SELECT id,name,home_dir,active,created_at,updated_at FROM antigravity_profiles WHERE id=?1', [id]); }
async function activateAntigravityProfile(id:string) {
  await db.run('UPDATE antigravity_profiles SET active=0');
  await db.run('UPDATE antigravity_profiles SET active=1, updated_at=?1 WHERE id=?2', [Date.now(), id]);
}
async function syncAntigravityProfilesFromDisk() {
  let dirs:any[] = [];
  try { dirs = await readdir(ANTIGRAVITY_PROFILES_DIR, { withFileTypes:true }); } catch { return; }
  const existingActive = await db.get('SELECT id FROM antigravity_profiles WHERE active=1 LIMIT 1');
  let activated = !!existingActive;
  for (const entry of dirs) {
    if (!entry.isDirectory() || !/^[a-f0-9]{16}$/i.test(entry.name)) continue;
    const homeDir = antigravityHomeForProfile(entry.name);
    const login = await antigravityLoginStatus(homeDir);
    if (!login.ok) continue;
    const name = login.email || await antigravityProfileName(homeDir).catch(()=>null) || 'Antigravity Account';
    const active = activated ? 0 : 1;
    await db.run('INSERT INTO antigravity_profiles (id,name,home_dir,active,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name, home_dir=excluded.home_dir, updated_at=excluded.updated_at', [entry.name, name, homeDir, active, Date.now()]);
    if (!activated) {
      await setSetting('activeProvider', 'antigravity').catch(()=>{});
      activated = true;
    }
  }
}
function antigravityHomeForProfile(id:string) {
  return path.join(ANTIGRAVITY_PROFILES_DIR, id, 'home');
}
async function finishAntigravityLoginJob(job:AntigravityLoginJob, email?:string|null) {
  const child = antigravityLoginChildren.get(job.id);
  const homeDir = antigravityHomeForProfile(job.profileId);
  const login = await antigravityLoginStatus(homeDir);
  const name = email || login.email || await antigravityProfileName(homeDir).catch(()=>null) || 'Antigravity Account';
  const now = Date.now();
  await db.run('INSERT INTO antigravity_profiles (id,name,home_dir,active,created_at,updated_at) VALUES (?1,?2,?3,0,?4,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name, home_dir=excluded.home_dir, updated_at=excluded.updated_at', [job.profileId, name, homeDir, now]);
  await activateAntigravityProfile(job.profileId).catch(()=>{});
  await setSetting('activeProvider', 'antigravity').catch(()=>{});
  job.status = 'done';
  job.code = 0;
  job.error = undefined;
  antigravityLoginChildren.delete(job.id);
  try { child?.kill(); } catch {}
}
async function failAntigravityLoginJob(job:AntigravityLoginJob, message?:string) {
  const homeDir = antigravityHomeForProfile(job.profileId);
  job.status = 'error';
  job.error = message || job.error || 'Antigravity login did not complete';
  antigravityLoginChildren.delete(job.id);
  await db.run('DELETE FROM antigravity_profiles WHERE id=?1 AND active=0', [job.profileId]).catch(()=>{});
  await deleteAntigravityProfileDir(homeDir).catch(()=>{});
}
async function maybeFinishAntigravityLoginJob(job:AntigravityLoginJob) {
  if (job.status !== 'running') return false;
  const homeDir = antigravityHomeForProfile(job.profileId);
  const login = await antigravityLoginStatus(homeDir);
  if (!login.ok) return false;
  await finishAntigravityLoginJob(job, login.email);
  return true;
}
async function antigravityLoginStatus(homeDir:string) {
  try {
    const email = await scanEmail(path.join(homeDir, '.gemini')).catch(()=>null);
    const tokenFile = path.join(homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    const ok = existsSync(tokenFile) || !!email;
    return { ok, email, text: ok ? 'Logged in' : 'Not logged in' };
  } catch (e:any) {
    return { ok:false, email:null, text: String(e?.message || 'Not logged in') };
  }
}
async function antigravityProfileName(homeDir:string) {
  return await scanEmail(path.join(homeDir, '.gemini')).catch(()=>null) || 'Antigravity Account';
}
function antigravityUsage(homeDir:string): Promise<string|null> {
  return new Promise((resolve) => {
    let output = '';
    let sent = false;
    let done = false;
    const child = pty.spawn(ANTIGRAVITY_BIN, [], {
      name: 'xterm-256color',
      cols: 100,
      rows: 36,
      cwd: homeDir,
      env: { ...process.env, HOME:homeDir, XDG_CONFIG_HOME:path.join(homeDir,'.config'), XDG_CACHE_HOME:path.join(homeDir,'.cache') },
    });
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      const text = cleanAgentOutput(output).split(/\r?\n/).map(s=>s.trim()).filter(Boolean).filter(s=>!isTerminalControlNoise(s)).slice(-80).join('\n');
      resolve(isUsefulAntigravityUsage(text) ? text : null);
    };
    const timer = setTimeout(finish, 8000);
    child.onData((d:string) => {
      output += d;
      if (!sent && /send a message|Type|Welcome|Antigravity/i.test(stripAnsi(output))) {
        sent = true;
        setTimeout(() => child.write('/usage\r'), 500);
      }
    });
    child.onExit(() => finish());
  });
}
async function scanEmail(dir:string, depth = 0): Promise<string|null> {
  if (depth > 5) return null;
  let entries:any[] = [];
  try { entries = await readdir(dir, { withFileTypes:true }); } catch { return null; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await scanEmail(p, depth + 1);
      if (found) return found;
    } else if (entry.isFile() && /\.(json|log|txt|toml|yaml|yml)$/i.test(entry.name)) {
      const text = await readFile(p, 'utf8').catch(()=>'');
      const found = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0];
      if (found) return found.slice(0, 120);
    }
  }
  return null;
}
async function deleteAntigravityProfileDir(homeDir:string) {
  const root = realpathSync(ANTIGRAVITY_PROFILES_DIR);
  if (!homeDir.startsWith(ANTIGRAVITY_PROFILES_DIR + path.sep)) return;
  const parent = path.dirname(realpathSync(homeDir));
  if (!parent.startsWith(root + path.sep)) return;
  await rm(parent, { recursive:true, force:true });
}
async function profileLoginStatus(codexHome:string) {
  const email = await readProfileEmail(codexHome).catch(()=>null);
  const ok = existsSync(path.join(codexHome, 'auth.json'));
  return { ok, email, text: ok ? 'Logged in' : 'Not logged in' };
}
async function updateProfileEmailName(id:string, codexHome:string) {
  const email = await readProfileEmail(codexHome).catch(()=>null);
  if (!email) return;
  await setProfileName(id, email);
}
async function setProfileName(id:string, name:string) { await db.run('UPDATE codex_profiles SET name=?1, updated_at=?2 WHERE id=?3', [name, Date.now(), id]); }
async function readProfileEmail(codexHome:string): Promise<string|null> {
  const raw = await readFile(path.join(codexHome, 'auth.json'), 'utf8');
  const json = JSON.parse(raw);
  const found = findEmail(json);
  return found ? found.slice(0, 120) : null;
}
function findEmail(value:any): string|null {
  if (!value) return null;
  if (typeof value === 'string') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
  if (Array.isArray(value)) { for (const x of value) { const found = findEmail(x); if (found) return found; } return null; }
  if (typeof value === 'object') {
    for (const key of ['email','email_address','account_email','login']) {
      const found = findEmail(value[key]);
      if (found) return found;
    }
    for (const x of Object.values(value)) {
      const found = findEmail(x);
      if (found) return found;
    }
  }
  return null;
}
function cleanProfileName(name:string) { return name.replace(/[^\w .@-]/g, '_').trim().slice(0, 60) || 'Codex Account'; }
function profileDisplayName(name:any){ const v = String(name || '').trim(); return v && v !== 'Default' ? v : 'ChatGPT'; }
function isEmail(value:string){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function parseDeviceLogin(output:string) {
  const text = stripAnsi(output).replace(/[^\S\r\n]+/g, ' ');
  const loginUrl = text.match(/https?:\/\/[^\s)]+/i)?.[0]?.replace(/[),.]+$/, '');
  const codeMatch = text.match(/\b([A-Z0-9]{4})\s*-\s*([A-Z0-9]{4,5})\b/i);
  const deviceCode = codeMatch ? `${codeMatch[1]}-${codeMatch[2]}`.toUpperCase() : undefined;
  return { loginUrl, deviceCode };
}
function parseAntigravityLogin(output:string) {
  const text = stripAnsi(output).replace(/[^\S\r\n]+/g, ' ');
  const compact = stripAnsi(output).replace(/\s+/g, '');
  const loginUrl = compact.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?.*?state=[A-Za-z0-9_-]+/i)?.[0]?.replace(/[),.]+$/, '');
  const authCodePrompt = /authorization code|paste .*code|输入.*code/i.test(text);
  return { loginUrl, authCodePrompt };
}
function parseAntigravityAuthenticatedEmail(output:string) {
  const text = stripAnsi(output).replace(/[^\S\r\n]+/g, ' ');
  const match = text.match(/authenticated successfully as\s+([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i)
    || text.match(/email=([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i)
    || text.match(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/);
  return match?.[1]?.slice(0, 120) || null;
}
function stripAnsi(text:string){ return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\u001b\u009b][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''); }
function cleanAgentOutput(text:string) {
  let cleaned = stripAnsi(String(text || ''))
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\uFFFD+/g, '')
    .trim();
  if ((cleaned.match(/\n/g) || []).length < 2 && /\\n/.test(cleaned)) {
    cleaned = cleaned.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t').trim();
  }
  return cleaned;
}
function isTerminalControlNoise(line:string){ return !/[A-Za-z0-9\u4e00-\u9fff]/.test(line) || /^[?;=<>0-9\s()[\]{}|/\\._:-]+$/.test(line); }
function isUsefulAntigravityUsage(text:string){ return /usage|quota|limit|额度|剩余|remaining|tokens?|requests?|reset/i.test(text) && text.length > 20; }
function redactLine(line:string){ return line.replace(/(token|secret|password|refresh_token|access_token)[^\n]*/ig, '$1=[redacted]'); }
function shellQuote(value:string) { return `'${value.replaceAll("'", "'\\''")}'`; }
function normalizeMode(value:any) { const v = String(value || ''); return ['yolo','workspace-write','read-only'].includes(v) ? v : null; }
function normalizeProvider(value:any): AgentProviderId | null { const v = String(value || ''); return v === 'codex' || v === 'gemini' || v === 'antigravity' ? v : null; }
function cleanModel(value:any) { const v = String(value || '').trim(); return /^[\w./:-]{1,120}$/.test(v) ? v : ''; }
function cleanAgentModel(value:any) { const v = String(value || '').trim(); return /^[\w ./:()+-]{1,160}$/.test(v) ? v : ''; }
function modeFields(mode:string) {
  if (mode === 'read-only') return { permission_mode:'read-only', approval_policy:'on-request', sandbox_mode:'read-only' };
  if (mode === 'workspace-write') return { permission_mode:'workspace-write', approval_policy:'on-request', sandbox_mode:'workspace-write' };
  return { permission_mode:'yolo', approval_policy:'never', sandbox_mode:'danger-full-access' };
}
function modeOptions(mode:string, model?:string) { const f = modeFields(mode); return { approvalPolicy:f.approval_policy, sandboxMode:f.sandbox_mode, model:cleanModel(model) || cleanAgentModel(model) || undefined }; }
function sessionMode(row:any) { return normalizeMode(row?.permission_mode) || (row?.sandbox_mode === 'read-only' ? 'read-only' : row?.sandbox_mode === 'workspace-write' ? 'workspace-write' : 'yolo'); }
function modeLabel(mode:string) { if (mode === 'read-only') return 'Read Only'; if (mode === 'workspace-write') return 'Workspace Write'; return 'YOLO · Full Access'; }
async function effectiveModel(row:any) { const settings = await appSettings(); return cleanModel(row?.model) || cleanModel(settings.defaultModels?.codex) || undefined; }
function providerModelCatalog(result:any) {
  const models = Array.isArray(result?.models) ? result.models : [];
  const normalized = models.map((m:any) => {
    const id = String(m.id || m.model || '').trim();
    return {
      id,
      model: String(m.model || id),
      actualModel: String(m.actualModel || m.model || id),
      displayName: String(m.displayName || m.name || m.model || id),
      description: String(m.description || ''),
      hidden: !!m.hidden,
      isDefault: !!m.isDefault,
      inputModalities: m.inputModalities || [],
      upgrade: m.upgrade || null,
    };
  }).filter((m:any)=>m.id && m.model);
  return { models: normalized, current: String(result?.current || normalized.find((m:any)=>m.isDefault)?.model || normalized[0]?.model || ''), error: result?.error || null };
}
async function modelCatalog(includeHidden = false, provider: AgentProviderId = 'codex') {
  if (provider === 'gemini') {
    const runtimeStatus = USE_AGENT_RUNTIME ? await runtime.geminiStatus().catch((e:any)=>({ error:e?.message || String(e) })) : null;
    const configOptions = runtimeStatus?.runtime?.configOptions || runtimeStatus?.configOptions || [];
    const modelOptions = Array.isArray(configOptions)
      ? configOptions.filter((opt:any) => String(opt.category || '').includes('model') || String(opt.id || opt.name || '').toLowerCase().includes('model'))
      : [];
    return {
      models: [],
      current: '',
      error: modelOptions.length ? null : 'Gemini CLI ACP 当前没有返回稳定的模型列表；保持 CLI 当前配置。',
      configOptions: modelOptions,
    };
  }
  if (provider === 'antigravity') {
    const activeProfile:any = await getActiveAntigravityProfile();
    if (!activeProfile?.home_dir) return { models: [], current: '', error: '请先登录 Antigravity，再读取模型列表' };
    const login = await antigravityLoginStatus(String(activeProfile.home_dir));
    if (!login.ok) return { models: [], current: '', error: '请先登录 Antigravity，再读取模型列表' };
    const homeDir = String(activeProfile.home_dir);
    const cacheKey = `${homeDir}:${includeHidden ? 'hidden' : 'visible'}`;
    if (antigravityModelsCache.key === cacheKey && antigravityModelsCache.value && antigravityModelsCache.expiresAt > Date.now()) {
      return antigravityModelsCache.value;
    }
    if (antigravityModelsCache.key === cacheKey && antigravityModelsCache.promise) {
      return antigravityModelsCache.promise;
    }
    const promise = antigravity.listModels(includeHidden, {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: path.join(homeDir, '.config'),
      XDG_CACHE_HOME: path.join(homeDir, '.cache'),
    }).then((result:any) => providerModelCatalog(result)).then((result:any) => {
      antigravityModelsCache = { key:cacheKey, value:result, expiresAt:Date.now() + (result?.models?.length ? 5 * 60_000 : 15_000) };
      return result;
    }).catch((e:any) => {
      antigravityModelsCache = { key:cacheKey, value:null, expiresAt:0 };
      throw e;
    });
    antigravityModelsCache = { key:cacheKey, promise, expiresAt:Date.now() + 30_000 };
    return promise;
  }
  const runtimeCatalog = USE_AGENT_RUNTIME ? await runtime.models(includeHidden).catch(()=>null) : null;
  const [models, config] = runtimeCatalog ? [
    { status:'fulfilled', value:runtimeCatalog.models } as PromiseFulfilledResult<any>,
    { status:'fulfilled', value:runtimeCatalog.config } as PromiseFulfilledResult<any>
  ] : await Promise.allSettled([codex.models(includeHidden), codex.config()]);
  const data = models.status === 'fulfilled' ? (models.value?.data || []) : [];
  const current = (config.status === 'fulfilled' ? cleanModel(config.value?.config?.model || config.value?.model) : '') || cleanModel(data.find((m:any)=>m?.isDefault)?.id || data[0]?.id || data.find((m:any)=>m?.isDefault)?.model || data[0]?.model);
  return {
    models: data.map((m:any)=>({ id:String(m.id || m.model), model:String(m.id || m.model), actualModel:String(m.model || m.id), displayName:String(m.displayName || m.model || m.id), description:String(m.description || ''), hidden:!!m.hidden, isDefault:!!m.isDefault, inputModalities:m.inputModalities || [], upgrade:m.upgrade || null })),
    current,
    error: models.status === 'rejected' ? models.reason?.message || String(models.reason) : null,
  };
}
function generatedImagesDir(){ return SHARED_GENERATED_IMAGES_DIR; }
async function currentSessionUsage(id:string) {
  const row = await findSession(id);
  if (!row) return { supported:false, error:'session not found' };
  const threadId = String(row.codex_thread_id || row.id);
  const liveUsage = threadTokenUsage.get(threadId);
  const read = await codex.readThread(threadId, true);
  const usage:any[] = [];
  collectUsage(read.thread, usage);
  if (liveUsage) usage.push(liveUsage);
  const totals = usage.reduce((acc:any, u:any) => {
    const flat = u?.total && typeof u.total === 'object' ? u.total : u;
    for (const [k,v] of Object.entries(flat)) if (typeof v === 'number') acc[k] = Math.max(acc[k] || 0, v);
    return acc;
  }, {});
  return { supported: usage.length > 0, totals, last: liveUsage?.last || null, modelContextWindow: liveUsage?.modelContextWindow || null, turns: read.thread?.turns?.length || 0, note: usage.length ? null : 'Codex 当前协议没有返回会话级额度/usage' };
}
function collectUsage(value:any, out:any[]) {
  if (!value || typeof value !== 'object') return;
  if (value.usage && typeof value.usage === 'object') out.push(value.usage);
  if (value.tokenUsage && typeof value.tokenUsage === 'object') out.push(value.tokenUsage);
  for (const v of Array.isArray(value) ? value : Object.values(value)) collectUsage(v, out);
}
async function codexStatus(){ try { const codexHome = codex.getCodexHome(); const {stdout}=await execFileAsync('codex',['--version'], { env:{...process.env, HOME:DEFAULT_HOME, CODEX_HOME:codexHome} }); return { ok:true, version:stdout.trim(), appServer:true, sessionsPath:path.join(codexHome,'sessions') }; } catch(e:any) { return { ok:false, error:e.message }; } }
function codexProviderStatus(status:any) {
  return {
    id: 'codex',
    displayName: 'Codex',
    ok: !!status?.ok,
    installed: !!status?.ok,
    version: status?.version || null,
    error: status?.ok ? null : (status?.error || 'Codex CLI 不可用'),
    command: 'codex',
  };
}
function attachmentCapabilities(geminiRuntime:any = null) {
  return {
    imageInput: true,
    imageOutput: true,
    fileInput: false,
    attachmentTypes: Object.keys(IMAGE_TYPES),
    maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
    maxAttachmentsPerMessage: Number(process.env.MAX_ATTACHMENTS_PER_MESSAGE || 10),
    maxTotalAttachmentBytes: Number(process.env.MAX_TOTAL_ATTACHMENT_BYTES || 64 * 1024 * 1024),
    providers: {
      codex: { imageInput:true, fileInput:false, fileTransport:'path' },
      gemini: {
        imageInput: !!geminiRuntime?.capabilities?.promptCapabilities?.image,
        fileInput: true,
        fileTransport: geminiRuntime?.capabilities?.promptCapabilities?.embeddedContext ? 'embedded' : 'resource-link',
        loadSession: !!geminiRuntime?.capabilities?.loadSession,
      },
      antigravity: { imageInput:true, fileInput:false, fileTransport:'path' },
    },
  };
}
function pathAllowed(p:string){ try { const rp = realpathSync(p); return roots.some(r => rp === r || rp.startsWith(r + path.sep)); } catch { return false; } }
async function findSession(id:string){ return db.get('SELECT * FROM sessions WHERE id=?1 OR codex_thread_id=?1',[id]); }
async function upsertThread(thread:any, extra:any = {}) { if (!thread?.id || !pathAllowed(thread.cwd)) return; const existing:any = await findSession(String(thread.id)); const title = cleanTitle(extra.title || existing?.title || thread.name || thread.preview, thread.cwd); const now = Date.now(); const mode = normalizeMode(extra.permission_mode) || 'yolo'; const fields = { ...modeFields(mode), ...extra }; const model = cleanModel(fields.model); await db.run("INSERT INTO sessions (id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,model,archived,created_at,updated_at,provider_id,account_id,model_id,workspace_path,provider_session_id) VALUES (?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'codex',?12,?8,?2,?1) ON CONFLICT(id) DO UPDATE SET codex_thread_id=excluded.codex_thread_id, project_dir=excluded.project_dir, title=excluded.title, status=excluded.status, archived=excluded.archived, provider_id=COALESCE(sessions.provider_id,'codex'), account_id=COALESCE(sessions.account_id,excluded.account_id), model_id=excluded.model_id, workspace_path=excluded.workspace_path, provider_session_id=excluded.provider_session_id, updated_at=excluded.updated_at", [thread.id, thread.cwd, title, extra.status || statusName(thread.status), fields.permission_mode, fields.approval_policy, fields.sandbox_mode, model || null, extra.archived ?? 0, (thread.createdAt || Math.floor(now/1000))*1000, (thread.updatedAt || Math.floor(now/1000))*1000, fields.account_id || null]); }
async function indexedSession(thread:any){ const row = await findSession(thread.id); return sessionDto(thread, row || undefined); }
function sessionDto(thread:any, row:any = {}) { const fields = modeFields(sessionMode(row)); const providerId = normalizeProvider(row.provider_id) || 'codex'; const model = providerId === 'codex' ? cleanModel(row.model) : cleanAgentModel(row.model); const modelId = providerId === 'codex' ? cleanModel(row.model_id) || model : cleanAgentModel(row.model_id) || model; return { id: thread.id, codex_thread_id: thread.id, provider_id: providerId, providerId, provider_session_id: row.provider_session_id || thread.id, account_id: row.account_id || null, workspace_path: row.workspace_path || thread.cwd, project_dir: thread.cwd, title: cleanTitle(row.title || thread.name || thread.preview, thread.cwd), status: row.status || statusName(thread.status), permission_mode:row.permission_mode || fields.permission_mode, approval_policy:row.approval_policy || fields.approval_policy, sandbox_mode:row.sandbox_mode || fields.sandbox_mode, model, model_id:modelId, archived: Number(row.archived || 0), created_at: (thread.createdAt || 0)*1000, updated_at: (thread.updatedAt || 0)*1000, last_sequence:Number(row.last_sequence || 0), path: thread.path || null }; }
function threadFromRow(row:any) {
  const now = Date.now();
  return {
    id: String(row.codex_thread_id || row.id),
    name: String(row.title || projectNameFromPath(String(row.project_dir || 'Session'))),
    preview: String(row.title || ''),
    cwd: String(row.project_dir),
    status: { type:String(row.status || 'idle') },
    createdAt: Math.floor(Number(row.created_at || now) / 1000),
    updatedAt: Math.floor(Number(row.updated_at || now) / 1000),
    turns: [],
    path: null,
  };
}
async function runtimeThreadFromEvents(threadId:string, row:any) {
  const events = await runtimeDb.all(
    `SELECT session_id,sequence,event_type,payload_json,created_at
     FROM (
       SELECT session_id,sequence,event_type,payload_json,created_at FROM (
         SELECT session_id,sequence,event_type,payload_json,created_at
         FROM events
         WHERE session_id=?1
           AND event_type IN ('user','turn/failed','turn/interrupted','thread_recovered_with_new_upstream')
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
      )
      ORDER BY sequence ASC`,
    [threadId]
  ).catch(()=>[]);
  const items:any[] = [];
  const completedItemIds = new Set<string>();
  const deltaText = new Map<string, string>();
  const deltaOrder:string[] = [];
  for (const event of events as any[]) {
    const eventType = String(event.event_type || '');
    let payload:any = {};
    try { payload = JSON.parse(String(event.payload_json || '{}')); } catch {}
    if (eventType === 'user') {
      const input = Array.isArray(payload?.input) ? payload.input : [];
      const content = input
        .filter((item:any) => item?.type === 'text' && String(item.text || '').trim())
        .map((item:any) => ({ type:'text', text:String(item.text || '').replace(MOBILE_CONTEXT_MARKER, '').trim() }))
        .filter((item:any) => item.text);
      if (content.length) items.push({ id:`user-${event.sequence}`, type:'userMessage', content });
      continue;
    }
    if (eventType === 'item/completed') {
      const item = payload?.params?.item || payload?.item;
      if (item?.id) completedItemIds.add(String(item.id));
      if (item?.id && ['userMessage','agentMessage','imageView','imageGeneration','artifact'].includes(String(item.type))) items.push(compactSnapshotItem(item));
      continue;
    }
    if (eventType === 'item/agentMessage/delta') {
      const itemId = String(payload?.params?.itemId || '');
      const delta = String(payload?.params?.delta || '');
      if (itemId && delta) {
        if (!deltaText.has(itemId)) deltaOrder.push(itemId);
        deltaText.set(itemId, (deltaText.get(itemId) || '') + delta);
      }
      continue;
    }
    if (eventType === 'turn/failed' || eventType === 'turn/interrupted') {
      const reason = payload?.reason || payload?.params?.reason || payload?.error?.message || payload?.params?.error?.message || '';
      items.push({ id:`${eventType}-${event.sequence}`, type:'agentMessage', text:eventType === 'turn/failed' ? `请求失败：${reason || 'turn failed'}` : '已停止生成', phase:'final_answer' });
    }
  }
  for (const itemId of deltaOrder) {
    const text = String(deltaText.get(itemId) || '').trim();
    if (text && !completedItemIds.has(itemId)) items.push({ id:itemId, type:'agentMessage', text, phase:'commentary' });
  }
  return {
    id:threadId,
    name:String(row.title || projectNameFromPath(String(row.project_dir || 'Session'))),
    preview:String(row.title || ''),
    cwd:String(row.project_dir),
    status:{ type:String(row.status || 'idle') },
    createdAt:Math.floor(Number(row.created_at || Date.now()) / 1000),
    updatedAt:Math.floor(Number(row.updated_at || Date.now()) / 1000),
    turns:items.length ? [{ id:`turn-${threadId}`, items }] : [],
    path:null,
  };
}

function compactSnapshotItem(item:any) {
  if (!item || typeof item !== 'object') return item;
  const next = { ...item };
  if (typeof next.text === 'string' && next.text.length > 80_000) next.text = `${next.text.slice(0, 80_000)}\n\n[output truncated for mobile snapshot]`;
  if (Array.isArray(next.content)) {
    next.content = next.content.map((part:any) => typeof part?.text === 'string' && part.text.length > 80_000 ? { ...part, text:`${part.text.slice(0, 80_000)}\n\n[output truncated for mobile snapshot]` } : part);
  }
  return next;
}
function rowSessionDto(row:any) {
  const fields = modeFields(sessionMode(row));
  const providerId = normalizeProvider(row.provider_id) || 'codex';
  const model = providerId === 'antigravity' || providerId === 'gemini' ? cleanAgentModel(row.model) : cleanModel(row.model);
  const modelId = providerId === 'antigravity' || providerId === 'gemini' ? cleanAgentModel(row.model_id) || model : cleanModel(row.model_id) || model;
  return { id:String(row.codex_thread_id || row.id), codex_thread_id:String(row.codex_thread_id || row.id), provider_id:providerId, providerId, provider_session_id:String(row.provider_session_id || row.codex_thread_id || row.id), account_id:row.account_id || null, workspace_path:String(row.workspace_path || row.project_dir), project_dir:String(row.project_dir), title:String(row.title || projectNameFromPath(String(row.project_dir))), status:String(row.status || 'idle'), permission_mode:row.permission_mode || fields.permission_mode, approval_policy:row.approval_policy || fields.approval_policy, sandbox_mode:row.sandbox_mode || fields.sandbox_mode, model, model_id:modelId, archived:Number(row.archived || 0), created_at:Number(row.created_at || 0), updated_at:Number(row.updated_at || 0), last_sequence:Number(row.last_sequence || 0), path:null };
}
async function antigravityThread(row:any) {
  const messages = await db.all('SELECT * FROM agent_messages WHERE session_id=?1 ORDER BY created_at ASC', [String(row.id)]);
  const items = messages.map((m:any)=>m.role === 'user'
    ? { id:m.id, type:'userMessage', content:[{ type:'text', text:String(m.text || '') }] }
    : { id:m.id, type:'agentMessage', text:String(m.text || ''), phase:'final_answer' });
  return {
    id:String(row.id),
    name:String(row.title || projectNameFromPath(String(row.project_dir))),
    preview:String(row.title || ''),
    cwd:String(row.project_dir),
    status:{ type:String(row.status || 'idle') },
    createdAt:Math.floor(Number(row.created_at || Date.now()) / 1000),
    updatedAt:Math.floor(Number(row.updated_at || Date.now()) / 1000),
    turns: items.length ? [{ id:`turn-${row.id}`, items }] : [],
    path:null,
  };
}
async function listIndexedThreads(archived:boolean){
  if (USE_AGENT_RUNTIME) {
    const startedAt = Date.now();
    const byId = new Map<string, any>();
    const runtimeStartedAt = Date.now();
    const runtimeSessions = await runtimeDb.all('SELECT * FROM sessions WHERE archived=?1 ORDER BY updated_at DESC LIMIT 500', [archived ? 1 : 0]).catch(()=>[]);
    for (const session of runtimeSessions as any[]) {
      if (!pathAllowed(String(session.project_dir || session.workspace_path || ''))) continue;
      byId.set(String(session.codex_thread_id || session.id), rowSessionDto(session));
    }
    const runtimeSqliteDurationMs = Date.now() - runtimeStartedAt;
    const localStartedAt = Date.now();
    const rows = await db.all('SELECT * FROM sessions WHERE archived=?1 ORDER BY updated_at DESC LIMIT 500', [archived ? 1 : 0]);
    for (const row of rows) {
      const id = String(row.codex_thread_id || row.id);
      if (!byId.has(id) && pathAllowed(String(row.project_dir))) byId.set(id, rowSessionDto(row));
    }
    app.log.info({ operation:'GET /api/sessions', sqliteDurationMs:Date.now() - localStartedAt + runtimeSqliteDurationMs, totalDurationMs:Date.now() - startedAt }, 'web sessions listed from sqlite');
    return [...byId.values()].sort((a:any,b:any)=>Number(b.updated_at || 0)-Number(a.updated_at || 0));
  }
  const res = await codex.listThreads(archived, 500).catch(()=>({data:[]}));
  const byId = new Map<string, any>();
  for (const t of res.data || []) {
    if (!pathAllowed(t.cwd)) continue;
    await upsertThread(t, { archived: archived ? 1 : 0 });
    const dto = await indexedSession(t);
    byId.set(String(dto.codex_thread_id || dto.id), dto);
  }
  const rows = await db.all('SELECT * FROM sessions WHERE archived=?1 ORDER BY updated_at DESC LIMIT 500', [archived ? 1 : 0]);
  for (const row of rows) {
    const id = String(row.codex_thread_id || row.id);
    if (!byId.has(id) && pathAllowed(String(row.project_dir))) byId.set(id, rowSessionDto(row));
  }
  return [...byId.values()].sort((a:any,b:any)=>Number(b.updated_at || 0)-Number(a.updated_at || 0));
}
function projectNameFromPath(p:string){ return p.split(path.sep).filter(Boolean).pop() || p; }
async function joinAndResume(id:string, ws:any, lastSequence = 0){
  const row = await findSession(id);
  const threadId = String(row?.codex_thread_id || id);
  if(!clients.has(threadId)) clients.set(threadId,new Set());
  clients.get(threadId)!.add(ws);
  if (row && normalizeProvider(row.provider_id) === 'antigravity') {
    ws.send(JSON.stringify({type:'joined', sessionId:threadId, runtimeConnection:'connected'}));
    return;
  }
  if (USE_AGENT_RUNTIME) {
    await replayRuntimeEventsToWs(threadId, ws, lastSequence);
    const subscription = ensureRuntimePushSubscription(threadId);
    app.log.info({ threadId, rowStatus:String(row?.status || ''), lastSequence:Number(lastSequence || 0), latestSequence:Number(row?.last_sequence || 0), runtimeConnection:runtimeConnectionStatus(subscription) }, 'codex session joined with runtime subscription');
    ws.send(JSON.stringify({type:'joined', sessionId:threadId, runtimeConnection:runtimeConnectionStatus(subscription)}));
    return;
  }
  if (row?.project_dir) await codex.resumeThread(threadId, String(row.project_dir), modeOptions(sessionMode(row), await effectiveModel(row))).catch(()=>{});
  ws.send(JSON.stringify({type:'joined', sessionId:threadId}));
}
function broadcast(id:string, msg:any){ for(const ws of clients.get(id) || []) if(ws.readyState === 1) { ws.send(JSON.stringify(msg)); runtimeDiagnostics.broadcasts++; } }
function runtimeConnectionStatus(state?:RuntimeSubscriptionState):RuntimeSubscriptionState['lastStatus'] {
  if (!state) return 'unknown';
  if (state.connected) return 'connected';
  if (state.connecting) return state.lastStatus === 'unavailable' ? 'unavailable' : 'checking';
  return state.lastStatus || 'recovering';
}
function ensureRuntimePushSubscription(threadId:string) {
  const existing = runtimeSubscriptions.get(threadId);
  if (existing?.connected || existing?.connecting) return existing;
  existing?.close?.();
  const state:RuntimeSubscriptionState = { close:()=>{}, connected:false, connecting:true, lastSequence:Number(existing?.lastSequence || 0), generation:existing?.generation, lastError:existing?.lastError, lastStatus:'checking' };
  runtimeSubscriptions.set(threadId, state);
  runtimeDiagnostics.subscribeStarts++;
  app.log.info({ threadId, after:state.lastSequence }, 'runtime sse subscribe starting');
  const close = runtime.subscribe(threadId, state.lastSequence, async (event:any) => {
    state.generation = String(event.generation || '');
    state.lastSequence = Math.max(state.lastSequence, Number(event.sequence || 0));
    runtimeDiagnostics.subscribeEvents++;
    const messages = await runtimeEventMessages(threadId, event);
    for (const msg of messages) broadcast(threadId, msg);
  }, (status, error) => {
    if (status === 'connected') {
      state.connecting = false;
      state.connected = true;
      state.lastStatus = 'connected';
      state.lastError = undefined;
      broadcast(threadId, { type:'runtimeConnection', status:'connected' });
      return;
    }
    state.connecting = false;
    state.connected = false;
    state.lastError = error?.message || undefined;
    state.lastStatus = status === 'error' ? 'unavailable' : 'recovering';
    if (status === 'closed' && runtimeSubscriptions.get(threadId) === state && !(clients.get(threadId)?.size || activeCodexSessions.has(threadId))) {
      runtimeSubscriptions.delete(threadId);
    }
    runtimeDiagnostics.subscribeReconnects++;
    app.log.warn({ threadId, status, error:error?.message || undefined }, 'runtime sse subscribe disconnected');
    broadcast(threadId, { type:'runtimeConnection', status:state.lastStatus, error:error?.message || undefined });
    if (runtimeSubscriptions.get(threadId) === state) {
      setTimeout(() => {
        if (clients.get(threadId)?.size || activeCodexSessions.has(threadId)) ensureRuntimePushSubscription(threadId);
      }, 1000).unref?.();
    }
  });
  state.close = close;
  return state;
}
async function ensureRuntimeCodexSession(row:any) {
  const threadId = String(row.codex_thread_id || row.id);
  try { return await runtime.readSession(threadId); } catch {}
  const profile:any = row.account_id ? await getProfile(String(row.account_id)).catch(()=>null) : await getActiveProfile();
  return runtime.resumeCodexSession({
    threadId,
    accountId: row.account_id || profile?.id || 'default',
    codexHome: profile?.codex_home || DEFAULT_CODEX_HOME,
    cwd: String(row.project_dir),
    title: String(row.title || projectNameFromPath(String(row.project_dir))),
    mode: sessionMode(row),
    model: await effectiveModel(row),
    approvalPolicy: row.approval_policy,
    sandboxMode: row.sandbox_mode,
  });
}
async function sendTurn(id:string, text:string, attachments:any[] = [], clientMessageId = ''){
  const row = await findSession(id);
  if(!row) throw new Error('session not found');
  const threadId = String(row.codex_thread_id || row.id);
  const ack = (status:string, error?:string) => {
    if (clientMessageId) broadcast(threadId, { type:'messageStatus', clientMessageId, status, error });
  };
  ack('received');
  if (normalizeProvider(row.provider_id) === 'antigravity') {
    await sendAntigravityTurn(row, text, attachments);
    ack('accepted');
    return;
  }
  if (normalizeProvider(row.provider_id) === 'gemini') {
    const profile:any = row.account_id ? await getGeminiProfile(String(row.account_id)).catch(()=>null) : null;
    if (!profile || geminiProfileState(profile) === 'disabled') throw new Error('该 Gemini 账户已移除，请重新登录后创建新会话');
    const dto = await geminiProfileDto(profile);
    if (dto.status !== 'authenticated' || !dto.login?.ok) throw new Error('请先登录 Gemini');
    const input = await buildTurnInput(threadId, text, attachments);
    const userMessage = { type:'user', clientMessageId, status:'persisted', text, attachments: attachments.map((a:any)=>({ id:String(a.id), name:String(a.name||'attachment'), type:String(a.type||''), url:`/api/sessions/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(String(a.id))}` })) };
    const subscription = ensureRuntimePushSubscription(threadId);
    broadcast(threadId, { type:'runtimeConnection', status:runtimeConnectionStatus(subscription), error:subscription.lastError });
    await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['submitting',Date.now(),threadId]).catch(()=>{});
    broadcast(threadId, userMessage);
    ack('persisted');
    try {
      await runtime.startTurn(threadId, { input, text, cwd:String(row.project_dir), approvalPolicy:row.approval_policy, sandboxMode:row.sandbox_mode, model:cleanAgentModel(row.model) || undefined });
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['running',Date.now(),threadId]).catch(()=>{});
      ack('accepted');
    } catch (e:any) {
      const message = e?.message || String(e);
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['interrupted',Date.now(),threadId]).catch(()=>{});
      ack('failed', message);
      broadcast(threadId,{type:'codex',method:'turn/failed',params:{error:{message}}});
      throw e;
    }
    return;
  }
  const input = await buildTurnInput(threadId, text, attachments);
  const title = autoTitle(text, String(row.project_dir), String(row.title || ''));
  const opts = modeOptions(sessionMode(row), await effectiveModel(row));
  const userMessage = { type:'user', clientMessageId, status:'persisted', text, attachments: attachments.map((a:any)=>({ id:String(a.id), name:String(a.name||'image'), type:String(a.type||''), url:`/api/sessions/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(String(a.id))}` })) };
  if (USE_AGENT_RUNTIME) {
    const subscription = ensureRuntimePushSubscription(threadId);
    broadcast(threadId, { type:'runtimeConnection', status:runtimeConnectionStatus(subscription), error:subscription.lastError });
    if (title) {
      await runtime.setSessionTitle(threadId, title).catch(()=>{});
      await db.run('UPDATE sessions SET title=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[title,Date.now(),threadId]);
      broadcast(threadId,{type:'sessionTitle', title});
    }
    await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['submitting',Date.now(),threadId]).catch(async () => {
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['running',Date.now(),threadId]);
    });
    activeCodexSessions.add(threadId);
    broadcast(threadId, userMessage);
    ack('persisted');
    artifactScanStarts.set(threadId, Date.now());
    try {
      await runtime.startTurn(threadId, { input, text, cwd:String(row.project_dir), approvalPolicy:opts.approvalPolicy, sandboxMode:opts.sandboxMode, model:opts.model });
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['running',Date.now(),threadId]).catch(()=>{});
      ack('accepted');
    } catch(e:any) {
      const message = e?.message || String(e);
      activeCodexSessions.delete(threadId);
      artifactScanStarts.delete(threadId);
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['interrupted',Date.now(),threadId]).catch(()=>{});
      ack('failed', message);
      broadcast(threadId,{type:'codex',method:'turn/failed',params:{error:{message}}});
      maybeExitAfterDrain();
      throw e;
    }
    return;
  }
  await codex.resumeThread(threadId, String(row.project_dir), opts).catch(()=>null);
  if (title) {
    await db.run('UPDATE sessions SET title=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[title,Date.now(),threadId]);
    await codex.setName(threadId, title).catch(()=>{});
    broadcast(threadId,{type:'sessionTitle', title});
  }
  artifactScanStarts.set(threadId, Date.now());
  await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['running',Date.now(),threadId]);
  activeCodexSessions.add(threadId);
  broadcast(threadId, userMessage);
  ack('persisted');
  try {
    await codex.startTurn(threadId, input, String(row.project_dir), opts);
    ack('accepted');
  } catch(e:any) {
    activeCodexSessions.delete(threadId);
    artifactScanStarts.delete(threadId);
    await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['interrupted',Date.now(),threadId]).catch(()=>{});
    ack('failed', e?.message || String(e));
    maybeExitAfterDrain();
    throw e;
  }
}
async function stopTurn(id:string){ const row = await findSession(id); const threadId = String(row?.codex_thread_id || id); if (row && normalizeProvider(row.provider_id) === 'antigravity') { const child = activeAntigravityTurns.get(threadId); if (child) { try { child.kill('SIGTERM'); } catch {} activeAntigravityTurns.delete(threadId); } await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['interrupted',Date.now(),threadId]); broadcast(threadId,{type:'system',text:'已停止生成'}); maybeExitAfterDrain(); return; } if (USE_AGENT_RUNTIME) await runtime.stopTurn(threadId); else await interruptTurn(threadId, row?.project_dir ? String(row.project_dir) : undefined); activeCodexSessions.delete(threadId); await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['interrupted',Date.now(),threadId]); broadcast(threadId,{type:'system',text:'已停止生成'}); maybeExitAfterDrain(); }
async function sendAntigravityTurn(row:any, text:string, attachments:any[] = []) {
  const threadId = String(row.codex_thread_id || row.id);
  const message = String(text || '').trim();
  if (!message && !attachments.length) throw new Error('empty message');
  const attachmentText = attachments.length ? await attachmentPromptText(threadId, attachments) : '';
  const prompt = [message, attachmentText].filter(Boolean).join('\n\n');
  const profile:any = await getActiveAntigravityProfile();
  if (!profile?.home_dir) throw new Error('请先登录 Antigravity');
  const login = await antigravityLoginStatus(String(profile.home_dir));
  if (!login.ok) throw new Error('请先登录 Antigravity');
  const now = Date.now();
  const userId = crypto.randomUUID();
  const title = autoTitle(message, String(row.project_dir), String(row.title || ''));
  await db.run('INSERT INTO agent_messages (id,session_id,role,text,created_at) VALUES (?1,?2,?3,?4,?5)', [userId, threadId, 'user', prompt, now]);
  if (title) { await db.run('UPDATE sessions SET title=?1, updated_at=?2 WHERE id=?3 OR codex_thread_id=?3',[title, now, threadId]); broadcast(threadId,{type:'sessionTitle', title}); }
  await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE id=?3 OR codex_thread_id=?3',['running', now, threadId]);
  broadcast(threadId,{type:'user', text:message, attachments:attachments.map((a:any)=>({ id:String(a.id), name:String(a.name||'attachment'), type:String(a.type||''), url:`/api/sessions/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(String(a.id))}` }))});
  broadcast(threadId,{type:'codex', method:'turn/started', params:{}});
  const assistantId = crypto.randomUUID();
  const model = cleanAgentModel(row.model);
  broadcast(threadId,{type:'codex', method:'item/completed', params:{ item:{ id:`${assistantId}-progress`, type:'plan', text:`Antigravity 已接收请求，正在用 ${model || '默认模型'} 分析。` } }});
  try {
    const output = await runAntigravityPrint(profile, row, prompt, threadId, assistantId);
    await db.run('INSERT INTO agent_messages (id,session_id,role,text,created_at) VALUES (?1,?2,?3,?4,?5)', [assistantId, threadId, 'assistant', output, Date.now()]);
    await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE id=?3 OR codex_thread_id=?3',['idle', Date.now(), threadId]);
    broadcast(threadId,{type:'codex', method:'item/completed', params:{ item:{ id:assistantId, type:'agentMessage', text:output, phase:'final_answer' } }});
    broadcast(threadId,{type:'codex', method:'turn/completed', params:{}});
  } catch (e:any) {
    await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE id=?3 OR codex_thread_id=?3',['idle', Date.now(), threadId]);
    broadcast(threadId,{type:'codex', method:'turn/completed', params:{}});
    throw e;
  }
}
async function attachmentPromptText(threadId:string, attachments:any[]) {
  const lines = ['Attachments are available as local files:'];
  for (const a of attachments) {
    const meta = await readAttachmentMeta(threadId, String(a.id));
    lines.push(`- ${meta.name} | ${meta.type || meta.mime} | ${meta.size} bytes | ${meta.path}`);
  }
  return lines.join('\n');
}
async function runAntigravityPrint(profile:any, row:any, prompt:string, threadId:string, itemId:string) {
  return new Promise<string>((resolve, reject) => {
    const args:string[] = [];
    const model = cleanAgentModel(row.model);
    if (model) args.push('--model', model);
    if (sessionMode(row) === 'yolo') args.push('--dangerously-skip-permissions');
    args.push('--print', prompt);
    const homeDir = String(profile.home_dir);
    const child = spawn(ANTIGRAVITY_BIN, args, {
      cwd:String(row.project_dir),
      env:{ ...process.env, HOME:homeDir, XDG_CONFIG_HOME:path.join(homeDir,'.config'), XDG_CACHE_HOME:path.join(homeDir,'.cache') },
      stdio:['ignore','pipe','pipe'],
    });
    activeAntigravityTurns.set(threadId, child);
    let out = '';
    let err = '';
    let streamed = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error('Antigravity 响应超时'));
    }, 5 * 60 * 1000);
    child.stdout.on('data', d => {
      out += d.toString();
      const cleaned = cleanAgentOutput(out);
      if (cleaned.length > streamed.length && cleaned.startsWith(streamed)) {
        const delta = cleaned.slice(streamed.length);
        streamed = cleaned;
        if (delta.trim()) broadcast(threadId,{type:'codex', method:'item/agentMessage/delta', params:{ itemId, delta }});
      }
    });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => { clearTimeout(timer); activeAntigravityTurns.delete(threadId); maybeExitAfterDrain(); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      activeAntigravityTurns.delete(threadId);
      maybeExitAfterDrain();
      const text = cleanAgentOutput(out || err);
      if (code === 0 && text) resolve(text);
      else reject(new Error(text || `Antigravity exited ${code}`));
    });
  });
}
async function replayRuntimeEventsToWs(threadId:string, ws:any, after:number) {
  if (!USE_AGENT_RUNTIME || ws.readyState !== 1) return;
  runtimeDiagnostics.replayCalls++;
  const res = await runtime.events(threadId, after).catch(()=>({events:[]}));
  for (const event of res.events || []) {
    const messages = await runtimeEventMessages(threadId, event);
    for (const msg of messages) if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
}
async function runtimeEventMessages(threadId:string, event:any) {
  const eventType = String(event.event_type || '');
  const runtimeSequence = Number(event.sequence || 0);
  const runtimeGeneration = String(event.generation || '');
  const base = { runtimeSequence, runtimeGeneration, threadId };
  let payload:any = {};
  try { payload = JSON.parse(String(event.payload_json || '{}')); } catch {}
  const out:any[] = [];
  if (eventType === 'runtime/recovering') {
    out.push({ type:'runtimeConnection', status:'recovering', ...base });
    return out;
  }
  if (eventType === 'runtime/disconnect') {
    out.push({ type:'runtimeConnection', status:'recovering', ...base });
    return out;
  }
  if (eventType === 'thread_recovered_with_new_upstream') {
    out.push({ type:'system', text:String(payload?.warning || '上游会话已重建，部分模型上下文可能丢失'), ...base });
    out.push({ type:'runtimeConnection', status:'connected', ...base });
    return out;
  }
  if (eventType === 'approval/requested') {
    out.push({ type:'approval', requestId:payload?.requestId, method:'gemini/session/request_permission', params:payload?.request || {}, ...base });
    return out;
  }
  if (eventType === 'thread_snapshot') {
    const row = await findSession(threadId);
    const thread = payload?.thread;
    if (thread && row) {
      decorateThreadImages(thread, threadId, String(row.project_dir));
      await injectGeneratedImages(thread, threadId).catch(()=>{});
      await injectArtifacts(thread, threadId).catch(()=>{});
      sanitizeThreadForMobile(thread);
    }
    out.push({ type:'thread_snapshot', thread, status:payload?.status, activeTurnId:payload?.activeTurnId || null, snapshot:{ generation:runtimeGeneration, coveredSequence:runtimeSequence }, ...base });
    out.push({ type:'runtimeConnection', status:'connected', ...base });
    return out;
  }
  if (eventType === 'output_gap') {
    out.push({ type:'runtimeConnection', status:'recovering', ...base });
    return out;
  }
  if (eventType === 'user') {
    const input = Array.isArray(payload?.input) ? payload.input : [];
    const text = input
      .filter((item:any) => item?.type === 'text')
      .map((item:any) => String(item.text || '').replace(MOBILE_CONTEXT_MARKER, '').trim())
      .filter(Boolean)
      .join('\n');
    if (text) out.push({ type:'user', text, attachments:[], ...base });
    return out;
  }
  if (eventType === 'thread/read') return out;
  if (eventType === 'turn/start') {
    const turn = payload?.result?.turn || payload?.turn || null;
    if (turn?.id) activeTurns.set(threadId, String(turn.id));
    out.push({ type:'codex', method:'turn/started', params:{ turn }, ...base });
    return out;
  }
  if (eventType.includes('/')) {
    const msg = payload?.method ? payload : { method:eventType, params:payload?.params || payload };
    if (shouldBroadcastCodexNotification(msg)) out.push({ type:'codex', method:msg.method, params:msg.params, ...base });
    if (msg.method === 'turn/started' && msg.params?.turn?.id) activeTurns.set(threadId, String(msg.params.turn.id));
    if (msg.method === 'turn/completed' || msg.method === 'turn/failed' || msg.method === 'turn/interrupted') {
      activeCodexSessions.delete(threadId);
      activeTurns.delete(threadId);
      const row = await findSession(threadId);
      const read = msg.method === 'turn/completed' && row ? await runtime.readSession(threadId).catch(()=>null) : null;
      const anchorItemId = read?.thread ? latestAgentItemIdFromThread(read.thread) : null;
      const found = msg.method === 'turn/completed' && row ? await scanArtifacts(threadId, String(row.project_dir), artifactScanStarts.get(threadId) || Date.now(), anchorItemId) : [];
      artifactScanStarts.delete(threadId);
      const nextStatus = msg.method === 'turn/completed' && !turnFailed(msg.params?.turn) ? 'idle' : 'interrupted';
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[nextStatus,Date.now(),threadId]);
      if (found.length) out.push({ type:'codex', method:'item/completed', params:{ item:artifactMessageItem(found, Date.now()) }, ...base });
      maybeExitAfterDrain();
    }
    if (msg.method === 'item/completed' && isFinalAnswerItem(msg.params?.item)) {
      activeCodexSessions.delete(threadId);
      activeTurns.delete(threadId);
      artifactScanStarts.delete(threadId);
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['idle',Date.now(),threadId]);
      maybeExitAfterDrain();
    }
    if (msg.method === 'thread/status/changed') {
      const rawStatus = rawStatusName(msg.params?.status);
      const row = rawStatus === 'active' ? await findSession(threadId).catch(()=>null) : null;
      const hasActiveTurn = activeTurns.has(threadId) || !!row?.active_turn_id || String(row?.status || '') === 'running' || String(row?.status || '') === 'submitting';
      const nextStatus = rawStatus === 'active' && hasActiveTurn ? 'running' : statusName(rawStatus);
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[nextStatus,Date.now(),threadId]).catch(()=>{});
    }
  }
  return out;
}
async function interruptTurn(threadId:string, cwd?:string){ const turnId = activeTurns.get(threadId) || await activeTurnId(threadId, cwd); if (!turnId) throw new Error('没有正在运行的 turn 可停止'); await codex.interrupt(threadId, turnId); activeTurns.delete(threadId); }
async function activeTurnId(threadId:string, cwd?:string){ const read = await codex.readThread(threadId, true).catch(async () => { if (cwd) await codex.resumeThread(threadId, cwd).catch(()=>null); return codex.readThread(threadId, true); }); const turns = read.thread?.turns || []; for (let i = turns.length - 1; i >= 0; i--) if (turns[i]?.status === 'inProgress' && turns[i]?.id) return String(turns[i].id); return null; }
async function sessionIdForThread(threadId?:string){ if(!threadId) return null; const row = await findSession(threadId); return row?.codex_thread_id ? String(row.codex_thread_id) : threadId; }
async function latestAgentItemId(threadId:string, cwd:string){
  const read = await codex.readThread(threadId, true).catch(async () => { await codex.resumeThread(threadId, cwd).catch(()=>null); return codex.readThread(threadId, true); });
  for (let ti = (read.thread?.turns || []).length - 1; ti >= 0; ti--) {
    const items = read.thread.turns[ti]?.items || [];
    for (let ii = items.length - 1; ii >= 0; ii--) {
      const item = items[ii];
      if (item?.type === 'agentMessage' && String(item.text || '').trim()) return String(item.id || '');
    }
  }
  return null;
}
function latestAgentItemIdFromThread(thread:any){
  for (let ti = (thread?.turns || []).length - 1; ti >= 0; ti--) {
    const items = thread.turns[ti]?.items || [];
    for (let ii = items.length - 1; ii >= 0; ii--) {
      const item = items[ii];
      if (item?.type === 'agentMessage' && String(item.text || '').trim()) return String(item.id || '');
    }
  }
  return null;
}

function cleanTitle(value:any, cwd:string){ const raw = String(value || '').split(/\r?\n/)[0].trim(); return (raw ? raw.slice(0, 120) : path.basename(cwd)); }
function autoTitle(text:string, cwd:string, current:string){ const base = path.basename(cwd); const generic = new Set([base, 'Default Workspace', 'default-workspace', 'Session']); if (!generic.has(current.trim())) return null; const raw = text.split(/\r?\n/).map(s=>s.trim()).find(Boolean) || ''; const cleaned = raw.replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim(); if (!cleaned) return null; return cleaned.slice(0, 42); }
function startChunkedMessage(msg:any){ const id = String(msg.messageId || ''); const sessionId = String(msg.sessionId || ''); if (!id || !sessionId) throw new Error('bad chunked message'); chunkedMessages.set(id, { sessionId, clientMessageId:String(msg.clientMessageId || id), chunks: [], size: 0, createdAt: Date.now() }); cleanupChunkedMessages(); }
function appendChunkedMessage(msg:any){ const id = String(msg.messageId || ''); const state = chunkedMessages.get(id); if (!state) throw new Error('chunked message not found'); const chunk = String(msg.chunk || ''); state.size += Buffer.byteLength(chunk); if (state.size > 25 * 1024 * 1024) { chunkedMessages.delete(id); throw new Error('message too large'); } state.chunks.push(chunk); }
async function finishChunkedMessage(msg:any){ const id = String(msg.messageId || ''); const state = chunkedMessages.get(id); if (!state) throw new Error('chunked message not found'); chunkedMessages.delete(id); const payload = JSON.parse(state.chunks.join('')); await sendTurn(state.sessionId, String(payload.text || ''), Array.isArray(payload.attachments) ? payload.attachments : [], state.clientMessageId); }
function cleanupChunkedMessages(){ const cutoff = Date.now() - 10 * 60 * 1000; for (const [id, state] of chunkedMessages) if (state.createdAt < cutoff) chunkedMessages.delete(id); }
function cleanupPendingApprovals(){ const cutoff = Date.now() - 10 * 60 * 1000; for (const [id, state] of pendingApprovals) if (state.createdAt < cutoff) pendingApprovals.delete(id); }
function statusName(status:any){ if (!status) return 'idle'; const value = rawStatusName(status); return value === 'active' ? 'idle' : value; }
function rawStatusName(status:any){ if (!status) return 'idle'; return typeof status === 'string' ? status : status.type || 'idle'; }
function isFinalAnswerItem(item:any){ return item?.type === 'agentMessage' && item?.phase === 'final_answer' && String(item?.text || '').trim(); }
function turnFailed(turn:any){ const status=String(turn?.status || ''); return status === 'failed' || status === 'interrupted'; }
function approvalResponse(method:string, decision:'accept'|'decline' = 'accept'){
  if (method.includes('permissions')) return decision === 'decline'
    ? { permissions:{}, scope:'turn' }
    : { permissions:{ network:null, fileSystem:null }, scope:'session' };
  if (method.includes('fileChange')) return { decision };
  return { decision };
}
async function deleteRollout(filePath:string){ const sessionsRoot = realpathSync(path.join(codex.getCodexHome(),'sessions')); if (!existsSync(filePath)) return; const rp = realpathSync(filePath); if (rp === sessionsRoot || !rp.startsWith(sessionsRoot + path.sep)) throw new Error('refusing to delete outside Codex sessions'); await execFileAsync('rm', ['-f', rp]); }
function sessionIdentitySet(...rows:any[]) {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row) continue;
    if (typeof row === 'string') ids.add(row);
    for (const key of ['id','codex_thread_id','provider_session_id','upstream_thread_id']) {
      const value = row?.[key];
      if (value) ids.add(String(value));
    }
  }
  return [...ids].filter(Boolean);
}
async function hardDeleteSessionData(ids:string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  const result = { ids:unique, webRows:0, runtimeRows:0, attachmentDirs:0, rolloutFiles:0 };
  for (const id of unique) {
    await db.run('DELETE FROM events WHERE session_id=?1', [id]).catch(()=>{});
    await db.run('DELETE FROM artifacts WHERE session_id=?1', [id]).catch(()=>{});
    await db.run('DELETE FROM agent_messages WHERE session_id=?1', [id]).catch(()=>{});
    await runtimeDb.run('DELETE FROM events WHERE session_id=?1', [id]).catch(()=>{});
    await runtimeDb.run('DELETE FROM artifacts WHERE session_id=?1', [id]).catch(()=>{});
  }
  for (const id of unique) {
    result.webRows += await deleteSessionRows(db, id, false);
    result.runtimeRows += await deleteSessionRows(runtimeDb, id, true);
    try {
      if (await deleteSessionAttachmentDir(id)) result.attachmentDirs++;
    } catch (e:any) {
      app.log.warn({ id, err:e?.message || String(e) }, 'failed to delete session attachment directory');
    }
    try {
      result.rolloutFiles += await deleteSharedRolloutFiles(id);
    } catch (e:any) {
      app.log.warn({ id, err:e?.message || String(e) }, 'failed to delete shared rollout files');
    }
  }
  return result;
}
async function deleteSessionRows(database:Db, id:string, includeUpstream:boolean) {
  const before = await database.get('SELECT COUNT(*) AS count FROM sessions WHERE id=?1 OR codex_thread_id=?1 OR provider_session_id=?1' + (includeUpstream ? ' OR upstream_thread_id=?1' : ''), [id]).catch(()=>({count:0} as any));
  await database.run('DELETE FROM sessions WHERE id=?1 OR codex_thread_id=?1 OR provider_session_id=?1' + (includeUpstream ? ' OR upstream_thread_id=?1' : ''), [id]).catch(()=>{});
  return Number(before?.count || 0);
}
async function deleteSessionAttachmentDir(id:string) {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) return false;
  const root = path.resolve(ATTACHMENTS_DIR);
  const dir = path.resolve(root, id);
  if (dir === root || !dir.startsWith(root + path.sep) || !existsSync(dir)) return false;
  await rm(dir, { recursive:true, force:true });
  return true;
}
async function deleteSharedRolloutFiles(id:string) {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(id) || !existsSync(SHARED_SESSIONS_DIR)) return 0;
  let deleted = 0;
  const root = realpathSync(SHARED_SESSIONS_DIR);
  async function walk(dir:string) {
    let entries:any[] = [];
    try { entries = await readdir(dir, { withFileTypes:true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl') || !entry.name.includes(id)) continue;
      const rp = realpathSync(file);
      if (rp.startsWith(root + path.sep)) {
        await rm(rp, { force:true });
        deleted++;
      }
    }
  }
  await walk(root);
  return deleted;
}
async function cleanupArchivedSessions(reason = 'scheduled') {
  if (!Number.isFinite(ARCHIVED_SESSION_RETENTION_DAYS) || ARCHIVED_SESSION_RETENTION_DAYS <= 0) return { disabled:true };
  const cutoff = Date.now() - ARCHIVED_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const webRows = await db.all(
    "SELECT * FROM sessions WHERE archived=1 AND COALESCE(archived_at,updated_at,created_at)<?1 AND status NOT IN ('running','inProgress') LIMIT 50",
    [cutoff]
  ).catch(()=>[]);
  const runtimeRows = await runtimeDb.all(
    "SELECT * FROM sessions WHERE archived=1 AND COALESCE(archived_at,updated_at,created_at)<?1 AND status NOT IN ('running','inProgress') AND active_turn_id IS NULL LIMIT 50",
    [cutoff]
  ).catch(()=>[]);
  const byId = new Map<string, any[]>();
  for (const row of [...webRows, ...runtimeRows]) {
    const key = String(row.id || row.codex_thread_id || row.upstream_thread_id || '');
    if (!key) continue;
    byId.set(key, [...(byId.get(key) || []), row]);
  }
  const deleted:any[] = [];
  for (const rows of byId.values()) {
    const ids = sessionIdentitySet(...rows);
    if (!ids.length) continue;
    deleted.push(await hardDeleteSessionData(ids));
  }
  if (deleted.length) app.log.info({ reason, retentionDays:ARCHIVED_SESSION_RETENTION_DAYS, sessions:deleted.length, deleted }, 'archived session cleanup completed');
  return { retentionDays:ARCHIVED_SESSION_RETENTION_DAYS, sessions:deleted.length, deleted };
}
async function buildTurnInput(threadId:string, text:string, attachments:any[]){
  const input:any[] = [];
  if (text.trim()) input.push({ type:'text', text, text_elements: [] });
  for (const a of attachments) {
    const meta = await readAttachmentMeta(threadId, String(a.id));
    if (String(meta.kind || '').startsWith('image') || String(meta.type || meta.mime || '').startsWith('image/')) input.push({ type:'localImage', path: meta.path, detail:'high' });
    else input.push({ type:'text', text:`Attachment: ${meta.name}\nMIME: ${meta.type || meta.mime}\nSize: ${meta.size} bytes\nLocal path: ${meta.path}\nRead this file from the local path if needed.`, text_elements: [] });
  }
  if (!input.length) throw new Error('empty message');
  return input;
}
function cleanFileName(name:string){ return path.basename(name).replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'image'; }
async function uploadMultipartAttachment(req:any, reply:any, row:any) {
  const part = await req.file();
  if (!part) return reply.code(400).send({ error:'file required' });
  const threadId = String(row.codex_thread_id || row.id);
  const attachmentId = crypto.randomBytes(16).toString('base64url');
  const name = cleanFileName(String(part.filename || 'attachment'));
  const dir = path.join(ATTACHMENTS_DIR, threadId, attachmentId);
  const tmpDir = path.join(ATTACHMENTS_DIR, '.tmp');
  await mkdir(dir, { recursive:true, mode:0o700 });
  await mkdir(tmpDir, { recursive:true, mode:0o700 });
  const tmp = path.join(tmpDir, `${attachmentId}.upload`);
  let size = 0;
  part.file.on('data', (chunk:Buffer) => { size += chunk.length; });
  try {
    await pipeline(part.file, createWriteStream(tmp, { flags:'wx', mode:0o600 }));
    const st = await stat(tmp);
    size = st.size;
    if (!size) throw Object.assign(new Error('empty file'), { statusCode:400 });
    if (size > MAX_ATTACHMENT_BYTES) throw Object.assign(new Error('file too large'), { statusCode:413 });
    const head = await readFileHead(tmp, 4096);
    const detected = detectAttachmentType(head, name, String(part.mimetype || ''));
    const finalName = cleanFileName(name) || `attachment${detected.ext || ''}`;
    const finalPath = path.join(dir, finalName);
    await rename(tmp, finalPath);
    const meta = { id:attachmentId, sessionId:threadId, name:finalName, type:detected.mime, mime:detected.mime, kind:detected.kind, size, path:finalPath, storagePath:finalPath, createdAt:Date.now() };
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
    return attachmentDto(meta);
  } catch (e:any) {
    await rm(tmp, { force:true }).catch(()=>{});
    await rm(dir, { recursive:true, force:true }).catch(()=>{});
    return reply.code(e?.statusCode || 500).send({ error:e?.message || String(e) });
  }
}
async function readFileHead(filePath:string, bytes:number) {
  const buffer = await readFile(filePath);
  return buffer.subarray(0, Math.min(bytes, buffer.length));
}
function detectAttachmentType(head:Buffer, name:string, browserMime:string) {
  if (head.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return { mime:'image/png', kind:'image', ext:'.png' };
  if (head[0] === 0xff && head[1] === 0xd8) return { mime:'image/jpeg', kind:'image', ext:'.jpg' };
  if (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP') return { mime:'image/webp', kind:'image', ext:'.webp' };
  if (head.subarray(0, 4).toString() === '%PDF') return { mime:'application/pdf', kind:'document', ext:'.pdf' };
  if (head.subarray(0, 2).toString('hex') === '504b') return { mime:officeOrZipMime(name), kind:isOfficeName(name) ? 'document' : 'archive', ext:path.extname(name).toLowerCase() };
  if (head.subarray(0, 2).toString('hex') === '1f8b') return { mime:'application/gzip', kind:'archive', ext:'.gz' };
  const ext = path.extname(name).toLowerCase();
  const textExt = new Set(['.txt','.md','.json','.yaml','.yml','.xml','.csv','.log','.patch','.diff','.ts','.tsx','.js','.jsx','.mjs','.cjs','.css','.html','.py','.go','.rs','.java','.kt','.swift','.sh','.sql']);
  if (textExt.has(ext) || looksText(head)) return { mime:mimeForTextExt(ext), kind:'text', ext };
  if (browserMime && /^[-\w.]+\/[-\w.+]+$/.test(browserMime) && !browserMime.startsWith('text/html')) return { mime:browserMime, kind:'binary', ext };
  return { mime:'application/octet-stream', kind:'binary', ext };
}
function officeOrZipMime(name:string) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === '.pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  return 'application/zip';
}
function isOfficeName(name:string) { return ['.docx','.xlsx','.pptx'].includes(path.extname(name).toLowerCase()); }
function looksText(head:Buffer) { return !head.includes(0) && head.subarray(0, 512).every(b => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0x80); }
function mimeForTextExt(ext:string) {
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.csv') return 'text/csv; charset=utf-8';
  if (ext === '.xml') return 'application/xml; charset=utf-8';
  if (ext === '.yaml' || ext === '.yml') return 'application/yaml; charset=utf-8';
  return 'text/plain; charset=utf-8';
}
function safeInlineMime(mime:string) { return /^image\/(png|jpeg|webp)$/.test(mime) || mime.startsWith('text/') || mime.startsWith('application/pdf'); }
function looksLikeImage(buffer:Buffer, type:string){
  if (type === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (type === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8;
  if (type === 'image/webp') return buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  return false;
}
async function readAttachmentMeta(threadId:string, attachmentId:string){
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(attachmentId)) throw new Error('bad attachment id');
  const dir = path.join(ATTACHMENTS_DIR, threadId);
  const nested = path.join(dir, attachmentId, 'meta.json');
  const legacy = path.join(dir, `${attachmentId}.json`);
  const meta = JSON.parse(await readFile(existsSync(nested) ? nested : legacy, 'utf8'));
  const rp = realpathSync(meta.path);
  const root = realpathSync(dir);
  if (!rp.startsWith(root + path.sep)) throw new Error('attachment outside session');
  return { ...meta, type:meta.type || meta.mime, mime:meta.mime || meta.type, path: rp };
}
function attachmentDto(meta:any){ return { id: meta.id, name: meta.name, type: meta.type || meta.mime, mime:meta.mime || meta.type, kind:meta.kind || ((meta.type || meta.mime || '').startsWith('image/') ? 'image' : 'binary'), size: meta.size, url: `/api/sessions/${encodeURIComponent(meta.sessionId)}/attachments/${encodeURIComponent(meta.id)}`, previewUrl: safeInlineMime(meta.type || meta.mime || '') ? `/api/sessions/${encodeURIComponent(meta.sessionId)}/attachments/${encodeURIComponent(meta.id)}` : undefined }; }
function decorateThreadImages(thread:any, threadId:string, projectDir:string){
  for (const turn of thread?.turns || []) for (const item of turn.items || []) {
    if (item.type === 'userMessage') for (const c of item.content || []) if (c?.type === 'localImage' && imageFileAllowed(String(c.path || ''), projectDir, threadId)) c.viewerUrl = attachmentUrlFromPath(threadId, String(c.path)) || imageUrl(threadId, String(c.path));
    if ((item.type === 'imageView' || item.type === 'imageGeneration') && item.path && imageFileAllowed(String(item.path), projectDir, threadId)) item.viewerUrl = imageUrl(threadId, String(item.path));
    if (item.type === 'imageGeneration' && item.savedPath && imageFileAllowed(String(item.savedPath), projectDir, threadId)) item.viewerUrl = imageUrl(threadId, String(item.savedPath));
  }
}
function imageUrl(threadId:string, filePath:string){ return `/api/sessions/${encodeURIComponent(threadId)}/image-file/${encodeURIComponent(signPathToken(filePath))}`; }
function attachmentUrlFromPath(threadId:string, filePath:string){ try { const root = realpathSync(path.join(ATTACHMENTS_DIR, threadId)); const rp = realpathSync(filePath); if (!rp.startsWith(root + path.sep)) return null; const id = path.basename(rp).replace(/\.[^.]+$/, ''); return `/api/sessions/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(id)}`; } catch { return null; } }
function signPathToken(filePath:string){ const payload = Buffer.from(filePath).toString('base64url'); const sig = crypto.createHmac('sha256', process.env.COOKIE_SECRET || 'agentdeck').update(payload).digest('base64url'); return `${payload}~${sig}`; }
function verifyPathToken(token:string){ const [payload, sig] = token.includes('~') ? token.split('~') : token.split('.'); if (!payload || !sig) return null; const expected = crypto.createHmac('sha256', process.env.COOKIE_SECRET || 'agentdeck').update(payload).digest('base64url'); if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; return Buffer.from(payload, 'base64url').toString(); }
function imageFileAllowed(filePath:string, projectDir:string, threadId:string){
  try {
    if (!mimeFromPath(filePath) || !existsSync(filePath)) return false;
    const rp = realpathSync(filePath);
    const attachRoot = realpathSync(path.join(ATTACHMENTS_DIR, threadId));
    const projectRoot = realpathSync(projectDir);
    return rp.startsWith(attachRoot + path.sep) || rp.startsWith(projectRoot + path.sep);
  } catch { return false; }
}
function mimeFromPath(filePath:string){ const ext = path.extname(filePath).toLowerCase(); if (ext === '.png') return 'image/png'; if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'; if (ext === '.webp') return 'image/webp'; return null; }
function sanitizeThreadForMobile(thread:any){
  for (const turn of thread?.turns || []) {
    for (const item of turn.items || []) {
      if (item?.type === 'userMessage') {
        item.content = (item.content || []).filter((c:any) => !(c.type === 'text' && String(c.text || '').includes('[[CODEX_MOBILE_CLIENT_CONTEXT]]')));
      }
    }
    turn.items = (turn.items || []).filter((item:any) => {
      if (!item?.type) return false;
      if (item.type === 'userMessage') return (item.content || []).some((c:any) => (c.type === 'text' && String(c.text || '').trim()) || c.type === 'image' || c.type === 'localImage');
      if (item.type === 'agentMessage') return !!String(item.text || '').trim();
      if (item.type === 'imageView' || item.type === 'imageGeneration') return true;
      return false;
    });
  }
}
async function injectGeneratedImages(thread:any, threadId:string){
  let files:any[] = [];
  try {
    const dir = path.join(generatedImagesDir(), threadId);
    files = await Promise.all((await readdir(dir)).filter(f=>/^ig_[A-Za-z0-9]+\.png$/.test(f)).map(async f=>({ name:f, mtime:(await stat(path.join(dir,f))).mtimeMs })));
  } catch { return; }
  if (!files.length) return;
  files.sort((a,b)=>a.mtime-b.mtime);
  const existing = new Set<string>();
  for (const turn of thread?.turns || []) for (const item of turn.items || []) if (item?.type === 'imageGeneration' && item.viewerUrl) existing.add(item.viewerUrl);
  const items = files.map(f=>({
    type:'imageGeneration',
    id:`generated-${f.name}`,
    status:'completed',
    revisedPrompt:null,
    result:'Generated image',
    generatedAt:f.mtime,
    viewerUrl:`/api/sessions/${encodeURIComponent(threadId)}/generated-images/${encodeURIComponent(f.name)}`,
  })).filter(item=>!existing.has(item.viewerUrl));
  if (!items.length) return;
  if (!thread.turns) thread.turns = [];
  for (const item of items) {
    const turn = { items:[item], startedAt:Math.floor(item.generatedAt/1000), completedAt:Math.floor(item.generatedAt/1000), durationMs:null };
    const idx = thread.turns.findIndex((t:any) => turnTimeMs(t) > item.generatedAt);
    if (idx >= 0) thread.turns.splice(idx, 0, turn);
    else thread.turns.push(turn);
  }
}
async function scanArtifacts(threadId:string, projectDir:string, sinceMs:number, anchorItemId?:string|null){
  const out:any[] = [];
  if (!anchorItemId) return [];
  const root = realpathSync(projectDir);
  await walkArtifacts(root, root, sinceMs, out);
  const saved:any[] = [];
  for (const f of out.sort((a,b)=>a.createdAt-b.createdAt).slice(-12)) {
    const id = crypto.createHash('sha256').update(`${threadId}\0${f.path}`).digest('base64url').slice(0, 24);
    const existed = await db.get('SELECT id FROM artifacts WHERE id=?1 AND session_id=?2', [id, threadId]);
    await db.run('INSERT OR IGNORE INTO artifacts (id, session_id, path, name, mime, size, created_at, anchor_item_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)', [id, threadId, f.path, f.name, f.mime, f.size, f.createdAt, anchorItemId || null]);
    if (anchorItemId) await db.run('UPDATE artifacts SET anchor_item_id=?1 WHERE id=?2 AND anchor_item_id IS NULL', [anchorItemId, id]);
    if (existed) continue;
    const row = await artifactForSession(threadId, id);
    if (row) saved.push(artifactDto(row));
  }
  return saved;
}
async function walkArtifacts(root:string, dir:string, sinceMs:number, out:any[], depth = 0){
  if (depth > 5 || out.length > 80) return;
  let entries:any[] = [];
  try { entries = await readdir(dir, { withFileTypes:true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.codex') continue;
    if (entry.isDirectory()) {
      if (!ARTIFACT_SKIP_DIRS.has(entry.name)) await walkArtifacts(root, path.join(dir, entry.name), sinceMs, out, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    const ext = artifactExt(filePath);
    const mime = ARTIFACT_TYPES[ext];
    if (!mime) continue;
    let st:any;
    try { st = await stat(filePath); } catch { continue; }
    if (st.mtimeMs <= sinceMs || st.size <= 0 || st.size > 25 * 1024 * 1024) continue;
    const rp = realpathSync(filePath);
    if (!rp.startsWith(root + path.sep)) continue;
    out.push({ path:rp, name:path.basename(rp), mime, size:st.size, createdAt:Math.floor(st.mtimeMs) });
  }
}
async function injectArtifacts(thread:any, threadId:string){
  const rows = await db.all('SELECT * FROM artifacts WHERE session_id=?1 AND anchor_item_id IS NOT NULL ORDER BY created_at ASC LIMIT 100', [threadId]);
  if (!rows.length) return;
  if (!thread.turns) thread.turns = [];
  const groups = groupArtifacts(rows);
  for (const group of groups) {
    const newest = Math.max(...group.map((row:any)=>Number(row.created_at || Date.now())));
    const turn = { items:[artifactMessageItem(group.map(artifactDto), newest)], startedAt:Math.floor(newest/1000), completedAt:Math.floor(newest/1000), durationMs:null };
    const insertAfter = turnIndexForAnchor(thread.turns, group[0]?.anchor_item_id) ?? turnIndexMentioningArtifacts(thread.turns, group) ?? lastAgentTurnIndex(thread.turns) ?? lastFiniteTurnIndexAtOrBefore(thread.turns, newest);
    if (insertAfter >= 0) thread.turns.splice(insertAfter + 1, 0, turn);
    else thread.turns.push(turn);
  }
}
async function artifactForSession(threadId:string, artifactId:string): Promise<any | null>{
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(artifactId)) return null;
  const row = await db.get('SELECT * FROM artifacts WHERE id=?1 AND session_id=?2', [artifactId, threadId]);
  if (!row) return null;
  const rp = realpathSync(String(row.path));
  const session = await findSession(threadId);
  if (!session || !pathAllowed(String(session.project_dir))) return null;
  const root = realpathSync(String(session.project_dir));
  if (!rp.startsWith(root + path.sep)) return null;
  const ext = artifactExt(rp);
  const mime = ARTIFACT_TYPES[ext];
  if (!mime || mime !== row.mime) return null;
  return { ...row, path:rp };
}
function artifactDto(row:any){ return { id:String(row.id), name:String(row.name), type:String(row.mime), size:Number(row.size || 0), url:`/api/sessions/${encodeURIComponent(String(row.session_id))}/files/${encodeURIComponent(String(row.id))}` }; }
function artifactMessageItem(artifacts:any[], stamp:number){
  const lines = artifacts.map(a => String(a.type || '').startsWith('image/') ? `![${a.name}](${a.url})` : `[${a.name}](${a.url})`);
  return { type:'agentMessage', id:`artifacts-${stamp}`, phase:'final_answer', text:['已生成文件：', ...lines].join('\n\n'), artifacts };
}
function groupArtifacts(rows:any[]){
  const groups:any[][] = [];
  for (const row of rows) {
    const ts = Number(row.created_at || 0);
    const last = groups[groups.length - 1];
    const lastTs = last?.length ? Number(last[last.length - 1].created_at || 0) : 0;
    const sameAnchor = String(last?.[0]?.anchor_item_id || '') === String(row.anchor_item_id || '');
    if (last && sameAnchor && Math.abs(ts - lastTs) <= 30_000) last.push(row);
    else groups.push([row]);
  }
  return groups;
}
function turnIndexForAnchor(turns:any[], anchorItemId:any){
  if (!anchorItemId) return null;
  for (let i = turns.length - 1; i >= 0; i--) {
    if ((turns[i]?.items || []).some((item:any)=>String(item?.id || '') === String(anchorItemId))) return i;
  }
  return null;
}
function turnIndexMentioningArtifacts(turns:any[], rows:any[]){
  const names = rows.map((row:any)=>String(row.name || '')).filter(Boolean);
  if (!names.length) return null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const text = (turns[i]?.items || []).filter((item:any)=>item?.type === 'agentMessage').map((item:any)=>String(item.text || '')).join('\n');
    if (text && names.some(name => text.includes(name))) return i;
  }
  return null;
}
function lastAgentTurnIndex(turns:any[]){
  for (let i = turns.length - 1; i >= 0; i--) {
    if ((turns[i]?.items || []).some((item:any)=>item?.type === 'agentMessage' && String(item.text || '').trim())) return i;
  }
  return null;
}
function lastFiniteTurnIndexAtOrBefore(turns:any[], atMs:number){
  let found = -1;
  for (let i = 0; i < turns.length; i++) {
    const t = turnTimeMs(turns[i]);
    if (Number.isFinite(t) && t <= atMs) found = i;
  }
  return found;
}
function artifactExt(filePath:string){ const lower = filePath.toLowerCase(); return lower.endsWith('.tar.gz') ? '.tar.gz' : path.extname(lower); }
function turnTimeMs(turn:any){ const seconds = turn?.completedAt || turn?.startedAt; return typeof seconds === 'number' ? seconds * 1000 : Number.POSITIVE_INFINITY; }
function shouldBroadcastCodexNotification(msg:any){
  if (msg.method === 'item/completed') {
    const type = msg.params?.item?.type;
    if (!['userMessage','agentMessage','imageView','imageGeneration'].includes(type)) return false;
    if (type === 'agentMessage' && !String(msg.params?.item?.text || '').trim()) return false;
  }
  if (msg.method && (msg.method.includes('fileChange') || msg.method.includes('command'))) return false;
  return true;
}
