import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import staticPlugin from '@fastify/static';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import * as pty from 'node-pty';
import { promisify } from 'node:util';
import { realpathSync, existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { Db } from './db.js';
import { CodexBridge } from './codex.js';
import { RuntimeClient } from './runtime-client.js';
import { AntigravityProvider, type AgentProviderId } from './providers.js';
import { existingRoots, validateProject, scanProjects, gitBranch, gitDiff } from './workspaces.js';
const execFileAsync = promisify(execFile);
const DATA_DIR = process.env.DATA_DIR || '/opt/data/codex-mobile';
const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || '/home/ubuntu/.codex';
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const ANTIGRAVITY_PROFILES_DIR = path.join(DATA_DIR, 'antigravity-profiles');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const SHARED_CODEX_DIR = path.join(DATA_DIR, 'shared');
const SHARED_SESSIONS_DIR = path.join(SHARED_CODEX_DIR, 'sessions');
const SHARED_GENERATED_IMAGES_DIR = path.join(SHARED_CODEX_DIR, 'generated_images');
const MAX_ATTACHMENT_BYTES = Number(process.env.MAX_ATTACHMENT_BYTES || 16 * 1024 * 1024);
const IMAGE_TYPES: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/pjpeg': '.jpg', 'image/webp': '.webp' };
const ARTIFACT_TYPES: Record<string, string> = { '.txt':'text/plain; charset=utf-8', '.log':'text/plain; charset=utf-8', '.json':'application/json; charset=utf-8', '.csv':'text/csv; charset=utf-8', '.patch':'text/plain; charset=utf-8', '.diff':'text/plain; charset=utf-8', '.zip':'application/zip', '.tar.gz':'application/gzip', '.conf':'application/x-wireguard-profile', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp' };
const ARTIFACT_SKIP_DIRS = new Set(['.git','node_modules','dist','build','.next','.vite','coverage','vendor']);
const MOBILE_CONTEXT_MARKER = '[[CODEX_MOBILE_CLIENT_CONTEXT]]';
const artifactScanStarts = new Map<string, number>();
const COOKIE_NAME = 'codex_mobile_session';
const CSRF_COOKIE = 'codex_mobile_csrf';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://codex.rubusoo.com,http://codex.rubusoo.com,http://127.0.0.1:3842').split(',').map(s=>s.trim()).filter(Boolean);
const db = new Db(path.join(DATA_DIR, 'codex-mobile.sqlite3'));
const runtimeDb = new Db(process.env.RUNTIME_DB || path.join(DATA_DIR, 'agent-runtime.sqlite3'));
const codex = new CodexBridge('/home/ubuntu', DEFAULT_CODEX_HOME);
const runtime = new RuntimeClient();
const USE_AGENT_RUNTIME = process.env.USE_AGENT_RUNTIME === '1';
const antigravity = new AntigravityProvider();
const clients = new Map<string, Set<any>>();
const pendingApprovals = new Map<string, { id:string|number; method:string; createdAt:number }>();
const activeTurns = new Map<string, string>();
const activeCodexSessions = new Set<string>();
const runtimeSubscriptions = new Map<string, { close:()=>void; connected:boolean; generation?:string; lastSequence:number }>();
const activeAntigravityTurns = new Map<string, any>();
const chunkedMessages = new Map<string, { sessionId:string; chunks:string[]; size:number; createdAt:number }>();
const threadTokenUsage = new Map<string, any>();
const runtimeDiagnostics = { subscribeStarts:0, subscribeReconnects:0, subscribeEvents:0, broadcasts:0, replayCalls:0 };
type LoginJob = { id:string; profileId:string; output:string[]; status:'running'|'done'|'error'; code?:number|null; error?:string; startedAt:number; newProfile?:boolean; loginUrl?:string; deviceCode?:string };
const loginJobs = new Map<string, LoginJob>();
type AntigravityLoginJob = LoginJob & { providerId:'antigravity'; authCodePrompt?:boolean; codeSubmitted?:boolean };
const antigravityLoginJobs = new Map<string, AntigravityLoginJob>();
const antigravityLoginChildren = new Map<string, any>();
const roots = await existingRoots((process.env.ALLOWED_WORKSPACES || '/opt/stacks,/opt/projects,/home/ubuntu,/opt/data,/etc/nginx,/etc/systemd/system').split(',').map(s=>s.trim()).filter(Boolean));
const DEFAULT_WORKSPACE_DIR = roots.find(r => r === '/opt/stacks/codex-mobile' || r.endsWith('/codex-mobile')) || roots[0];
const PROJECTS_CACHE_MS = Number(process.env.PROJECTS_CACHE_MS || 30_000);
const CODEX_STATUS_CACHE_MS = Number(process.env.CODEX_STATUS_CACHE_MS || 60_000);
let projectsCache: { expiresAt:number; promise?:Promise<any[]>; value?:any[] } = { expiresAt: 0 };
let codexStatusCache: { expiresAt:number; promise?:Promise<any>; value?:any } = { expiresAt: 0 };
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
await db.run("UPDATE sessions SET provider_id='codex' WHERE provider_id IS NULL OR provider_id=''").catch(()=>{});
await db.run('UPDATE sessions SET provider_session_id=codex_thread_id WHERE provider_session_id IS NULL AND codex_thread_id IS NOT NULL').catch(()=>{});
await db.run('UPDATE sessions SET workspace_path=project_dir WHERE workspace_path IS NULL').catch(()=>{});
await db.run('UPDATE sessions SET model_id=model WHERE model_id IS NULL AND model IS NOT NULL').catch(()=>{});
await db.run('ALTER TABLE artifacts ADD COLUMN anchor_item_id TEXT').catch(()=>{});
await db.run('CREATE TABLE IF NOT EXISTS antigravity_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, home_dir TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)').catch(()=>{});
await db.run('CREATE TABLE IF NOT EXISTS agent_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL)').catch(()=>{});
await db.run('UPDATE sessions SET status=?1 WHERE status=?2', ['interrupted', 'running']).catch(()=>{});
await ensureProfiles();
await ensureAdmin();
const app = Fastify({ bodyLimit: Number(process.env.BODY_LIMIT_BYTES || 25 * 1024 * 1024), logger: { redact: ['req.headers.authorization','req.headers.cookie','res.headers.set-cookie','password','token','secret'] } });
await app.register(cookie, { secret: process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex') });
await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
await app.register(websocket);
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
await app.register(staticPlugin, { root: publicDir, prefix: '/' });
app.addHook('preHandler', async (req, reply) => { if (['POST','PUT','PATCH','DELETE'].includes(req.method) && !['/api/login'].includes(req.url)) { const csrf = req.cookies[CSRF_COOKIE]; if (!csrf || req.headers['x-csrf-token'] !== csrf) return reply.code(403).send({error:'csrf'}); } });
function secureCookie() { return { httpOnly:true, secure:true, sameSite:'strict' as const, path:'/', maxAge: 60*60*24*14 }; }
function csrfCookie() { return { httpOnly:false, secure:true, sameSite:'strict' as const, path:'/', maxAge: 60*60*24*14 }; }
async function ensureAuth(req:any, reply:any) { const sid = req.cookies[COOKIE_NAME]; if (!sid) return reply.code(401).send({error:'unauthorized'}); try { const decoded = app.unsignCookie(sid); if (!decoded.valid) throw new Error('bad cookie'); } catch { return reply.code(401).send({error:'unauthorized'}); } }
app.get('/api/status', async (req) => { await syncAntigravityProfilesFromDisk().catch(()=>{}); const raw = req.cookies[COOKIE_NAME] || ''; const authed = !!raw && !!app.unsignCookie(raw).valid; const settings = await appSettings(); const activeProfile = await getActiveProfile(); const activeAntigravityProfile = await getActiveAntigravityProfile(); const codexStatus = await cachedCodexStatus(); const antigravityStatus = await antigravity.status(); return { authed, serverTime: Date.now(), codex: codexStatus, antigravity: antigravityStatus, providers: [codexProviderStatus(codexStatus), antigravityStatus], activeProvider: settings.activeProvider, roots, defaultWorkspace: DEFAULT_WORKSPACE_DIR, mode:modeLabel(settings.defaultMode), defaultMode:settings.defaultMode, defaultModel:settings.defaultModel, codexHome: codex.getCodexHome(), activeProfile, activeAntigravityProfile, capabilities: { imageInput: true, imageOutput: true, attachmentTypes: Object.keys(IMAGE_TYPES), maxAttachmentBytes: MAX_ATTACHMENT_BYTES } }; });
app.get('/api/runtime-diagnostics', { preHandler: ensureAuth }, async () => ({
  local: {
    ...runtimeDiagnostics,
    subscriptions:[...runtimeSubscriptions.entries()].map(([sessionId,state]) => ({ sessionId, connected:state.connected, lastSequence:state.lastSequence, generation:state.generation || null, clients:clients.get(sessionId)?.size || 0 })),
  },
  runtime: await runtime.diagnostics().catch((e:any)=>({ error:e?.message || String(e) })),
}));
app.get('/api/quota', { preHandler: ensureAuth }, async (req:any) => {
  const settings = await appSettings();
  const provider = normalizeProvider(req.query?.provider) || settings.activeProvider;
  if (provider === 'antigravity') {
    const status = await antigravity.status();
    const activeProfile:any = await getActiveAntigravityProfile();
    const login = activeProfile?.home_dir ? await antigravityLoginStatus(String(activeProfile.home_dir)) : { ok:false, email:null };
    const usageText = status.ok && login.ok ? await antigravityUsage(String(activeProfile.home_dir)).catch((e:any)=>e?.message || String(e)) : null;
    const email = login.email || activeProfile?.name || null;
    return {
      providerId: 'antigravity',
      account: email ? { email, type:'Google' } : null,
      rateLimits: usageText ? { usageText } : null,
      provider: status,
      errors: {
        account: status.ok && !email ? '请先登录 Antigravity Google 账户' : (status.ok ? null : status.error),
        rateLimits: status.ok && login.ok ? null : (status.ok ? 'Antigravity 额度需要登录后通过 CLI 内置 /usage 读取' : status.error),
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
app.get('/api/settings', { preHandler: ensureAuth }, async () => { await syncAntigravityProfilesFromDisk().catch(()=>{}); const codexStatus = await cachedCodexStatus(); const antigravityStatus = await antigravity.status(); return { settings: await appSettings(), profiles: await listProfiles(), activeProfile: await getActiveProfile(), antigravityProfiles: await listAntigravityProfiles(), activeAntigravityProfile: await getActiveAntigravityProfile(), codex: codexStatus, antigravity: antigravityStatus, providers: [codexProviderStatus(codexStatus), antigravityStatus] }; });
app.patch('/api/settings', { preHandler: ensureAuth }, async (req:any) => {
  const provider = normalizeProvider(req.body?.activeProvider);
  if (provider) await setSetting('activeProvider', provider);
  const mode = normalizeMode(req.body?.defaultMode);
  if (mode) await setSetting('defaultMode', mode);
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'defaultModel')) {
    const settings = await appSettings();
    const modelProvider = normalizeProvider(req.body?.provider) || provider || settings.activeProvider;
    const model = modelProvider === 'antigravity' ? cleanAgentModel(req.body?.defaultModel) : cleanModel(req.body?.defaultModel);
    await setSetting(modelProvider === 'antigravity' ? 'defaultModelAntigravity' : 'defaultModelCodex', model || '');
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
app.post('/api/profiles/:id/login/device', { preHandler: ensureAuth }, async (req:any) => {
  const profile = await getProfile(String(req.params.id));
  if (!profile) throw new Error('profile not found');
  const jobId = crypto.randomBytes(12).toString('base64url');
  const job: LoginJob = { id:jobId, profileId:String(profile.id), output:[], status:'running', code:null, startedAt:Date.now(), newProfile:req.body?.newProfile === true };
  loginJobs.set(jobId, job);
  const child = spawn('codex', ['login','--device-auth'], { env:{...process.env, HOME:'/home/ubuntu', CODEX_HOME:String(profile.codex_home)}, stdio:['ignore','pipe','pipe'] });
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
  const child = pty.spawn('/home/ubuntu/.local/bin/agy', [], {
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
    const status = await antigravity.status();
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
app.patch('/api/sessions/:id', { preHandler: ensureAuth }, async (req:any) => { const row = await findSession(req.params.id); const threadId = String(row?.codex_thread_id || req.params.id); const provider = normalizeProvider(row?.provider_id) || 'codex'; const title = String(req.body?.title || '').trim(); const mode = normalizeMode(req.body?.mode); if (title) { if (provider === 'codex') { if (USE_AGENT_RUNTIME) await runtime.setSessionTitle(threadId, title).catch(()=>{}); else await codex.setName(threadId, title); } await db.run('UPDATE sessions SET title=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[title, Date.now(), threadId]); } if (mode) { const fields = modeFields(mode); await db.run('UPDATE sessions SET permission_mode=?1, approval_policy=?2, sandbox_mode=?3, updated_at=?4 WHERE codex_thread_id=?5 OR id=?5',[fields.permission_mode, fields.approval_policy, fields.sandbox_mode, Date.now(), threadId]); } if (Object.prototype.hasOwnProperty.call(req.body || {}, 'model')) { const model = provider === 'antigravity' ? cleanAgentModel(req.body?.model) : cleanModel(req.body?.model); await db.run('UPDATE sessions SET model=?1, model_id=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[model || null, Date.now(), threadId]); } return {ok:true}; });
app.post('/api/sessions/:id/archive', { preHandler: ensureAuth }, async (req:any) => { const row = await findSession(req.params.id); const threadId = String(row?.codex_thread_id || req.params.id); if (!USE_AGENT_RUNTIME) await codex.archive(threadId).catch((e:any)=>app.log.warn({err:e.message}, 'official thread archive failed; archiving local index only')); await db.run('UPDATE sessions SET archived=1, updated_at=?1 WHERE codex_thread_id=?2 OR id=?2',[Date.now(), threadId]); return {ok:true}; });
app.post('/api/sessions/:id/unarchive', { preHandler: ensureAuth }, async (req:any) => { const row = await findSession(req.params.id); const threadId = String(row?.codex_thread_id || req.params.id); if (!USE_AGENT_RUNTIME) await codex.unarchive(threadId).catch((e:any)=>app.log.warn({err:e.message}, 'official thread unarchive failed; restoring local index only')); await db.run('UPDATE sessions SET archived=0, updated_at=?1 WHERE codex_thread_id=?2 OR id=?2',[Date.now(), threadId]); return {ok:true}; });
app.post('/api/sessions/:id/fork', { preHandler: ensureAuth }, async (req:any, reply) => { if (USE_AGENT_RUNTIME) return reply.code(409).send({error:'runtime 模式暂不支持 Fork，未创建重复会话'}); const row = await findSession(req.params.id); const threadId = String(row?.codex_thread_id || req.params.id); const mode = sessionMode(row); const model = await effectiveModel(row); const forked = await codex.fork(threadId, row?.project_dir ? String(row.project_dir) : undefined, modeOptions(mode, model)); await upsertThread(forked.thread, { status:'idle', model, ...modeFields(mode) }); return sessionDto(forked.thread, { model, ...modeFields(mode) }); });
app.delete('/api/sessions/:id', { preHandler: ensureAuth }, async (req:any, reply) => { const row = await findSession(req.params.id); if (!row) return reply.code(404).send({error:'not found'}); const threadId = String(row.codex_thread_id || row.id); let filePath:string|null = null; if (!USE_AGENT_RUNTIME) { try { const read = await codex.readThread(threadId, false); filePath = read.thread.path; await codex.archive(threadId).catch(()=>{}); } catch {} if (filePath) await deleteRollout(filePath); } await db.run('DELETE FROM sessions WHERE id=?1 OR codex_thread_id=?1',[threadId]); return {ok:true}; });
app.get('/api/sessions/:id/diff', { preHandler: ensureAuth }, async (req:any, reply) => { const row = await findSession(req.params.id); if (!row) return reply.code(404).send({error:'not found'}); return { diff: await gitDiff(String(row.project_dir)) }; });
app.post('/api/sessions/:id/attachments', { preHandler: ensureAuth }, async (req:any, reply) => {
  const row = await findSession(req.params.id);
  if (!row) return reply.code(404).send({error:'not found'});
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
  const dir = path.join(ATTACHMENTS_DIR, threadId);
  await mkdir(dir, { recursive: true });
  const filename = `${attachmentId}${ext}`;
  const filePath = path.join(dir, filename);
  const meta = { id: attachmentId, sessionId: threadId, name, type, size: buffer.length, path: filePath, createdAt: Date.now() };
  await writeFile(filePath, buffer, { flag: 'wx' });
  await writeFile(path.join(dir, `${attachmentId}.json`), JSON.stringify(meta));
  return attachmentDto(meta);
});
app.get('/api/sessions/:id/attachments/:attachmentId', { preHandler: ensureAuth }, async (req:any, reply) => {
  const row = await findSession(req.params.id);
  if (!row) return reply.code(404).send({error:'not found'});
  const meta = await readAttachmentMeta(String(row.codex_thread_id || row.id), String(req.params.attachmentId)).catch(()=>null);
  if (!meta) return reply.code(404).send({error:'not found'});
  const buffer = await readFile(meta.path);
  reply.header('Cache-Control', 'private, max-age=86400');
  return reply.type(meta.type).send(buffer);
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
app.post('/api/sessions/:id/stop', { preHandler: ensureAuth }, async (req:any) => { const row = await findSession(req.params.id); const threadId = String(row?.codex_thread_id || req.params.id); if (USE_AGENT_RUNTIME && (!row || normalizeProvider(row.provider_id) === 'codex')) { await runtime.stopTurn(threadId); } else { await interruptTurn(threadId, row?.project_dir ? String(row.project_dir) : undefined); } await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['interrupted',Date.now(),threadId]); return {ok:true}; });
app.post('/api/approvals/:requestId', { preHandler: ensureAuth }, async (req:any, reply) => {
  cleanupPendingApprovals();
  const requestKey = String(req.params.requestId);
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
app.get('/ws', { websocket: true }, async (connection:any, req:any) => { const ws = connection.socket || connection; const origin = req.headers.origin; if (origin && !ALLOWED_ORIGINS.includes(origin)) return ws.close(1008, 'origin'); const sid = req.cookies?.[COOKIE_NAME]; if (!sid || !app.unsignCookie(sid).valid) return ws.close(1008, 'auth'); ws.on('message', async (raw:Buffer) => { try { const msg = JSON.parse(raw.toString()); if (msg.type === 'join') await joinAndResume(String(msg.sessionId), ws, Number(msg.lastSequence || 0)); if (msg.type === 'send') await sendTurn(String(msg.sessionId), String(msg.text || ''), Array.isArray(msg.attachments) ? msg.attachments : []); if (msg.type === 'sendChunkStart') startChunkedMessage(msg); if (msg.type === 'sendChunk') appendChunkedMessage(msg); if (msg.type === 'sendChunkEnd') await finishChunkedMessage(msg); if (msg.type === 'stop') await stopTurn(String(msg.sessionId)); } catch (e:any) { ws.send(JSON.stringify({type:'error', error:e.message})); } }); ws.on('close', () => { for (const set of clients.values()) set.delete(ws); }); });
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
    antigravity: cleanAgentModel(map.defaultModelAntigravity) || legacyAntigravityModel,
  };
  return {
    activeProvider,
    defaultMode: normalizeMode(map.defaultMode) || 'yolo',
    defaultModel: activeProvider === 'antigravity' ? defaultModels.antigravity : defaultModels.codex,
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
  const file = path.join(DATA_DIR, 'codex-app-server-default.env');
  const body = [
    'HOME=/home/ubuntu',
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
function antigravityUsage(homeDir:string): Promise<string> {
  return new Promise((resolve) => {
    let output = '';
    let sent = false;
    let done = false;
    const child = pty.spawn('/home/ubuntu/.local/bin/agy', [], {
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
      const text = cleanAgentOutput(output).split(/\r?\n/).map(s=>s.trim()).filter(Boolean).slice(-80).join('\n');
      resolve(text || 'Antigravity 未返回 usage 输出');
    };
    const timer = setTimeout(finish, 8000);
    child.onData((d:string) => {
      output += d;
      if (!sent && /send a message|Type|Welcome|Antigravity/i.test(stripAnsi(output))) {
        sent = true;
        setTimeout(() => child.write('/usage\r'), 200);
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
function redactLine(line:string){ return line.replace(/(token|secret|password|refresh_token|access_token)[^\n]*/ig, '$1=[redacted]'); }
function shellQuote(value:string) { return `'${value.replaceAll("'", "'\\''")}'`; }
function normalizeMode(value:any) { const v = String(value || ''); return ['yolo','workspace-write','read-only'].includes(v) ? v : null; }
function normalizeProvider(value:any): AgentProviderId | null { const v = String(value || ''); return v === 'codex' || v === 'antigravity' ? v : null; }
function cleanModel(value:any) { const v = String(value || '').trim(); return /^[\w./:-]{1,120}$/.test(v) ? v : ''; }
function cleanAgentModel(value:any) { const v = String(value || '').trim(); return /^[\w ./:()+-]{1,160}$/.test(v) ? v : ''; }
function modeFields(mode:string) {
  if (mode === 'read-only') return { permission_mode:'read-only', approval_policy:'on-request', sandbox_mode:'read-only' };
  if (mode === 'workspace-write') return { permission_mode:'workspace-write', approval_policy:'on-request', sandbox_mode:'workspace-write' };
  return { permission_mode:'yolo', approval_policy:'never', sandbox_mode:'danger-full-access' };
}
function modeOptions(mode:string, model?:string) { const f = modeFields(mode); return { approvalPolicy:f.approval_policy, sandboxMode:f.sandbox_mode, model:cleanModel(model) || undefined }; }
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
async function codexStatus(){ try { const codexHome = codex.getCodexHome(); const {stdout}=await execFileAsync('codex',['--version'], { env:{...process.env, HOME:'/home/ubuntu', CODEX_HOME:codexHome} }); return { ok:true, version:stdout.trim(), appServer:true, sessionsPath:path.join(codexHome,'sessions') }; } catch(e:any) { return { ok:false, error:e.message }; } }
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
function pathAllowed(p:string){ try { const rp = realpathSync(p); return roots.some(r => rp === r || rp.startsWith(r + path.sep)); } catch { return false; } }
async function findSession(id:string){ return db.get('SELECT * FROM sessions WHERE id=?1 OR codex_thread_id=?1',[id]); }
async function upsertThread(thread:any, extra:any = {}) { if (!thread?.id || !pathAllowed(thread.cwd)) return; const existing:any = await findSession(String(thread.id)); const title = cleanTitle(extra.title || existing?.title || thread.name || thread.preview, thread.cwd); const now = Date.now(); const mode = normalizeMode(extra.permission_mode) || 'yolo'; const fields = { ...modeFields(mode), ...extra }; const model = cleanModel(fields.model); await db.run("INSERT INTO sessions (id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,model,archived,created_at,updated_at,provider_id,account_id,model_id,workspace_path,provider_session_id) VALUES (?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'codex',?12,?8,?2,?1) ON CONFLICT(id) DO UPDATE SET codex_thread_id=excluded.codex_thread_id, project_dir=excluded.project_dir, title=excluded.title, status=excluded.status, archived=excluded.archived, provider_id=COALESCE(sessions.provider_id,'codex'), account_id=COALESCE(sessions.account_id,excluded.account_id), model_id=excluded.model_id, workspace_path=excluded.workspace_path, provider_session_id=excluded.provider_session_id, updated_at=excluded.updated_at", [thread.id, thread.cwd, title, extra.status || statusName(thread.status), fields.permission_mode, fields.approval_policy, fields.sandbox_mode, model || null, extra.archived ?? 0, (thread.createdAt || Math.floor(now/1000))*1000, (thread.updatedAt || Math.floor(now/1000))*1000, fields.account_id || null]); }
async function indexedSession(thread:any){ const row = await findSession(thread.id); return sessionDto(thread, row || undefined); }
function sessionDto(thread:any, row:any = {}) { const fields = modeFields(sessionMode(row)); const providerId = normalizeProvider(row.provider_id) || 'codex'; return { id: thread.id, codex_thread_id: thread.id, provider_id: providerId, providerId, provider_session_id: row.provider_session_id || thread.id, account_id: row.account_id || null, workspace_path: row.workspace_path || thread.cwd, project_dir: thread.cwd, title: cleanTitle(row.title || thread.name || thread.preview, thread.cwd), status: row.status || statusName(thread.status), permission_mode:row.permission_mode || fields.permission_mode, approval_policy:row.approval_policy || fields.approval_policy, sandbox_mode:row.sandbox_mode || fields.sandbox_mode, model:cleanModel(row.model), model_id: cleanModel(row.model_id) || cleanModel(row.model), archived: Number(row.archived || 0), created_at: (thread.createdAt || 0)*1000, updated_at: (thread.updatedAt || 0)*1000, last_sequence:Number(row.last_sequence || 0), path: thread.path || null }; }
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
       SELECT session_id,sequence,event_type,payload_json,created_at
       FROM events
       WHERE session_id=?1
         AND event_type IN ('user','item/completed','turn/failed','turn/interrupted','thread_recovered_with_new_upstream')
       ORDER BY sequence DESC
       LIMIT 250
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
      if (item?.id && ['userMessage','agentMessage','reasoning','plan','commandExecution','fileChange','imageView','imageGeneration','artifact','dynamicToolCall'].includes(String(item.type))) items.push(item);
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
function rowSessionDto(row:any) {
  const fields = modeFields(sessionMode(row));
  const providerId = normalizeProvider(row.provider_id) || 'codex';
  const model = providerId === 'antigravity' ? cleanAgentModel(row.model) : cleanModel(row.model);
  const modelId = providerId === 'antigravity' ? cleanAgentModel(row.model_id) || model : cleanModel(row.model_id) || model;
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
async function joinAndResume(id:string, ws:any, lastSequence = 0){ const row = await findSession(id); const threadId = String(row?.codex_thread_id || id); if(!clients.has(threadId)) clients.set(threadId,new Set()); clients.get(threadId)!.add(ws); if (row && normalizeProvider(row.provider_id) === 'antigravity') { ws.send(JSON.stringify({type:'joined', sessionId:threadId})); return; } if (USE_AGENT_RUNTIME) { await replayRuntimeEventsToWs(threadId, ws, lastSequence); ensureRuntimePushSubscription(threadId); ws.send(JSON.stringify({type:'joined', sessionId:threadId, runtimeConnection:runtimeSubscriptions.get(threadId)?.connected?'connected':'recovering'})); return; } if (row?.project_dir) await codex.resumeThread(threadId, String(row.project_dir), modeOptions(sessionMode(row), await effectiveModel(row))).catch(()=>{}); ws.send(JSON.stringify({type:'joined', sessionId:threadId})); }
function broadcast(id:string, msg:any){ for(const ws of clients.get(id) || []) if(ws.readyState === 1) { ws.send(JSON.stringify(msg)); runtimeDiagnostics.broadcasts++; } }
function ensureRuntimePushSubscription(threadId:string) {
  const existing = runtimeSubscriptions.get(threadId);
  if (existing?.connected) return;
  existing?.close?.();
  const state = { close:()=>{}, connected:false, lastSequence:Number(existing?.lastSequence || 0), generation:existing?.generation };
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
      state.connected = true;
      broadcast(threadId, { type:'runtimeConnection', status:'connected' });
      return;
    }
    state.connected = false;
    runtimeDiagnostics.subscribeReconnects++;
    app.log.warn({ threadId, status, error:error?.message || undefined }, 'runtime sse subscribe disconnected');
    broadcast(threadId, { type:'runtimeConnection', status:'recovering', error:error?.message || undefined });
    if (runtimeSubscriptions.get(threadId) === state) {
      setTimeout(() => {
        if (clients.get(threadId)?.size || activeCodexSessions.has(threadId)) ensureRuntimePushSubscription(threadId);
      }, 1000).unref?.();
    }
  });
  state.close = close;
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
async function sendTurn(id:string, text:string, attachments:any[] = []){ const row = await findSession(id); if(!row) throw new Error('session not found'); const threadId = String(row.codex_thread_id || row.id); if (normalizeProvider(row.provider_id) === 'antigravity') { await sendAntigravityTurn(row, text, attachments); return; } const input = await buildTurnInput(threadId, text, attachments); const title = autoTitle(text, String(row.project_dir), String(row.title || '')); const opts = modeOptions(sessionMode(row), await effectiveModel(row)); if (USE_AGENT_RUNTIME) { ensureRuntimePushSubscription(threadId); if (title) { await runtime.setSessionTitle(threadId, title).catch(()=>{}); await db.run('UPDATE sessions SET title=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[title,Date.now(),threadId]); broadcast(threadId,{type:'sessionTitle', title}); } await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['running',Date.now(),threadId]); activeCodexSessions.add(threadId); broadcast(threadId,{type:'user', text, attachments: attachments.map((a:any)=>({ id:String(a.id), name:String(a.name||'image'), type:String(a.type||''), url:`/api/sessions/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(String(a.id))}` }))}); artifactScanStarts.set(threadId, Date.now()); try { await runtime.startTurn(threadId, { input, text, cwd:String(row.project_dir), approvalPolicy:opts.approvalPolicy, sandboxMode:opts.sandboxMode, model:opts.model }); } catch(e:any) { activeCodexSessions.delete(threadId); artifactScanStarts.delete(threadId); await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['interrupted',Date.now(),threadId]).catch(()=>{}); broadcast(threadId,{type:'codex',method:'turn/failed',params:{error:{message:e?.message||String(e)}}}); maybeExitAfterDrain(); throw e; } return; } await codex.resumeThread(threadId, String(row.project_dir), opts).catch(()=>null); if (title) { await db.run('UPDATE sessions SET title=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[title,Date.now(),threadId]); await codex.setName(threadId, title).catch(()=>{}); broadcast(threadId,{type:'sessionTitle', title}); } artifactScanStarts.set(threadId, Date.now()); await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['running',Date.now(),threadId]); activeCodexSessions.add(threadId); broadcast(threadId,{type:'user', text, attachments: attachments.map((a:any)=>({ id:String(a.id), name:String(a.name||'image'), type:String(a.type||''), url:`/api/sessions/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(String(a.id))}` }))}); try { await codex.startTurn(threadId, input, String(row.project_dir), opts); } catch(e:any) { activeCodexSessions.delete(threadId); artifactScanStarts.delete(threadId); await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['interrupted',Date.now(),threadId]).catch(()=>{}); maybeExitAfterDrain(); throw e; } }
async function stopTurn(id:string){ const row = await findSession(id); const threadId = String(row?.codex_thread_id || id); if (row && normalizeProvider(row.provider_id) === 'antigravity') { const child = activeAntigravityTurns.get(threadId); if (child) { try { child.kill('SIGTERM'); } catch {} activeAntigravityTurns.delete(threadId); } await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['interrupted',Date.now(),threadId]); broadcast(threadId,{type:'system',text:'已停止生成'}); maybeExitAfterDrain(); return; } if (USE_AGENT_RUNTIME) await runtime.stopTurn(threadId); else await interruptTurn(threadId, row?.project_dir ? String(row.project_dir) : undefined); activeCodexSessions.delete(threadId); await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['interrupted',Date.now(),threadId]); broadcast(threadId,{type:'system',text:'已停止生成'}); maybeExitAfterDrain(); }
async function sendAntigravityTurn(row:any, text:string, attachments:any[] = []) {
  const threadId = String(row.codex_thread_id || row.id);
  const message = String(text || '').trim();
  if (!message && !attachments.length) throw new Error('empty message');
  if (attachments.length) throw new Error('Antigravity 暂未接入图片附件');
  const profile:any = await getActiveAntigravityProfile();
  if (!profile?.home_dir) throw new Error('请先登录 Antigravity');
  const login = await antigravityLoginStatus(String(profile.home_dir));
  if (!login.ok) throw new Error('请先登录 Antigravity');
  const now = Date.now();
  const userId = crypto.randomUUID();
  const title = autoTitle(message, String(row.project_dir), String(row.title || ''));
  await db.run('INSERT INTO agent_messages (id,session_id,role,text,created_at) VALUES (?1,?2,?3,?4,?5)', [userId, threadId, 'user', message, now]);
  if (title) { await db.run('UPDATE sessions SET title=?1, updated_at=?2 WHERE id=?3 OR codex_thread_id=?3',[title, now, threadId]); broadcast(threadId,{type:'sessionTitle', title}); }
  await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE id=?3 OR codex_thread_id=?3',['running', now, threadId]);
  broadcast(threadId,{type:'user', text:message, attachments:[]});
  broadcast(threadId,{type:'codex', method:'turn/started', params:{}});
  const assistantId = crypto.randomUUID();
  const model = cleanAgentModel(row.model);
  broadcast(threadId,{type:'codex', method:'item/completed', params:{ item:{ id:`${assistantId}-progress`, type:'plan', text:`Antigravity 已接收请求，正在用 ${model || '默认模型'} 分析。` } }});
  try {
    const output = await runAntigravityPrint(profile, row, message, threadId, assistantId);
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
async function runAntigravityPrint(profile:any, row:any, prompt:string, threadId:string, itemId:string) {
  return new Promise<string>((resolve, reject) => {
    const args:string[] = [];
    const model = cleanAgentModel(row.model);
    if (model) args.push('--model', model);
    if (sessionMode(row) === 'yolo') args.push('--dangerously-skip-permissions');
    args.push('--print', prompt);
    const homeDir = String(profile.home_dir);
    const child = spawn('/home/ubuntu/.local/bin/agy', args, {
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
  if (eventType === 'turn/start') return out;
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
      const nextStatus = rawStatus === 'active' && activeTurns.has(threadId) ? 'running' : statusName(rawStatus);
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
function startChunkedMessage(msg:any){ const id = String(msg.messageId || ''); const sessionId = String(msg.sessionId || ''); if (!id || !sessionId) throw new Error('bad chunked message'); chunkedMessages.set(id, { sessionId, chunks: [], size: 0, createdAt: Date.now() }); cleanupChunkedMessages(); }
function appendChunkedMessage(msg:any){ const id = String(msg.messageId || ''); const state = chunkedMessages.get(id); if (!state) throw new Error('chunked message not found'); const chunk = String(msg.chunk || ''); state.size += Buffer.byteLength(chunk); if (state.size > 25 * 1024 * 1024) { chunkedMessages.delete(id); throw new Error('message too large'); } state.chunks.push(chunk); }
async function finishChunkedMessage(msg:any){ const id = String(msg.messageId || ''); const state = chunkedMessages.get(id); if (!state) throw new Error('chunked message not found'); chunkedMessages.delete(id); const payload = JSON.parse(state.chunks.join('')); await sendTurn(state.sessionId, String(payload.text || ''), Array.isArray(payload.attachments) ? payload.attachments : []); }
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
async function buildTurnInput(threadId:string, text:string, attachments:any[]){
  const input:any[] = [];
  if (text.trim()) input.push({ type:'text', text, text_elements: [] });
  for (const a of attachments) {
    const meta = await readAttachmentMeta(threadId, String(a.id));
    input.push({ type:'localImage', path: meta.path, detail:'high' });
  }
  if (!input.length) throw new Error('empty message');
  return input;
}
function cleanFileName(name:string){ return path.basename(name).replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'image'; }
function looksLikeImage(buffer:Buffer, type:string){
  if (type === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (type === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8;
  if (type === 'image/webp') return buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  return false;
}
async function readAttachmentMeta(threadId:string, attachmentId:string){
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(attachmentId)) throw new Error('bad attachment id');
  const dir = path.join(ATTACHMENTS_DIR, threadId);
  const meta = JSON.parse(await readFile(path.join(dir, `${attachmentId}.json`), 'utf8'));
  const rp = realpathSync(meta.path);
  const root = realpathSync(dir);
  if (!rp.startsWith(root + path.sep)) throw new Error('attachment outside session');
  return { ...meta, path: rp };
}
function attachmentDto(meta:any){ return { id: meta.id, name: meta.name, type: meta.type, size: meta.size, url: `/api/sessions/${encodeURIComponent(meta.sessionId)}/attachments/${encodeURIComponent(meta.id)}` }; }
function decorateThreadImages(thread:any, threadId:string, projectDir:string){
  for (const turn of thread?.turns || []) for (const item of turn.items || []) {
    if (item.type === 'userMessage') for (const c of item.content || []) if (c?.type === 'localImage' && imageFileAllowed(String(c.path || ''), projectDir, threadId)) c.viewerUrl = attachmentUrlFromPath(threadId, String(c.path)) || imageUrl(threadId, String(c.path));
    if ((item.type === 'imageView' || item.type === 'imageGeneration') && item.path && imageFileAllowed(String(item.path), projectDir, threadId)) item.viewerUrl = imageUrl(threadId, String(item.path));
    if (item.type === 'imageGeneration' && item.savedPath && imageFileAllowed(String(item.savedPath), projectDir, threadId)) item.viewerUrl = imageUrl(threadId, String(item.savedPath));
  }
}
function imageUrl(threadId:string, filePath:string){ return `/api/sessions/${encodeURIComponent(threadId)}/image-file/${encodeURIComponent(signPathToken(filePath))}`; }
function attachmentUrlFromPath(threadId:string, filePath:string){ try { const root = realpathSync(path.join(ATTACHMENTS_DIR, threadId)); const rp = realpathSync(filePath); if (!rp.startsWith(root + path.sep)) return null; const id = path.basename(rp).replace(/\.[^.]+$/, ''); return `/api/sessions/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(id)}`; } catch { return null; } }
function signPathToken(filePath:string){ const payload = Buffer.from(filePath).toString('base64url'); const sig = crypto.createHmac('sha256', process.env.COOKIE_SECRET || 'codex-mobile').update(payload).digest('base64url'); return `${payload}~${sig}`; }
function verifyPathToken(token:string){ const [payload, sig] = token.includes('~') ? token.split('~') : token.split('.'); if (!payload || !sig) return null; const expected = crypto.createHmac('sha256', process.env.COOKIE_SECRET || 'codex-mobile').update(payload).digest('base64url'); if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; return Buffer.from(payload, 'base64url').toString(); }
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
