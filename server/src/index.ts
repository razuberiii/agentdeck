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
import { constants, createWriteStream, realpathSync, existsSync, readFileSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, open, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Db } from './db.js';
import { CodexBridge } from './codex.js';
import { RuntimeClient } from './runtime-client.js';
import { SessionCommandQueue } from './websocket-command-queue.js';
import { BrowserDeliveryHub } from './browser-delivery.js';
import { withReceiptFailure } from './message-receipt.js';
import { claimRetryReceipt } from './message-retry-claim.js';
import { migrateWebSchema, RUNTIME_SCHEMA_VERSION, WEB_SCHEMA_VERSION, verifyWebSchema } from './schema-migrations.js';
import { deleteSessionRelations } from './session-lifecycle.js';
import { AntigravityProvider, GeminiProvider } from './providers.js';
import { ClaudeProvider } from './claude/claude-provider.js';
import { ClaudeProfileStore } from './claude/claude-profile-store.js';
import { claudeAuthLogout, claudeAuthState, claudeAuthStatus } from './claude/claude-auth.js';
import { claudeProfileEnv, claudeSafeEnvSummary } from './claude/claude-profile-env.js';
import { extractGeminiModelOptions, providerStatus, type ProviderStatus } from './provider-status.js';
import { providerCapabilitiesFor } from './provider-adapter.js';
import { artifactContentChanged, artifactEligibleForDownload, buildArtifactManifest, isArtifactTestAssetPath, workspaceCodeChangesForDisplay } from './artifact-manifest.js';
import { PROVIDER_DEFINITIONS, PROVIDER_ORDER, VISIBLE_PROVIDER_ORDER, providerDisplayName as registryProviderDisplayName, providerStatusArray as orderedProviderStatusArray, normalizeProvider as registryNormalizeProvider, visibleProvider, type AgentProviderId } from './provider-registry.js';
import { existingRoots, validateProject, scanProjects, gitBranch, gitDiff } from './workspaces.js';
import { activateCodexProfileAtomically, evaluateCodexProfileReadiness, type CodexProfileState } from './codex-profile-lifecycle.js';
import { resolveCodexProfileMetadataFromAuth } from './codex-profile-metadata.js';
import { safeAntigravitySummary } from './antigravity-turn.js';
import { loadAntigravityLegacyHistory } from './antigravity-history.js';
const execFileAsync = promisify(execFile);
const DEFAULT_HOME = process.env.HOME || os.homedir();
const DATA_DIR = process.env.DATA_DIR || '/var/lib/agentdeck';
const PROVIDER_TOOLS_DIR = path.join(DATA_DIR, 'provider-tools');
const MANAGED_PROVIDER_BIN_DIR = path.join(PROVIDER_TOOLS_DIR, 'bin');
process.env.PATH = `${MANAGED_PROVIDER_BIN_DIR}${path.delimiter}${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`;
const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || path.join(DEFAULT_HOME, '.codex');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const ANTIGRAVITY_PROFILES_DIR = path.join(DATA_DIR, 'antigravity-profiles');
const GEMINI_PROFILES_DIR = path.join(DATA_DIR, 'gemini', 'profiles');
const CLAUDE_PROFILES_DIR = path.join(DATA_DIR, 'claude', 'profiles');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const SHARED_CODEX_DIR = path.join(DATA_DIR, 'shared');
const SHARED_SESSIONS_DIR = path.join(SHARED_CODEX_DIR, 'sessions');
const SHARED_GENERATED_IMAGES_DIR = path.join(SHARED_CODEX_DIR, 'generated_images');
const CODEX_PROFILE_COLUMNS = 'id,name,codex_home,active,status,email,display_name,metadata_status,metadata_error,metadata_updated_at,created_at,updated_at';
const MAX_ATTACHMENT_BYTES = Number(process.env.MAX_ATTACHMENT_BYTES || 32 * 1024 * 1024);
const MAX_ATTACHMENTS_PER_MESSAGE = Number(process.env.MAX_ATTACHMENTS_PER_MESSAGE || 10);
const MAX_TOTAL_ATTACHMENT_BYTES = Number(process.env.MAX_TOTAL_ATTACHMENT_BYTES || 64 * 1024 * 1024);
const ARCHIVED_SESSION_RETENTION_DAYS = Number(process.env.ARCHIVED_SESSION_RETENTION_DAYS || 30);
const ARCHIVED_SESSION_CLEANUP_INTERVAL_MS = Number(process.env.ARCHIVED_SESSION_CLEANUP_INTERVAL_MS || 6 * 60 * 60 * 1000);
const IMAGE_TYPES: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/pjpeg': '.jpg', 'image/webp': '.webp' };
const ARTIFACT_TYPES: Record<string, string> = { '.txt':'text/plain; charset=utf-8', '.log':'text/plain; charset=utf-8', '.json':'application/json; charset=utf-8', '.csv':'text/csv; charset=utf-8', '.patch':'text/plain; charset=utf-8', '.diff':'text/plain; charset=utf-8', '.zip':'application/zip', '.tar.gz':'application/gzip', '.conf':'application/x-wireguard-profile', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp' };
const ARTIFACT_SKIP_DIRS = new Set(['.git','node_modules','dist','build','.next','.vite','coverage','vendor']);
const MOBILE_CONTEXT_MARKER = '[[CODEX_MOBILE_CLIENT_CONTEXT]]';
const RECOVERY_CONTEXT_MARKER = '[[AGENT_RUNTIME_RECOVERY_CONTEXT]]';
const COOKIE_NAME = 'agentdeck_session';
const CSRF_COOKIE = 'agentdeck_csrf';
const AUTH_SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS || 1000 * 60 * 60 * 24 * 14);
const VERBOSE_DIAGNOSTICS = process.env.AGENTDECK_ENABLE_VERBOSE_DIAGNOSTICS === '1';
const ALLOWED_ORIGINS_CONFIGURED = typeof process.env.ALLOWED_ORIGINS === 'string' && process.env.ALLOWED_ORIGINS.trim().length > 0;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
const WS_MAX_MESSAGE_BYTES = Number(process.env.WS_MAX_MESSAGE_BYTES || 1024 * 1024);
const WS_MAX_CONNECTIONS_PER_SESSION = Number(process.env.WS_MAX_CONNECTIONS_PER_SESSION || 8);
const WS_MAX_CONNECTIONS_PER_IP = Number(process.env.WS_MAX_CONNECTIONS_PER_IP || 32);
const db = new Db(path.join(DATA_DIR, 'agentdeck.sqlite3'));
const runtimeDb = new Db(process.env.RUNTIME_DB || path.join(DATA_DIR, 'agentdeck-runtime.sqlite3'));
const codex = new CodexBridge(DEFAULT_HOME, DEFAULT_CODEX_HOME);
const runtime = new RuntimeClient();
const USE_AGENT_RUNTIME = process.env.USE_AGENT_RUNTIME === '1';
const RELEASE_INFO = releaseMetadata();
const RELEASE_ID = process.env.AGENTDECK_RELEASE_ID || RELEASE_INFO.releaseId;
const API_DTO_CONTRACT_VERSION=1;
const RELEASE_COMMIT = process.env.AGENTDECK_RELEASE_COMMIT || RELEASE_INFO.commit;
const antigravity = new AntigravityProvider();
const geminiProvider = new GeminiProvider();
const claudeProvider = new ClaudeProvider();
const claudeProfileStore = new ClaudeProfileStore(db, DATA_DIR, process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude'));
const clients = new Map<string, Set<any>>();
const browserDelivery=new BrowserDeliveryHub({maxSequences:2000,maxRingBytes:8*1024*1024,maxQueuedFrames:2048,maxQueuedBytes:8*1024*1024});
let websocketConnectionGeneration = 0;
const websocketSessions = new Map<any, Set<string>>();
const websocketConnectionIps = new Map<any, string>();
const websocketIpCounts = new Map<string, number>();
const websocketSessionCounts = new Map<string, number>();
const websocketJoinFlights=new WeakMap<any,Map<string,Promise<void>>>();
const pendingApprovals = new Map<string, { id:string|number; method:string; createdAt:number }>();
const activeTurns = new Map<string, string>();
const activeCodexSessions = new Set<string>();
const activeRuntimeProviderSessions = new Set<string>();
let canonicalMessageFaults=Number(process.env.NODE_ENV==='test'?process.env.AGENTDECK_TEST_CANONICAL_INSERT_FAILURES||0:0);
type RuntimeSubscriptionState = { close:()=>void; connected:boolean; connecting:boolean; generation?:string; receivedSequence:number; processingSequence:number; committedSequence:number; lastSequence:number; lastError?:string; lastStatus:'unknown'|'checking'|'recovering'|'connected'|'unavailable'|'disconnected' };
const runtimeSubscriptions = new Map<string, RuntimeSubscriptionState>();
const runtimeSubscriptionReleases=new Map<string,NodeJS.Timeout>();
const RUNTIME_SUBSCRIPTION_IDLE_MS=Math.max(1000,Number(process.env.RUNTIME_SUBSCRIPTION_IDLE_MS||5000));
// Loaded before the server starts accepting websocket joins.  This is the
// durable owner cursor for the shared Runtime SSE, not a browser cursor.
const persistedIngestionCursors = new Map<string,number>();
const persistedIngestionGenerations = new Map<string,string>();
const sessionCommandQueue=new SessionCommandQueue(Number(process.env.WS_SESSION_COMMAND_QUEUE_MAX||64));
const chunkedMessages = new Map<string, { sessionId:string; clientMessageId:string; chunks:string[]; size:number; createdAt:number }>();
const threadTokenUsage = new Map<string, any>();
const runtimeDiagnostics = { subscribeStarts:0, subscribeReconnects:0, subscribeEvents:0, broadcasts:0, replayCalls:0 };
type LoginJob = { id:string; profileId:string; output:string[]; status:'running'|'done'|'error'; code?:number|null; error?:string; startedAt:number; newProfile?:boolean; loginUrl?:string; deviceCode?:string; metadataStatus?:'pending'|'ready'|'failed'; metadataError?:string };
const loginJobs = new Map<string, LoginJob>();
const loginChildren = new Map<string, any>();
type ProviderLoginAttemptStatus = 'starting'|'waiting_authorization'|'waiting_code'|'verifying'|'failed'|'cancelled'|'done';
type ProviderLoginAttempt = { id:string; provider:AgentProviderId; profileId:string|null; tempHome:string|null; methodId:string|null; status:ProviderLoginAttemptStatus; error:string|null; metadata:Record<string, any>; createdAt:number; updatedAt:number };
type AntigravityLoginJob = LoginJob & { providerId:'antigravity'; authCodePrompt?:boolean; codeSubmitted?:boolean };
const antigravityLoginJobs = new Map<string, AntigravityLoginJob>();
const antigravityLoginChildren = new Map<string, any>();
type ClaudeLoginJob = Omit<LoginJob, 'status'> & { providerId:'claude'; status:'running'|'waiting_user'|'verifying'|'done'|'error'|'cancelled'; requiresInput?:boolean };
const claudeLoginJobs = new Map<string, ClaudeLoginJob>();
const claudeLoginProfiles = new Map<string, string>();
const claudeLoginChildren = new Map<string, any>();
type GeminiLoginJob = {
  id:string;
  profileId:string;
  methodId:string;
  status:'preparing'|'waiting_user'|'verifying'|'done'|'failed'|'error'|'cancelled'|'fallback';
  loginUrl?:string;
  deviceCode?:string;
  requiresCodeInput?:boolean;
  error?:string;
  fallbackCommand?:string;
  output?:string[];
  codeSubmitted?:boolean;
  codeSubmittedAt?:number;
  startedAt:number;
};
const geminiLoginJobs = new Map<string, GeminiLoginJob>();
const geminiLoginProfiles = new Map<string, string>();
const geminiLoginWorkers = new Map<string, any>();
type ProviderInstallStatus = 'queued'|'downloading'|'installing'|'verifying'|'succeeded'|'failed'|'cancelled';
type ProviderInstallJob = {
  id:string;
  provider:AgentProviderId;
  action:'install'|'update';
  status:ProviderInstallStatus;
  output:string[];
  error?:string;
  version?:string|null;
  startedAt:number;
  updatedAt:number;
};
const providerInstallJobs = new Map<string, ProviderInstallJob>();
const providerInstallChildren = new Map<string, any>();
const providerInstallByProvider = new Map<AgentProviderId, string>();
const PROVIDER_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const activeArtifactTurns = new Map<string, string>();
const PROVIDER_INSTALL_JOBS_FILE = path.join(PROVIDER_TOOLS_DIR, 'jobs', 'install-jobs.json');
const PROVIDER_INSTALLERS:Record<AgentProviderId, {
  automatic:boolean;
  packageName?:string;
  installScriptUrl?:string;
  binary:string;
  manual:string;
  source:string;
  reason:string;
}> = {
  codex: {
    automatic:true,
    packageName:'@openai/codex',
    binary:'codex',
    source:'OpenAI Codex CLI npm package @openai/codex',
    reason:'OpenAI documents npm install -g @openai/codex as an official Codex CLI install path.',
    manual:'安装 Codex CLI：npm install -g @openai/codex，或使用 OpenAI 官方安装脚本。AgentDeck 会优先使用管理员配置，其次使用托管安装。',
  },
  claude: {
    automatic:true,
    installScriptUrl:'https://claude.ai/install.sh',
    binary:'claude',
    source:'Anthropic official Claude Code installer https://claude.ai/install.sh',
    reason:'Anthropic recommends the native Claude Code installer for Linux/macOS; AgentDeck runs it in an isolated managed tools directory.',
    manual:'安装 Claude Code：curl -fsSL https://claude.ai/install.sh | bash，或使用 Anthropic 文档中的 apt/dnf/apk/npm 方法。',
  },
  antigravity: {
    automatic:false,
    binary:'agy',
    source:'manual administrator install',
    reason:'没有稳定、公开且可验证的统一自动安装源；AgentDeck 不编造安装命令。',
    manual:'请按上游官方说明安装 Antigravity CLI，并将 ANTIGRAVITY_BIN 指向 agy 可执行文件。',
  },
  gemini: {
    automatic:false,
    binary:'gemini',
    source:'manual administrator install',
    reason:'Gemini CLI 在 AgentDeck 中仍是低优先级/受限 Provider，本版本只显示手动安装方法。',
    manual:'如需使用 Gemini CLI，请按 Google 官方说明安装并确保 gemini --acp 可用；个人账户可能受上游限制。',
  },
};
const GEMINI_LOGIN_TIMEOUT_MS = Number(process.env.GEMINI_LOGIN_TIMEOUT_MS || 5 * 60 * 1000);
const GEMINI_LOGIN_VERIFY_TIMEOUT_MS = Number(process.env.GEMINI_LOGIN_VERIFY_TIMEOUT_MS || 60 * 1000);
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
let claudeStatusCache: { expiresAt:number; promise?:Promise<any>; value?:any } = { expiresAt: 0 };
let unifiedProviderStatusCache: { expiresAt:number; promise?:Promise<Record<AgentProviderId, ProviderStatus>>; value?:Record<AgentProviderId, ProviderStatus>; generation:number } = { expiresAt: 0, generation: 0 };
let antigravityModelsCache: { key:string; expiresAt:number; promise?:Promise<any>; value?:any } = { key:'', expiresAt: 0 };
const antigravityUsageCache=new Map<string,{expiresAt:number;value:string|null;promise?:Promise<string|null>}>();
let shutdownRequested = false;
if (roots.length === 0) throw new Error('No allowed workspaces exist');
await db.init();
for (const row of await db.all('SELECT session_id,committed_sequence,runtime_generation FROM runtime_ingestion_cursors')){persistedIngestionCursors.set(String(row.session_id),Number(row.committed_sequence||0));persistedIngestionGenerations.set(String(row.session_id),String(row.runtime_generation||''));}
await migrateWebSchema(db);
await claudeProfileStore.initSchema();
await ensureProfiles();
await ensureGeminiProfiles();
await ensureAdmin();
await loadProviderInstallJobs();
const app = Fastify({ bodyLimit: Number(process.env.BODY_LIMIT_BYTES || 25 * 1024 * 1024), logger: { redact: ['req.headers.authorization','req.headers.cookie','res.headers.set-cookie','password','token','secret'] } });
await app.register(cookie, { secret: process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex') });
await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
await app.register(websocket);
await app.register(multipart, { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_ATTACHMENTS_PER_MESSAGE } });
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
await app.register(staticPlugin, { root: publicDir, prefix: '/' });
function requestOrigin(req:any) {
  const value = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  return value || '';
}
function sameHostOrigin(origin:string, host:string) {
  try {
    const parsed = new URL(origin);
    return !!host && parsed.host === host && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}
function localhostOrigin(origin:string) {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}
function allowedRequestOrigin(req:any) {
  const origin = requestOrigin(req);
  const referer = typeof req.headers.referer === 'string' ? req.headers.referer : '';
  const candidate = origin || referer;
  if (!candidate) return !ALLOWED_ORIGINS_CONFIGURED;
  let candidateOrigin = candidate;
  try { candidateOrigin = new URL(candidate).origin; } catch {}
  if (ALLOWED_ORIGINS.includes(candidate) || ALLOWED_ORIGINS.includes(candidateOrigin)) return true;
  if (ALLOWED_ORIGINS_CONFIGURED) return false;
  const host = typeof req.headers.host === 'string' ? req.headers.host : '';
  return sameHostOrigin(candidate, host) || localhostOrigin(candidate);
}
function authTokenHash(token:string) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}
function adminPasswordFingerprint() {
  return crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD || '').digest('hex');
}
function requestIpHint(req:any) {
  return String(req.ip || req.socket?.remoteAddress || '').slice(0, 80);
}
function legacySignedSessionCookie(req:any) {
  const value = req.cookies?.[COOKIE_NAME];
  if (!value) return null;
  try {
    const unsigned = app.unsignCookie(value);
    return unsigned.valid ? String(unsigned.value || '') : null;
  } catch {
    return null;
  }
}
async function createAuthSession(req:any, reply:any) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const expiresAt = now + AUTH_SESSION_TTL_MS;
  const id = crypto.randomUUID();
  await db.run(
    'INSERT INTO auth_sessions (id,token_hash,created_at,expires_at,last_seen_at,user_agent,ip_hint) VALUES (?1,?2,?3,?4,?5,?6,?7)',
    [id, authTokenHash(token), now, expiresAt, now, String(req.headers['user-agent'] || '').slice(0, 300), requestIpHint(req)]
  );
  await db.run('DELETE FROM auth_sessions WHERE expires_at<?1 OR revoked_at<?1', [now - AUTH_SESSION_TTL_MS]).catch(()=>{});
  reply.setCookie(COOKIE_NAME, token, secureCookie());
  reply.setCookie(CSRF_COOKIE, csrf, csrfCookie());
  return { id, token, csrf, expiresAt };
}
async function authSessionForRequest(req:any, reply?:any) {
  const token = req.cookies?.[COOKIE_NAME];
  const now = Date.now();
  if (token) {
    const row = await db.get('SELECT * FROM auth_sessions WHERE token_hash=?1 AND revoked_at IS NULL AND expires_at>?2', [authTokenHash(String(token)), now]).catch(()=>null);
    if (row) {
      req.authSession = row;
      await db.run('UPDATE auth_sessions SET last_seen_at=?1 WHERE id=?2', [now, row.id]).catch(()=>{});
      return row;
    }
  }
  const legacy = legacySignedSessionCookie(req);
  if (legacy && reply) {
    const session = await createAuthSession(req, reply);
    const row = await db.get('SELECT * FROM auth_sessions WHERE id=?1', [session.id]).catch(()=>null);
    req.authSession = row;
    return row;
  }
  return null;
}
app.addHook('preHandler', async (req, reply) => {
  if (!['GET','HEAD'].includes(req.method) && !allowedRequestOrigin(req)) return reply.code(403).send({error:'origin'});
  if (['POST','PUT','PATCH','DELETE'].includes(req.method) && !['/api/login'].includes(req.url)) {
    const csrf = req.cookies[CSRF_COOKIE];
    if (!csrf || req.headers['x-csrf-token'] !== csrf) return reply.code(403).send({error:'csrf'});
  }
});
function cookieIsSecure() { return String(process.env.COOKIE_SECURE ?? 'true').toLowerCase() !== 'false'; }
function secureCookie() { return { httpOnly:true, secure:cookieIsSecure(), sameSite:'strict' as const, path:'/', maxAge: 60*60*24*14 }; }
function csrfCookie() { return { httpOnly:false, secure:cookieIsSecure(), sameSite:'strict' as const, path:'/', maxAge: 60*60*24*14 }; }
async function ensureAuth(req:any, reply:any) { if (!(await authSessionForRequest(req, reply))) return reply.code(401).send({error:'unauthorized'}); }
async function isAuthenticated(req:any, reply?:any) {
  return !!(await authSessionForRequest(req, reply));
}
app.get('/api/auth/status', async (req, reply) => ({ authenticated: await isAuthenticated(req, reply) }));
app.get('/api/status', async (req) => {
  const startedAt = Date.now();
  const authed = await isAuthenticated(req);
  if (!authed) return { authed:false, authenticated:false, serverTime:Date.now(), capabilities:{} };
  const force = !!(req.query && typeof req.query === 'object' && (req.query as any).refresh === '1');
  const [
    settings,
    activeProfile,
    activeGeminiProfile,
    activeAntigravityProfile,
    activeClaudeProfile,
    codexStatus,
    claudeStatus,
    antigravityStatus,
    geminiStatus,
    geminiRuntime,
    runtimeState,
    providerStatuses,
  ] = await Promise.all([
    appSettings(),
    getActiveProfile(),
    getActiveGeminiProfile(),
    getActiveAntigravityProfile(),
    activeClaudeProfileSummary(),
    cachedCodexStatus(),
    cachedClaudeStatus(force),
    cachedAntigravityStatus(force),
    cachedGeminiStatus(force),
    USE_AGENT_RUNTIME ? runtime.geminiStatus().catch((e:any)=>({ error:e?.message || String(e) })) : Promise.resolve({ error:'persistent runtime disabled' }),
    USE_AGENT_RUNTIME ? runtimeAdminState().catch((e:any)=>({ error:e?.message || String(e), acceptingNewTurns:false })) : Promise.resolve({ error:'persistent runtime disabled', acceptingNewTurns:true }),
    unifiedProviderStatuses(force),
    syncAntigravityProfilesFromDisk().catch(()=>{}),
  ]);
  app.log.info({ ms:Date.now() - startedAt }, 'api status computed');
  return { authed, authenticated:true, serverTime: Date.now(), release:{ releaseId:RELEASE_ID, commit:RELEASE_COMMIT, pid:process.pid, port:Number(process.env.PORT || 3842) }, runtimeState, codex: codexStatus, claude: claudeStatus, gemini: { ...geminiStatus, runtime:geminiRuntime }, antigravity: antigravityStatus, providers: providerStatusArray(providerStatuses), providerDefinitions: VISIBLE_PROVIDER_ORDER.map(id => PROVIDER_DEFINITIONS[id]), providerStatus: providerStatuses, activeProvider: settings.activeProvider, roots, defaultWorkspace: DEFAULT_WORKSPACE_DIR, mode:modeLabel(settings.defaultMode), defaultMode:settings.defaultMode, defaultModel:settings.defaultModel, codexHome: codex.getCodexHome(), activeProfile, activeClaudeProfile, activeGeminiProfile, activeAntigravityProfile, claudeProfiles: await listClaudeProfiles(), geminiProfiles: await listGeminiProfiles(), geminiPendingProfiles: await listGeminiPendingProfiles(), capabilities: attachmentCapabilities(geminiRuntime) };
});
app.get('/internal/deep-health',async(req:any,reply)=>{if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(String(req.ip||'')))return reply.code(403).send({error:'loopback_only'});const runtimeHealth=USE_AGENT_RUNTIME?await runtime.deepHealth():null;const migration=await db.get("SELECT COALESCE(MAX(version),0) version FROM schema_migrations WHERE owner='web'");const integrity=await db.get('PRAGMA integrity_check');const sqlite=integrity?.integrity_check==='ok',schemaMigrationVersion=Number(migration?.version||0),webSchemaShapeCompatible=await verifyWebSchema(db).then(()=>true).catch(()=>false),webSchemaCompatible=schemaMigrationVersion===WEB_SCHEMA_VERSION&&webSchemaShapeCompatible,runtimeSchemaCompatible=!!runtimeHealth&&Number(runtimeHealth.schemaMigrationVersion)===RUNTIME_SCHEMA_VERSION&&runtimeHealth.schemaShapeCompatible===true;const compatible=!!runtimeHealth&&Number(runtimeHealth.contractVersion)===API_DTO_CONTRACT_VERSION&&runtimeSchemaCompatible;return{ok:sqlite&&webSchemaCompatible&&compatible&&!!runtimeHealth?.ok,component:'web',releaseId:RELEASE_ID,contractVersion:API_DTO_CONTRACT_VERSION,schemaMigrationVersion,expectedSchemaMigrationVersion:WEB_SCHEMA_VERSION,webSchemaCompatible,webSchemaShapeCompatible,runtimeSchemaCompatible,sqlite,runtimeConnected:!!runtimeHealth?.ok,runtimeReleaseId:runtimeHealth?.releaseId||null,runtimeMode:runtimeHealth?.mode||null,runtimeContractVersion:runtimeHealth?.contractVersion||null,runtimeSchemaMigrationVersion:runtimeHealth?.schemaMigrationVersion||null,compatible};});
app.get('/api/app-state', { preHandler: ensureAuth }, async () => lightAppState());
async function lightAppState() {
  const settings = await appSettings();
  const codexStatus = cachedCodexStatusSnapshot();
  const geminiStatus = cachedProviderStatusSnapshot('gemini', geminiStatusCache.value);
  const claudeStatus = cachedProviderStatusSnapshot('claude', claudeStatusCache.value);
  const antigravityStatus = cachedProviderStatusSnapshot('antigravity', antigravityStatusCache.value);
  // The dashboard is the product's primary control surface. Returning synthetic
  // "checking" snapshots here made every provider look unknown after switching
  // agents, even when the authoritative status was available milliseconds later.
  const providerStatuses = await unifiedProviderStatuses(false);
  return {
    authed:true,
    authenticated:true,
    serverTime:Date.now(),
    codex:codexStatus,
    claude:claudeStatus,
    gemini:geminiStatus,
    antigravity:antigravityStatus,
    providers:providerStatusArray(providerStatuses),
    providerStatus:providerStatuses,
    providerInstallers:providerInstallerSummaries(),
    providerInstallJobs:providerInstallJobSummaries(),
    activeProvider:settings.activeProvider,
    roots,
    defaultWorkspace:DEFAULT_WORKSPACE_DIR,
    mode:modeLabel(settings.defaultMode),
    defaultMode:settings.defaultMode,
    defaultModel:settings.defaultModel,
    defaultModels:settings.defaultModels,
    activeProfile:await activeCodexProfileSummary(),
    activeClaudeProfile:await activeClaudeProfileSummary(),
    activeGeminiProfile:await activeGeminiProfileSummary(),
    activeAntigravityProfile:await activeAntigravityProfileSummary(),
    capabilities:attachmentCapabilities(null),
  };
}
app.get('/api/providers/status', { preHandler: ensureAuth }, async (req:any) => {
  const providers = await unifiedProviderStatuses(req.query?.refresh === '1');
  return { providers, checkedAt:new Date().toISOString() };
});
app.get('/api/providers/installers', { preHandler: ensureAuth }, async () => ({
  installers: providerInstallerSummaries(),
  jobs: providerInstallJobSummaries(),
}));
app.post('/api/providers/:provider/install', { preHandler: ensureAuth }, async (req:any, reply) => {
  const provider = normalizeProvider(req.params.provider);
  if (!provider) return reply.code(400).send({ error:'unknown provider' });
  const action = String(req.body?.action || 'install');
  if (!['install','retry'].includes(action)) return reply.code(400).send({ error:'unsupported installer action' });
  const installer = PROVIDER_INSTALLERS[provider];
  if (!installer.automatic) return reply.code(409).send({ error:'automatic install is not supported for this provider', installer:providerInstallerSummary(provider) });
  const existingId = providerInstallByProvider.get(provider);
  const existing = existingId ? providerInstallJobs.get(existingId) : null;
  if (existing && !['succeeded','failed','cancelled'].includes(existing.status)) return { job:providerInstallJobSummary(existing) };
  const job:ProviderInstallJob = { id:`install-${provider}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, provider, action:'install', status:'queued', output:[], startedAt:Date.now(), updatedAt:Date.now() };
  providerInstallJobs.set(job.id, job);
  providerInstallByProvider.set(provider, job.id);
  await persistProviderInstallJobs().catch(()=>{});
  runProviderInstallJob(job).catch((e:any) => failProviderInstallJob(job, e?.message || String(e)));
  return { job:providerInstallJobSummary(job) };
});
app.get('/api/provider-install/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const job = providerInstallJobs.get(String(req.params.id));
  if (!job) return reply.code(404).send({ error:'install job not found' });
  return { job:providerInstallJobSummary(job) };
});
app.delete('/api/provider-install/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const id = String(req.params.id);
  const job = providerInstallJobs.get(id);
  if (!job) return reply.code(404).send({ error:'install job not found' });
  const child = providerInstallChildren.get(id);
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
    providerInstallChildren.delete(id);
  }
  if (!['succeeded','failed','cancelled'].includes(job.status)) {
    job.status = 'cancelled';
    job.error = '安装已取消';
    job.updatedAt = Date.now();
    providerInstallByProvider.delete(job.provider);
    await rm(providerInstallCandidateDir(job), { recursive:true, force:true }).catch(()=>{});
    await persistProviderInstallJobs().catch(()=>{});
  }
  return { job:providerInstallJobSummary(job) };
});
app.get('/api/diagnostics', { preHandler: ensureAuth }, async () => {
  const settings = await appSettings();
  const providerStatuses = await unifiedProviderStatuses(false);
  const activeProvider = settings.activeProvider;
  const activeStatus = providerStatuses[activeProvider];
  const session = await diagnosticSession();
  const runtimeInfo = await runtime.diagnostics().catch((e:any)=>({ error:e?.message || String(e) }));
  const profileId = String(activeStatus?.activeProfileId || activeStatus?.accountSummary?.profileId || '');
  const appServer = activeProvider === 'codex' && profileId ? diagnosticCodexAppServer(profileId) : null;
  const payload = {
    commit: await currentCommit(),
    web: {
      ok:true,
      pid:process.pid,
      status:'ready',
      runtimeSubscriptions:[...runtimeSubscriptions.entries()].map(([sessionId,state]) => ({
        sessionId,
        connected:state.connected,
        runtimeLatestSequence:state.lastSequence,
        generation:state.generation || null,
        subscriberCount:clients.get(sessionId)?.size || 0,
      })),
      counters:runtimeDiagnostics,
    },
    runtime: runtimeInfo,
    provider: {
      activeProvider,
      activeProfileId:activeStatus?.activeProfileId || null,
      accountEmail:activeStatus?.accountSummary?.email || activeStatus?.account?.email || null,
      checkedAt:activeStatus?.checkedAt || null,
      canCreateSession:!!activeStatus?.canCreateSession,
      canContinueSession:!!activeStatus?.canContinueSession,
      status:activeStatus ? {
        availability:activeStatus.availability,
        auth:activeStatus.auth,
        reasonCode:activeStatus.reasonCode || null,
        message:activeStatus.message || null,
      } : null,
    },
    session,
    appServer,
    verbose: VERBOSE_DIAGNOSTICS,
    sequenceTerms: {
      runtimeLatestSequence:'Runtime persisted event high-water mark.',
      snapshotCoveredSequence:'Sequence covered by the current HTTP/thread snapshot.',
      browserAppliedSequence:'Highest sequence the browser has rendered locally.',
      browserAcknowledgedSequence:'Highest sequence the browser has reported back to the server.',
    },
  };
  return maskSecrets(VERBOSE_DIAGNOSTICS ? payload : redactDiagnosticPaths(payload));
});
app.get('/api/runtime-diagnostics', { preHandler: ensureAuth }, async () => {
  const payload = {
    local: {
      ...runtimeDiagnostics,
      subscriptions:[...runtimeSubscriptions.entries()].map(([sessionId,state]) => ({ sessionId, connected:state.connected, lastSequence:state.lastSequence, generation:state.generation || null, clients:clients.get(sessionId)?.size || 0 })),
    },
    runtime: await runtime.diagnostics().catch((e:any)=>({ error:e?.message || String(e) })),
    verbose: VERBOSE_DIAGNOSTICS,
  };
  return maskSecrets(VERBOSE_DIAGNOSTICS ? payload : redactDiagnosticPaths(payload));
});
app.post('/api/maintenance/cleanup-archived', { preHandler: ensureAuth }, async () => cleanupArchivedSessions('manual'));
app.get('/api/quota', { preHandler: ensureAuth }, async (req:any) => {
  const settings = await appSettings();
  const provider = normalizeProvider(req.query?.provider) || settings.activeProvider;
  if (provider === 'gemini') {
    const activeProfile:any = await getActiveGeminiProfile();
    const providerStatuses = await unifiedProviderStatuses(false);
    const geminiProviderStatus = providerStatuses.gemini;
    const account = activeProfile ? geminiAccountSnapshot(activeProfile) : null;
    return {
      provider: 'gemini',
      providerId: 'gemini',
      supported: false,
      providerStatus: geminiProviderStatus,
      account: account ? {
        id: account.id,
        email: account.email || null,
        name: account.name || account.email || 'Gemini Account',
        authType: account.authType || activeProfile?.authType || null,
      } : null,
      rateLimits: null,
      message: 'Gemini ACP 暂未提供稳定的独立实时剩余额度查询。',
      errors: {},
      checkedAt: Date.now(),
    };
  }
  if (provider === 'claude') {
    const providerStatuses = await unifiedProviderStatuses(false);
    return {
      provider:'claude',
      providerId:'claude',
      supported:false,
      providerStatus:providerStatuses.claude,
      account:providerStatuses.claude?.accountSummary || providerStatuses.claude?.account || null,
      rateLimits:null,
      message:'Claude Agent SDK 返回 usage/cost，但没有稳定账户剩余额度接口。',
      errors:{},
      checkedAt:Date.now(),
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
  const activeProfile:any = await getActiveProfile().catch(()=>null);
  const accountId = activeProfile?.id ? String(activeProfile.id) : 'default';
  const codexHome = activeProfile?.codex_home ? String(activeProfile.codex_home) : DEFAULT_CODEX_HOME;
  const [account, limits] = await Promise.allSettled(USE_AGENT_RUNTIME ? [runtime.account(accountId, codexHome), runtime.rateLimits(accountId, codexHome)] : [codex.account(), codex.rateLimits()]);
  if (limits.status === 'fulfilled') {
    app.log.info({ provider:'codex', operation:'quota_read', accountId, cache:'none', ...codexQuotaLogFields(limits.value) }, 'codex quota read');
  }
  return {
    providerId: 'codex',
    accountId,
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
  const light = req.query?.light === '1';
  const [
    settings,
    profiles,
    claudeProfiles,
    activeClaudeProfile,
    pendingProfiles,
    activeProfile,
    geminiProfiles,
    geminiPendingProfiles,
    activeGeminiProfile,
    antigravityProfiles,
    activeAntigravityProfile,
    codexStatus,
    claudeStatus,
    antigravityStatus,
    geminiStatus,
    geminiRuntime,
    providerStatuses,
  ] = await Promise.all([
    appSettings(),
    listProfiles(),
    listClaudeProfiles(),
    activeClaudeProfileSummary(),
    listPendingProfiles(),
    getActiveProfile(),
    listGeminiProfiles(),
    listGeminiPendingProfiles(),
    getActiveGeminiProfile(),
    listAntigravityProfiles(),
    getActiveAntigravityProfile(),
    light ? Promise.resolve(cachedCodexStatusSnapshot()) : cachedCodexStatus(),
    light ? Promise.resolve(cachedProviderStatusSnapshot('claude', claudeStatusCache.value)) : cachedClaudeStatus(force),
    light ? Promise.resolve(cachedProviderStatusSnapshot('antigravity', antigravityStatusCache.value)) : cachedAntigravityStatus(force),
    light ? Promise.resolve(cachedProviderStatusSnapshot('gemini', geminiStatusCache.value)) : cachedGeminiStatus(force),
    light || !USE_AGENT_RUNTIME ? Promise.resolve({ error: light ? 'not refreshed' : 'persistent runtime disabled' }) : runtime.geminiStatus().catch((e:any)=>({ error:e?.message || String(e) })),
    light ? Promise.resolve(cachedUnifiedProviderStatusesSnapshot()) : unifiedProviderStatuses(force),
    syncAntigravityProfilesFromDisk().catch(()=>{}),
  ]);
  return { settings, profiles, pendingProfiles, activeProfile, claudeProfiles, activeClaudeProfile, geminiProfiles, geminiPendingProfiles, activeGeminiProfile, antigravityProfiles, activeAntigravityProfile, codex: codexStatus, claude: claudeStatus, gemini:{...geminiStatus,runtime:geminiRuntime}, antigravity: antigravityStatus, providers: providerStatusArray(providerStatuses), providerStatus: providerStatuses, providerDefinitions: VISIBLE_PROVIDER_ORDER.map(id => PROVIDER_DEFINITIONS[id]), providerInstallers:providerInstallerSummaries(), providerInstallJobs:providerInstallJobSummaries() };
});
app.patch('/api/settings', { preHandler: ensureAuth }, async (req:any) => {
  const provider = normalizeProvider(req.body?.activeProvider);
  // Selecting an agent does not change CLI or account health. Keep the warm
  // provider snapshot so this interaction stays instant instead of probing all
  // four CLIs again (Gemini alone can take several seconds to answer).
  if (provider&&visibleProvider(provider)) await setSetting('activeProvider', provider);
  const mode = normalizeMode(req.body?.defaultMode);
  if (mode) await setSetting('defaultMode', mode);
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'defaultModel')) {
    const settings = await appSettings();
    const modelProvider = normalizeProvider(req.body?.provider) || provider || settings.activeProvider;
    const model = modelProvider === 'antigravity' || modelProvider === 'gemini' || modelProvider === 'claude' ? cleanAgentModel(req.body?.defaultModel) : cleanModel(req.body?.defaultModel);
    if (modelProvider === 'gemini') await setActiveGeminiDefaultModel(model || null);
    else await setSetting(modelProvider === 'antigravity' ? 'defaultModelAntigravity' : modelProvider === 'claude' ? 'defaultModelClaude' : 'defaultModelCodex', model || '');
  }
  return { settings: await appSettings() };
});
app.get('/api/models', { preHandler: ensureAuth }, async (req:any) => modelCatalog(req.query?.hidden === '1', normalizeProvider(req.query?.provider) || (await appSettings()).activeProvider));
app.get('/api/claude/profiles', { preHandler: ensureAuth }, async () => ({ profiles: await listClaudeProfiles(), activeClaudeProfile: await activeClaudeProfileSummary() }));
app.post('/api/claude/profiles', { preHandler: ensureAuth }, async (req:any, reply) => {
  const type = String(req.body?.type || 'official_cli');
  if (!['official_cli','existing_cli','setup_token','api_key'].includes(type)) return reply.code(400).send({ error:'bad profile type' });
  const profile = await claudeProfileStore.create({
    name: cleanProfileName(String(req.body?.name || 'Claude Code Account')),
    type: type as any,
    token: typeof req.body?.token === 'string' ? req.body.token : undefined,
    apiKey: typeof req.body?.apiKey === 'string' ? req.body.apiKey : undefined,
    existingConfigDir: typeof req.body?.configDir === 'string' ? req.body.configDir : undefined,
  });
  if (!profile) return reply.code(500).send({ error:'profile create failed' });
  const verified = await claudeAuthStatus(profile);
  if (!verified.ok) {
    await claudeProfileStore.delete(profile.id).catch(()=>{});
    invalidateUnifiedProviderStatuses();
    return reply.code(400).send({ error:'claude_auth_failed', message:verified.error || 'Claude auth status 未通过' });
  }
  await claudeProfileStore.markStatus(profile.id, 'authenticated');
  await claudeProfileStore.switch(profile.id);
  invalidateUnifiedProviderStatuses();
  return { profile: await activeClaudeProfileSummary() };
});
app.post('/api/claude/profiles/login', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profileId = typeof req.body?.profileId === 'string' ? req.body.profileId : '';
  let profile = profileId ? await claudeProfileStore.get(profileId) : null;
  if (!profile) {
    profile = await claudeProfileStore.create({
      name: cleanProfileName(String(req.body?.name || 'Claude Code Account')),
      type: 'official_cli' as any,
    });
  }
  if (!profile) return reply.code(500).send({ error:'profile create failed' });
  const existingJobId = claudeLoginProfiles.get(profile.id);
  if (existingJobId) {
    const existing = claudeLoginJobs.get(existingJobId);
    if (existing && !['done','error','cancelled'].includes(existing.status)) return { job:existing };
  }
  const job:ClaudeLoginJob = { id:`claude-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, providerId:'claude', profileId:profile.id, output:[], status:'running', startedAt:Date.now(), newProfile:!profileId };
  claudeLoginJobs.set(job.id, job);
  claudeLoginProfiles.set(profile.id, job.id);
  await claudeProfileStore.switch(profile.id).catch(()=>{});
  await claudeProfileStore.markStatus(profile.id, 'not_configured').catch(()=>{});
  runClaudeCliLoginJob(job).catch((e:any)=>failClaudeLoginJob(job, safeClaudeError(e)));
  invalidateUnifiedProviderStatuses();
  return { job };
});
app.get('/api/claude-login/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const job = claudeLoginJobs.get(String(req.params.id));
  if (!job) return reply.code(404).send({ error:'login job not found' });
  return { job };
});
app.post('/api/claude-login/:id/input', { preHandler: ensureAuth }, async (req:any, reply) => {
  const id = String(req.params.id);
  const job = claudeLoginJobs.get(id);
  const child = claudeLoginChildren.get(id);
  if (!job || !child) return reply.code(404).send({ error:'login job not running' });
  const text = String(req.body?.text || '');
  if (!text || text.length > 4096) return reply.code(400).send({ error:'input required' });
  child.write(text.endsWith('\n') || text.endsWith('\r') ? text : `${text}\r`);
  return { ok:true };
});
app.delete('/api/claude-login/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const id = String(req.params.id);
  const job = claudeLoginJobs.get(id);
  const child = claudeLoginChildren.get(id);
  if (child) {
    try { child.kill(); } catch {}
    claudeLoginChildren.delete(id);
  }
  if (job && job.status !== 'done') {
    job.status = 'cancelled';
    job.error = '登录已取消';
    claudeLoginProfiles.delete(job.profileId);
    await claudeProfileStore.markStatus(job.profileId, 'not_configured').catch(()=>{});
    invalidateUnifiedProviderStatuses();
  }
  return { ok:true };
});
app.post('/api/claude/profiles/:id/switch', { preHandler: ensureAuth }, async (req:any, reply) => {
  const existing = await claudeProfileStore.get(String(req.params.id));
  if (!existing || existing.status !== 'authenticated') return reply.code(404).send({ error:'profile not found' });
  const profile = await claudeProfileStore.switch(String(req.params.id)).catch(()=>null);
  if (!profile) return reply.code(404).send({ error:'profile not found' });
  invalidateProviderCaches('claude');
  const statuses = await unifiedProviderStatuses(false);
  return { ok:true, activeClaudeProfile: await activeClaudeProfileSummary(), providerStatus:statuses.claude };
});
app.post('/api/claude/profiles/:id/logout', { preHandler: ensureAuth }, async (req:any, reply) => {
  const id = String(req.params.id);
  const profile = await claudeProfileStore.get(id);
  if (!profile) return reply.code(404).send({ error:'profile not found' });
  const result = await claudeAuthLogout(profile);
  await claudeProfileStore.markStatus(id, 'not_configured').catch(()=>{});
  invalidateUnifiedProviderStatuses();
  return { ok:result.ok, result };
});
app.patch('/api/claude/profiles/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await claudeProfileStore.rename(String(req.params.id), String(req.body?.name || '')).catch(()=>null);
  if (!profile) return reply.code(404).send({ error:'profile not found' });
  invalidateUnifiedProviderStatuses();
  return { ok:true, profile };
});
app.delete('/api/claude/profiles/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const id = String(req.params.id);
  const running = await db.get("SELECT id FROM sessions WHERE provider_id='claude' AND (current_upstream_account_id=?1 OR (current_upstream_account_id IS NULL AND account_id=?1)) AND status IN ('running','submitting','recovering') LIMIT 1", [id])
    || await runtimeDb.get("SELECT id FROM sessions WHERE (provider_id='claude' OR provider='claude') AND (current_upstream_account_id=?1 OR (current_upstream_account_id IS NULL AND account_id=?1)) AND status IN ('running','submitting','recovering') LIMIT 1", [id]).catch(()=>null);
  if (running) return reply.code(409).send({ error:'该 Claude profile 仍有正在运行的会话，不能删除' });
  const ok = await claudeProfileStore.delete(id);
  if (!ok) return reply.code(404).send({ error:'profile not found' });
  invalidateUnifiedProviderStatuses();
  return { ok:true };
});
app.get('/api/profiles', { preHandler: ensureAuth }, async () => ({ profiles: await listProfiles(), pendingProfiles: await listPendingProfiles(), activeProfile: await getActiveProfile() }));
app.post('/api/profiles/:id/metadata/refresh', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile:any = await getProfile(String(req.params.id));
  if (!profile) return reply.code(404).send({error:'profile not found'});
  const metadata = await refreshCodexProfileMetadata(String(profile.id), String(profile.codex_home));
  return { ok:metadata.status === 'ready', metadata, profile:await getProfileDto(String(profile.id)) };
});
app.post('/api/profiles', { preHandler: ensureAuth }, async (req:any) => {
  const name = cleanProfileName(String(req.body?.name || 'Codex Account'));
  const attempt = await createProviderLoginAttempt('codex', { displayName:name });
  await mkdir(String(attempt.tempHome), { recursive:true });
  await ensureSharedCodexDirs(String(attempt.tempHome));
  return { loginAttempt: attempt, profile: providerLoginAttemptDto(attempt) };
});
app.post('/api/profiles/:id/switch', { preHandler: ensureAuth }, async (req:any) => {
  const profile = await getProfile(String(req.params.id));
  if (!profile) throw new Error('profile not found');
  try {
    await activateProfile(String(profile.id));
  } catch (error:any) {
    throw new Error(`Codex 账户切换失败：${safeAntigravitySummary(String(error?.message || error))}`);
  }
  void refreshCodexProfileMetadata(String(profile.id), String(profile.codex_home)).catch(()=>{});
  invalidateProviderCaches('codex');
  const statuses = await unifiedProviderStatuses(false);
  return { ok:true, activeProfile: await getActiveProfile(), providerStatus:statuses.codex };
});
app.delete('/api/profiles/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await getProfile(String(req.params.id));
  if (!profile) {
    const attempt = await getProviderLoginAttempt(String(req.params.id));
    if (attempt?.provider === 'codex') {
      await cancelCodexLoginForProfile(String(attempt.id));
      await updateProviderLoginAttempt(String(attempt.id), { status:'cancelled', error:'登录已取消' });
      if (attempt.tempHome) await deleteProfileDir(String(attempt.tempHome)).catch(()=>{});
      return { ok:true, cancelled:true };
    }
    return reply.code(404).send({error:'profile not found'});
  }
  const running = await db.get("SELECT id FROM sessions WHERE provider_id='codex' AND account_id=?1 AND status IN ('running','submitting','recovering') LIMIT 1", [String(profile.id)]);
  if (running) return reply.code(409).send({error:'该账户仍有正在运行的任务，请停止任务后再删除。'});
  await cancelCodexLoginForProfile(String(profile.id));
  const refs = await providerSessionReferenceCount('codex', String(profile.id));
  if (refs > 0) {
    await db.run("UPDATE codex_profiles SET active=0, status='disabled', updated_at=?1 WHERE id=?2", [Date.now(), String(profile.id)]);
    await ensureCodexActiveProfile();
    invalidateUnifiedProviderStatuses();
    return { ok:true, hidden:true, references:refs };
  }
  await db.run('DELETE FROM codex_profiles WHERE id=?1', [String(profile.id)]);
  await deleteProfileDir(String(profile.codex_home)).catch(()=>{});
  await ensureCodexActiveProfile();
  invalidateUnifiedProviderStatuses();
  return { ok:true };
});
app.get('/api/gemini/profiles', { preHandler: ensureAuth }, async () => ({ profiles: await listGeminiProfiles(), pendingProfiles: await listGeminiPendingProfiles(), activeGeminiProfile: await getActiveGeminiProfile() }));
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
  const dto = await getGeminiProfileDto(String(profile.id), { includeHidden:true });
  if (dto?.status !== 'authenticated' || !dto.login?.ok) return reply.code(409).send({error:'请先登录该 Gemini 账户'});
  await activateGeminiProfile(String(profile.id));
  invalidateProviderCaches('gemini');
  const statuses = await unifiedProviderStatuses(false);
  return { ok:true, activeGeminiProfile: await getActiveGeminiProfile(), providerStatus:statuses.gemini };
});
app.post('/api/gemini/profiles/:id/refresh', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await getGeminiProfile(String(req.params.id));
  if (!profile) return reply.code(404).send({error:'profile not found'});
  const result = await reconcileGeminiProfileAuthentication(String(profile.id), { reason:'manual_refresh' });
  return { profile: await getGeminiProfileDto(String(profile.id), { includeHidden:true }), runtime: sanitizeGeminiRuntimeStatus(result.runtimeStatus), reconcile: result };
});
app.post('/api/gemini/profiles/:id/logout', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await getGeminiProfile(String(req.params.id));
  if (!profile) return reply.code(404).send({error:'profile not found'});
  const running = await db.get("SELECT id FROM sessions WHERE provider_id='gemini' AND (current_upstream_account_id=?1 OR (current_upstream_account_id IS NULL AND account_id=?1)) AND status IN ('running','submitting','recovering') LIMIT 1", [String(profile.id)])
    || await runtimeDb.get("SELECT id FROM sessions WHERE (provider_id='gemini' OR provider='gemini') AND (current_upstream_account_id=?1 OR (current_upstream_account_id IS NULL AND account_id=?1)) AND status IN ('running','submitting','recovering') LIMIT 1", [String(profile.id)]).catch(()=>null);
  if (running) return reply.code(409).send({error:'该 Gemini 账户仍有正在运行的会话，不能退出登录'});
  await runtime.logoutGeminiProfile(String(profile.id)).catch((e:any)=>{ throw new Error(safeGeminiError(e)); });
  await removeGeminiProfileSecret(String(profile.home_dir), 'GEMINI_API_KEY').catch(()=>{});
  await db.run("UPDATE gemini_profiles SET auth_type=NULL, active=0, status='configured', updated_at=?1 WHERE id=?2", [Date.now(), String(profile.id)]);
  await ensureGeminiActiveProfile();
  invalidateUnifiedProviderStatuses();
  return { ok:true, profile: await getGeminiProfileDto(String(profile.id)) };
});
app.post('/api/gemini/profiles/:id/login', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await getGeminiProfile(String(req.params.id));
  if (!profile) return reply.code(404).send({error:'profile not found'});
  if (geminiLoginProfiles.has(String(profile.id))) return reply.code(409).send({error:'该 Gemini Profile 已有登录任务在运行'});
  const methodId = String(req.body?.methodId || '').trim();
  if (!methodId) return reply.code(400).send({error:'methodId required'});
  await db.run("UPDATE gemini_profiles SET status='authenticating', updated_at=?1 WHERE id=?2 AND status IN ('bootstrap','draft','failed','needs_login','configured')", [Date.now(), String(profile.id)]).catch(()=>{});
  let attempt = await getProviderLoginAttempt(String(profile.id));
  if (!attempt || attempt.provider !== 'gemini') attempt = await createProviderLoginAttempt('gemini', { id:String(profile.id), profileId:String(profile.id), tempHome:String(profile.home_dir), methodId, displayName:String(profile.name || 'Gemini Login') });
  await updateProviderLoginAttempt(String(attempt!.id), { status:'starting', methodId, profileId:String(profile.id) }).catch(()=>{});
  invalidateUnifiedProviderStatuses();
  const job:GeminiLoginJob = { id:crypto.randomBytes(12).toString('base64url'), profileId:String(profile.id), methodId, status:'preparing', startedAt:Date.now() };
  geminiLoginJobs.set(job.id, job);
  geminiLoginProfiles.set(String(profile.id), job.id);
  runGeminiLoginJob(job, req.body || {}).catch((e:any) => {
    setGeminiJobStatus(job, 'failed', safeGeminiError(e));
    job.codeSubmitted = false;
  }).finally(() => {
    if (geminiLoginProfiles.get(job.profileId) === job.id) geminiLoginProfiles.delete(job.profileId);
  });
  return { job };
});
app.delete('/api/gemini/profiles/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await getGeminiProfile(String(req.params.id));
  if (!profile) {
    const attempt = await getProviderLoginAttempt(String(req.params.id));
    if (attempt?.provider === 'gemini') {
      await updateProviderLoginAttempt(String(attempt.id), { status:'cancelled', error:'登录已取消' });
      if (attempt.tempHome) await deleteGeminiProfileDir(String(attempt.tempHome)).catch(()=>{});
      return { ok:true, cancelled:true };
    }
    return reply.code(404).send({error:'profile not found'});
  }
  const running = await db.get("SELECT id FROM sessions WHERE provider_id='gemini' AND (current_upstream_account_id=?1 OR (current_upstream_account_id IS NULL AND account_id=?1)) AND status IN ('running','submitting','recovering') LIMIT 1", [String(profile.id)])
    || await runtimeDb.get("SELECT id FROM sessions WHERE (provider_id='gemini' OR provider='gemini') AND (current_upstream_account_id=?1 OR (current_upstream_account_id IS NULL AND account_id=?1)) AND status IN ('running','submitting','recovering') LIMIT 1", [String(profile.id)]).catch(()=>null);
  if (running) return reply.code(409).send({error:'该账户仍有正在运行的任务，请停止任务后再删除。'});
  const timings:Record<string, number> = {};
  const step = async (name:string, fn:()=>Promise<any>) => {
    const started = Date.now();
    try { return await fn(); }
    finally { timings[name] = Date.now() - started; }
  };
  const snapshot = geminiAccountSnapshot(profile);
  await step('cancelLogin', () => cancelGeminiLoginForProfile(String(profile.id)));
  await step('stopDisposeAcp', () => runtime.disposeGeminiProfile(String(profile.id)).catch(()=>null));
  await step('dbDelete', async () => {
    await db.run("UPDATE sessions SET account_snapshot_json=COALESCE(account_snapshot_json, ?1) WHERE provider_id='gemini' AND account_id=?2", [JSON.stringify(snapshot), String(profile.id)]).catch(()=>{});
    await db.run('DELETE FROM gemini_profiles WHERE id=?1', [String(profile.id)]);
  });
  await step('chooseActive', () => ensureGeminiActiveProfile());
  invalidateUnifiedProviderStatuses();
  const homeDir = String(profile.home_dir);
  setTimeout(() => {
    const started = Date.now();
    deleteGeminiProfileDir(homeDir)
      .then(() => app.log.info({ provider:'gemini', profileId:String(profile.id), elapsedMs:Date.now() - started }, 'gemini profile directory deleted'))
      .catch((e:any) => app.log.warn({ provider:'gemini', profileId:String(profile.id), err:safeGeminiError(e), elapsedMs:Date.now() - started }, 'gemini profile directory delete failed'));
  }, 0).unref?.();
  app.log.info({ provider:'gemini', profileId:String(profile.id), timings, totalMs:Object.values(timings).reduce((a, b) => a + b, 0) }, 'gemini profile deleted');
  return { ok:true, deleted:true, timings };
});
app.get('/api/gemini-login/:jobId', { preHandler: ensureAuth }, async (req:any, reply) => {
  const job = geminiLoginJobs.get(String(req.params.jobId));
  if (!job) return reply.code(404).send({error:'not found'});
  const profile = await getGeminiProfileDto(job.profileId, { includeHidden:true }).catch(()=>null);
  if (profile?.status === 'authenticated') {
    job.status = 'done';
    job.error = undefined;
    clearGeminiLoginJobChallenge(job);
    job.codeSubmitted = false;
    geminiLoginProfiles.delete(job.profileId);
    invalidateUnifiedProviderStatuses();
    return { completed:true, job };
  }
  return { job };
});
app.post('/api/gemini-login/:jobId/input', { preHandler: ensureAuth }, async (req:any, reply) => {
  const job = geminiLoginJobs.get(String(req.params.jobId));
  if (!job) return reply.code(404).send({error:'not found'});
  const child = geminiLoginWorkers.get(job.id);
  if (!child || !['waiting_user','failed'].includes(job.status)) return reply.code(409).send({error:'Gemini 登录进程未在等待授权码'});
  if (!job.requiresCodeInput) return reply.code(409).send({error:'当前 Gemini 登录流程未要求网页输入 code'});
  if (job.codeSubmitted) return reply.code(409).send({error:'授权码已提交，正在验证'});
  const code = String(req.body?.code || '').trim();
  if (!/^[A-Za-z0-9_./~+=-]{4,4096}$/.test(code)) return reply.code(400).send({error:'bad code'});
  child.write(code + '\r');
  job.codeSubmitted = true;
  job.codeSubmittedAt = Date.now();
  job.error = undefined;
  setGeminiJobStatus(job, 'verifying');
  const profile:any = await getGeminiProfile(job.profileId).catch(()=>null);
  if (profile?.home_dir) verifyGeminiGoogleLoginJob(job, String(profile.home_dir), child).catch((e:any) => {
    if (job.status === 'done' || job.status === 'cancelled') return;
    setGeminiJobStatus(job, 'failed', safeGeminiError(e));
    job.codeSubmitted = false;
  });
  return { ok:true, job:{ ...job, codeSubmitted:true } };
});
app.post('/api/gemini-login/:jobId/cancel', { preHandler: ensureAuth }, async (req:any, reply) => {
  const job = geminiLoginJobs.get(String(req.params.jobId));
  if (!job) return reply.code(404).send({error:'not found'});
  if (job.status === 'done' || job.status === 'error' || job.status === 'failed' || job.status === 'fallback') return { job };
  await cancelGeminiLoginForProfile(job.profileId);
  return { job };
});
app.post('/api/profiles/:id/login/device', { preHandler: ensureAuth }, async (req:any) => {
  let profile = await getProfile(String(req.params.id));
  let attempt = await getProviderLoginAttempt(String(req.params.id));
  if (!profile && !attempt) throw new Error('profile not found');
  if (!attempt && profile && ['draft','authenticating','verifying','failed'].includes(String(profile.status || ''))) {
    attempt = await createProviderLoginAttempt('codex', { id:String(profile.id), tempHome:String(profile.codex_home), displayName:String(profile.name || 'Codex Account') });
  }
  const codexHome = String(attempt?.tempHome || profile?.codex_home || DEFAULT_CODEX_HOME);
  if (profile) await db.run("UPDATE codex_profiles SET status='authenticating', updated_at=?1 WHERE id=?2 AND COALESCE(status,'draft') IN ('draft','failed')", [Date.now(), String(profile.id)]).catch(()=>{});
  if (attempt) await updateProviderLoginAttempt(String(attempt.id), { status:'waiting_authorization' });
  const jobId = crypto.randomBytes(12).toString('base64url');
  const job: LoginJob = { id:jobId, profileId:String(attempt?.id || profile!.id), output:[], status:'running', code:null, startedAt:Date.now(), newProfile:req.body?.newProfile === true || !!attempt };
  loginJobs.set(jobId, job);
  const child = spawn('codex', ['login','--device-auth'], { env:{...process.env, HOME:DEFAULT_HOME, CODEX_HOME:codexHome}, stdio:['ignore','pipe','pipe'] });
  loginChildren.set(jobId, child);
  const push = (s:string) => {
    for (const line of s.split(/\r?\n/).filter(Boolean)) job.output.push(line.replace(/(token|secret|password)[^\n]*/ig, '$1=[redacted]'));
    job.output = job.output.slice(-80);
    const parsed = parseDeviceLogin(job.output.join('\n'));
    if (parsed.loginUrl) job.loginUrl = parsed.loginUrl;
    if (parsed.deviceCode) job.deviceCode = parsed.deviceCode;
    if (attempt && (parsed.loginUrl || parsed.deviceCode)) updateProviderLoginAttempt(String(attempt.id), { status:'waiting_authorization' }).catch(()=>{});
  };
  child.stdout.on('data', d=>push(d.toString()));
  child.stderr.on('data', d=>push(d.toString()));
  child.on('close', async code => {
    loginChildren.delete(jobId);
    job.code = code;
    job.status = code === 0 ? 'running' : 'error';
    if (attempt && code === 0) await updateProviderLoginAttempt(String(attempt.id), { status:'verifying' }).catch(()=>{});
    if (code !== 0) (job as any).error = `codex login exited ${code}`;
    if (code !== 0 && job.newProfile && profile) await db.run("UPDATE codex_profiles SET status='failed', active=0, updated_at=?1 WHERE id=?2", [Date.now(), String(profile.id)]).catch(()=>{});
    if (code !== 0 && attempt) await updateProviderLoginAttempt(String(attempt.id), { status:'failed', error:`codex login exited ${code}` }).catch(()=>{});
    if (code === 0) {
      try {
        const candidate = attempt
          ? await prepareCodexLoginCandidate(String(attempt.id), codexHome)
          : profile;
        if (!candidate) throw new Error('profile not found');
        await activateProfileCandidate(candidate);
        if (attempt) await updateProviderLoginAttempt(String(attempt.id), { status:'done', error:null, profileId:String(candidate.id), metadata:{ email:candidate.email || null } });
        await ensureSharedCodexDirs(String(candidate.codex_home)).catch(()=>{});
        job.profileId = String(candidate.id);
        job.metadataStatus = ['pending','ready','failed'].includes(String(candidate.metadata_status)) ? String(candidate.metadata_status) as LoginJob['metadataStatus'] : 'pending';
        job.metadataError = candidate.metadata_error ? String(candidate.metadata_error) : undefined;
        job.status = 'done';
        job.error = undefined;
        codexStatusCache = { expiresAt:0 };
        invalidateUnifiedProviderStatuses();
      } catch (error:any) {
        const message = safeAntigravitySummary(String(error?.message || error));
        job.status = 'error';
        job.error = message;
        if (attempt) await updateProviderLoginAttempt(String(attempt.id), { status:'failed', error:message }).catch(()=>{});
        app.log.error({ jobId, profileId:job.profileId, error:message }, 'codex login runtime activation failed');
      }
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
  const antigravityBin = await resolveAntigravityBinary();
  const id = crypto.randomBytes(8).toString('hex');
  const homeDir = path.join(ANTIGRAVITY_PROFILES_DIR, id, 'home');
  await mkdir(homeDir, { recursive:true });
  await chmod(path.dirname(homeDir), 0o700).catch(()=>{});
  await chmod(homeDir, 0o700).catch(()=>{});
  const jobId = crypto.randomBytes(12).toString('base64url');
  const job: AntigravityLoginJob = { id:jobId, providerId:'antigravity', profileId:id, output:[], status:'running', code:null, startedAt:Date.now(), newProfile:true };
  antigravityLoginJobs.set(jobId, job);
  const child = pty.spawn(antigravityBin, [], {
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
app.post('/api/antigravity-login/:jobId/cancel', { preHandler: ensureAuth }, async (req:any, reply) => {
  const job = antigravityLoginJobs.get(String(req.params.jobId));
  if (!job) return reply.code(404).send({error:'login job not found'});
  await cancelAntigravityLoginForProfile(job.profileId);
  await deleteAntigravityProfileDir(antigravityHomeForProfile(job.profileId)).catch(()=>{});
  return { ok:true, job };
});
app.post('/api/antigravity/profiles/:id/switch', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await getAntigravityProfile(String(req.params.id));
  if (!profile) return reply.code(404).send({error:'profile not found'});
  await activateAntigravityProfile(String(profile.id));
  invalidateProviderCaches('antigravity');
  const statuses = await unifiedProviderStatuses(false);
  return { activeProfile: await getActiveAntigravityProfile(), providerStatus:statuses.antigravity };
});
app.delete('/api/antigravity/profiles/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const profile = await getAntigravityProfile(String(req.params.id));
  if (!profile) return reply.code(404).send({error:'profile not found'});
  const running = await db.get("SELECT id FROM sessions WHERE provider_id='antigravity' AND account_id=?1 AND status IN ('running','submitting','recovering') LIMIT 1", [String(profile.id)]);
  if (running) return reply.code(409).send({error:'该账户仍有正在运行的任务，请停止任务后再删除。'});
  await cancelAntigravityLoginForProfile(String(profile.id));
  const refs = await providerSessionReferenceCount('antigravity', String(profile.id));
  if (refs > 0) {
    await db.run("UPDATE antigravity_profiles SET active=0, status='disabled', updated_at=?1 WHERE id=?2", [Date.now(), String(profile.id)]);
    await deleteAntigravityProfileDir(String(profile.home_dir)).catch(()=>{});
    await ensureAntigravityActiveProfile();
    invalidateUnifiedProviderStatuses();
    return { ok:true, hidden:true, references:refs };
  }
  await db.run('DELETE FROM antigravity_profiles WHERE id=?1', [String(profile.id)]);
  await deleteAntigravityProfileDir(String(profile.home_dir)).catch(()=>{});
  await ensureAntigravityActiveProfile();
  invalidateUnifiedProviderStatuses();
  return { ok:true };
});
app.get('/api/antigravity-login/:jobId', { preHandler: ensureAuth }, async (req:any, reply) => {
  const job = antigravityLoginJobs.get(String(req.params.jobId));
  if (!job) return reply.code(404).send({error:'not found'});
  await maybeFinishAntigravityLoginJob(job).catch(()=>{});
  return { job };
});
app.post('/api/login', { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } }, async (req:any, reply) => {
  const { username, password } = req.body || {};
  const row = await db.get('SELECT * FROM users WHERE username = ?1', [username || 'admin']);
  if (!row || typeof password !== 'string' || !(await argon2.verify(String(row.password_hash), password))) return reply.code(401).send({error:'invalid login'});
  const session = await createAuthSession(req, reply);
  return { ok:true, csrf:session.csrf };
});
app.post('/api/logout', { preHandler: ensureAuth }, async (req:any, reply) => {
  if (req.authSession?.id) await db.run('UPDATE auth_sessions SET revoked_at=?1 WHERE id=?2', [Date.now(), req.authSession.id]).catch(()=>{});
  reply.clearCookie(COOKIE_NAME, {path:'/'});
  reply.clearCookie(CSRF_COOKIE, {path:'/'});
  return {ok:true};
});
app.get('/api/auth/sessions', { preHandler: ensureAuth }, async (req:any) => {
  const rows = await db.all('SELECT id,created_at,expires_at,revoked_at,last_seen_at,user_agent,ip_hint FROM auth_sessions WHERE revoked_at IS NULL AND expires_at>?1 ORDER BY last_seen_at DESC LIMIT 50', [Date.now()]);
  return { sessions: rows.map(row => ({ ...row, current: row.id === req.authSession?.id })) };
});
app.delete('/api/auth/sessions/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const id = String(req.params.id || '');
  if (!id) return reply.code(400).send({ error:'missing session id' });
  await db.run('UPDATE auth_sessions SET revoked_at=?1 WHERE id=?2', [Date.now(), id]);
  return { ok:true, revoked:id };
});
app.get('/api/projects', { preHandler: ensureAuth }, async (req:any) => ({ roots, projects: await cachedProjects(req.query?.refresh === '1') }));
app.get('/api/sessions', { preHandler: ensureAuth }, async (req:any) => ({ sessions: await listIndexedThreads(req.query?.archived === '1') }));
app.get('/api/dashboard', { preHandler: ensureAuth }, async (req:any) => {
  const archived = req.query?.archived === '1';
  const [sessions,control,artifacts] = await Promise.all([listIndexedThreads(archived), lightAppState(), dashboardArtifacts()]);
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(new Date(now).toDateString()).getTime();
  const runningStates = new Set(['running','active','planning','submitting','recovering','executing_approved_plan','waiting_approval','waiting_input','waiting_plan_approval','inProgress']);
  const waitingStates = new Set(['waiting_approval','waiting_plan_approval','waiting_input']);
  const projects = new Map<string,{path:string;name:string;sessions:number;lastActiveAt:number}>();
  for (const session of sessions) {
    const projectPath = String(session.project_dir || session.workspace_path || '');
    if (!projectPath) continue;
    const current = projects.get(projectPath) || { path:projectPath, name:projectNameFromPath(projectPath), sessions:0, lastActiveAt:0 };
    current.sessions++;
    current.lastActiveAt = Math.max(current.lastActiveAt, Number(session.updated_at || 0));
    projects.set(projectPath, current);
  }
  const activity = Array.from({length:7}, (_,index) => {
    const from = startOfToday - (6 - index) * dayMs;
    const to = from + dayMs;
    return { date:new Date(from).toISOString().slice(0,10), count:sessions.filter(session => Number(session.updated_at || 0) >= from && Number(session.updated_at || 0) < to).length };
  });
  return {
    generatedAt:now,
    archived,
    control,
    artifacts,
    metrics:{
      total:sessions.length,
      running:sessions.filter(session => runningStates.has(String(session.status))).length,
      waiting:sessions.filter(session => waitingStates.has(String(session.status))).length,
      updatedToday:sessions.filter(session => Number(session.updated_at || 0) >= startOfToday).length,
      projects:projects.size,
    },
    activity,
    projects:[...projects.values()].sort((a,b)=>b.lastActiveAt-a.lastActiveAt).slice(0,8),
    sessions,
  };
});
async function dashboardArtifacts(){
  const sql='SELECT id,session_id,name,mime,size,created_at,modified_at,relative_path,operation FROM artifacts ORDER BY COALESCE(modified_at,created_at) DESC LIMIT 50';
  const [webRows,runtimeRows]=await Promise.all([db.all(sql).catch(()=>[]),runtimeDb.all(sql).catch(()=>[])]);
  const byId=new Map<string,any>();
  for(const row of [...runtimeRows,...webRows]) if(artifactEligibleForDownload(String(row.relative_path||row.name),String(row.operation||'created'))&&!byId.has(String(row.id))) byId.set(String(row.id),row);
  const items=[...byId.values()].sort((a,b)=>Number(b.modified_at||b.created_at||0)-Number(a.modified_at||a.created_at||0)).slice(0,8).map(row=>({
    id:String(row.id),sessionId:String(row.session_id),name:String(row.name),type:String(row.mime||'application/octet-stream'),size:Number(row.size||0),updatedAt:Number(row.modified_at||row.created_at||0),url:`/api/sessions/${encodeURIComponent(String(row.session_id))}/files/${encodeURIComponent(String(row.id))}`,
  }));
  return { total:byId.size, items };
}
app.post('/api/sessions', { preHandler: ensureAuth }, async (req:any, reply) => {
  let projectDir:string;
  try { projectDir = await validateProject(req.body?.projectDir || DEFAULT_WORKSPACE_DIR, roots); }
  catch { return reply.code(400).send({error:'project path is outside allowed workspace roots'}); }
  const provider = normalizeProvider(req.body?.providerId) || (await appSettings()).activeProvider;
  if(!visibleProvider(provider))return reply.code(409).send({error:`${provider}_not_selectable`,code:`${provider}_not_selectable`,message:`${providerDisplayName(provider)} 不能用于新建会话`});
  const requestedTitle = String(req.body?.title || '').trim();
  const title = sessionTitleFromTask(req.body?.initialTask, requestedTitle || path.basename(projectDir));
  const settings = await appSettings();
  const mode = normalizeMode(req.body?.mode) || settings.defaultMode;
  const statuses = await unifiedProviderStatuses();
  const selectedStatus = statuses[provider];
  if (!selectedStatus?.canCreateSession) {
    const statusCode = selectedStatus?.availability === 'unavailable' ? 503 : 409;
    const code = selectedStatus?.reasonCode === 'gemini_client_unsupported' ? 'gemini_client_unsupported' : `${provider}_cannot_create_session`;
    return reply.code(statusCode).send({
      error: code,
      code,
      message: selectedStatus?.message || `${providerDisplayName(provider)} 当前不能创建会话`,
      detail: selectedStatus ? `availability=${selectedStatus.availability}; auth=${selectedStatus.auth}` : 'provider status unavailable',
    });
  }
  if (provider === 'antigravity') {
    if(!USE_AGENT_RUNTIME)return reply.code(409).send({error:'Antigravity 需要 persistent runtime'});
    const status = await cachedAntigravityStatus();
    if (!status.ok) return reply.code(409).send({error:'Antigravity CLI 不可用，不能创建 Antigravity 会话'});
    const activeProfile:any = await getActiveAntigravityProfile();
    if (!activeProfile?.home_dir) return reply.code(409).send({error:'请先登录 Antigravity'});
    const login = await antigravityLoginStatus(String(activeProfile.home_dir));
    if (!login.ok) return reply.code(409).send({error:'请先登录 Antigravity'});
    const id = crypto.randomUUID();
    const now = Date.now();
    const model = cleanAgentModel(req.body?.model) || cleanAgentModel(settings.defaultModels?.antigravity) || null;
    const fields = modeFields(mode),snapshot={id:String(activeProfile.id),name:String(activeProfile.name||'Antigravity Account')};
    const created=await runtime.createAntigravitySession({sessionId:id,accountId:activeProfile.id,profile:{id:activeProfile.id,homeDir:activeProfile.home_dir},accountSnapshot:snapshot,cwd:projectDir,title,mode,model,approvalPolicy:fields.approval_policy,sandboxMode:fields.sandbox_mode});
    await db.run(
      'INSERT INTO sessions (id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,model,archived,created_at,updated_at,provider_id,account_id,model_id,workspace_path,provider_session_id,creator_profile_id,selected_profile_id,executing_profile_id,upstream_binding_profile_id,last_execution_account_id,current_upstream_account_id,account_snapshot_json) VALUES (?1,?1,?2,?3,?4,?5,?6,?7,?8,0,?9,?9,?10,?11,?8,?2,NULL,?11,?11,?11,?11,?11,?11,?12)',
      [id, projectDir, title, 'idle', fields.permission_mode, fields.approval_policy, fields.sandbox_mode, model, now, 'antigravity', activeProfile.id,JSON.stringify(snapshot)]
    );
    return rowSessionDto(created.session||await findSession(id));
  }
  if (provider === 'gemini') {
    if (!USE_AGENT_RUNTIME) return reply.code(409).send({error:'Gemini ACP 需要 persistent runtime'});
    const status = await cachedGeminiStatus();
    if (!status.ok) return reply.code(409).send({error:status.error || 'Gemini CLI 不可用'});
    const activeProfile:any = await getActiveGeminiProfile();
    if (!activeProfile?.id || activeProfile.status !== 'authenticated') return reply.code(409).send({error:'请先登录 Gemini'});
    if (!activeProfile.login?.ok) return reply.code(409).send({error:'当前 Gemini 账户需要重新登录'});
    if (isGeminiPersonalUnsupportedProfile(activeProfile)) {
      return reply.code(409).send({
        error:'gemini_client_unsupported',
        code:'gemini_client_unsupported',
        layer:'web_session_api',
        message:geminiPersonalUnsupportedMessage(),
        safeDetail:'Gemini personal OAuth profile is authenticated but cannot create sessions with the current CLI client.',
      });
    }
    const id = crypto.randomUUID();
    const model = cleanAgentModel(req.body?.model) || cleanAgentModel(settings.defaultModels?.gemini) || null;
    const opts = modeOptions(mode, model || undefined);
    let created:any;
    try {
      app.log.info({ provider:'gemini', operation:'create_session_start', activeProvider:provider, profileId:String(activeProfile.id), profileStatus:activeProfile.status, localSessionId:id, cwd:projectDir }, 'gemini session create requested');
      created = await runtime.createGeminiSession({
        sessionId:id,
        accountId: activeProfile.id,
        accountSnapshot: geminiAccountSnapshot(activeProfile),
        cwd: projectDir,
        title,
        mode,
        model,
        approvalPolicy: opts.approvalPolicy,
        sandboxMode: opts.sandboxMode,
      });
    } catch (e:any) {
      const message = safeGeminiError(e);
      if (isGeminiAuthenticationErrorMessage(message)) {
        await markGeminiProfileNeedsLogin(String(activeProfile.id), message);
        return reply.code(409).send({ error:'gemini_needs_login', message:'请先登录 Gemini', detail:message });
      }
      const body = e?.body || {};
      const code = body.code || body.error || 'gemini_session_create_failed';
      const detail = safeGeminiError(body.safeDetail || body.detail || body.message || body.error || message);
      app.log.warn({ provider:'gemini', operation:'create_session_failed', profileId:String(activeProfile.id), localSessionId:id, statusCode:e?.statusCode || null, detail }, 'gemini session create failed');
      return reply.code(e?.statusCode === 409 ? 409 : 502).send({
        error:code,
        code,
        layer:body.layer || 'web_session_api',
        message:body.message || 'Gemini 会话初始化失败',
        detail,
        safeDetail:detail,
      });
    }
    return rowSessionDto(created.session);
  }
  if (provider === 'claude') {
    if (!USE_AGENT_RUNTIME) return reply.code(409).send({ error:'Claude Code 需要 persistent runtime' });
    const activeProfile:any = await activeClaudeProfileSummary();
    if (!activeProfile?.id) return reply.code(409).send({ error:'请先配置 Claude Code profile' });
    const id = crypto.randomUUID();
    const model = cleanAgentModel(req.body?.model) || cleanAgentModel(settings.defaultModels?.claude) || null;
    const opts = modeOptions(mode, model || undefined);
    const created = await runtime.createClaudeSession({
      sessionId:id,
      accountId:activeProfile.id,
      profile:activeProfile,
      accountSnapshot:claudeAccountSnapshot(activeProfile),
      cwd:projectDir,
      title,
      mode,
      model,
      approvalPolicy:opts.approvalPolicy,
      sandboxMode:opts.sandboxMode,
    }).catch((e:any) => { throw Object.assign(new Error(e?.message || String(e)), { statusCode:e?.statusCode || 502, body:e?.body }); });
    await db.run(
      'INSERT INTO sessions (id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,model,archived,created_at,updated_at,provider_id,account_id,model_id,workspace_path,provider_session_id,creator_profile_id,selected_profile_id,executing_profile_id,upstream_binding_profile_id,last_execution_account_id,current_upstream_account_id,account_snapshot_json) VALUES (?1,?1,?2,?3,?4,?5,?6,?7,?8,0,?9,?9,?10,?11,?8,?2,NULL,?11,?11,?11,?11,?11,?11,?12)',
      [id, projectDir, title, 'idle', opts.approvalPolicy === 'never' ? 'yolo' : mode, opts.approvalPolicy, opts.sandboxMode, model, Date.now(), 'claude', activeProfile.id, JSON.stringify(claudeAccountSnapshot(activeProfile))]
    ).catch(()=>{});
    return rowSessionDto(created.session || await findSession(id));
  }
  const model = cleanModel(req.body?.model) || cleanModel(settings.defaultModels?.codex);
  const codexPreflight = await codexCreateSessionPreflight();
  if (!codexPreflight.ok) return reply.code(codexPreflight.statusCode).send(codexPreflight.body);
  const activeProfile:any = codexPreflight.profile;
  const accountId = activeProfile?.id || null;
  const opts = modeOptions(mode, model);
  if (USE_AGENT_RUNTIME) {
    try {
      const created = await runtime.createCodexSession({
        accountId,
        codexHome: activeProfile.codex_home,
        accountSnapshot: codexAccountSnapshot(activeProfile),
        cwd: projectDir,
        title,
        mode,
        model,
        approvalPolicy: opts.approvalPolicy,
        sandboxMode: opts.sandboxMode,
      });
      const profileFields = codexSessionProfileFields(accountId, accountId, accountId);
      await upsertThread(created.thread, { title, archived: 0, status:'idle', model, account_id: accountId, account_snapshot_json:JSON.stringify(codexAccountSnapshot(activeProfile)), ...profileFields, ...modeFields(mode) });
      return sessionDto(created.thread, { title, status:'idle', archived:0, model, account_id: accountId, account_snapshot_json:JSON.stringify(codexAccountSnapshot(activeProfile)), ...profileFields, ...modeFields(mode) });
    } catch (e:any) {
      const body = structuredSessionCreateError('codex', e, 'web_session_api');
      return reply.code(body.statusCode).send(body.body);
    }
  }
  const started = await codex.startThread(projectDir, opts);
  const thread = started.thread;
  const profileFields = codexSessionProfileFields(accountId, accountId, accountId);
  await upsertThread(thread, { title, archived: 0, status:'idle', model, account_id: accountId, account_snapshot_json:JSON.stringify(codexAccountSnapshot(activeProfile)), ...profileFields, ...modeFields(mode) });
  await codex.setName(thread.id, title).catch(()=>{});
  return sessionDto(thread, { title, status:'idle', archived:0, model, account_id: accountId, account_snapshot_json:JSON.stringify(codexAccountSnapshot(activeProfile)), ...profileFields, ...modeFields(mode) });
});
app.get('/api/sessions/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const requestId = req.id;
  const startedAt = Date.now();
  let row = await findSession(req.params.id);
  if (!row && USE_AGENT_RUNTIME) row = await runtimeDb.get('SELECT * FROM sessions WHERE id=?1 OR codex_thread_id=?1 OR upstream_thread_id=?1', [String(req.params.id)]).catch(()=>null);
  const runtimeBackedRow:any = USE_AGENT_RUNTIME && row && normalizeProvider(row.provider_id) === 'antigravity'
    ? await runtimeDb.get('SELECT * FROM sessions WHERE id=?1 OR codex_thread_id=?1', [String(row.codex_thread_id || row.id)]).catch(()=>null)
    : null;
  if (row && normalizeProvider(row.provider_id) === 'antigravity' && !runtimeBackedRow) {
    if (!pathAllowed(String(row.project_dir))) return reply.code(403).send({error:'workspace not allowed'});
    const thread = await antigravityThread(row);
    const localSessionId = String(row.codex_thread_id || row.id || req.params.id);
    return { session: rowSessionDto(row), thread, branch: await gitBranch(String(row.project_dir)), interrupted: (row?.status === 'interrupted'), interactiveRequests: await listInteractiveRequests(localSessionId) };
  }
  const threadId = String(row?.codex_thread_id || req.params.id);
  if (USE_AGENT_RUNTIME) {
    if (!row) return reply.code(404).send({error:'not found'});
    if (!pathAllowed(String(row.project_dir))) return reply.code(403).send({error:'workspace not allowed'});
    const sqliteStartedAt = Date.now();
    const runtimeRowRaw:any = runtimeBackedRow || await runtimeDb.get('SELECT * FROM sessions WHERE id=?1 OR codex_thread_id=?1 OR upstream_thread_id=?1', [threadId]).catch(()=>null) || row;
    const runtimeAntigravity=normalizeProvider(runtimeRowRaw?.provider_id||runtimeRowRaw?.provider)==='antigravity';
    const webPlanStatus = !runtimeAntigravity&&['planning','waiting_plan_approval','executing_approved_plan','plan_cancelled'].includes(String(row.status || '')) ? String(row.status) : '';
    const inferredStatus = runtimeAntigravity?String(runtimeRowRaw?.status||'idle'):webPlanStatus || await inferredRuntimeStatus(threadId, String(runtimeRowRaw?.status || row.status || 'idle')).catch(()=>String(runtimeRowRaw?.status || row.status || 'idle'));
    const runtimeRow:any = { ...runtimeRowRaw, status:inferredStatus };
    if (runtimeRow?.status && runtimeRow.status !== row.status) {
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3', [String(runtimeRow.status), Date.now(), threadId]).catch(()=>{});
    }
    const snapshotWatermark=Number(runtimeRow?.last_sequence||0);
    const thread = await runtimeThreadFromEvents(threadId, runtimeRow, snapshotWatermark);
    decorateThreadImages(thread, threadId, String(runtimeRow.project_dir || row.project_dir));
    const [branch] = await Promise.all([
      gitBranch(String(runtimeRow.project_dir || row.project_dir)).catch(()=>null),
      injectArtifacts(thread, threadId).catch(()=>{}),
    ]);
    sanitizeThreadForMobile(thread);
    const coveredSequence = snapshotWatermark;
    const snapshot = { coveredSequence, throughSequence:coveredSequence, latestSequence:coveredSequence, generation:String(runtimeRow?.upstream_generation || '') || null };
    app.log.info({ requestId, localSessionId:threadId, upstreamThreadId:String(runtimeRow?.upstream_thread_id || threadId), status:runtimeRow.status, latestSequence:Number(runtimeRow?.last_sequence || 0), operation:'GET /api/sessions/:id', sqliteDurationMs:Date.now() - sqliteStartedAt, totalDurationMs:Date.now() - startedAt }, 'web session snapshot returned');
    return { session: rowSessionDto(runtimeRow), thread, snapshot, branch, interrupted: (runtimeRow?.status === 'interrupted'), interactiveRequests: await listInteractiveRequests(threadId) };
  }
  let read:any;
  try { read = await codex.readThread(threadId, true); }
  catch { if (!row) return reply.code(404).send({error:'not found'}); await codex.resumeThread(threadId, String(row.project_dir)).catch(()=>null); read = await codex.readThread(threadId, true); }
  if (!pathAllowed(read.thread.cwd)) return reply.code(403).send({error:'workspace not allowed'});
  await upsertThread(read.thread, { status: statusName(read.thread.status) });
  decorateThreadImages(read.thread, threadId, String(row?.project_dir || read.thread.cwd));
  await injectArtifacts(read.thread, threadId);
  sanitizeThreadForMobile(read.thread);
  return { session: await indexedSession(read.thread), thread: read.thread, branch: await gitBranch(read.thread.cwd), interrupted: (row?.status === 'interrupted'), interactiveRequests: await listInteractiveRequests(threadId) };
});
app.patch('/api/sessions/:id', { preHandler: ensureAuth }, async (req:any, reply) => {
  const row = await findSession(req.params.id);
  const threadId = String(row?.codex_thread_id || req.params.id);
  const provider = normalizeProvider(row?.provider_id) || 'codex';
  const title = String(req.body?.title || '').trim();
  const mode = normalizeMode(req.body?.mode);
  if (title) {
    if (provider === 'codex') {
      if (USE_AGENT_RUNTIME) await runtime.setSessionTitle(threadId, title).catch(()=>{});
      else await codex.setName(threadId, title);
    }
    await db.run('UPDATE sessions SET title=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[title, Date.now(), threadId]);
  }
  if (mode) {
    const fields = modeFields(mode);
    await db.run('UPDATE sessions SET permission_mode=?1, approval_policy=?2, sandbox_mode=?3, updated_at=?4 WHERE codex_thread_id=?5 OR id=?5',[fields.permission_mode, fields.approval_policy, fields.sandbox_mode, Date.now(), threadId]);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'model')) {
    const model = provider === 'antigravity' || provider === 'gemini' ? cleanAgentModel(req.body?.model) : cleanModel(req.body?.model);
    if (provider === 'gemini') {
      if (!USE_AGENT_RUNTIME) return reply.code(409).send({ error:'gemini_model_switch_unsupported', supported:false, message:'当前 Gemini CLI ACP 未公开可切换模型，继续使用 CLI 默认配置。' });
      let changed:any = null;
      try {
        changed = await runtime.setGeminiSessionModel(threadId, model || null);
      } catch (e:any) {
        return reply.code(e?.statusCode === 400 ? 400 : 409).send({
          error:e?.body?.error || e?.code || 'gemini_model_switch_unsupported',
          supported:false,
          message:e?.body?.message || '当前 Gemini CLI ACP 未公开可切换模型，继续使用 CLI 默认配置。',
          detail:safeGeminiError(e?.body?.detail || e?.message || String(e)),
        });
      }
      const appliedModel = cleanAgentModel(changed?.model) || model || null;
      const revision=Number(changed?.modelRevision||0);await db.run('UPDATE sessions SET model=?1,model_id=?1,model_revision=MAX(COALESCE(model_revision,0)+1,?2),updated_at=?3 WHERE codex_thread_id=?4 OR id=?4',[appliedModel,revision,Date.now(),threadId]);
      return {ok:true,model:appliedModel,modelId:appliedModel,modelRevision:revision||Number((await findSession(threadId))?.model_revision||0),supported:true};
    }
    if(provider==='antigravity'){await db.run('UPDATE sessions SET model=?1,model_id=?1,model_revision=COALESCE(model_revision,0)+1,updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[model||null,Date.now(),threadId]);const applied=await findSession(threadId);return{ok:true,model:applied?.model||null,modelId:applied?.model_id||applied?.model||null,modelRevision:Number(applied?.model_revision||0),supported:true};}
    if(!USE_AGENT_RUNTIME)return reply.code(409).send({error:'model_switch_requires_runtime',supported:false});
    const changed=await runtime.setSessionModel(threadId,model||null);
    const appliedModel=(provider==='codex'?cleanModel(changed?.model):cleanAgentModel(changed?.model))||model||null;const revision=Number(changed?.modelRevision||0);await db.run('UPDATE sessions SET model=?1,model_id=?1,model_revision=MAX(COALESCE(model_revision,0)+1,?2),updated_at=?3 WHERE codex_thread_id=?4 OR id=?4',[appliedModel,revision,Date.now(),threadId]);return{ok:true,model:appliedModel,modelId:appliedModel,modelRevision:revision||Number((await findSession(threadId))?.model_revision||0),supported:true};
  }
  return {ok:true};
});
app.post('/api/sessions/:id/archive', { preHandler: ensureAuth }, async (req:any) => {
  const row = await findSession(req.params.id);
  const threadId = String(row?.codex_thread_id || req.params.id);
  const now = Date.now();
  if (!USE_AGENT_RUNTIME) await codex.archive(threadId).catch((e:any)=>app.log.warn({err:e.message}, 'official thread archive failed; archiving local index only'));
  await db.run('UPDATE sessions SET archived=1, archived_at=?1, updated_at=?1 WHERE codex_thread_id=?2 OR id=?2 OR provider_session_id=?2', [now, threadId]);
  if(USE_AGENT_RUNTIME)await runtime.setSessionArchived(threadId,true);
  return {ok:true};
});
app.post('/api/sessions/:id/unarchive', { preHandler: ensureAuth }, async (req:any) => {
  const row = await findSession(req.params.id);
  const threadId = String(row?.codex_thread_id || req.params.id);
  const now = Date.now();
  if (!USE_AGENT_RUNTIME) await codex.unarchive(threadId).catch((e:any)=>app.log.warn({err:e.message}, 'official thread unarchive failed; restoring local index only'));
  await db.run('UPDATE sessions SET archived=0, archived_at=NULL, updated_at=?1 WHERE codex_thread_id=?2 OR id=?2 OR provider_session_id=?2', [now, threadId]);
  if(USE_AGENT_RUNTIME)await runtime.setSessionArchived(threadId,false);
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
  const dir = path.join(attachmentSessionDir(threadId), attachmentId);
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
app.get('/api/sessions/:id/interactive-requests', { preHandler: ensureAuth }, async (req:any) => ({ requests: await listInteractiveRequests(String(req.params.id)) }));
app.post('/api/interactive-requests/:requestId/answer', { preHandler: ensureAuth }, async (req:any, reply) => {
  const requestId = String(req.params.requestId);
  const row = await db.get('SELECT * FROM interactive_requests WHERE request_id=?1', [requestId]).catch(()=>null);
  if (!row) return reply.code(404).send({ error:'interactive request not found' });
  const request = interactiveRequestDto(row);
  if (request.status !== 'pending') return reply.code(409).send({ error:'interactive request already answered', request });
  const optionId = ['approve','revise','regenerate','cancel'].includes(String(req.body?.optionId)) ? String(req.body.optionId) : 'approve';
  const text = String(req.body?.text || '').trim();
  const answer = { optionId, text };
  const now = Date.now();
  const claimed:any = await db.run('UPDATE interactive_requests SET status=?1, answer_json=?2, answered_at=?3 WHERE request_id=?4 AND status=?5', [optionId === 'cancel' ? 'cancelled' : 'answered', JSON.stringify(answer), now, requestId, 'pending']);
  if (!Number(claimed?.changes || 0)) {
    const latest = await db.get('SELECT * FROM interactive_requests WHERE request_id=?1', [requestId]).catch(()=>row);
    return reply.code(409).send({ error:'interactive request already answered', request:interactiveRequestDto(latest) });
  }
  broadcast(request.sessionId, { type:'interactive_answered', requestId, answer });
  if (optionId === 'cancel') {
    await db.run("UPDATE plan_tasks SET status='cancelled',cancelled_at=?1 WHERE session_id=?2 AND status IN ('planning','completed','awaiting_approval')", [now, request.sessionId]).catch(()=>{});
    await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3', ['plan_cancelled', now, request.sessionId]);
    broadcast(request.sessionId, { type:'system', text:'计划已取消' });
    return { ok:true, requestId, sentFollowup:false };
  }
  const plan = await db.get('SELECT * FROM plan_tasks WHERE session_id=?1 AND plan_assistant_message_id=?2 ORDER BY created_at DESC LIMIT 1', [request.sessionId, request.turnId]).catch(()=>null)
    || await db.get("SELECT * FROM plan_tasks WHERE session_id=?1 AND status='awaiting_approval' ORDER BY created_at DESC LIMIT 1", [request.sessionId]).catch(()=>null);
  if (!plan) return { ok:true, requestId, sentFollowup:false };
  if (optionId === 'approve') {
    await db.run('UPDATE plan_tasks SET status=?1, approved_at=?2,approved_plan_text=COALESCE(approved_plan_text,?3) WHERE plan_id=?4', ['executing', now, request.body || '', plan.plan_id]).catch(()=>{});
    await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3', ['executing_approved_plan', now, request.sessionId]).catch(()=>{});
    const followup = approvedPlanPrompt(String(plan.original_user_task || ''), String(plan.approved_plan_text || request.body || ''), text);
    try { await sendTurn(request.sessionId, followup, [], crypto.randomUUID(), 'direct'); }
    catch (error) { await restorePlanReviewAfterFailure(requestId, request.sessionId, String(plan.plan_id), error); throw error; }
    return { ok:true, requestId, sentFollowup:true };
  }
  const revision = optionId === 'regenerate'
    ? regeneratePlanPrompt(String(plan.original_user_task || ''), String(plan.approved_plan_text || request.body || ''), text)
    : revisePlanPrompt(String(plan.original_user_task || ''), String(plan.approved_plan_text || request.body || ''), text);
  await db.run("UPDATE plan_tasks SET status='superseded' WHERE plan_id=?1 AND status='awaiting_approval'", [plan.plan_id]).catch(()=>{});
  try { await sendTurn(request.sessionId, revision, [], crypto.randomUUID(), 'plan'); }
  catch (error) { await restorePlanReviewAfterFailure(requestId, request.sessionId, String(plan.plan_id), error); throw error; }
  return { ok:true, requestId, sentFollowup:true };
});
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
  const claudeApproval = await runtimeDb.get("SELECT session_id FROM events WHERE event_type='approval/requested' AND payload_json LIKE ?1 ORDER BY sequence DESC LIMIT 1", [`%"approvalId":"${requestKey}"%`]).catch(()=>null);
  if (claudeApproval) {
    const decision = req.body?.decision === 'decline' ? 'decline' : req.body?.decision === 'accept_session' ? 'accept_session' : 'accept';
    await runtime.answerClaudeApproval(requestKey, { decision });
    return { ok:true };
  }
  const pending = pendingApprovals.get(requestKey);
  if (!pending) return reply.code(404).send({error:'approval request not found'});
  pendingApprovals.delete(requestKey);
  const decision = req.body?.decision === 'decline' ? 'decline' : 'accept';
  codex.respond(pending.id, approvalResponse(pending.method, decision));
  return {ok:true};
});
app.get('/api/sessions/:id/messages/:clientMessageId/status',{preHandler:ensureAuth},async(req:any,reply)=>{
  const session=await findSession(String(req.params.id));
  if(!session)return reply.code(404).send({code:'session_not_found'});
  const sessionId=String(session.codex_thread_id||session.id);
  const row=await db.get(`SELECT r.status,r.error,r.retry_of,r.created_at,r.updated_at,m.original_text,m.text,m.attachments_json
    FROM message_receipts r LEFT JOIN agent_messages m ON m.session_id=r.session_id AND m.client_message_id=r.client_message_id AND m.role='user'
    WHERE r.session_id=?1 AND r.client_message_id=?2 ORDER BY m.created_at DESC LIMIT 1`,[sessionId,String(req.params.clientMessageId)]);
  if(!row)return reply.code(404).send({code:'message_not_found',clientMessageId:String(req.params.clientMessageId)});
  let attachments:any[]=[];try{const parsed=JSON.parse(String(row.attachments_json||'[]'));if(Array.isArray(parsed))attachments=parsed.map((item:any)=>({id:String(item.id||''),name:String(item.name||'attachment'),type:String(item.type||''),size:Number(item.size||0)})).filter((item:any)=>item.id);}catch{}
  return{clientMessageId:String(req.params.clientMessageId),sessionId,status:String(row.status),error:row.error||null,retryOf:row.retry_of||null,text:String(row.original_text||row.text||''),attachments,createdAt:Number(row.created_at),updatedAt:Number(row.updated_at)};
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
function wsClose(ws:any, code:number, reason:string) {
  try { ws.close(code, reason); } catch {}
}
function incrementMapCount(map:Map<string, number>, key:string) {
  const next = (map.get(key) || 0) + 1;
  map.set(key, next);
  return next;
}
function decrementMapCount(map:Map<string, number>, key:string) {
  const next = Math.max(0, (map.get(key) || 0) - 1);
  if (next) map.set(key, next); else map.delete(key);
}
function validateWsMessage(msg:any) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
  const type = String(msg.type || '');
  if (!['join','send','sendChunkStart','sendChunk','sendChunkEnd','stop'].includes(type)) return false;
  if (!msg.sessionId || typeof msg.sessionId !== 'string') return false;
  if (type === 'join') return (!('lastSequence' in msg)||Number.isFinite(Number(msg.lastSequence)))&&typeof msg.joinRequestId==='string'&&msg.joinRequestId.length<=128&&typeof msg.clientConnectionId==='string'&&msg.clientConnectionId.length>=8&&msg.clientConnectionId.length<=128&&(!('recoveryEpoch'in msg)||Number.isSafeInteger(Number(msg.recoveryEpoch)));
  if (type === 'send') return typeof msg.text === 'string' && (!('attachments' in msg) || Array.isArray(msg.attachments))&&(!('retryOf'in msg)||typeof msg.retryOf==='string');
  if (type === 'sendChunkStart') return typeof msg.messageId === 'string';
  if (type === 'sendChunk') return typeof msg.messageId === 'string' && typeof msg.chunk === 'string';
  if (type === 'sendChunkEnd') return typeof msg.messageId === 'string';
  return type === 'stop';
}
function registerWsSession(ws:any, sessionId:string) {
  let sessions = websocketSessions.get(ws);
  if (!sessions) {
    sessions = new Set<string>();
    websocketSessions.set(ws, sessions);
  }
  if (sessions.has(sessionId)) return true;
  if ((websocketSessionCounts.get(sessionId) || 0) >= WS_MAX_CONNECTIONS_PER_SESSION) return false;
  sessions.add(sessionId);
  incrementMapCount(websocketSessionCounts, sessionId);
  return true;
}
function cleanupWsConnection(ws:any) {
  browserDelivery.closeSocket(ws);
  const ip = websocketConnectionIps.get(ws);
  if (ip) {
    decrementMapCount(websocketIpCounts, ip);
    websocketConnectionIps.delete(ws);
  }
  const sessions = websocketSessions.get(ws);
  if (sessions) {
    for (const sessionId of sessions) decrementMapCount(websocketSessionCounts, sessionId);
    websocketSessions.delete(ws);
  }
  for (const [sessionId,set] of clients.entries()) {
    if (set.delete(ws)) {
      app.log.info({ sessionId, connectionGeneration:ws.agentdeckGeneration, subscriberCount:set.size }, 'websocket removed from session subscribers');
      if(!set.size){
        clients.delete(sessionId);
        scheduleRuntimeSubscriptionRelease(sessionId);
      }
    }
  }
}
function runtimeSessionActive(sessionId:string){return activeCodexSessions.has(sessionId)||activeRuntimeProviderSessions.has(sessionId);}
function scheduleRuntimeSubscriptionRelease(sessionId:string){const previous=runtimeSubscriptionReleases.get(sessionId);if(previous)clearTimeout(previous);const timer=setTimeout(()=>{runtimeSubscriptionReleases.delete(sessionId);if(clients.get(sessionId)?.size)return;if(runtimeSessionActive(sessionId)){scheduleRuntimeSubscriptionRelease(sessionId);return;}const subscription=runtimeSubscriptions.get(sessionId);if(subscription){runtimeSubscriptions.delete(sessionId);subscription.close();}browserDelivery.releaseSession(sessionId);},RUNTIME_SUBSCRIPTION_IDLE_MS);timer.unref?.();runtimeSubscriptionReleases.set(sessionId,timer);}
app.get('/ws', { websocket: true }, async (connection:any, req:any) => {
  const ws = connection.socket || connection;
  ws.agentdeckGeneration = ++websocketConnectionGeneration;
  if (!(await authSessionForRequest(req))) return wsClose(ws, 1008, 'auth');
  if (!allowedRequestOrigin(req)) return wsClose(ws, 1008, 'origin');
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  if (incrementMapCount(websocketIpCounts, ip) > WS_MAX_CONNECTIONS_PER_IP) {
    decrementMapCount(websocketIpCounts, ip);
    return wsClose(ws, 1008, 'too_many_connections');
  }
  websocketConnectionIps.set(ws, ip);
  app.log.info({ connectionGeneration:ws.agentdeckGeneration }, 'websocket connected');
  // Mobile carriers and handset proxies commonly reap an otherwise healthy
  // WebSocket after roughly 30 seconds of silence. Protocol ping frames keep
  // the transport alive while an agent is thinking without producing events.
  const heartbeat = setInterval(() => {
    if (ws.readyState !== 1) return;
    try { ws.ping(); } catch {}
  }, 15_000);
  heartbeat.unref?.();
  ws.on('message', async (raw:Buffer) => {
    if (Buffer.byteLength(raw) > WS_MAX_MESSAGE_BYTES) return wsClose(ws, 1009, 'message_too_large');
    let msg:any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return wsClose(ws, 1003, 'invalid_json');
    }
    if (!validateWsMessage(msg)) return wsClose(ws, 1008, 'invalid_message');
    try {
      const sessionId=String(msg.sessionId);
      if (msg.type === 'join') {
        if (!registerWsSession(ws, sessionId)) return wsClose(ws, 1008, 'too_many_session_connections');
        startJoinSingleFlight(ws,sessionId,{clientConnectionId:String(msg.clientConnectionId),joinRequestId:String(msg.joinRequestId),recoveryEpoch:Number(msg.recoveryEpoch||0)},()=>joinAndResume(sessionId,ws,Number(msg.lastSequence||0),{clientConnectionId:String(msg.clientConnectionId),recoverRuntimeGeneration:msg.runtimeGenerationRecovery===true,requestedRuntimeGeneration:String(msg.runtimeGeneration||''),joinRequestId:String(msg.joinRequestId||''),recoveryEpoch:Number(msg.recoveryEpoch||0),browserAppliedSequence:Number(msg.clientAppliedSequence||msg.lastSequence||0),snapshotCoveredSequence:Number(msg.snapshotCoveredSequence||0)}));
        return;
      }
      await sessionCommandQueue.run(sessionId,async()=>{
      if (msg.type === 'send') await sendTurn(sessionId, String(msg.text || ''), Array.isArray(msg.attachments) ? msg.attachments : [], String(msg.clientMessageId || ''), msg.planMode === 'plan' ? 'plan' : 'direct',String(msg.retryOf||''));
      if (msg.type === 'sendChunkStart') startChunkedMessage(msg);
      if (msg.type === 'sendChunk') appendChunkedMessage(msg);
      if (msg.type === 'sendChunkEnd') await finishChunkedMessage(msg);
      if (msg.type === 'stop') await stopTurn(sessionId);
      });
    } catch (e:any) {
      await failPlanningTask(String(msg.sessionId || ''), e?.message || String(e)).catch(()=>{});
      if (ws.readyState === 1) ws.send(JSON.stringify({type:'error', error:e?.body?.code || e?.code || e.message, code:e?.body?.code || e?.code || null, retryable:!!e?.body?.retryable}));
    }
  });
  ws.on('close', (code:number, reason:Buffer) => {
    clearInterval(heartbeat);
    app.log.info({ connectionGeneration:ws.agentdeckGeneration, code, reason:String(reason || '') }, 'websocket closed');
    cleanupWsConnection(ws);
  });
});
function startJoinSingleFlight(ws:any,sessionId:string,identity:{clientConnectionId:string;joinRequestId:string;recoveryEpoch:number},run:()=>Promise<void>){let map=websocketJoinFlights.get(ws);if(!map){map=new Map();websocketJoinFlights.set(ws,map);}if(!ws.agentdeckJoinIdentity)ws.agentdeckJoinIdentity=new Map();const identityKey=`${identity.clientConnectionId}:${identity.joinRequestId}:${identity.recoveryEpoch}`;ws.agentdeckJoinIdentity.set(sessionId,identityKey);const task=run().catch((error:any)=>{if(ws.readyState===1&&ws.agentdeckJoinIdentity?.get(sessionId)===identityKey)browserDelivery.sendDirect(ws,{type:'recovery_error',sessionId,...identity,error:String(error?.message||error)});}).finally(()=>{if(map?.get(sessionId)===task)map.delete(sessionId);});map.set(sessionId,task);}
app.setNotFoundHandler(async (req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({error:'not found'}) : reply.sendFile('index.html'));
codex.on('notification', async (msg:any) => {
  const sid = await sessionIdForThread(msg.params?.threadId || msg.params?.thread?.id);
  if (sid) {
    if (msg.method === 'turn/started') {
      activeCodexSessions.add(sid);
      if (msg.params?.turn?.id && !activeTurns.has(sid)) activeTurns.set(sid, String(msg.params.turn.id));
    }
    if (msg.method === 'thread/tokenUsage/updated') threadTokenUsage.set(sid, msg.params?.tokenUsage);
    const activity = compactCodexActivity(msg);
    if (activity) broadcast(sid, activity);
    if (shouldBroadcastCodexNotification(msg)) broadcast(sid, { type:'codex', method:msg.method, params:msg.params });
    if (msg.method === 'turn/completed') {
      const artifactTurnId = activeArtifactTurns.get(sid) || activeTurns.get(sid) || '';
      activeCodexSessions.delete(sid);
      activeTurns.delete(sid);
      activeArtifactTurns.delete(sid);
      const row = await findSession(sid);
      const anchorItemId = row ? await latestAgentItemId(sid, String(row.project_dir)).catch(()=>null) : null;
      const found = row ? await scanArtifactsForTurn(sid, String(row.project_dir), artifactTurnId, anchorItemId) : {artifacts:[],codeChanges:[]};
      if (String(row?.status || '') === 'planning') {
        const read = row ? await codex.readThread(sid, true).catch(()=>null) : null;
        const turns = read?.thread?.turns || [];
        const lastTurn = turns[turns.length - 1] || {};
        const finalItem = [...(lastTurn.items || [])].reverse().find((item:any) => isFinalAnswerItem(item));
        await completePlanTask(sid, String(finalItem?.text || ''), String(finalItem?.id || ''), found.artifacts);
        await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['idle',Date.now(),sid]);
      } else {
        await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['idle',Date.now(),sid]);
      }
      if (found.artifacts.length) broadcast(sid, { type:'codex', method:'item/completed', params:{ item:artifactMessageItem(found.artifacts, Date.now()) } });
      if(found.codeChanges.length)broadcast(sid,{type:'codex',method:'item/completed',params:{item:codeChangesItem(artifactTurnId,found.codeChanges)}});
      maybeExitAfterDrain();
    }
    if (msg.method === 'thread/status/changed') {
      const row = await findSession(sid).catch(()=>null);
      if (!['planning','waiting_plan_approval','executing_approved_plan'].includes(String(row?.status || ''))) await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[statusName(msg.params?.status),Date.now(),sid]).catch(()=>{});
    }
  }
});
codex.on('request', async (msg:any) => {
  const sid = await sessionIdForThread(msg.params?.threadId);
  const row = sid ? await findSession(sid) : null;
  if (String(row?.status || '') === 'planning') {
    await recordPlanPolicyViolation(sid!, `Plan mode is read-only. Blocked ${String(msg.method || 'approval request')}.`);
    codex.respond(msg.id, approvalResponse(msg.method, 'decline'));
    if (sid) broadcast(sid, { type:'system', text:'Plan mode is read-only. This action is blocked.' });
    return;
  }
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
setTimeout(() => reconcileGeminiProfilesOnStartup().catch(e => app.log.warn({ err:safeGeminiError(e) }, 'gemini startup reconcile failed')), 1000).unref();
setTimeout(() => cleanupArchivedSessions('startup').catch(e => app.log.error({ err:e }, 'archived session cleanup failed')), 30_000).unref();
setInterval(() => cleanupArchivedSessions('scheduled').catch(e => app.log.error({ err:e }, 'archived session cleanup failed')), Math.max(60_000, ARCHIVED_SESSION_CLEANUP_INTERVAL_MS)).unref();
process.on('SIGTERM', () => requestGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => requestGracefulShutdown('SIGINT'));
function activeAgentTurnCount() { return activeCodexSessions.size; }
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
  app.log.warn({ signal, activeCodex: activeCodexSessions.size }, 'shutdown requested; waiting for active agent turns');
  for (const sessionId of activeCodexSessions) {
    broadcast(sessionId, { type:'system', text:'服务将在当前回复完成后重启' });
  }
}
function maybeExitAfterDrain() {
  if (!shutdownRequested || activeAgentTurnCount()) return;
  app.log.info('active agent turns drained; exiting for restart');
  setTimeout(() => process.exit(0), 50);
}
async function ensureAdmin() {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) throw new Error('ADMIN_PASSWORD must be set');
  if (pw === 'change-me-at-least-12-chars' || pw === 'change-me' || pw.length < 8) throw new Error('ADMIN_PASSWORD must be changed and contain at least 8 characters');
  const secret = process.env.COOKIE_SECRET || '';
  if (!secret || secret === 'change-me-random-32-bytes' || secret === 'change-me' || secret.length < 32) throw new Error('COOKIE_SECRET must be changed and contain at least 32 characters');
  if (!cookieIsSecure()) {
    const host = process.env.HOST || '127.0.0.1';
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
    if (!loopback && process.env.ALLOW_INSECURE_TRUSTED_LAN !== '1') throw new Error('COOKIE_SECURE=false requires a loopback HOST or ALLOW_INSECURE_TRUSTED_LAN=1');
  }
  const row = await db.get('SELECT * FROM users WHERE username=?1',['admin']);
  const fingerprint = adminPasswordFingerprint();
  const previous = await getSetting('adminPasswordFingerprint').catch(()=>null);
  if (!row) {
    const hash = await argon2.hash(pw, { type: argon2.argon2id });
    await db.run('INSERT INTO users (username,password_hash,created_at) VALUES (?1,?2,?3)', ['admin', hash, Date.now()]);
    await setSetting('adminPasswordFingerprint', fingerprint);
    return;
  }
  if (previous && previous !== fingerprint) {
    const hash = await argon2.hash(pw, { type: argon2.argon2id });
    await db.run('UPDATE users SET password_hash=?1 WHERE username=?2', [hash, 'admin']);
    await db.run('UPDATE auth_sessions SET revoked_at=?1 WHERE revoked_at IS NULL', [Date.now()]);
  }
  if (!previous || previous !== fingerprint) await setSetting('adminPasswordFingerprint', fingerprint);
}
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
async function cachedClaudeStatus(force = false) {
  return cachedProviderStatus(
    claudeStatusCache,
    cache => { claudeStatusCache = cache; },
    'claudeProvider.status',
    force,
    () => claudeProvider.status()
  );
}
function cachedCodexStatusSnapshot() {
  return codexStatusCache.value || { ok:false, error:'Codex CLI 状态尚未刷新', appServer:true, sessionsPath:path.join(DEFAULT_CODEX_HOME, 'sessions') };
}
function cachedProviderStatusSnapshot(id:Exclude<AgentProviderId, 'codex'>, status:any) {
  const displayName = registryProviderDisplayName(id);
  return status || { id, displayName, ok:false, installed:false, version:null, error:`${displayName} 状态尚未刷新` };
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
function invalidateUnifiedProviderStatuses() {
  unifiedProviderStatusCache = { expiresAt: 0, generation: unifiedProviderStatusCache.generation + 1 };
}
function providerStatusArray(statuses:Record<AgentProviderId, ProviderStatus>) {
  return orderedProviderStatusArray(statuses);
}
function codexQuotaLogFields(rateLimits:any) {
  const limit = rateLimits?.rateLimitsByLimitId?.codex || rateLimits?.rateLimits || {};
  const primary = limit?.primary || {};
  const secondary = limit?.secondary || null;
  return {
    planType: limit?.planType || rateLimits?.planType || limit?.credits?.planType || null,
    limitId: limit?.limitId || limit?.id || 'codex',
    limitName: limit?.limitName || limit?.name || null,
    primaryUsedPercent: primary?.usedPercent ?? null,
    primaryWindowDurationMins: primary?.windowDurationMins ?? null,
    primaryResetsAt: primary?.resetsAt ?? null,
    secondaryPresent: !!secondary,
    secondaryUsedPercent: secondary?.usedPercent ?? null,
    secondaryWindowDurationMins: secondary?.windowDurationMins ?? null,
    secondaryResetsAt: secondary?.resetsAt ?? null,
  };
}
function providerDisplayName(provider:AgentProviderId) {
  return registryProviderDisplayName(provider);
}
function cachedUnifiedProviderStatusesSnapshot():Record<AgentProviderId, ProviderStatus> {
  if (unifiedProviderStatusCache.value) return unifiedProviderStatusCache.value;
  const snapshots:Record<AgentProviderId, any> = {
    codex:cachedCodexStatusSnapshot(),
    claude:cachedProviderStatusSnapshot('claude', claudeStatusCache.value),
    gemini:cachedProviderStatusSnapshot('gemini', geminiStatusCache.value),
    antigravity:cachedProviderStatusSnapshot('antigravity', antigravityStatusCache.value),
  };
  return Object.fromEntries(PROVIDER_ORDER.map(provider => [provider, providerStatus({
    provider,
    displayName:providerDisplayName(provider),
    cliStatus:snapshots[provider],
    auth:'checking',
    canCreateSession:false,
    canContinueSession:false,
    capabilities:providerCapabilitiesFor(provider),
    reasonCode:'status_refreshing',
    message:'账号状态正在后台刷新',
  })])) as Record<AgentProviderId, ProviderStatus>;
}
function isGeminiPersonalUnsupportedProfile(profile:any) {
  return String(profile?.authType || profile?.auth_type || profile?.login?.authType || '').toLowerCase() === 'oauth-personal';
}
function geminiPersonalUnsupportedMessage() {
  return '个人版 Gemini CLI 客户端已停止支持，请使用 Antigravity，或改用仍受支持的 API Key/企业账户。';
}
async function unifiedProviderStatuses(force = false):Promise<Record<AgentProviderId, ProviderStatus>> {
  const now = Date.now();
  if (!force && unifiedProviderStatusCache.value && unifiedProviderStatusCache.expiresAt > now) return unifiedProviderStatusCache.value;
  if (!force && unifiedProviderStatusCache.promise) return unifiedProviderStatusCache.promise;
  const generation = unifiedProviderStatusCache.generation;
  const promise = buildUnifiedProviderStatuses(force).then(value => {
    if (generation === unifiedProviderStatusCache.generation) {
      unifiedProviderStatusCache = { value, expiresAt: Date.now() + 5000, generation };
    }
    return value;
  }).catch(err => {
    if (generation === unifiedProviderStatusCache.generation) unifiedProviderStatusCache = { expiresAt: 0, generation };
    throw err;
  });
  unifiedProviderStatusCache = { ...unifiedProviderStatusCache, promise };
  return promise;
}
async function buildUnifiedProviderStatuses(force = false):Promise<Record<AgentProviderId, ProviderStatus>> {
  const checkedAt = new Date().toISOString();
  const [codexCli, claudeCli, geminiCli, antigravityCli, codexProfile, claudeProfile, geminiProfile, antigravityProfile, geminiPendingProfiles, codexPendingProfiles] = await Promise.all([
    force ? codexStatus() : cachedCodexStatus().catch((e:any)=>({ ok:false, error:e?.message || String(e) })),
    cachedClaudeStatus(force).catch((e:any)=>({ id:'claude', displayName:'Claude Code', ok:false, error:e?.message || String(e) })),
    cachedGeminiStatus(force).catch((e:any)=>({ id:'gemini', displayName:'Gemini', ok:false, error:e?.message || String(e) })),
    cachedAntigravityStatus(force).catch((e:any)=>({ id:'antigravity', displayName:'Antigravity', ok:false, error:e?.message || String(e) })),
    activeCodexProfileSummary(),
    activeClaudeProfileSummary(),
    activeGeminiProfileSummary(),
    activeAntigravityProfileSummary(),
    listGeminiPendingProfiles().catch(()=>[]),
    listPendingProfiles().catch(()=>[]),
  ]);
  const codexLogin:any = codexProfile?.login || {};
  const codexEmail = findEmailInText(String(codexLogin.email || codexProfile?.name || '')) || undefined;
  const codexAuthenticating = codexPendingProfiles.some((p:any) => ['draft','authenticating','verifying'].includes(String(p.state || p.status || '')));
  const codexAuth = codexProfile?.id ? 'authenticated' : codexAuthenticating ? 'authenticating' : 'unauthenticated';
  const geminiAuthenticating = geminiPendingProfiles.some((p:any) => ['draft','authenticating','verifying'].includes(String(p.state || p.status || '')));
  const geminiAuth = geminiProfile?.status === 'authenticated' ? 'authenticated' : geminiAuthenticating ? 'authenticating' : 'unauthenticated';
  const geminiEmail = findEmailInText(String(geminiProfile?.login?.email || geminiProfile?.name || '')) || undefined;
  const geminiPersonalUnsupported = geminiAuth === 'authenticated' && isGeminiPersonalUnsupportedProfile(geminiProfile);
  const geminiReason = !geminiCli?.ok ? 'gemini_unavailable' : !USE_AGENT_RUNTIME ? 'gemini_runtime_disabled' : geminiPersonalUnsupported ? 'gemini_client_unsupported' : geminiAuth === 'authenticated' ? null : geminiAuth === 'authenticating' ? 'gemini_authenticating' : 'gemini_not_logged_in';
  const geminiMessage = !geminiCli?.ok ? (geminiCli?.error || 'Gemini CLI 不可用') : !USE_AGENT_RUNTIME ? 'Gemini ACP 需要 persistent runtime' : geminiPersonalUnsupported ? geminiPersonalUnsupportedMessage() : geminiAuth === 'authenticated' ? null : geminiAuth === 'authenticating' ? 'Gemini 正在登录' : '请先登录 Gemini';
  const antigravityEmail = findEmailInText(String(antigravityProfile?.login?.email || antigravityProfile?.name || '')) || undefined;
  const antigravityAuth = antigravityProfile?.id ? 'unknown' : 'unauthenticated';
  const antigravityCanCreate = USE_AGENT_RUNTIME && !!antigravityCli?.ok && !!antigravityProfile?.id && !!antigravityProfile?.login?.ok;
  const claudeState = claudeAuthState(claudeProfile ? {
    id:String(claudeProfile.id),
    name:String(claudeProfile.name || 'Claude Code Account'),
    profileDir:String(claudeProfile.profileDir || ''),
    configDir:String(claudeProfile.configDir || ''),
    type:['official_cli','existing_cli','setup_token','api_key'].includes(String(claudeProfile.type)) ? claudeProfile.type : 'official_cli',
    active:!!claudeProfile.active,
    status:['not_installed','not_configured','authenticated','invalid_credentials','runtime_unavailable','capability_limited'].includes(String(claudeProfile.status)) ? claudeProfile.status : 'not_configured',
    credentialSummary:claudeProfile.credentialSummary || null,
    createdAt:Number(claudeProfile.createdAt || 0),
    updatedAt:Number(claudeProfile.updatedAt || 0),
  } as any : null, claudeCli as any);
  const adapterCapabilities = {
    codex: providerCapabilitiesFor('codex'),
    claude: providerCapabilitiesFor('claude'),
    gemini: providerCapabilitiesFor('gemini'),
    antigravity: providerCapabilitiesFor('antigravity'),
  };
  return {
    codex: providerStatus({
      provider:'codex',
      displayName:'Codex',
      cliStatus: codexCli,
      auth: codexAuth,
      activeProfileId: codexProfile?.id || null,
      account: codexProfile?.id ? { id:codexProfile.id, profileId:codexProfile.id, email:codexEmail, displayName:codexEmail || codexProfile.name } : null,
      canCreateSession: !!codexCli?.ok && codexAuth === 'authenticated',
      canContinueSession: !!codexCli?.ok && codexAuth === 'authenticated',
      canManageAccounts: true,
      canLogout: codexAuth === 'authenticated',
      canQueryQuota: true,
      canListModels: !!codexCli?.ok,
      canSelectModel: !!codexCli?.ok,
      capabilities: adapterCapabilities.codex,
      reasonCode: codexCli?.ok ? (codexAuth === 'authenticated' ? null : 'codex_not_logged_in') : 'codex_unavailable',
      message: codexCli?.ok ? (codexAuth === 'authenticated' ? null : '请先登录 Codex') : (codexCli?.error || 'Codex CLI 不可用'),
      checkedAt,
      command:codexCli?.command || 'codex',
    }),
    claude: providerStatus({
      provider:'claude',
      displayName:'Claude Code',
      cliStatus: claudeCli,
      auth: claudeState.auth,
      activeProfileId: claudeProfile?.id || null,
      account: claudeProfile?.id ? { id:claudeProfile.id, profileId:claudeProfile.id, displayName:claudeProfile.name, authType:claudeProfile.type } : null,
      canCreateSession: !!claudeCli?.ok && claudeState.auth === 'authenticated',
      canContinueSession: !!claudeCli?.ok && claudeState.auth === 'authenticated',
      canManageAccounts: true,
      canLogout: !!claudeProfile?.id,
      canQueryQuota: false,
      canListModels: true,
      canSelectModel: true,
      capabilities: adapterCapabilities.claude,
      reasonCode: claudeState.status,
      message: claudeState.message,
      checkedAt,
      command:claudeCli?.command || 'claude',
      installHint:'安装 Claude Code CLI，或设置 CLAUDE_BIN。',
    }),
    gemini: providerStatus({
      provider:'gemini',
      displayName:'Gemini',
      cliStatus: geminiCli,
      auth: geminiAuth,
      activeProfileId: geminiProfile?.id || null,
      account: geminiProfile?.id ? { id:geminiProfile.id, profileId:geminiProfile.id, email:geminiEmail, displayName:geminiEmail || geminiProfile.name, authType:geminiProfile.authType ? String(geminiProfile.authType) : undefined } : null,
      canCreateSession: !!geminiCli?.ok && USE_AGENT_RUNTIME && geminiAuth === 'authenticated' && !geminiPersonalUnsupported,
      canContinueSession: !!geminiCli?.ok && USE_AGENT_RUNTIME && geminiAuth === 'authenticated' && !geminiPersonalUnsupported,
      canManageAccounts: true,
      canLogout: geminiAuth === 'authenticated',
      canQueryQuota: false,
      canListModels: !!geminiCli?.ok,
      canSelectModel: !!geminiCli?.ok,
      capabilities: adapterCapabilities.gemini,
      reasonCode: geminiReason,
      message: geminiMessage,
      checkedAt,
      command:'gemini',
    }),
    antigravity: providerStatus({
      provider:'antigravity',
      displayName:'Antigravity',
      cliStatus: antigravityCli,
      auth: antigravityAuth,
      activeProfileId: antigravityProfile?.id || null,
      account: antigravityProfile?.id ? { id:antigravityProfile.id, profileId:antigravityProfile.id, email:antigravityEmail, displayName:antigravityEmail || antigravityProfile.name } : null,
      canCreateSession: antigravityCanCreate,
      canContinueSession: antigravityCanCreate,
      canManageAccounts: true,
      canLogout: false,
      canQueryQuota: true,
      canListModels: !!antigravityCli?.ok && !!antigravityProfile?.id,
      canSelectModel: !!antigravityCli?.ok,
      capabilities: adapterCapabilities.antigravity,
      reasonCode: !antigravityCli?.ok ? 'antigravity_unavailable' : antigravityProfile?.id ? 'antigravity_auth_unknown' : 'antigravity_not_logged_in',
      message: !antigravityCli?.ok ? (antigravityCli?.error || 'Antigravity CLI 不可用') : antigravityProfile?.id ? 'Antigravity 登录状态无法可靠探测' : '请先添加 Antigravity 账户',
      checkedAt,
      command:'agy',
      installHint:'需要先安装官方 CLI 后才能登录和创建 Antigravity 会话。',
    }),
  };
}
function providerInstallerSummary(provider:AgentProviderId) {
  const installer = PROVIDER_INSTALLERS[provider];
  const latestJobId = providerInstallByProvider.get(provider);
  const latestJob = latestJobId ? providerInstallJobs.get(latestJobId) : null;
  return {
    provider,
    automatic: installer.automatic,
    binary: installer.binary,
    packageName: installer.packageName || null,
    source: installer.source,
    reason: installer.reason,
    manual: installer.manual,
    latestJob: latestJob ? providerInstallJobSummary(latestJob) : null,
  };
}
function providerInstallerSummaries() {
  return Object.fromEntries(VISIBLE_PROVIDER_ORDER.map(provider => [provider, providerInstallerSummary(provider)]));
}
function providerInstallJobSummary(job:ProviderInstallJob) {
  return {
    id:job.id,
    provider:job.provider,
    action:job.action,
    status:job.status,
    output:job.output.slice(-80).map(line => maskSecretText(line)),
    error:job.error ? maskSecretText(job.error) : null,
    version:job.version || null,
    startedAt:job.startedAt,
    updatedAt:job.updatedAt,
  };
}
function providerInstallJobSummaries() {
  return [...providerInstallJobs.values()].sort((a,b)=>b.startedAt-a.startedAt).slice(0, 20).map(providerInstallJobSummary);
}
async function runProviderInstallJob(job:ProviderInstallJob) {
  const installer = PROVIDER_INSTALLERS[job.provider];
  if (!installer.automatic) throw new Error('automatic install is not supported');
  const providerDir = path.join(PROVIDER_TOOLS_DIR, job.provider);
  const candidateDir = providerInstallCandidateDir(job);
  const currentLink = path.join(providerDir, 'current');
  const binLink = path.join(MANAGED_PROVIDER_BIN_DIR, installer.binary);
  const binaryPath = job.provider === 'claude'
    ? path.join(candidateDir, '.local', 'bin', installer.binary)
    : path.join(candidateDir, 'node_modules', '.bin', installer.binary);
  try {
    await mkdir(MANAGED_PROVIDER_BIN_DIR, { recursive:true });
    await mkdir(path.dirname(PROVIDER_INSTALL_JOBS_FILE), { recursive:true });
    await rm(candidateDir, { recursive:true, force:true });
    await mkdir(candidateDir, { recursive:true, mode:0o755 });
    updateProviderInstallJob(job, 'downloading', `Using ${installer.source}`);
    if (job.provider === 'claude') {
      const scriptPath = path.join(candidateDir, 'install.sh');
      updateProviderInstallJob(job, 'downloading', `Downloading ${installer.installScriptUrl}`);
      await downloadProviderInstallScript(job, String(installer.installScriptUrl), scriptPath);
      await chmod(scriptPath, 0o755);
      updateProviderInstallJob(job, 'installing', 'Running official Claude Code installer in managed candidate HOME');
      await spawnProviderInstall(job, 'bash', [scriptPath], providerInstallEnv(candidateDir));
    } else {
      if (!installer.packageName) throw new Error('automatic install source is missing');
      updateProviderInstallJob(job, 'installing', `npm install ${installer.packageName}@latest`);
      await spawnProviderInstall(job, 'npm', ['--prefix', candidateDir, 'install', '--omit=dev', `${installer.packageName}@latest`], providerInstallEnv(DEFAULT_HOME, {
        npm_config_cache: path.join(DATA_DIR, 'cache', 'npm-provider-tools'),
        NPM_CONFIG_CACHE: path.join(DATA_DIR, 'cache', 'npm-provider-tools'),
      }));
    }
    updateProviderInstallJob(job, 'verifying', `${installer.binary} --version`);
    await access(binaryPath, constants.X_OK).catch(() => { throw new Error(`${installer.binary} binary was not installed at ${binaryPath}`); });
    const version = await execFileAsync(binaryPath, ['--version'], { timeout:10_000, env:providerInstallEnv(DEFAULT_HOME) }).then(r => (r.stdout || r.stderr).trim()).catch((e:any) => {
      throw new Error(String(e?.stderr || e?.stdout || e?.message || e));
    });
    const previousLink = path.join(providerDir, 'previous');
    await rm(previousLink, { recursive:true, force:true });
    if (existsSync(currentLink)) await rename(currentLink, previousLink).catch(()=>{});
    await rm(currentLink, { recursive:true, force:true });
    await symlink(candidateDir, currentLink);
    await rm(binLink, { force:true });
    const managedBinaryPath = job.provider === 'claude'
      ? path.join(currentLink, '.local', 'bin', installer.binary)
      : path.join(currentLink, 'node_modules', '.bin', installer.binary);
    await symlink(managedBinaryPath, binLink);
    job.version = version || null;
    updateProviderInstallJob(job, 'succeeded', `Installed ${installer.binary} ${version || ''}`.trim());
    providerInstallByProvider.delete(job.provider);
    invalidateProviderCaches(job.provider);
  } catch (e) {
    await rm(candidateDir, { recursive:true, force:true }).catch(()=>{});
    throw e;
  }
}
function providerInstallCandidateDir(job:ProviderInstallJob) {
  return path.join(PROVIDER_TOOLS_DIR, job.provider, `candidate-${job.id}`);
}
function providerInstallEnv(home:string, extra:Record<string,string> = {}) {
  const env:Record<string,string> = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    DATA_DIR,
    ...extra,
  };
  for (const key of ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy']) {
    if (process.env[key]) env[key] = String(process.env[key]);
  }
  return env;
}
async function downloadProviderInstallScript(job:ProviderInstallJob, url:string, dest:string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'claude.ai' || parsed.pathname !== '/install.sh') throw new Error('installer source is not allowlisted');
  await spawnProviderInstall(job, 'curl', ['-fsSL', '-o', dest, url], providerInstallEnv(DEFAULT_HOME));
}
function updateProviderInstallJob(job:ProviderInstallJob, status:ProviderInstallStatus, line?:string) {
  job.status = status;
  job.updatedAt = Date.now();
  if (line) job.output.push(`[${new Date().toISOString()}] ${maskSecretText(line)}`);
  persistProviderInstallJobs().catch(()=>{});
}
function failProviderInstallJob(job:ProviderInstallJob, message:string) {
  if (job.status === 'cancelled') return;
  job.status = 'failed';
  job.error = maskSecretText(safeAntigravitySummary(message));
  job.updatedAt = Date.now();
  job.output.push(`[${new Date().toISOString()}] ERROR ${job.error}`);
  providerInstallChildren.delete(job.id);
  providerInstallByProvider.delete(job.provider);
  persistProviderInstallJobs().catch(()=>{});
}
function spawnProviderInstall(job:ProviderInstallJob, command:string, args:string[], env:NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, cwd:PROVIDER_TOOLS_DIR, stdio:['ignore','pipe','pipe'], detached:true });
    providerInstallChildren.set(job.id, child);
    const killTree = (signal:NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
    };
    const timer = setTimeout(() => {
      updateProviderInstallJob(job, 'failed', `${command} timed out after ${Math.round(PROVIDER_INSTALL_TIMEOUT_MS / 60000)} minutes`);
      providerInstallChildren.delete(job.id);
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 10_000).unref?.();
      reject(new Error(`${command} timed out`));
    }, PROVIDER_INSTALL_TIMEOUT_MS);
    timer.unref?.();
    const append = (chunk:Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/).filter(Boolean)) job.output.push(maskSecretText(redactLine(line)).slice(0, 1000));
      job.output = job.output.slice(-200);
      job.updatedAt = Date.now();
      persistProviderInstallJobs().catch(()=>{});
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      providerInstallChildren.delete(job.id);
      if (job.status === 'cancelled') return resolve();
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`));
    });
  });
}
async function persistProviderInstallJobs() {
  await mkdir(path.dirname(PROVIDER_INSTALL_JOBS_FILE), { recursive:true, mode:0o755 });
  const jobs = [...providerInstallJobs.values()].sort((a,b)=>b.startedAt-a.startedAt).slice(0, 50);
  await writeFile(PROVIDER_INSTALL_JOBS_FILE, JSON.stringify({ jobs }, null, 2) + '\n', { mode:0o600 });
}
async function loadProviderInstallJobs() {
  let parsed:any = null;
  try { parsed = JSON.parse(await readFile(PROVIDER_INSTALL_JOBS_FILE, 'utf8')); } catch { return; }
  for (const raw of Array.isArray(parsed?.jobs) ? parsed.jobs : []) {
    const provider = normalizeProvider(raw?.provider);
    if (!provider) continue;
    const status = ['queued','downloading','installing','verifying'].includes(String(raw?.status)) ? 'failed' : String(raw?.status || 'failed');
    const job:ProviderInstallJob = {
      id:String(raw.id || ''),
      provider,
      action:'install',
      status: ['succeeded','failed','cancelled'].includes(status) ? status as ProviderInstallStatus : 'failed',
      output:Array.isArray(raw.output) ? raw.output.map((line:any)=>String(line).slice(0, 1000)).slice(-200) : [],
      error:raw.error ? String(raw.error) : (['queued','downloading','installing','verifying'].includes(String(raw?.status)) ? '安装任务因服务重启而中断' : undefined),
      version:raw.version ? String(raw.version) : null,
      startedAt:Number(raw.startedAt || Date.now()),
      updatedAt:Number(raw.updatedAt || Date.now()),
    };
    if (!job.id) continue;
    providerInstallJobs.set(job.id, job);
    if (!['succeeded','failed','cancelled'].includes(job.status)) providerInstallByProvider.set(provider, job.id);
  }
}
function invalidateProviderCaches(provider:AgentProviderId) {
  if (provider === 'codex') codexStatusCache = { expiresAt:0 };
  if (provider === 'claude') claudeStatusCache = { expiresAt:0 };
  if (provider === 'gemini') geminiStatusCache = { expiresAt:0 };
  if (provider === 'antigravity') antigravityStatusCache = { expiresAt:0 };
  invalidateUnifiedProviderStatuses();
}
async function activeCodexProfileSummary() {
  const p = await db.get(`SELECT ${CODEX_PROFILE_COLUMNS} FROM codex_profiles WHERE active=1 AND COALESCE(status,'authenticated')='authenticated' ORDER BY updated_at DESC LIMIT 1`);
  if (!p) return null;
  const email = String(p.email || '').trim() || undefined;
  const displayName = String(p.display_name || '').trim() || undefined;
  return {
    id:String(p.id),
    provider:'codex',
    name:email || displayName || codexMetadataLabel(p),
    email,
    displayName,
    metadataStatus:String(p.metadata_status || 'pending'),
    metadataError:p.metadata_error || undefined,
    state:'authenticated',
    status:String(p.status || 'authenticated'),
    active:Number(p.active || 0),
    login:{ ok:true, email, displayName, text:'Cached account summary' },
    created_at:Number(p.created_at || 0),
    updated_at:Number(p.updated_at || 0),
  };
}
async function activeGeminiProfileSummary() {
  const p = await db.get("SELECT id,name,auth_type,active,status,default_model_mode,default_model,created_at,updated_at FROM gemini_profiles WHERE active=1 AND COALESCE(status,'configured')='authenticated' ORDER BY updated_at DESC LIMIT 1");
  if (!p) return null;
  const name = String(p.name || '').trim() || 'Gemini Account';
  return {
    id:String(p.id),
    provider:'gemini',
    name,
    state:String(p.status || 'authenticated'),
    status:String(p.status || 'authenticated'),
    authType:p.auth_type || null,
    defaultModelMode: p.default_model_mode === 'manual' && cleanAgentModel(p.default_model) ? 'manual' : 'auto',
    defaultModel: p.default_model_mode === 'manual' ? cleanAgentModel(p.default_model) : '',
    active:Number(p.active || 0),
    login:{ ok:String(p.status || '') === 'authenticated', email:findEmailInText(name) || undefined, text:'Cached account summary' },
    created_at:Number(p.created_at || 0),
    updated_at:Number(p.updated_at || 0),
  };
}
async function activeAntigravityProfileSummary() {
  const p = await db.get("SELECT id,name,active,status,created_at,updated_at FROM antigravity_profiles WHERE active=1 AND COALESCE(status,'authenticated')='authenticated' ORDER BY updated_at DESC LIMIT 1");
  if (!p) return null;
  const name = String(p.name || '').trim() || 'Antigravity Account';
  return {
    id:String(p.id),
    provider:'antigravity',
    name,
    state:String(p.status || 'authenticated'),
    status:String(p.status || 'authenticated'),
    active:Number(p.active || 0),
    login:{ ok:String(p.status || '') === 'authenticated', email:findEmailInText(name) || undefined, text:'Cached account summary' },
    created_at:Number(p.created_at || 0),
    updated_at:Number(p.updated_at || 0),
  };
}
async function activeClaudeProfileSummary() {
  const profile = await claudeProfileStore.active();
  if (!profile || profile.status !== 'authenticated') return null;
  return claudeProfileDto(profile);
}
async function listClaudeProfiles() {
  const profiles = await claudeProfileStore.list();
  return profiles.filter(profile => profile.status === 'authenticated').map(claudeProfileDto);
}
function claudeProfileDto(profile:any) {
  return {
    id:String(profile.id),
    provider:'claude',
    name:String(profile.name || 'Claude Code Account'),
    profileDir:String(profile.profileDir || ''),
    configDir:String(profile.configDir || ''),
    type:String(profile.type || 'existing_cli'),
    authType:String(profile.type || 'existing_cli'),
    state:String(profile.status || 'not_configured'),
    status:String(profile.status || 'not_configured'),
    credentialSummary:profile.credentialSummary || null,
    active:Number(profile.active || 0),
    login:{ ok:!['not_installed','not_configured','invalid_credentials','runtime_unavailable'].includes(String(profile.status || '')), text:'Claude Code profile configured' },
    createdAt:Number(profile.createdAt || 0),
    updatedAt:Number(profile.updatedAt || 0),
  };
}
function claudeAccountSnapshot(profile:any) {
  return {
    id:String(profile.id),
    provider:'claude',
    name:String(profile.name || 'Claude Code Account'),
    authType:String(profile.type || profile.authType || 'existing_cli'),
    timestamp:Date.now(),
  };
}
async function runClaudeCliLoginJob(job:ClaudeLoginJob) {
  const profile = await claudeProfileStore.get(job.profileId);
  if (!profile) throw new Error('Claude profile not found');
  const cli = await cachedClaudeStatus(true);
  if (!cli?.command) throw new Error(cli?.error || 'Claude Code CLI 未安装，无法启动官方登录');
  await mkdir(profile.profileDir, { recursive:true, mode:0o700 });
  await mkdir(profile.configDir, { recursive:true, mode:0o700 });
  await chmod(profile.profileDir, 0o700).catch(()=>{});
  await chmod(profile.configDir, 0o700).catch(()=>{});
  job.output = [];
  let child:any = null;
  let rawOutput = '';
  let finalized = false;
  let timeout:NodeJS.Timeout|null = null;
  let completeResolve:(()=>void)|null = null;
  const complete = new Promise<void>(resolve => { completeResolve = resolve; });
  const finalize = async (fn:()=>Promise<void>|void) => {
    if (finalized) return;
    finalized = true;
    if (timeout) clearTimeout(timeout);
    claudeLoginChildren.delete(job.id);
    await fn();
    completeResolve?.();
  };
  try {
    child = pty.spawn(String(cli.command), ['auth', 'login'], {
      name:'xterm-256color',
      cols:96,
      rows:32,
      cwd:profile.profileDir,
      env:claudeProfileEnv(profile, {}, process.env),
    });
    claudeLoginChildren.set(job.id, child);
    app.log.info({ provider:'claude', jobId:job.id, profileId:job.profileId, env:claudeSafeEnvSummary(profile), command:cli.command }, 'claude cli login pty started');
  } catch (e:any) {
    await failClaudeLoginJob(job, `无法启动 Claude Code 登录进程：${safeClaudeError(e)}`);
    return;
  }
  timeout = setTimeout(() => {
    finalize(async () => {
      try { child?.kill(); } catch {}
      if (job.status === 'done' || job.status === 'cancelled') return;
      await failClaudeLoginJob(job, 'Claude 登录验证超时');
    }).catch(()=>{});
  }, 10 * 60_000);
  const handleOutput = (chunk:string) => {
    rawOutput = (rawOutput + String(chunk || '')).slice(-12000);
    const sanitized = redactClaudeLoginOutput(chunk);
    for (const line of stripAnsi(sanitized).split(/\r?\n/).map(x=>x.trim()).filter(Boolean)) job.output.push(line);
    job.output = job.output.slice(-120);
    const parsed = parseClaudeLogin(rawOutput);
    if (parsed.loginUrl) {
      job.loginUrl = parsed.loginUrl;
      job.status = 'waiting_user';
      job.error = undefined;
    }
    if (parsed.requiresInput) job.requiresInput = true;
    if (parsed.failure && job.status !== 'cancelled') failClaudeLoginJob(job, parsed.failure).catch(()=>{});
    if (parsed.success && job.status !== 'done' && job.status !== 'cancelled') {
      verifyClaudeLoginJob(job).catch((e:any)=>failClaudeLoginJob(job, safeClaudeError(e)));
    }
  };
  child.onData((d:string)=>handleOutput(d));
  child.onExit(async ({ exitCode }:any) => {
    await finalize(async () => {
      if (job.status === 'done' || job.status === 'cancelled') return;
      if (exitCode === 0) await verifyClaudeLoginJob(job);
      else await failClaudeLoginJob(job, `Claude 登录进程退出，code=${exitCode}`);
    });
  });
  await complete;
}
async function verifyClaudeLoginJob(job:ClaudeLoginJob) {
  const profile = await claudeProfileStore.get(job.profileId);
  if (!profile) throw new Error('Claude profile not found');
  job.status = 'verifying';
  const result = await claudeAuthStatus(profile);
  if (!result.ok) throw new Error(result.error || 'Claude auth status 未通过');
  await claudeProfileStore.markStatus(profile.id, 'authenticated');
  await claudeProfileStore.switch(profile.id).catch(()=>{});
  job.status = 'done';
  job.error = undefined;
  claudeLoginProfiles.delete(profile.id);
  try { claudeLoginChildren.get(job.id)?.kill(); } catch {}
  claudeLoginChildren.delete(job.id);
  invalidateUnifiedProviderStatuses();
}
async function failClaudeLoginJob(job:ClaudeLoginJob, message:string) {
  if (job.status === 'done' || job.status === 'cancelled') return;
  job.status = 'error';
  job.error = message || 'Claude 登录失败';
  claudeLoginProfiles.delete(job.profileId);
  claudeLoginChildren.delete(job.id);
  await claudeProfileStore.markStatus(job.profileId, 'invalid_credentials').catch(()=>{});
  invalidateUnifiedProviderStatuses();
}
function parseClaudeLogin(output:string) {
  const text = stripAnsi(output).replace(/\r/g, '').replace(/[^\S\n]+/g, ' ');
  const loginUrl = extractClaudeLoginUrl(text);
  const requiresInput = /authorization code|paste .*code|press enter|select|continue/i.test(text);
  const failureMatch = text.match(/(authentication failed[^\n]*|login failed[^\n]*|invalid[_ -]?grant[^\n]*|error:[^\n]*)/i);
  const success = /authenticated|login successful|successfully logged in/i.test(text);
  return { loginUrl, requiresInput, success, failure: failureMatch?.[1] ? redactClaudeLoginOutput(failureMatch[1]).slice(0, 500) : null };
}
function extractClaudeLoginUrl(text:string) {
  const match = text.match(/https:\/\/[^\s)]+/i)?.[0]?.replace(/[),.]+$/, '');
  if (!match) return undefined;
  try {
    const url = new URL(match);
    if (url.protocol !== 'https:') return undefined;
    if (!/(anthropic\.com|claude\.ai)$/i.test(url.hostname) && !url.hostname.endsWith('.anthropic.com') && !url.hostname.endsWith('.claude.ai')) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
function redactClaudeLoginOutput(text:string) {
  return String(text || '')
    .replace(/([?&](?:code|client_secret|token|refresh_token|access_token|id_token)=)[^&\s]+/ig, '$1[redacted]')
    .replace(/(authorization code\s*:?\s*)[A-Za-z0-9_./~+=-]{4,}/ig, '$1[redacted]')
    .replace(/(access_token|refresh_token|id_token|client_secret|api[_ -]?key|token)\s*[:=]\s*[^\s]+/ig, '$1=[redacted]');
}
function safeClaudeError(e:any) {
  return redactClaudeLoginOutput(String(e?.message || e || 'Claude request failed'));
}
function findEmailInText(value:string) {
  return value.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0] || null;
}
async function ensureProfiles() {
  await mkdir(PROFILES_DIR, { recursive:true });
  const existing = await db.get('SELECT * FROM codex_profiles LIMIT 1');
  if (!existing) {
    const email = await readProfileEmail(DEFAULT_CODEX_HOME).catch(()=>null);
    await db.run('INSERT INTO codex_profiles (id,name,codex_home,active,created_at,updated_at) VALUES (?1,?2,?3,1,?4,?4)', ['default', email || 'Codex Account', DEFAULT_CODEX_HOME, Date.now()]);
  }
  const profiles = await db.all('SELECT id,codex_home FROM codex_profiles');
  for (const profile of profiles) {
    await ensureSharedCodexDirs(String(profile.codex_home)).catch(err => console.warn('shared session setup failed', profile.codex_home, err?.message || err));
    await refreshCodexProfileMetadata(String(profile.id), String(profile.codex_home));
  }
  const active:any = await getActiveProfile();
  if (!USE_AGENT_RUNTIME && active?.codex_home) await codex.switchCodexHome(String(active.codex_home));
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
    const login = await geminiLoginStatus(defaultHome, existing?.auth_type ? String(existing.auth_type) : null).catch(()=>({ ok:false, credentialsPresent:false, email:null, text:'Not logged in', authType:null }));
    const name = login.email || existing?.name || 'Gemini Account';
    const state = existing?.status || (login.credentialsPresent ? 'configured' : 'bootstrap');
    const active = state === 'authenticated' ? Number(existing?.active || 0) : 0;
    await db.run(
      `INSERT INTO gemini_profiles (id,name,home_dir,auth_type,active,status,created_at,updated_at)
       VALUES ('default',?1,?2,?3,?4,?5,?6,?6)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, home_dir=excluded.home_dir, auth_type=COALESCE(gemini_profiles.auth_type, excluded.auth_type), active=excluded.active, status=CASE WHEN gemini_profiles.status='disabled' THEN 'disabled' ELSE excluded.status END, updated_at=excluded.updated_at`,
      [name, defaultHome, login.authType || existing?.auth_type || null, active, state, Date.now()]
    );
  }
  await ensureGeminiActiveProfile();
  await db.run("UPDATE sessions SET account_id='default' WHERE provider_id='gemini' AND (account_id IS NULL OR account_id='')").catch(()=>{});
}
async function reconcileGeminiProfilesOnStartup() {
  if (!USE_AGENT_RUNTIME) return;
  const rows = await db.all("SELECT id,name,home_dir,auth_type,active,status,default_model_mode,default_model,created_at,updated_at FROM gemini_profiles WHERE COALESCE(status,'configured') IN ('verifying','failed','configured','authenticating') ORDER BY updated_at DESC");
  for (const row of rows as any[]) {
    const credential = await geminiCredentialState(row).catch(()=>({ exists:false, size:0 }));
    if (!credential.exists || credential.size <= 0) continue;
    await reconcileGeminiProfileAuthentication(String(row.id), { reason:'startup_reconcile' }).catch((e:any) => app.log.warn({ provider:'gemini', profileId:String(row.id), err:safeGeminiError(e) }, 'gemini startup reconcile profile failed'));
  }
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
  const storedProvider=normalizeProvider(map.activeProvider);const activeProvider=storedProvider&&visibleProvider(storedProvider)?storedProvider:'codex';
  const legacyCodexModel = cleanModel(map.defaultModel) || '';
  const legacyAntigravityModel = legacyCodexModel ? '' : (cleanAgentModel(map.defaultModel) || '');
  const geminiDefault = await activeGeminiDefaultModel();
  const defaultModels = {
    codex: cleanModel(map.defaultModelCodex) || legacyCodexModel,
    claude: cleanAgentModel(map.defaultModelClaude) || '',
    gemini: geminiDefault.model || cleanAgentModel(map.defaultModelGemini) || '',
    antigravity: cleanAgentModel(map.defaultModelAntigravity) || legacyAntigravityModel,
  };
  return {
    activeProvider,
    defaultMode: normalizeMode(map.defaultMode) || 'yolo',
    defaultModel: defaultModels[activeProvider as keyof typeof defaultModels] || defaultModels.codex,
    defaultModels,
    defaultModelModes: { gemini:geminiDefault.mode },
  };
}
async function getSetting(key:string) { return (await db.get('SELECT value FROM settings WHERE key=?1', [key]))?.value as string | undefined; }
async function setSetting(key:string, value:string) { await db.run('INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, value]); }
async function activeGeminiDefaultModel() {
  const row = await db.get("SELECT default_model_mode, default_model FROM gemini_profiles WHERE active=1 AND COALESCE(status,'configured')='authenticated' ORDER BY updated_at DESC LIMIT 1").catch(()=>null);
  const mode = row?.default_model_mode === 'manual' && cleanAgentModel(row?.default_model) ? 'manual' : 'auto';
  return { mode, model: mode === 'manual' ? cleanAgentModel(row?.default_model) : '' };
}
async function setActiveGeminiDefaultModel(model:string | null) {
  const active = await db.get("SELECT id FROM gemini_profiles WHERE active=1 AND COALESCE(status,'configured')='authenticated' ORDER BY updated_at DESC LIMIT 1");
  if (!active?.id) {
    const err:any = new Error('请先登录 Gemini');
    err.statusCode = 409;
    throw err;
  }
  const clean = cleanAgentModel(model);
  await db.run(
    "UPDATE gemini_profiles SET default_model_mode=?1, default_model=?2, updated_at=?3 WHERE id=?4",
    [clean ? 'manual' : 'auto', clean || null, Date.now(), String(active.id)]
  );
}
async function createProviderLoginAttempt(provider:AgentProviderId, options:{ id?:string; profileId?:string|null; tempHome?:string|null; methodId?:string|null; displayName?:string } = {}) {
  const id = options.id || crypto.randomBytes(8).toString('hex');
  const tempHome = options.tempHome || (
    provider === 'codex'
      ? path.join(PROFILES_DIR, id, '.codex')
      : provider === 'gemini'
        ? geminiHomeForProfile(id)
        : antigravityHomeForProfile(id)
  );
  const metadata = { displayName: options.displayName || `${provider} login` };
  const now = Date.now();
  await db.run(
    `INSERT INTO provider_login_attempts (id,provider,profile_id,temp_home,method_id,status,error,metadata_json,created_at,updated_at)
     VALUES (?1,?2,?3,?4,?5,'starting',NULL,?6,?7,?7)
     ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, profile_id=excluded.profile_id, temp_home=excluded.temp_home, method_id=excluded.method_id, status=excluded.status, error=NULL, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`,
    [id, provider, options.profileId || null, tempHome, options.methodId || null, JSON.stringify(metadata), now]
  );
  return getProviderLoginAttempt(id) as Promise<ProviderLoginAttempt>;
}
async function getProviderLoginAttempt(id:string) {
  const row = await db.get('SELECT id,provider,profile_id,temp_home,method_id,status,error,metadata_json,created_at,updated_at FROM provider_login_attempts WHERE id=?1', [id]).catch(()=>null);
  if (!row) return null;
  let metadata:Record<string, any> = {};
  try { metadata = JSON.parse(String(row.metadata_json || '{}')); } catch { metadata = {}; }
  return {
    id:String(row.id),
    provider:normalizeProvider(row.provider) || 'codex',
    profileId:row.profile_id ? String(row.profile_id) : null,
    tempHome:row.temp_home ? String(row.temp_home) : null,
    methodId:row.method_id ? String(row.method_id) : null,
    status:normalizeProviderLoginAttemptStatus(row.status),
    error:row.error ? String(row.error) : null,
    metadata,
    createdAt:Number(row.created_at || 0),
    updatedAt:Number(row.updated_at || 0),
  };
}
async function updateProviderLoginAttempt(id:string, values:{ status?:ProviderLoginAttemptStatus; error?:string|null; profileId?:string|null; methodId?:string|null; metadata?:Record<string, any> }) {
  const attempt = await getProviderLoginAttempt(id);
  if (!attempt) return null;
  const nextMetadata = values.metadata ? { ...(attempt.metadata || {}), ...values.metadata } : attempt.metadata || {};
  await db.run(
    `UPDATE provider_login_attempts
     SET status=COALESCE(?1,status), error=?2, profile_id=COALESCE(?3,profile_id), method_id=COALESCE(?4,method_id), metadata_json=?5, updated_at=?6
     WHERE id=?7`,
    [values.status || null, values.error === undefined ? attempt.error || null : values.error, values.profileId || null, values.methodId || null, JSON.stringify(nextMetadata), Date.now(), id]
  );
  return getProviderLoginAttempt(id);
}
function normalizeProviderLoginAttemptStatus(value:any): ProviderLoginAttemptStatus {
  const status = String(value || '');
  return ['starting','waiting_authorization','waiting_code','verifying','failed','cancelled','done'].includes(status) ? status as ProviderLoginAttemptStatus : 'starting';
}
function providerLoginAttemptDto(attempt:ProviderLoginAttempt) {
  const state = attempt.status === 'waiting_authorization' || attempt.status === 'waiting_code' || attempt.status === 'starting' ? 'authenticating' : attempt.status === 'done' ? 'authenticated' : attempt.status === 'cancelled' ? 'failed' : attempt.status;
  return {
    id:attempt.id,
    provider:attempt.provider,
    name:String(attempt.metadata?.displayName || `${providerLabelForAttempt(attempt.provider)} Login`),
    active:0,
    status:state,
    state,
    isLoginAttempt:true,
    tempHome:attempt.tempHome,
    error:attempt.error || undefined,
    login:{ ok:false, text:'Login attempt' },
    created_at:attempt.createdAt,
    updated_at:attempt.updatedAt,
  };
}
function providerLabelForAttempt(provider:AgentProviderId) {
  return provider === 'gemini' ? 'Gemini' : provider === 'antigravity' ? 'Antigravity' : 'Codex';
}
async function listProviderLoginAttempts(provider:AgentProviderId) {
  const rows = await db.all("SELECT id FROM provider_login_attempts WHERE provider=?1 AND status IN ('starting','waiting_authorization','waiting_code','verifying','failed','cancelled') ORDER BY updated_at DESC", [provider]).catch(()=>[]);
  const attempts = await Promise.all(rows.map((row:any) => getProviderLoginAttempt(String(row.id))));
  return attempts.filter(Boolean).map((attempt:any) => providerLoginAttemptDto(attempt));
}
async function prepareCodexLoginCandidate(attemptId:string, codexHome:string) {
  const attempt = await getProviderLoginAttempt(attemptId);
  if (!attempt) throw new Error('login attempt not found');
  await updateProviderLoginAttempt(attemptId, { status:'verifying' });
  const metadata = await resolveCodexProfileMetadata(codexHome);
  const email = metadata.email;
  const existing = email ? await findCodexProfileByEmail(email) : null;
  const id = existing?.id ? String(existing.id) : attemptId;
  return {
    id,
    name:email || metadata.displayName || existing?.name || String(attempt.metadata?.displayName || 'Codex Account'),
    codex_home:codexHome,
    status:'verifying',
    active:0,
    email,
    display_name:metadata.displayName,
    metadata_status:metadata.status,
    metadata_error:metadata.error,
    metadata_updated_at:Date.now(),
    created_at:Number(existing?.created_at || Date.now()),
  };
}
async function findCodexProfileByEmail(email:string) {
  const normalized = email.trim().toLowerCase();
  const byName = await db.get(`SELECT ${CODEX_PROFILE_COLUMNS} FROM codex_profiles WHERE lower(COALESCE(email,name))=?1 LIMIT 1`, [normalized]).catch(()=>null);
  if (byName) return byName;
  const rows = await db.all(`SELECT ${CODEX_PROFILE_COLUMNS} FROM codex_profiles WHERE COALESCE(status,'authenticated')='authenticated'`).catch(()=>[]);
  for (const row of rows as any[]) {
    const found = await readProfileEmail(String(row.codex_home)).catch(()=>null);
    if (found && found.trim().toLowerCase() === normalized) return row;
  }
  return null;
}
async function codexCreateSessionPreflight() {
  const canonical:any = await getActiveProfile();
  const result = evaluateCodexProfileReadiness(canonical);
  if (result.ok) return { ok:true as const, profile:canonical };
  return {
    ok:false as const,
    statusCode:409,
    body:{ code:result.code, message:result.message, safeDetail:result.safeDetail, layer:'web_session_api' },
  };
}
async function codexContinueSessionPreflight() {
  const result = await codexCreateSessionPreflight();
  if (result.ok) return result;
  return {
    ok:false as const,
    statusCode:result.statusCode,
    body:{
      ...result.body,
      code: result.body.code === 'codex_no_active_profile' ? 'codex_no_executing_profile' : result.body.code,
      message: result.body.message || '当前 Codex 账户无法继续会话',
      safeDetail: `canContinueSession=false: ${result.body.safeDetail || result.body.code}`,
    },
  };
}
function codexSessionProfileFields(creatorProfileId:any, executingProfileId:any, upstreamBindingProfileId:any) {
  return {
    creator_profile_id: creatorProfileId || null,
    selected_profile_id: executingProfileId || null,
    executing_profile_id: executingProfileId || null,
    upstream_binding_profile_id: upstreamBindingProfileId || null,
    last_execution_account_id: executingProfileId || null,
    current_upstream_account_id: upstreamBindingProfileId || null,
  };
}
function codexAccountSnapshot(profile:any) {
  if (!profile) return null;
  return {
    provider:'codex',
    id:String(profile.id || ''),
    email:profile.email || profile.login?.email || null,
    name:profile.name || profile.email || null,
    status:profile.status || profile.state || 'authenticated',
    codexHome:profile.codex_home || null,
  };
}
function codexExecutionContext(profile:any) {
  const accountId = String(profile?.id || '');
  return {
    selectedProfileId:accountId,
    executingProfileId:accountId,
    accountSnapshot:codexAccountSnapshot(profile),
    runtime:{
      appServerUnit:codexAppServerUnitName(accountId),
      endpoint:codexAppServerEndpoint(accountId),
      codexHome:String(profile?.codex_home || ''),
    },
  };
}
function codexAppServerEndpoint(profileId:string) {
  return `ws://127.0.0.1:${codexAppServerPort(profileId)}`;
}
function codexAppServerPort(profileId:string) {
  if (profileId === 'default') return Number(process.env.CODEX_APP_SERVER_DEFAULT_PORT || 4668);
  const hash = crypto.createHash('sha256').update(profileId).digest();
  return Number(process.env.CODEX_APP_SERVER_PORT_BASE || 4520) + (hash.readUInt16BE(0) % 200);
}
function codexAppServerUnitName(profileId:string) {
  const safe = String(profileId || 'default').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64) || 'default';
  return profileId === 'default' ? 'agentdeck-app-server@default.service' : `agentdeck-app-server-${safe}.service`;
}
function structuredSessionCreateError(provider:AgentProviderId, e:any, layer:string) {
  const statusCode = e?.statusCode === 503 ? 503 : e?.statusCode === 409 ? 409 : 502;
  const raw = e?.body || {};
  const safeDetail = redactLine(String(raw.safeDetail || raw.detail || raw.message || raw.error || e?.message || `${provider} session create failed`)).slice(0, 1000);
  return {
    statusCode,
    body:{
      code:raw.code || `${provider}_session_create_failed`,
      message:raw.message || `${providerDisplayName(provider)} 会话初始化失败`,
      safeDetail,
      layer:raw.layer || layer,
      requestId:raw.requestId || undefined,
    },
  };
}
async function listProfiles() {
  const rows = await db.all(`SELECT ${CODEX_PROFILE_COLUMNS} FROM codex_profiles WHERE COALESCE(status,'authenticated')='authenticated' ORDER BY active DESC, updated_at DESC`);
  return Promise.all(rows.map((p:any)=>codexProfileDto(p)));
}
async function listPendingProfiles() {
  const attempts = await listProviderLoginAttempts('codex');
  const rows = await db.all(`SELECT ${CODEX_PROFILE_COLUMNS} FROM codex_profiles WHERE COALESCE(status,'authenticated') IN ('draft','authenticating','verifying','failed') ORDER BY updated_at DESC`);
  const legacy = rows.map((p:any) => ({ ...p, provider:'codex', name:profileDisplayName(p.name), state:String(p.status || 'draft'), active:false, isLoginAttempt:false, login:{ ok:false, text:'Not logged in' } }));
  return [...attempts, ...legacy.filter((row:any) => !attempts.some((attempt:any) => attempt.id === row.id))];
}
async function getProfile(id:string) { return db.get(`SELECT ${CODEX_PROFILE_COLUMNS} FROM codex_profiles WHERE id=?1`, [id]); }
async function getProfileDto(id:string) {
  const profile = await getProfile(id);
  return profile ? codexProfileDto(profile) : null;
}
async function getActiveProfile() {
  const p = await db.get(`SELECT ${CODEX_PROFILE_COLUMNS} FROM codex_profiles WHERE active=1 AND COALESCE(status,'authenticated')='authenticated' ORDER BY updated_at DESC LIMIT 1`);
  if (!p) return null;
  return codexProfileDto(p);
}
async function codexProfileDto(p:any) {
  const login = await profileLoginStatus(String(p.codex_home));
  const email = String(p.email || login.email || '').trim() || undefined;
  const displayName = String(p.display_name || login.displayName || '').trim() || undefined;
  return {
    ...p,
    provider:'codex',
    name:email || displayName || codexMetadataLabel(p),
    email,
    displayName,
    metadataStatus:String(p.metadata_status || 'pending'),
    metadataError:p.metadata_error || undefined,
    state:'authenticated',
    active:Number(p.active || 0),
    login:{ ...login, email, displayName },
  };
}
async function activateProfile(id:string) {
  const profile:any = await getProfile(id);
  if (!profile) throw new Error('profile not found');
  if (String(profile.status || 'authenticated') !== 'authenticated') throw new Error(`Codex profile is not authenticated: ${profile.status || 'unknown'}`);
  await activateProfileCandidate(profile);
}
async function activateProfileCandidate(candidate:any) {
  const previous:any = await db.get(`SELECT ${CODEX_PROFILE_COLUMNS} FROM codex_profiles WHERE active=1 AND COALESCE(status,'authenticated')='authenticated' ORDER BY updated_at DESC LIMIT 1`);
  const now = Date.now();
  await activateCodexProfileAtomically({
    target:candidate as CodexProfileState,
    previous:previous as CodexProfileState | null,
    verifyCredentials:async target => (await profileLoginStatus(String(target.codex_home))).ok,
    activateRuntime:activateCodexRuntimeProfile,
    restoreRuntime:activateCodexRuntimeProfile,
    commit:async () => {
      db.transactionRun([
        { sql:'UPDATE codex_profiles SET active=0' },
        {
          sql:`INSERT INTO codex_profiles (id,name,codex_home,active,status,email,display_name,metadata_status,metadata_error,metadata_updated_at,created_at,updated_at)
               VALUES (?1,?2,?3,1,'authenticated',?4,?5,?6,?7,?8,?9,?10)
               ON CONFLICT(id) DO UPDATE SET name=excluded.name,codex_home=excluded.codex_home,active=1,status='authenticated',
                 email=COALESCE(excluded.email,codex_profiles.email),display_name=COALESCE(excluded.display_name,codex_profiles.display_name),
                 metadata_status=excluded.metadata_status,metadata_error=excluded.metadata_error,metadata_updated_at=excluded.metadata_updated_at,updated_at=excluded.updated_at`,
          params:[
            String(candidate.id),
            String(candidate.name || 'Codex Account'),
            String(candidate.codex_home),
            candidate.email || null,
            candidate.display_name || null,
            String(candidate.metadata_status || 'pending'),
            candidate.metadata_error || null,
            Number(candidate.metadata_updated_at || now),
            Number(candidate.created_at || now),
            now,
          ],
        },
      ]);
    },
  });
  invalidateUnifiedProviderStatuses();
}
async function activateCodexRuntimeProfile(profile:CodexProfileState) {
  const codexHome = String(profile.codex_home);
  if (USE_AGENT_RUNTIME) {
    await syncDefaultCodexAppServerEnv(codexHome);
    const activated:any = await runtime.restartDefaultCodexAccount({ codexHome });
    if (activated?.read?.error) throw new Error(String(activated.read.error));
    if (String(activated?.account?.codex_home || '') !== codexHome) throw new Error('runtime activated an unexpected CODEX_HOME');
    return;
  }
  await codex.switchCodexHome(codexHome);
}
async function ensureCodexActiveProfile() {
  const active = await db.get("SELECT id FROM codex_profiles WHERE active=1 AND COALESCE(status,'authenticated')='authenticated' LIMIT 1");
  if (active?.id) {
    await db.run("UPDATE codex_profiles SET active=0 WHERE active=1 AND id<>?1", [String(active.id)]).catch(()=>{});
    return;
  }
  await db.run('UPDATE codex_profiles SET active=0').catch(()=>{});
  const next = await db.get("SELECT id FROM codex_profiles WHERE COALESCE(status,'authenticated')='authenticated' ORDER BY updated_at DESC LIMIT 1");
  if (next?.id) await activateProfile(String(next.id)).catch(()=>{});
}
async function cancelCodexLoginForProfile(profileId:string) {
  for (const [jobId, job] of loginJobs.entries()) {
    if (job.profileId !== profileId || job.status !== 'running') continue;
    const child = loginChildren.get(jobId);
    if (child) {
      try { child.kill(); } catch {}
      loginChildren.delete(jobId);
    }
    job.status = 'error';
    job.error = '登录已取消';
    updateProviderLoginAttempt(profileId, { status:'cancelled', error:'登录已取消' }).catch(()=>{});
  }
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
  const rows = await db.all("SELECT id,name,home_dir,auth_type,active,status,default_model_mode,default_model,created_at,updated_at FROM gemini_profiles WHERE COALESCE(status,'draft')='authenticated' ORDER BY active DESC, updated_at DESC");
  return Promise.all(rows.map((p:any) => geminiProfileDto(p)));
}
async function listGeminiPendingProfiles() {
  const attempts = await listProviderLoginAttempts('gemini');
  const rows = await db.all("SELECT id,name,home_dir,auth_type,active,status,default_model_mode,default_model,created_at,updated_at FROM gemini_profiles WHERE COALESCE(status,'draft') IN ('bootstrap','draft','authenticating','verifying','failed','needs_login','configured') ORDER BY updated_at DESC");
  const legacy = await Promise.all(rows.map((p:any) => geminiProfileDto(p)));
  return [...attempts, ...legacy.filter((row:any) => !attempts.some((attempt:any) => attempt.id === row.id))];
}
async function getGeminiProfile(id:string) {
  return db.get('SELECT id,name,home_dir,auth_type,active,status,default_model_mode,default_model,created_at,updated_at FROM gemini_profiles WHERE id=?1', [id]);
}
async function getGeminiProfileDto(id:string, options:{ includeHidden?:boolean } = {}) {
  const row = await getGeminiProfile(id);
  if (!row) return null;
  const state = geminiProfileState(row);
  if (!options.includeHidden && (state === 'draft' || state === 'disabled')) return null;
  return geminiProfileDto(row);
}
async function getActiveGeminiProfile() {
  const row = await db.get("SELECT id,name,home_dir,auth_type,active,status,default_model_mode,default_model,created_at,updated_at FROM gemini_profiles WHERE active=1 AND COALESCE(status,'configured')='authenticated' ORDER BY updated_at DESC LIMIT 1");
  return row ? geminiProfileDto(row) : null;
}
async function activateGeminiProfile(id:string) {
  await db.run('UPDATE gemini_profiles SET active=0');
  await db.run('UPDATE gemini_profiles SET active=1, updated_at=?1 WHERE id=?2', [Date.now(), id]);
  invalidateUnifiedProviderStatuses();
}
async function geminiProfileDto(row:any) {
  const login = await geminiLoginStatus(String(row.home_dir), String(row.auth_type || '') || null);
  const apiKey = row.auth_type === 'api_key';
  const fallbackName = apiKey ? 'Gemini API Key' : 'Gemini Google Account';
  const name = login.email || (String(row.name || '').trim() && row.name !== 'Gemini Account' ? row.name : fallbackName);
  const state = geminiProfileState(row, login);
  const safeLogin = { ...login, ok: state === 'authenticated', text: state === 'authenticated' ? 'Logged in' : (login.credentialsPresent ? 'Credentials present, ACP login not verified' : 'Not logged in') };
  return {
    id:String(row.id),
    provider:'gemini',
    name,
    email:login.email || undefined,
    active: state === 'authenticated' ? Number(row.active || 0) : 0,
    status: state,
    state,
    authType: row.auth_type || login.authType || null,
    defaultModelMode: row.default_model_mode === 'manual' && cleanAgentModel(row.default_model) ? 'manual' : 'auto',
    defaultModel: row.default_model_mode === 'manual' ? cleanAgentModel(row.default_model) : '',
    error: geminiLoginProfiles.get(String(row.id)) ? geminiLoginJobs.get(String(geminiLoginProfiles.get(String(row.id))))?.error : undefined,
    loginJobId: geminiLoginProfiles.get(String(row.id)) || undefined,
    login: safeLogin,
    created_at:Number(row.created_at || 0),
    updated_at:Number(row.updated_at || 0),
  };
}
function geminiAccountSnapshot(profile:any) {
  if (!profile) return null;
  return {
    id:String(profile.id),
    provider:'gemini',
    name:String(profile.name || profile.email || 'Gemini Account').slice(0, 200),
    email:profile.email || profile.login?.email || findEmailInText(String(profile.name || '')) || undefined,
    authType:profile.authType || profile.auth_type || profile.login?.authType || null,
    timestamp:Date.now(),
  };
}
function geminiProfileState(row:any, login?:any):'draft'|'authenticating'|'verifying'|'authenticated'|'needs_login'|'failed'|'disabled' {
  const explicit = String(row?.status || '').trim();
  if (explicit === 'disabled') return 'disabled';
  if (explicit === 'failed') return 'failed';
  if (explicit === 'needs_login') return 'needs_login';
  if (explicit === 'verifying') return 'verifying';
  if (explicit === 'authenticating') return 'authenticating';
  if (explicit === 'authenticated') return 'authenticated';
  return 'draft';
}
async function getReusableGeminiBootstrapProfile() {
  const visible = await db.get("SELECT id FROM gemini_profiles WHERE COALESCE(status,'draft')='authenticated' LIMIT 1");
  if (visible?.id) return null;
  return db.get("SELECT id,name,home_dir,auth_type,active,status,default_model_mode,default_model,created_at,updated_at FROM gemini_profiles WHERE COALESCE(status,'draft') IN ('bootstrap','draft','failed') ORDER BY CASE WHEN id='default' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1");
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
async function markGeminiProfileNeedsLogin(id:string, reason:string) {
  await db.run("UPDATE gemini_profiles SET status='needs_login', active=0, updated_at=?1 WHERE id=?2", [Date.now(), id]).catch(()=>{});
  await ensureGeminiActiveProfile().catch(()=>{});
  invalidateUnifiedProviderStatuses();
  app.log.warn({ provider:'gemini', profileId:id, reason:safeGeminiError(reason) }, 'gemini profile marked needs_login after ACP authentication error');
}

type GeminiCredentialState = { exists:boolean; size:number; mtimeMs:number; path:string; stable?:boolean };
async function geminiCredentialState(profile:any): Promise<GeminiCredentialState> {
  const homeDir = String(profile.home_dir || '');
  const authType = String(profile.auth_type || '');
  const file = authType === 'api_key' ? path.join(homeDir, 'agentdeck.env') : path.join(homeDir, '.gemini', 'oauth_creds.json');
  const st = await stat(file).catch(()=>null);
  return { exists:!!st, size:st?.size || 0, mtimeMs:st ? Math.floor(st.mtimeMs) : 0, path:file };
}

async function waitForStableGeminiCredentials(profile:any, options:{ submittedAt?:number; timeoutMs?:number } = {}) {
  const started = Date.now();
  const timeoutMs = Math.min(options.timeoutMs || GEMINI_LOGIN_VERIFY_TIMEOUT_MS, GEMINI_LOGIN_VERIFY_TIMEOUT_MS);
  let previous:GeminiCredentialState|null = null;
  for (;;) {
    const current = await geminiCredentialState(profile);
    const updatedAfterSubmit = !options.submittedAt || current.mtimeMs >= options.submittedAt;
    const stable = !!previous && current.exists && current.size > 0 && updatedAfterSubmit && previous.size === current.size && previous.mtimeMs === current.mtimeMs;
    if (stable) return { ...current, stable:true, elapsedMs:Date.now() - started };
    if (Date.now() - started >= timeoutMs) return { ...current, stable:false, elapsedMs:Date.now() - started };
    previous = current;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function reconcileGeminiProfileAuthentication(profileId:string, options:{ reason?:string; job?:GeminiLoginJob; submittedAt?:number; requireFreshCredential?:boolean } = {}) {
  const profile:any = await getGeminiProfile(profileId);
  if (!profile) throw new Error('profile not found');
  const started = Date.now();
  const timings:Record<string, number> = {};
  const logBase = { provider:'gemini', profileId, loginJobId:options.job?.id || null, reason:options.reason || 'reconcile' };
  const step = async <T>(name:string, fn:()=>Promise<T>): Promise<T> => {
    const stepStarted = Date.now();
    try { return await fn(); }
    finally { timings[name] = Date.now() - stepStarted; }
  };
  app.log.info({ ...logBase, codeSubmittedAt:options.submittedAt || null, ptyAlive:options.job ? !!geminiLoginWorkers.get(options.job.id) : false }, 'gemini authentication reconcile started');
  setGeminiJobStatus(options.job || { id:`reconcile-${profileId}`, profileId, methodId:String(profile.auth_type || GEMINI_GOOGLE_AUTH_TYPE), status:'verifying', startedAt:Date.now() } as GeminiLoginJob, 'verifying');
  const credential = await step('waitCredentialsStable', () => waitForStableGeminiCredentials(profile, { submittedAt:options.requireFreshCredential ? options.submittedAt : undefined, timeoutMs:GEMINI_LOGIN_VERIFY_TIMEOUT_MS }));
  app.log.info({ ...logBase, credential:{ exists:credential.exists, size:credential.size, mtimeMs:credential.mtimeMs, stable:credential.stable }, elapsedMs:credential.elapsedMs }, 'gemini credential file checked');
  if (!credential.exists || credential.size <= 0 || !credential.stable) {
    const reason = !credential.exists ? 'Gemini 凭据文件未落盘' : !credential.stable ? 'Gemini 凭据文件未稳定' : 'Gemini 凭据文件为空';
    await db.run("UPDATE gemini_profiles SET status='failed', active=0, updated_at=?1 WHERE id=?2", [Date.now(), profileId]);
    if (options.job) {
      setGeminiJobStatus(options.job, 'failed', reason);
      options.job.codeSubmitted = false;
    }
    app.log.warn({ ...logBase, credential:{ exists:credential.exists, size:credential.size, mtimeMs:credential.mtimeMs, stable:credential.stable }, reason, timings, totalMs:Date.now() - started }, 'gemini authentication reconcile failed before initialize');
    return { ok:false, status:'failed', reason, credential, timings, runtimeStatus:null };
  }

  await step('settleAfterCredentials', () => new Promise(resolve => setTimeout(resolve, 700)));
  const delays = [1000, 2000, 4000];
  let lastStatus:any = null;
  let lastReason = '';
  let initializedRuntimeStatus:any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const runtimeStatus = await step(`forceInitialize${attempt}`, () => runtime.forceInitializeGeminiProfile(profileId));
      lastStatus = runtimeStatus;
      const authMethodCount = Array.isArray(runtimeStatus?.authMethods) ? runtimeStatus.authMethods.length : 0;
      app.log.info({
        ...logBase,
        attempt,
        oldInstance:!!runtimeStatus?.oldInstance,
        disposeCompleted:!!runtimeStatus?.disposeCompleted,
        oldChildPid:runtimeStatus?.oldChildPid || null,
        newChildPid:runtimeStatus?.newChildPid || runtimeStatus?.childPid || null,
        initialized:!!runtimeStatus?.initialized,
        authMethodCount,
        elapsedMs:runtimeStatus?.elapsedMs,
      }, 'gemini fresh initialize completed');
      if (runtimeStatus?.initialized) {
        initializedRuntimeStatus = runtimeStatus;
        break;
      }
      lastReason = 'Gemini ACP 初始化未完成';
    } catch (e:any) {
      lastReason = safeGeminiError(e);
      app.log.warn({ ...logBase, attempt, error:lastReason }, 'gemini fresh initialize attempt failed');
    }
    if (attempt < 3) {
      await runtime.disposeGeminiProfile(profileId).catch(()=>null);
      await new Promise(resolve => setTimeout(resolve, delays[attempt - 1]));
    }
    if (Date.now() - started > GEMINI_LOGIN_VERIFY_TIMEOUT_MS) {
      lastReason = '登录验证超时';
      break;
    }
  }
  const login = await geminiLoginStatus(String(profile.home_dir), String(profile.auth_type || '') || null);
  await db.run("UPDATE gemini_profiles SET name=COALESCE(?1,name), auth_type=COALESCE(?2,auth_type), status='authenticated', updated_at=?3 WHERE id=?4", [login.email || null, login.authType || profile.auth_type || null, Date.now(), profileId]);
  const active = await db.get("SELECT id FROM gemini_profiles WHERE active=1 AND COALESCE(status,'configured')='authenticated' LIMIT 1");
  if (!active?.id) await activateGeminiProfile(profileId).catch(()=>{});
  if (options.job) {
    options.job.status = 'done';
    options.job.error = undefined;
    clearGeminiLoginJobChallenge(options.job);
    options.job.codeSubmitted = false;
    geminiLoginProfiles.delete(profileId);
  }
  const reason = initializedRuntimeStatus ? 'credentials_stable_initialize_completed' : 'credentials_stable_initialize_unavailable';
  app.log.info({ ...logBase, from:'verifying', to:'authenticated', reason, initializeWarning:lastReason || null, authMethodCount:Array.isArray(lastStatus?.authMethods) ? lastStatus.authMethods.length : null, timings, totalMs:Date.now() - started }, 'gemini authentication reconcile succeeded');
  return { ok:true, status:'authenticated', reason, credential, timings, runtimeStatus:initializedRuntimeStatus || lastStatus };
}

async function geminiLoginStatus(homeDir:string, authType:string|null = null) {
  const secretFile = path.join(homeDir, 'agentdeck.env');
  const hasApiKey = await geminiSecretEnvHas(secretFile, 'GEMINI_API_KEY').catch(()=>false);
  const email = await scanGeminiEmail(homeDir).catch(()=>null);
  const hasOAuthCredentials = existsSync(path.join(homeDir, '.gemini', 'oauth_creds.json'));
  const detectedAuthType = authType || (hasApiKey ? 'api_key' : (hasOAuthCredentials ? GEMINI_GOOGLE_AUTH_TYPE : null));
  const credentialsPresent = hasApiKey || hasOAuthCredentials;
  return { ok: credentialsPresent, credentialsPresent, email, text: credentialsPresent ? 'Credentials present' : 'Not logged in', authType: detectedAuthType };
}
async function geminiSecretEnvHas(file:string, key:string) {
  if (!existsSync(file)) return false;
  const text = await readFile(file, 'utf8');
  return text.split(/\r?\n/).some(line => line.trimStart().startsWith(`${key}=`) && line.split('=').slice(1).join('=').trim().length > 0);
}
async function scanGeminiEmail(homeDir:string) {
  const candidates = [
    path.join(homeDir, '.gemini', 'google_accounts.json'),
    path.join(homeDir, '.gemini', 'account.json'),
    path.join(homeDir, '.gemini', 'userinfo.json'),
    path.join(homeDir, '.gemini', 'settings.json'),
    path.join(homeDir, '.config', 'gemini', 'google_accounts.json'),
  ];
  for (const file of candidates) {
    const st = await stat(file).catch(()=>null);
    if (!st || st.size > 128 * 1024) continue;
    const text = await readFile(file, 'utf8').catch(()=>'');
    const found = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0];
    if (found) return found.slice(0, 120);
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
  return providerSessionReferenceCount('gemini', profileId);
}
async function providerSessionReferenceCount(providerId:string, profileId:string) {
  const web = await db.get("SELECT COUNT(*) count FROM sessions WHERE provider_id=?1 AND account_id=?2", [providerId, profileId]).catch(()=>({ count:0 }));
  const runtime = await runtimeDb.get("SELECT COUNT(*) count FROM sessions WHERE (provider_id=?1 OR provider=?1) AND account_id=?2", [providerId, profileId]).catch(()=>({ count:0 }));
  return Number(web?.count || 0) + Number(runtime?.count || 0);
}
async function runGeminiLoginJob(job:GeminiLoginJob, body:any) {
  const profile:any = await getGeminiProfile(job.profileId);
  if (!profile) throw new Error('profile not found');
  if (job.status === 'cancelled') return;
  const method = job.methodId.toLowerCase();
  if (method === 'api_key' || method === 'apikey' || method.includes('api')) {
    setGeminiJobStatus(job, 'verifying');
    const apiKey = String(body.apiKey || '').trim();
    if (!/^[A-Za-z0-9_.-]{20,}$/.test(apiKey)) throw new Error('Gemini API Key 格式不正确');
    await writeGeminiProfileSecret(String(profile.home_dir), { GEMINI_API_KEY: apiKey });
    await db.run("UPDATE gemini_profiles SET auth_type='api_key', status='authenticated', updated_at=?1 WHERE id=?2", [Date.now(), job.profileId]);
    const active = await db.get("SELECT id FROM gemini_profiles WHERE active=1 AND COALESCE(status,'configured')='authenticated' LIMIT 1");
    if (!active?.id) await activateGeminiProfile(job.profileId).catch(()=>{});
    job.status = 'done';
    job.error = undefined;
    clearGeminiLoginJobChallenge(job);
    job.codeSubmitted = false;
    geminiLoginProfiles.delete(job.profileId);
    return;
  }
  if (method.includes('oauth') || method.includes('google')) {
    setGeminiJobStatus(job, 'preparing');
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
  const result = await reconcileGeminiProfileAuthentication(job.profileId, { reason:'acp_authenticate', job });
  if (!result.ok) throw new Error(result.reason || 'Gemini 登录未完成，请重新检测或改用 API Key/Vertex');
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
    app.log.info({ provider:'gemini', jobId:job.id, profileId:job.profileId, env:geminiSafeEnvSummary(homeDir), cwd:homeDir }, 'gemini login pty started');
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
      setGeminiJobStatus(job, 'failed', '登录验证超时');
      job.codeSubmitted = false;
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
      setGeminiJobStatus(job, 'failed', parsed.failure || 'Gemini Google 登录失败');
      job.codeSubmitted = false;
    }
    if (parsed.success && job.status !== 'done' && job.status !== 'cancelled') {
      verifyGeminiGoogleLoginJob(job, homeDir, child).catch((e:any) => {
        if (job.status === 'done' || job.status === 'cancelled') return;
        setGeminiJobStatus(job, 'failed', safeGeminiError(e));
        job.codeSubmitted = false;
      });
    }
  };
  child.onData((d:string)=>handleOutput(d));
  child.onExit(async ({ exitCode }:any) => {
    await finalize(async () => {
      if (job.status === 'cancelled' || job.status === 'done') return;
      try {
        const login = await geminiLoginStatus(homeDir, GEMINI_GOOGLE_AUTH_TYPE).catch(()=>({ ok:false }));
        if (exitCode === 0 && login.ok) {
          await finishGeminiGoogleLoginJob(job, homeDir);
        } else {
          setGeminiJobStatus(job, 'failed', exitCode === 0 ? 'Gemini 登录进程已退出，但未检测到有效 Google 登录。' : `Gemini 登录进程退出，code=${exitCode}`);
          job.codeSubmitted = false;
        }
      } catch (e:any) {
        setGeminiJobStatus(job, 'failed', safeGeminiError(e));
        job.codeSubmitted = false;
      }
    });
  });
  await complete;
}
async function finishGeminiGoogleLoginJob(job:GeminiLoginJob, homeDir:string) {
  await db.run("UPDATE gemini_profiles SET auth_type=?1, status='verifying', updated_at=?2 WHERE id=?3", [GEMINI_GOOGLE_AUTH_TYPE, Date.now(), job.profileId]);
  const result = await reconcileGeminiProfileAuthentication(job.profileId, { reason:'google_login_finish', job, submittedAt:job.codeSubmittedAt, requireFreshCredential:!!job.codeSubmittedAt });
  if (!result.ok) throw new Error(result.reason || 'Gemini 登录验证失败');
}
async function verifyGeminiGoogleLoginJob(job:GeminiLoginJob, homeDir:string, child:any) {
  const started = Date.now();
  let lastCredentialOk = false;
  let lastInitializeOk = false;
  while (Date.now() - started < GEMINI_LOGIN_VERIFY_TIMEOUT_MS) {
    if (job.status === 'cancelled' || job.status === 'done') return;
    if (job.status === 'failed' || job.status === 'error') return;
    const credential = await geminiCredentialState({ home_dir:homeDir, auth_type:GEMINI_GOOGLE_AUTH_TYPE }).catch(()=>({ exists:false, size:0, mtimeMs:0 }));
    lastCredentialOk = !!credential.exists && credential.size > 0 && (!job.codeSubmittedAt || credential.mtimeMs >= job.codeSubmittedAt);
    if (lastCredentialOk) {
      try {
        const result = await reconcileGeminiProfileAuthentication(job.profileId, { reason:'google_code_submitted', job, submittedAt:job.codeSubmittedAt, requireFreshCredential:!!job.codeSubmittedAt });
        lastInitializeOk = !!result.ok;
        if (!result.ok) throw new Error(result.reason || 'Gemini 登录验证失败');
        try { child?.kill(); } catch {}
        geminiLoginWorkers.delete(job.id);
        app.log.info({ jobId:job.id, profileId:job.profileId, state:job.status, ptyAlive:!!geminiLoginWorkers.get(job.id), credentialsOk:lastCredentialOk, initializeOk:lastInitializeOk, elapsedMs:Date.now() - started }, 'gemini login verification completed');
        return;
      } catch (e:any) {
        lastInitializeOk = !String(e?.message || e).includes('initialize');
        job.error = safeGeminiError(e);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  if (job.status !== 'done' && job.status !== 'cancelled') {
    setGeminiJobStatus(job, 'failed', '登录验证超时');
    job.codeSubmitted = false;
    app.log.warn({ jobId:job.id, profileId:job.profileId, state:job.status, ptyAlive:!!geminiLoginWorkers.get(job.id), credentialsOk:lastCredentialOk, initializeOk:lastInitializeOk, elapsedMs:Date.now() - started }, 'gemini login verification timed out');
  }
}
function setGeminiJobStatus(job:GeminiLoginJob, status:GeminiLoginJob['status'], error?:string) {
  const previous = job.status;
  job.status = status;
  if (error) job.error = error;
  const attemptStatus = geminiJobStatusToAttemptStatus(status);
  if (attemptStatus) updateProviderLoginAttempt(job.profileId, { status:attemptStatus, error:error || (status === 'failed' || status === 'error' ? job.error || 'Gemini 登录失败' : null), methodId:job.methodId }).catch(()=>{});
  const profileStatus = status === 'done' ? 'authenticated' : status === 'verifying' ? 'verifying' : status === 'failed' || status === 'error' || status === 'fallback' ? 'failed' : status === 'cancelled' ? 'failed' : status === 'waiting_user' || status === 'preparing' ? 'authenticating' : null;
  if (profileStatus) db.run("UPDATE gemini_profiles SET status=?1, active=CASE WHEN ?1='authenticated' THEN active ELSE 0 END, updated_at=?2 WHERE id=?3", [profileStatus, Date.now(), job.profileId]).catch(()=>{});
  if (profileStatus) invalidateUnifiedProviderStatuses();
  if (previous !== status) app.log.info({ jobId:job.id, profileId:job.profileId, from:previous, to:status, ptyAlive:!!geminiLoginWorkers.get(job.id), elapsedMs:Date.now() - job.startedAt }, 'gemini login job state changed');
}
function geminiJobStatusToAttemptStatus(status:GeminiLoginJob['status']): ProviderLoginAttemptStatus | null {
  if (status === 'preparing') return 'starting';
  if (status === 'waiting_user' || status === 'fallback') return 'waiting_authorization';
  if (status === 'verifying') return 'verifying';
  if (status === 'done') return 'done';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed' || status === 'error') return 'failed';
  return null;
}
function clearGeminiLoginJobChallenge(job:GeminiLoginJob) {
  job.loginUrl = undefined;
  job.deviceCode = undefined;
  job.requiresCodeInput = false;
  job.fallbackCommand = undefined;
}
async function cancelGeminiLoginForProfile(profileId:string) {
  const jobId = geminiLoginProfiles.get(profileId);
  if (!jobId) return;
  const job = geminiLoginJobs.get(jobId);
  const child = geminiLoginWorkers.get(jobId);
  if (child) {
    try { child.kill(); } catch {}
    geminiLoginWorkers.delete(jobId);
  }
  if (job && job.status !== 'done') setGeminiJobStatus(job, 'cancelled', '登录已取消');
  geminiLoginProfiles.delete(profileId);
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
function geminiSafeEnvSummary(homeDir:string) {
  return {
    HOME:homeDir,
    GEMINI_CONFIG_DIR:geminiConfigDir(homeDir),
    XDG_CONFIG_HOME:path.join(homeDir, '.config'),
    workingDirectory:homeDir,
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
function isGeminiAuthenticationErrorMessage(message:string) {
  return /\b(unauthenticated|unauthorized|authentication required|not authenticated|not logged in|login required|requires login|invalid credentials|invalid_grant|api key.*invalid|permission denied)\b/i.test(String(message || ''));
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
  const rows = await db.all("SELECT id,name,home_dir,active,status,created_at,updated_at FROM antigravity_profiles WHERE COALESCE(status,'authenticated')='authenticated' ORDER BY active DESC, updated_at DESC");
  const profiles = await Promise.all(rows.map(async (p:any)=>{
    const login = await antigravityLoginStatus(String(p.home_dir));
    const name = login.email || (String(p.name || '').trim() && p.name !== 'Google Account' ? p.name : 'Antigravity Account');
    return { ...p, provider:'antigravity', name, email:login.email || undefined, state:'authenticated', active:Number(p.active || 0), login };
  }));
  return profiles.filter(Boolean);
}
async function getActiveAntigravityProfile() {
  await syncAntigravityProfilesFromDisk().catch(()=>{});
  const p = await db.get("SELECT id,name,home_dir,active,status,created_at,updated_at FROM antigravity_profiles WHERE active=1 AND COALESCE(status,'authenticated')='authenticated' ORDER BY updated_at DESC LIMIT 1");
  if (!p) return null;
  const login = await antigravityLoginStatus(String(p.home_dir));
  const name = login.email || (String(p.name || '').trim() && p.name !== 'Google Account' ? p.name : 'Antigravity Account');
  return { ...p, provider:'antigravity', name, email:login.email || undefined, state:'authenticated', active:Number(p.active || 0), login };
}
async function getAntigravityProfile(id:string) { return db.get('SELECT id,name,home_dir,active,status,created_at,updated_at FROM antigravity_profiles WHERE id=?1', [id]); }
async function activateAntigravityProfile(id:string) {
  await db.run('UPDATE antigravity_profiles SET active=0');
  await db.run("UPDATE antigravity_profiles SET active=1, updated_at=?1 WHERE id=?2 AND COALESCE(status,'authenticated')='authenticated'", [Date.now(), id]);
  invalidateUnifiedProviderStatuses();
}
async function ensureAntigravityActiveProfile() {
  const active = await db.get("SELECT id FROM antigravity_profiles WHERE active=1 AND COALESCE(status,'authenticated')='authenticated' LIMIT 1");
  if (active?.id) {
    await db.run("UPDATE antigravity_profiles SET active=0 WHERE active=1 AND id<>?1", [String(active.id)]).catch(()=>{});
    return;
  }
  await db.run('UPDATE antigravity_profiles SET active=0').catch(()=>{});
  const next = await db.get("SELECT id FROM antigravity_profiles WHERE COALESCE(status,'authenticated')='authenticated' ORDER BY updated_at DESC LIMIT 1");
  if (next?.id) await activateAntigravityProfile(String(next.id)).catch(()=>{});
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
    await db.run("INSERT INTO antigravity_profiles (id,name,home_dir,active,status,created_at,updated_at) VALUES (?1,?2,?3,?4,'authenticated',?5,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name, home_dir=excluded.home_dir, updated_at=excluded.updated_at, active=CASE WHEN antigravity_profiles.status='disabled' THEN 0 ELSE antigravity_profiles.active END", [entry.name, name, homeDir, active, Date.now()]);
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
  await db.run("INSERT INTO antigravity_profiles (id,name,home_dir,active,status,created_at,updated_at) VALUES (?1,?2,?3,0,'authenticated',?4,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name, home_dir=excluded.home_dir, status='authenticated', updated_at=excluded.updated_at", [job.profileId, name, homeDir, now]);
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
async function cancelAntigravityLoginForProfile(profileId:string) {
  for (const [jobId, job] of antigravityLoginJobs.entries()) {
    if (job.profileId !== profileId || job.status !== 'running') continue;
    const child = antigravityLoginChildren.get(jobId);
    if (child) {
      try { child.kill(); } catch {}
      antigravityLoginChildren.delete(jobId);
    }
    job.status = 'error';
    job.error = '登录已取消';
  }
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
async function ensureAntigravityBinary() {
  await resolveAntigravityBinary();
}
async function resolveAntigravityBinary() {
  const found = await detectManagedCommand(process.env.ANTIGRAVITY_BIN || '', 'agy');
  if (!found) throw structuredProviderError('provider_binary_not_found', 'antigravity_runtime', 'Antigravity binary was not found', `ANTIGRAVITY_BIN=${process.env.ANTIGRAVITY_BIN || 'agy'}`);
  try {
    if (found.includes('/')) await stat(found);
  } catch {
    throw structuredProviderError('provider_binary_not_found', 'antigravity_runtime', 'Antigravity binary was not found', `ANTIGRAVITY_BIN=${found}`);
  }
  return found;
}
function structuredProviderError(code:string, layer:string, message:string, safeDetail:string) {
  const err:any = new Error(message);
  err.code = code;
  err.layer = layer;
  err.safeDetail = safeDetail;
  return err;
}
async function antigravityProfileName(homeDir:string) {
  return await scanEmail(path.join(homeDir, '.gemini')).catch(()=>null) || 'Antigravity Account';
}
function antigravityUsage(homeDir:string): Promise<string|null> {
  const cached=antigravityUsageCache.get(homeDir);if(cached&&cached.expiresAt>Date.now()){if(cached.promise)return cached.promise;return Promise.resolve(cached.value);}
  const promise=readAntigravityUsage(homeDir).then(value=>{antigravityUsageCache.set(homeDir,{value,expiresAt:Date.now()+(value?5*60_000:60_000)});return value;}).catch(error=>{antigravityUsageCache.delete(homeDir);throw error;});
  antigravityUsageCache.set(homeDir,{value:null,promise,expiresAt:Date.now()+15_000});return promise;
}
function readAntigravityUsage(homeDir:string): Promise<string|null> {
  return new Promise((resolve) => {
    let output = '';
    let sent = false;
    let done = false;
    let child:any = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child?.kill(); } catch {}
      const text = cleanAgentOutput(output).split(/\r?\n/).map(s=>s.trim()).filter(Boolean).filter(s=>!isTerminalControlNoise(s)).slice(-80).join('\n');
      resolve(isUsefulAntigravityUsage(text) ? text : null);
    };
    const timer = setTimeout(finish, 8000);
    resolveAntigravityBinary().then(antigravityBin => {
      child = pty.spawn(antigravityBin, [], {
        name: 'xterm-256color',
        cols: 100,
        rows: 36,
        cwd: homeDir,
        env: { ...process.env, HOME:homeDir, XDG_CONFIG_HOME:path.join(homeDir,'.config'), XDG_CACHE_HOME:path.join(homeDir,'.cache') },
      });
      child.onData((d:string) => {
        output += d;
        if (!sent && /send a message|Type|Welcome|Antigravity/i.test(stripAnsi(output))) {
          sent = true;
          setTimeout(() => child.write('/usage\r'), 500);
        }
      });
      child.onExit(() => finish());
    }).catch(() => finish());
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
  const ok = existsSync(path.join(codexHome, 'auth.json'));
  const metadata = ok ? await resolveCodexProfileMetadata(codexHome) : { status:'failed' as const, email:null, displayName:null, error:'未找到 Codex 登录凭据' };
  return { ok, email:metadata.email, displayName:metadata.displayName, metadataStatus:metadata.status, metadataError:metadata.error || undefined, text:ok ? 'Logged in' : 'Not logged in' };
}
async function resolveCodexProfileMetadata(codexHome:string) {
  try {
    const raw = await readFile(path.join(codexHome, 'auth.json'), 'utf8');
    return resolveCodexProfileMetadataFromAuth(JSON.parse(raw));
  } catch {
    return { email:null, displayName:null, status:'failed' as const, error:'账户信息读取失败：无法解析本地认证凭据' };
  }
}
async function refreshCodexProfileMetadata(id:string, codexHome:string) {
  await db.run("UPDATE codex_profiles SET metadata_status='pending',metadata_error=NULL,updated_at=?1 WHERE id=?2", [Date.now(), id]);
  const metadata = await resolveCodexProfileMetadata(codexHome);
  const now = Date.now();
  if (metadata.status === 'ready') {
    await db.run(
      `UPDATE codex_profiles
          SET email=?1,display_name=?2,name=?1,metadata_status='ready',metadata_error=NULL,metadata_updated_at=?3,
              status=CASE WHEN status='unresolved_identity' THEN 'authenticated' ELSE status END,updated_at=?3
        WHERE id=?4`,
      [metadata.email, metadata.displayName || null, now, id]
    );
  } else {
    await db.run(
      "UPDATE codex_profiles SET metadata_status='failed',metadata_error=?1,metadata_updated_at=?2,updated_at=?2 WHERE id=?3",
      [metadata.error, now, id]
    );
  }
  invalidateUnifiedProviderStatuses();
  return metadata;
}
function codexMetadataLabel(profile:any) {
  const status = String(profile?.metadata_status || profile?.metadataStatus || 'pending');
  if (status === 'failed') return '账户信息读取失败，可重试';
  return '正在读取账户信息';
}
async function readProfileEmail(codexHome:string): Promise<string|null> {
  return (await resolveCodexProfileMetadata(codexHome)).email;
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
function maskSecrets(value:any):any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return maskSecretText(value);
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (typeof value !== 'object') return value;
  const out:any = {};
  for (const [key, raw] of Object.entries(value)) {
    if (isSensitiveKey(key)) out[key] = '[redacted]';
    else if (/email/i.test(key) && typeof raw === 'string') out[key] = maskEmail(raw);
    else out[key] = maskSecrets(raw);
  }
  return out;
}
function isSensitiveKey(key:string) {
  return /token|secret|password|apiKey|api_key|cookie|authorization|deviceCode|device_code|auth code|login URL|loginUrl/i.test(key);
}
function maskEmail(email:string) {
  const value = String(email || '');
  const match = value.match(/^([^@\s]{1,})(@[^@\s]+\.[^@\s]+)$/);
  if (!match) return maskSecretText(value);
  const name = match[1];
  return `${name.slice(0, Math.min(2, name.length))}${name.length > 2 ? '***' : '*'}${match[2]}`;
}
function maskSecretText(text:string) {
  return String(text || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/ig, 'Bearer [redacted]')
    .replace(/([?&](?:code|token|access_token|refresh_token|id_token|client_secret|api_key|apikey)=)[^&\s]+/ig, '$1[redacted]')
    .replace(/\b(authorization|cookie|token|secret|password|apiKey|api_key|access_token|refresh_token|id_token|client_secret|deviceCode|device_code)\s*[:=]\s*[^\s,;]+/ig, '$1=[redacted]')
    .replace(/\b(auth code|authorization code|device code)\s*:?\s*[A-Za-z0-9_./~+=-]{4,}/ig, '$1 [redacted]')
    .replace(/\b(login URL|login url)\s*:?\s*https?:\/\/\S+/ig, '$1 [redacted]')
    .replace(/https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s)]+/ig, '[redacted-login-url]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-api-key]');
}
function redactDiagnosticPaths(value:any):any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactLocalPathText(value);
  if (Array.isArray(value)) return value.map(redactDiagnosticPaths);
  if (typeof value !== 'object') return value;
  const out:any = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/profile.*path|home.*path|token.*path|codexHome|homeDir|profileDir|configDir/i.test(key)) out[key] = '[redacted-path]';
    else out[key] = redactDiagnosticPaths(raw);
  }
  return out;
}
function redactLocalPathText(text:string) {
  let out = String(text || '');
  for (const [prefix,label] of [[DATA_DIR, '[data-dir]'], [DEFAULT_HOME, '[home]'], [os.homedir(), '[home]']] as const) {
    if (prefix) out = out.split(prefix).join(label);
  }
  return out
    .replace(/\/opt\/data\/agentdeck(?:\/[^\s'",)]+)*/g, '[data-dir]')
    .replace(/\/home\/[^/\s'",)]+(?:\/[^\s'",)]+)*/g, '[home]');
}
function redactLine(line:string){ return maskSecretText(line); }
function shellQuote(value:string) { return `'${value.replaceAll("'", "'\\''")}'`; }
function normalizeMode(value:any) { const v = String(value || ''); return ['yolo','workspace-write','read-only'].includes(v) ? v : null; }
function normalizeProvider(value:any): AgentProviderId | null { return registryNormalizeProvider(value); }
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
  if (provider === 'claude') {
    return providerModelCatalog(await claudeProvider.listModels());
  }
  if (provider === 'gemini') {
    const activeProfile:any = await getActiveGeminiProfile();
    const rows = await runtimeDb.all(
      "SELECT id, model, provider_metadata, updated_at FROM sessions WHERE (provider_id='gemini' OR provider='gemini') AND provider_metadata IS NOT NULL AND (?1 IS NULL OR account_id=?1 OR current_upstream_account_id=?1) ORDER BY updated_at DESC LIMIT 10",
      [activeProfile?.id || null]
    ).catch(()=>[]);
    for (const row of rows as any[]) {
      let metadata:any = null;
      try { metadata = JSON.parse(String(row.provider_metadata || '{}')); } catch { metadata = null; }
      const models = extractGeminiModelOptions(metadata || {});
      if (models.length) {
        return {
          models,
          current: cleanAgentModel(row.model) || models.find((m:any)=>m.isDefault)?.model || models[0]?.model || '',
          error: null,
          configOptions: metadata?.configOptions || [],
          sourceSessionId: String(row.id || ''),
        };
      }
    }
    const anyGeminiSession = await runtimeDb.get("SELECT id FROM sessions WHERE (provider_id='gemini' OR provider='gemini') LIMIT 1").catch(()=>null);
    const hasGeminiSession = rows.length > 0 || !!anyGeminiSession;
    const defaultModel = cleanAgentModel(activeProfile?.defaultModel) || '';
    return {
      models: geminiFallbackModels(),
      current: defaultModel,
      error: hasGeminiSession
        ? '当前 Gemini CLI ACP 未公开可切换模型，继续使用 CLI 默认配置。'
        : 'Gemini 的模型选项由 ACP 会话返回。创建首个会话后可查看；当前使用 Gemini CLI 默认模型配置。',
      configOptions: [],
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
async function codexStatus(){
  const command = await detectManagedCommand(process.env.CODEX_BIN || '', 'codex');
  if (!command) return { ok:false, installed:false, command:'codex', error:'Codex CLI 未安装' };
  try {
    const codexHome = codex.getCodexHome();
    const {stdout}=await execFileAsync(command,['--version'], { env:{...process.env, HOME:DEFAULT_HOME, CODEX_HOME:codexHome} });
    return { ok:true, installed:true, command, version:stdout.trim(), appServer:true, sessionsPath:path.join(codexHome,'sessions') };
  } catch(e:any) {
    return { ok:false, installed:true, command, error:e.message };
  }
}
async function detectManagedCommand(configured:string, binary:string) {
  for (const candidate of [configured, path.join(MANAGED_PROVIDER_BIN_DIR, binary), binary].filter(Boolean)) {
    if (String(candidate).includes('/') && existsSync(String(candidate))) return String(candidate);
    if (!String(candidate).includes('/')) {
      try {
        const { stdout } = await execFileAsync('sh', ['-lc', `command -v '${String(candidate).replaceAll("'", "'\\''")}'`], { timeout:5000, env:process.env });
        if (stdout.trim()) return stdout.trim();
      } catch {}
    }
  }
  return null;
}
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
function geminiFallbackModels() {
  return [
    { id:'auto', model:'', actualModel:'', displayName:'自动', description:'使用 Gemini CLI 默认模型配置', hidden:false, isDefault:false, inputModalities:[], upgrade:null },
    { id:'gemini-2.5-pro', model:'gemini-2.5-pro', actualModel:'gemini-2.5-pro', displayName:'Pro', description:'当前 Gemini CLI 0.49.0 默认 Pro 模型别名', hidden:false, isDefault:false, inputModalities:[], upgrade:null },
    { id:'gemini-2.5-flash', model:'gemini-2.5-flash', actualModel:'gemini-2.5-flash', displayName:'Flash', description:'当前 Gemini CLI 0.49.0 默认 Flash 模型别名', hidden:false, isDefault:false, inputModalities:[], upgrade:null },
  ];
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
      codex: { imageInput:true, fileInput:true, fileTransport:'verified_path' },
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
async function findSession(id:string){
  const row = await db.get('SELECT * FROM sessions WHERE id=?1 OR codex_thread_id=?1',[id]);
  const runtimeRow = await runtimeDb.get('SELECT * FROM sessions WHERE id=?1 OR codex_thread_id=?1 OR upstream_thread_id=?1', [id]).catch(()=>null);
  if (normalizeProvider(row?.provider_id) === 'gemini' && runtimeRow) return runtimeRow;
  return row || runtimeRow;
}
async function upsertThread(thread:any, extra:any = {}) { if (!thread?.id || !pathAllowed(thread.cwd)) return; const existing:any = await findSession(String(thread.id)); const title = cleanTitle(extra.title || existing?.title || thread.name || thread.preview, thread.cwd); const now = Date.now(); const mode = normalizeMode(extra.permission_mode) || 'yolo'; const fields = { ...modeFields(mode), ...extra }; const model = cleanModel(fields.model); await db.run("INSERT INTO sessions (id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,model,archived,created_at,updated_at,provider_id,account_id,model_id,workspace_path,provider_session_id,creator_profile_id,selected_profile_id,executing_profile_id,upstream_binding_profile_id,last_execution_account_id,current_upstream_account_id,account_snapshot_json) VALUES (?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'codex',?12,?8,?2,?1,?13,?14,?15,?16,?15,?16,?17) ON CONFLICT(id) DO UPDATE SET codex_thread_id=excluded.codex_thread_id, project_dir=excluded.project_dir, title=excluded.title, status=excluded.status, archived=excluded.archived, provider_id=COALESCE(sessions.provider_id,'codex'), account_id=COALESCE(sessions.account_id,excluded.account_id), model_id=excluded.model_id, workspace_path=excluded.workspace_path, provider_session_id=excluded.provider_session_id, creator_profile_id=COALESCE(sessions.creator_profile_id,excluded.creator_profile_id), selected_profile_id=COALESCE(excluded.selected_profile_id,sessions.selected_profile_id), executing_profile_id=COALESCE(excluded.executing_profile_id,sessions.executing_profile_id), upstream_binding_profile_id=COALESCE(excluded.upstream_binding_profile_id,sessions.upstream_binding_profile_id), last_execution_account_id=COALESCE(excluded.last_execution_account_id,sessions.last_execution_account_id), current_upstream_account_id=COALESCE(excluded.current_upstream_account_id,sessions.current_upstream_account_id), account_snapshot_json=COALESCE(excluded.account_snapshot_json,sessions.account_snapshot_json), updated_at=excluded.updated_at", [thread.id, thread.cwd, title, extra.status || statusName(thread.status), fields.permission_mode, fields.approval_policy, fields.sandbox_mode, model || null, extra.archived ?? 0, (thread.createdAt || Math.floor(now/1000))*1000, (thread.updatedAt || Math.floor(now/1000))*1000, fields.account_id || null, fields.creator_profile_id || fields.account_id || null, fields.selected_profile_id || fields.account_id || null, fields.executing_profile_id || fields.account_id || null, fields.upstream_binding_profile_id || fields.account_id || null, fields.account_snapshot_json || null]); }
async function indexedSession(thread:any){ const row = await findSession(thread.id); return sessionDto(thread, row || undefined); }
function sessionDto(thread:any, row:any = {}) { const fields = modeFields(sessionMode(row)); const providerId = normalizeProvider(row.provider_id) || 'codex'; const model = providerId === 'codex' ? cleanModel(row.model) : cleanAgentModel(row.model); const modelId = providerId === 'codex' ? cleanModel(row.model_id) || model : cleanAgentModel(row.model_id) || model; return { id: thread.id, codex_thread_id: thread.id, provider_id: providerId, providerId, provider_session_id: row.provider_session_id || thread.id, account_id: row.account_id || null, creatorProfileId:row.creator_profile_id || row.account_id || null, selectedProfileId:row.selected_profile_id || null, executingProfileId:row.executing_profile_id || row.last_execution_account_id || null, upstreamBindingProfileId:row.upstream_binding_profile_id || row.current_upstream_account_id || null, last_execution_account_id:row.last_execution_account_id || null, current_upstream_account_id:row.current_upstream_account_id || null, account_snapshot_json:row.account_snapshot_json || null, workspace_path: row.workspace_path || thread.cwd, project_dir: thread.cwd, title: cleanTitle(row.title || thread.name || thread.preview, thread.cwd), status: row.status || statusName(thread.status), activeTurn:sessionActiveTurn(row), permission_mode:row.permission_mode || fields.permission_mode, approval_policy:row.approval_policy || fields.approval_policy, sandbox_mode:row.sandbox_mode || fields.sandbox_mode, model, model_id:modelId, archived: Number(row.archived || 0), created_at: (thread.createdAt || 0)*1000, updated_at: (thread.updatedAt || 0)*1000, last_sequence:Number(row.last_sequence || 0), canCreateSession:providerId === 'codex' ? true : undefined, canContinueSession:providerId === 'codex' ? !!(row.executing_profile_id || row.last_execution_account_id || row.account_id) : undefined, path: thread.path || null }; }
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
async function runtimeThreadFromEvents(threadId:string, row:any, snapshotWatermark=Number(row?.last_sequence||0)) {
  const events = await runtimeDb.all(
    `SELECT session_id,sequence,event_type,payload_json,created_at
     FROM (
       SELECT session_id,sequence,event_type,payload_json,created_at FROM (
         SELECT session_id,sequence,event_type,payload_json,created_at
         FROM events
         WHERE session_id=?1 AND sequence<=?2
           AND event_type IN ('user','turn/failed','turn/interrupted','thread_recovered_with_new_upstream')
         ORDER BY sequence DESC
         LIMIT 80
       )
       UNION ALL
       SELECT session_id,sequence,event_type,payload_json,created_at FROM (
         SELECT session_id,sequence,event_type,payload_json,created_at
         FROM events
         WHERE session_id=?1 AND sequence<=?2
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
         WHERE session_id=?1 AND sequence<=?2
           AND event_type IN ('item/agentMessage/delta','assistant/delta')
         ORDER BY sequence DESC
         LIMIT 1000
       )
      )
      ORDER BY sequence ASC`,
    [threadId,snapshotWatermark]
  ).catch(()=>[]);
  const canonicalUsers = await db.all(
    `SELECT * FROM (
       SELECT * FROM agent_messages
       WHERE session_id=?1 AND role='user'
       ORDER BY created_at DESC, id DESC
       LIMIT 80
     ) ORDER BY created_at ASC, id ASC`,
    [threadId]
  ).catch(()=>[]);
  let canonicalUserIndex = 0;
  const items:any[] = [];
  const completedItemIds = new Set<string>();
  const deltaText = new Map<string, string>();
  const deltaTurn = new Map<string, string>();
  const deltaOrder:string[] = [];
  for (const event of events as any[]) {
    const eventType = String(event.event_type || '');
    let payload:any = {};
    try { payload = JSON.parse(String(event.payload_json || '{}')); } catch {}
    if (eventType === 'user') {
      if (inputHasProviderOnlyRecovery(payload?.input)) continue;
      const canonical = canonicalUsers[canonicalUserIndex++] as any;
      if (canonical) {
        items.push(canonicalUserMessageItem(canonical));
        continue;
      }
      const input = Array.isArray(payload?.input) ? payload.input : [];
      const content = input
        .filter((item:any) => item?.type === 'text' && String(item.text || '').trim())
        .map((item:any) => ({ type:'text', text:stripProviderOnlyText(stripInternalAttachmentPrompt(String(item.text || '').replace(MOBILE_CONTEXT_MARKER, ''))).trim() }))
        .filter((item:any) => item.text);
      if (content.length) items.push({ id:`user-${event.sequence}`, type:'userMessage', turnId:payload?.turnId||null,segmentId:payload?.segmentId||payload?.turnId||null,content });
      continue;
    }
    if (eventType === 'item/completed') {
      const item = payload?.params?.item || payload?.item;
      if (item?.id) completedItemIds.add(String(item.id));
      if (item?.type === 'userMessage' && canonicalUsers.length) continue;
      if (item?.id && ['userMessage','agentMessage','imageView','imageGeneration','artifact'].includes(String(item.type))) items.push(compactSnapshotItem(item));
      continue;
    }
    if (eventType === 'item/agentMessage/delta') {
      const itemId = String(payload?.params?.itemId || '');
      const delta = String(payload?.params?.delta || '');
      if (itemId && delta) {
        if (!deltaText.has(itemId)) deltaOrder.push(itemId);
        deltaText.set(itemId, (deltaText.get(itemId) || '') + delta);
        deltaTurn.set(itemId,String(payload?.turnId||payload?.params?.turnId||payload?.segmentId||''));
      }
      continue;
    }
    if (eventType === 'turn/failed' || eventType === 'turn/interrupted') {
      const reason = payload?.reason || payload?.params?.reason || payload?.error?.message || payload?.params?.error?.message || '';
      const terminalTurnId=String(payload?.turnId||payload?.params?.turn?.id||'');
      items.push({ id:`${eventType}-${event.sequence}`, type:'agentMessage',turnId:terminalTurnId||null,segmentId:terminalTurnId||null,text:eventType === 'turn/failed' ? `请求失败：${reason || 'turn failed'}` : '已停止生成', phase:'final_answer' });
    }
  }
  while (canonicalUserIndex < canonicalUsers.length) {
    items.push(canonicalUserMessageItem(canonicalUsers[canonicalUserIndex++]));
  }
  for (const itemId of deltaOrder) {
    const text = String(deltaText.get(itemId) || '').trim();
    if (text && !completedItemIds.has(itemId)){const turnId=deltaTurn.get(itemId)||'';items.push({id:itemId,type:'agentMessage',turnId:turnId||null,segmentId:turnId||null,text,phase:'commentary'});}
  }
  const turns:any[]=[];const turnsById=new Map<string,any>();
  for(const item of items){const itemTurnId=String(item?.turnId||item?.segmentId||'')||`legacy-${threadId}`;let turn=turnsById.get(itemTurnId);if(!turn){turn={id:itemTurnId,turnId:itemTurnId,userMessageIds:[],items:[]};turnsById.set(itemTurnId,turn);turns.push(turn);}turn.items.push(item);if(item?.type==='userMessage'&&item?.id)turn.userMessageIds.push(String(item.id));}
  return {
    id:threadId,
    name:String(row.title || projectNameFromPath(String(row.project_dir || 'Session'))),
    preview:String(row.title || ''),
    cwd:String(row.project_dir),
    status:{ type:String(row.status || 'idle') },
    createdAt:Math.floor(Number(row.created_at || Date.now()) / 1000),
    updatedAt:Math.floor(Number(row.updated_at || Date.now()) / 1000),
    turns,
    path:null,
  };
}

function compactSnapshotItem(item:any) {
  if (!item || typeof item !== 'object') return item;
  const next = { ...item };
  if (typeof next.text === 'string') next.text = stripInternalAttachmentPrompt(next.text);
  if (typeof next.text === 'string') next.text = stripProviderOnlyText(next.text);
  if (typeof next.text === 'string' && next.text.length > 80_000) next.text = `${next.text.slice(0, 80_000)}\n\n[output truncated for mobile snapshot]`;
  if (Array.isArray(next.content)) {
    next.content = next.content.map((part:any) => {
      if (typeof part?.text !== 'string') return part;
      const text = stripProviderOnlyText(stripInternalAttachmentPrompt(part.text));
      return text.length > 80_000 ? { ...part, text:`${text.slice(0, 80_000)}\n\n[output truncated for mobile snapshot]` } : { ...part, text };
    }).filter((part:any) => typeof part?.text !== 'string' || part.text.trim());
  }
  return next;
}
function canonicalUserMessageItem(m:any) {
  return {
    id:String(m.id),
    type:'userMessage',
    clientMessageId:m.client_message_id || null,
    turnId:m.turn_id || null,
    segmentId:m.segment_id || m.turn_id || null,
    retryOf:m.retry_of || null,
    createdAt:Number(m.created_at||0),
    status:m.status || 'persisted',
    attachments:userMessageAttachmentsFromRow(m),
    content:userMessageContentFromRow(m),
  };
}
function rowSessionDto(row:any) {
  const fields = modeFields(sessionMode(row));
  const providerId = normalizeProvider(row.provider_id) || 'codex';
  const model = providerId === 'antigravity' || providerId === 'gemini' ? cleanAgentModel(row.model) : cleanModel(row.model);
  const modelId = providerId === 'antigravity' || providerId === 'gemini' ? cleanAgentModel(row.model_id) || model : cleanModel(row.model_id) || model;
  return { id:String(row.codex_thread_id || row.id), codex_thread_id:String(row.codex_thread_id || row.id), provider_id:providerId, providerId, provider_session_id:String(row.provider_session_id || row.codex_thread_id || row.id), account_id:row.account_id || null, creatorProfileId:row.creator_profile_id || row.account_id || null, selectedProfileId:row.selected_profile_id || null, executingProfileId:row.executing_profile_id || row.last_execution_account_id || null, upstreamBindingProfileId:row.upstream_binding_profile_id || row.current_upstream_account_id || null, last_execution_account_id:row.last_execution_account_id || null, current_upstream_account_id:row.current_upstream_account_id || null, account_snapshot_json:row.account_snapshot_json || null, workspace_path:String(row.workspace_path || row.project_dir), project_dir:String(row.project_dir), title:String(row.title || projectNameFromPath(String(row.project_dir))), status:String(row.status || 'idle'), activeTurn:sessionActiveTurn(row), permission_mode:row.permission_mode || fields.permission_mode, approval_policy:row.approval_policy || fields.approval_policy, sandbox_mode:row.sandbox_mode || fields.sandbox_mode, model, model_id:modelId, modelRevision:Number(row.model_revision || 0), archived:Number(row.archived || 0), created_at:Number(row.created_at || 0), updated_at:Number(row.updated_at || 0), last_sequence:Number(row.last_sequence || 0), canCreateSession:providerId === 'codex' ? true : undefined, canContinueSession:providerId === 'codex' ? !!(row.executing_profile_id || row.last_execution_account_id || row.account_id) : undefined, path:null };
}
function sessionActiveTurn(row:any) {
  const turnId = row?.active_turn_id ? String(row.active_turn_id) : null;
  const status = String(row?.status || 'idle');
  if (!turnId && !['running','submitting','output_draining','waiting_approval','waiting_input','planning','waiting_plan_approval','executing_approved_plan','cancelling'].includes(status)) return null;
  const waitingKind = status === 'waiting_approval' ? 'approval' : status === 'waiting_input' ? 'input' : status === 'waiting_plan_approval' ? 'plan' : null;
  return { turnId, status:status === 'active' && turnId ? 'running' : status, startedAt:null, waitingKind };
}
async function antigravityThread(row:any) {
  const messages = await db.all('SELECT * FROM agent_messages WHERE session_id=?1 ORDER BY created_at ASC', [String(row.id)]);
  const items = messages.map((m:any)=>m.role === 'user'
    ? canonicalUserMessageItem(m)
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
function userMessageContentFromRow(m:any) {
  const content:any[] = [];
  const text = stripProviderOnlyText(stripInternalAttachmentPrompt(String(m.original_text || m.text || ''))).trim();
  if (text) content.push({ type:'text', text });
  for (const a of userMessageAttachmentsFromRow(m)) if (String(a.type || '').startsWith('image/')) content.push({ type:'image', url:a.url, viewerUrl:a.url, path:a.id, name:a.name });
  return content;
}
function userMessageAttachmentsFromRow(m:any) {
  try {
    const attachments = JSON.parse(String(m.attachments_json || '[]'));
    return (Array.isArray(attachments) ? attachments : []).map((a:any)=>({
      id:String(a.id || a.url || crypto.randomUUID()),
      name:String(a.name || 'attachment'),
      type:String(a.type || ''),
      size:Number(a.size || 0),
      url:String(a.url || ''),
    })).filter((a:any)=>a.url);
  } catch { return []; }
}
function stripInternalAttachmentPrompt(text:string) {
  let out = String(text || '');
  out = out.replace(/\n{0,2}Attachments are available as local files:\n(?:- .+ \| .+ \| \d+ bytes \| \/[^\n]+\n?)+/g, '').trim();
  out = out.replace(/\n{0,2}Attachment:\s*[^\n]*\nMIME:\s*[^\n]*\nSize:\s*[^\n]*\nLocal path:\s*\/[^\n]+\nRead this file from the local path if needed\.?/g, '').trim();
  return out;
}
function stripProviderOnlyText(text:string) {
  const value = String(text || '');
  const planText = stripInternalPlanPrompt(value);
  if (planText !== value) return planText;
  return value.includes(RECOVERY_CONTEXT_MARKER) ? '' : value;
}
function stripInternalPlanPrompt(text:string) {
  const value = String(text || '');
  if (!/^\s*\$plan\b/.test(value)) return value;
  const marker = value.match(/用户原始任务：\s*([\s\S]*)$/);
  return marker ? marker[1].trimStart() : '';
}
async function listIndexedThreads(archived:boolean){
  if (USE_AGENT_RUNTIME) {
    const startedAt = Date.now();
    const byId = new Map<string, any>();
    const runtimeStartedAt = Date.now();
    const runtimeSessions = await runtimeDb.all('SELECT * FROM sessions WHERE archived=?1 ORDER BY updated_at DESC LIMIT 500', [archived ? 1 : 0]).catch(()=>[]);
    for (const session of runtimeSessions as any[]) {
      if (isHiddenGeminiUtilitySession(session)) continue;
      if (!pathAllowed(String(session.project_dir || session.workspace_path || ''))) continue;
      byId.set(String(session.codex_thread_id || session.id), rowSessionDto(session));
    }
    const runtimeSqliteDurationMs = Date.now() - runtimeStartedAt;
    const localStartedAt = Date.now();
    const rows = await db.all('SELECT * FROM sessions WHERE archived=?1 ORDER BY updated_at DESC LIMIT 500', [archived ? 1 : 0]);
    for (const row of rows) {
      if (isHiddenGeminiUtilitySession(row)) continue;
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
    if (isHiddenGeminiUtilitySession(row)) continue;
    const id = String(row.codex_thread_id || row.id);
    if (!byId.has(id) && pathAllowed(String(row.project_dir))) byId.set(id, rowSessionDto(row));
  }
  return [...byId.values()].sort((a:any,b:any)=>Number(b.updated_at || 0)-Number(a.updated_at || 0));
}
function isHiddenGeminiUtilitySession(row:any) {
  if (normalizeProvider(row?.provider_id || row?.provider) !== 'gemini') return false;
  const id = String(row?.id || row?.codex_thread_id || '');
  const title = String(row?.title || '');
  if (String(row?.interruption_reason || '') === 'gemini_session_new_failed' && !row?.provider_session_id && Number(row?.last_sequence || 0) === 0) return true;
  return id.startsWith('gemini-login-verify-') || id.startsWith('gemini-smoke-') || title === 'Gemini login verification' || title === 'Gemini smoke test';
}
function projectNameFromPath(p:string){ return p.split(path.sep).filter(Boolean).pop() || p; }
function sessionTitleFromTask(task:any,fallback:string){
  const firstLine=String(task||'').replace(/\r/g,'').split('\n').map(line=>line.trim()).find(Boolean)||'';
  const clean=firstLine.replace(/^[-*#>\s]+/,'').replace(/\s+/g,' ').trim();
  if(!clean) return String(fallback||'New task').slice(0,72);
  const chars=Array.from(clean);
  return chars.length>72?chars.slice(0,71).join('')+'…':clean;
}
async function runtimeAdminState() {
  const url = `${process.env.AGENT_RUNTIME_URL || 'http://127.0.0.1:3852'}/admin/runtime/state`;
  const res = await fetch(url, { headers:runtimeAuthHeaders() });
  if (!res.ok) throw new Error(`runtime admin state failed: ${res.status}`);
  return res.json();
}
function runtimeAuthHeaders(): Record<string, string> {
  return process.env.RUNTIME_TOKEN ? { authorization:`Bearer ${process.env.RUNTIME_TOKEN}` } : {};
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
type JoinOptions={clientConnectionId?:string;recoverRuntimeGeneration?:boolean;requestedRuntimeGeneration?:string;joinRequestId?:string;recoveryEpoch?:number;browserAppliedSequence?:number;snapshotCoveredSequence?:number};
async function joinAndResume(id:string,ws:any,lastSequence=0,options:JoinOptions={}){
  const row = await findSession(id);
  const threadId = String(row?.codex_thread_id || id);
  const runtimeBackedAntigravity=USE_AGENT_RUNTIME&&normalizeProvider(row?.provider_id)==='antigravity'&&!!await runtimeDb.get('SELECT 1 AS ok FROM sessions WHERE id=?1 OR codex_thread_id=?1',[threadId]).catch(()=>null);
  if(USE_AGENT_RUNTIME&&['running','submitting','planning','recovering','executing_approved_plan','waiting_approval','waiting_input','waiting_plan_approval'].includes(String(row?.active_turn_status||row?.status||'')))activeRuntimeProviderSessions.add(threadId);
  const pendingRelease=runtimeSubscriptionReleases.get(threadId);if(pendingRelease){clearTimeout(pendingRelease);runtimeSubscriptionReleases.delete(threadId);}
  if(!clients.has(threadId)) clients.set(threadId,new Set());
  app.log.info({sessionId:id,threadId,connectionGeneration:ws.agentdeckGeneration||null,subscriberCount:clients.get(threadId)?.size||0,replayFrom:Number(lastSequence||0),browserAppliedSequence:options.browserAppliedSequence||0,snapshotCoveredSequence:options.snapshotCoveredSequence||0,runtimeGeneration:options.requestedRuntimeGeneration||null,recoveryEpoch:options.recoveryEpoch||0,joinRequestId:options.joinRequestId||null},'websocket joined session');
  if (row && normalizeProvider(row.provider_id) === 'antigravity' && !runtimeBackedAntigravity) {
    clients.get(threadId)!.add(ws);
    ws.send(JSON.stringify({type:'joined',sessionId:threadId,runtimeConnection:'connected',clientConnectionId:options.clientConnectionId||'',joinRequestId:options.joinRequestId||null,recoveryEpoch:options.recoveryEpoch||0}));
    return;
  }
  if (USE_AGENT_RUNTIME) {
    // A stale browser generation must never replace the shared ingestion SSE.
    // The subscription owns Runtime replay; this join owns no Runtime REST replay.
    const subscription = ensureSessionSubscription(id, threadId);
    await waitForRuntimeLive(subscription);
    const identityKey=`${options.clientConnectionId||''}:${options.joinRequestId||''}:${options.recoveryEpoch||0}`;if(ws.agentdeckJoinIdentity?.get(threadId)!==identityKey)return;
    const latest=subscription.committedSequence;
    const replay=browserDelivery.beginReplay(ws,threadId,{clientConnectionId:options.clientConnectionId||'',joinRequestId:options.joinRequestId||'',recoveryEpoch:options.recoveryEpoch||0},Number(lastSequence||0),latest);
    if(!replay){browserDelivery.sendDirect(ws,{type:'resnapshot_required',sessionId:threadId,latestSequence:latest,runtimeGeneration:subscription.generation||null,clientConnectionId:options.clientConnectionId||'',joinRequestId:options.joinRequestId||null,recoveryEpoch:options.recoveryEpoch||0});return;}
    clients.get(threadId)!.add(ws);
    app.log.info({ sessionId:id, threadId, rowStatus:String(row?.status || ''), lastSequence:Number(lastSequence || 0), latestSequence:latest, subscriberCount:clients.get(threadId)?.size || 0, connectionGeneration:ws.agentdeckGeneration || null, runtimeConnection:runtimeConnectionStatus(subscription) }, 'codex session joined with runtime subscription');
    await browserDelivery.finishReplay(ws,threadId,replay.state,replay.groups,{type:'joined',sessionId:threadId,runtimeConnection:runtimeConnectionStatus(subscription),runtimeGeneration:subscription.generation||options.requestedRuntimeGeneration||null,joinRequestId:options.joinRequestId||null,recoveryEpoch:options.recoveryEpoch||0,browserAppliedSequence:options.browserAppliedSequence||lastSequence,snapshotCoveredSequence:options.snapshotCoveredSequence||0,runtimeReceivedSequence:subscription.receivedSequence,replayThrough:latest});
    return;
  }
  if (row?.project_dir) await codex.resumeThread(threadId, String(row.project_dir), modeOptions(sessionMode(row), await effectiveModel(row))).catch(()=>{});
  clients.get(threadId)!.add(ws);
  ws.send(JSON.stringify({type:'joined',sessionId:threadId,clientConnectionId:options.clientConnectionId||'',joinRequestId:options.joinRequestId||null,recoveryEpoch:options.recoveryEpoch||0}));
}
async function waitForRuntimeLive(state:RuntimeSubscriptionState){
  const deadline=Date.now()+15_000;
  while(!state.connected && Date.now()<deadline){
    if(state.lastStatus==='unavailable') throw new Error('runtime stream unavailable');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  if(!state.connected) throw new Error('runtime stream did not reach caught-up barrier');
}
function replaceRuntimePushSubscription(threadId:string,committedSequence:number){const existing=runtimeSubscriptions.get(threadId);if(existing){runtimeSubscriptions.delete(threadId);existing.close();}const cursor=Math.max(0,Number(committedSequence||0));runtimeSubscriptions.set(threadId,{close:()=>{},connected:false,connecting:false,receivedSequence:cursor,processingSequence:0,committedSequence:cursor,lastSequence:cursor,generation:undefined,lastStatus:'recovering'});}
function broadcast(id:string, msg:any){
  const set = clients.get(id);
  if (!set?.size) {
    app.log.warn({ sessionId:id, threadId:id, eventType:msg?.method || msg?.type || 'unknown', subscriberCount:0, sequence:msg?.runtimeSequence || null, pushResult:'no_subscriber' }, 'runtime push has no websocket subscriber');
    return;
  }
  for(const ws of set) {
    if(ws.readyState === 1) {
      browserDelivery.sendDirect(ws,msg);
      runtimeDiagnostics.broadcasts++;
      app.log.debug({ sessionId:id, threadId:id, eventType:msg?.method || msg?.type || 'unknown', sequence:msg?.runtimeSequence || null, connectionGeneration:ws.agentdeckGeneration || null, pushResult:'sent' }, 'websocket event pushed');
    } else {
      app.log.warn({ sessionId:id, threadId:id, eventType:msg?.method || msg?.type || 'unknown', sequence:msg?.runtimeSequence || null, connectionGeneration:ws.agentdeckGeneration || null, readyState:ws.readyState, pushResult:'socket_closed' }, 'runtime push found closed websocket');
    }
  }
}
function runtimeConnectionStatus(state?:RuntimeSubscriptionState):RuntimeSubscriptionState['lastStatus'] {
  if (!state) return 'unknown';
  if (state.connected) return 'connected';
  if (state.connecting) return state.lastStatus === 'unavailable' ? 'unavailable' : 'checking';
  return state.lastStatus || 'recovering';
}
function ensureSessionSubscription(sessionId:string, threadId:string) {
  const state = ensureRuntimePushSubscription(threadId);
  app.log.info({ sessionId, threadId, subscriberCount:clients.get(threadId)?.size || 0, lastSequence:state.lastSequence, runtimeConnection:runtimeConnectionStatus(state) }, 'session subscription ensured');
  return state;
}
function ensureRuntimePushSubscription(threadId:string) {
  const existing = runtimeSubscriptions.get(threadId);
  if (existing?.connected || existing?.connecting) return existing;
  existing?.close?.();
  const committedSequence=Number(existing?.committedSequence || persistedIngestionCursors.get(threadId) || existing?.lastSequence || 0);
  const subscribedGeneration=String(existing?.generation||persistedIngestionGenerations.get(threadId)||'');
  let generationTransition=false;
  const state:RuntimeSubscriptionState = { close:()=>{}, connected:false, connecting:true, receivedSequence:committedSequence, processingSequence:0, committedSequence, lastSequence:committedSequence, generation:subscribedGeneration||undefined, lastError:existing?.lastError, lastStatus:'checking' };
  runtimeSubscriptions.set(threadId, state);
  runtimeDiagnostics.subscribeStarts++;
  app.log.info({ sessionId:threadId, threadId, after:state.lastSequence }, 'runtime sse subscribe starting');
  const close = runtime.subscribe(threadId, state.lastSequence, async (event:any) => {
    state.generation = String(event.generation || '');
    const sequence=Number(event.sequence || 0);
    state.receivedSequence=Math.max(state.receivedSequence,sequence);
    state.processingSequence=sequence;
    runtimeDiagnostics.subscribeEvents++;
    try {
      if(sequence!==state.committedSequence+1) throw new Error(`runtime live sequence gap: expected ${state.committedSequence+1}, got ${sequence}`);
      const messages = await ingestAndBuildRuntimeFrames(threadId, event);
      if (!messages.length) app.log.warn({ sessionId:threadId, threadId, sequence:event.sequence || null, eventType:event.event_type || 'unknown', reason:'explicitly_ignored_or_unmapped_runtime_event' }, 'runtime event produced no websocket messages');
      const frames=messages.length?messages:[{type:'runtime_cursor',fromSequence:sequence,throughSequence:sequence,runtimeGeneration:String(event.generation||state.generation||'')}];
      await db.run('INSERT INTO runtime_ingestion_cursors (session_id,committed_sequence,runtime_generation,updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(session_id) DO UPDATE SET committed_sequence=excluded.committed_sequence,runtime_generation=excluded.runtime_generation,updated_at=excluded.updated_at',[threadId,sequence,state.generation||null,Date.now()]);
      state.committedSequence=sequence;
      state.lastSequence=sequence;
      persistedIngestionCursors.set(threadId,sequence);
      persistedIngestionGenerations.set(threadId,state.generation||'');
      browserDelivery.publish(threadId,sequence,String(event.generation||state.generation||''),frames);
      state.processingSequence=0;
    } catch (error:any) {
      state.processingSequence=0;
      state.connected=false;
      state.connecting=false;
      state.lastStatus='recovering';
      state.lastError=String(error?.message || error).slice(0,500);
      app.log.error({sessionId:threadId,sequence,eventType:String(event.event_type||'unknown'),error:state.lastError},'runtime event processing failed; reconnecting from committed sequence');
      queueMicrotask(()=>state.close());
      throw error;
    }
  }, async (status, error) => {
    if (status === 'transport_connected') {
      const connectedGeneration=String(error?.generation||'');
      generationTransition=!!connectedGeneration&&!!subscribedGeneration&&connectedGeneration!==subscribedGeneration;
      if(connectedGeneration)state.generation=connectedGeneration;
      if(generationTransition){browserDelivery.releaseSession(threadId);broadcast(threadId,{type:'runtimeConnection',status:'recovering',runtimeGeneration:connectedGeneration});}
      state.connecting = true;
      state.lastStatus = 'checking';
      return;
    }
    if (status === 'stream_ready') {
      const connectedGeneration=String(error?.runtimeGeneration||error?.generation||'');
      if(connectedGeneration)state.generation=connectedGeneration;
      const authoritativeSequence=Math.max(0,Number(error?.caughtUpThrough ?? error?.currentLatestSequence ?? state.committedSequence));
      const generationChanged=generationTransition||!!connectedGeneration&&connectedGeneration!==subscribedGeneration;
      if(authoritativeSequence!==state.committedSequence||generationChanged){
        await db.run('INSERT INTO runtime_ingestion_cursors (session_id,committed_sequence,runtime_generation,updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(session_id) DO UPDATE SET committed_sequence=excluded.committed_sequence,runtime_generation=excluded.runtime_generation,updated_at=excluded.updated_at',[threadId,authoritativeSequence,state.generation||null,Date.now()]);
        state.receivedSequence=authoritativeSequence;state.committedSequence=authoritativeSequence;state.lastSequence=authoritativeSequence;persistedIngestionCursors.set(threadId,authoritativeSequence);persistedIngestionGenerations.set(threadId,state.generation||'');
        if(authoritativeSequence!==Number(error?.requestedAfter??authoritativeSequence)&&!generationTransition)browserDelivery.releaseSession(threadId);
        app.log.warn({sessionId:threadId,requestedAfter:error?.requestedAfter,replayFrom:error?.replayFrom,authoritativeSequence,runtimeGeneration:state.generation||null},'runtime ingestion cursor rebased to authoritative watermark');
      }
      state.connecting=false; state.connected=true; state.lastStatus='connected';
      state.lastError = undefined;
      app.log.info({ sessionId:threadId, threadId, subscriberCount:clients.get(threadId)?.size || 0 }, 'runtime subscription restored');
      broadcast(threadId, { type:'runtimeConnection', status:'connected',runtimeGeneration:state.generation||null });
      return;
    }
    state.connecting = false;
    state.connected = false;
    state.lastError = error?.message || undefined;
    state.lastStatus = status === 'error' ? 'unavailable' : 'recovering';
    if (status === 'closed' && runtimeSubscriptions.get(threadId) === state && !(clients.get(threadId)?.size || runtimeSessionActive(threadId))) {
      runtimeSubscriptions.delete(threadId);
    }
    runtimeDiagnostics.subscribeReconnects++;
    app.log.warn({ sessionId:threadId, threadId, status, error:error?.message || undefined, subscriberCount:clients.get(threadId)?.size || 0 }, 'runtime sse subscribe disconnected');
    broadcast(threadId, { type:'runtimeConnection', status:state.lastStatus, error:error?.message || undefined });
    if (runtimeSubscriptions.get(threadId) === state) {
      setTimeout(() => {
        if (clients.get(threadId)?.size || runtimeSessionActive(threadId)) ensureSessionSubscription(threadId, threadId);
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
async function sendTurn(id:string, text:string, attachments:any[] = [], clientMessageId = '', planMode:'direct'|'plan' = 'direct',retryOf=''){
  const messageId=clientMessageId||crypto.randomUUID();
  return withReceiptFailure(()=>sendTurnClaimed(id,text,attachments,messageId,planMode,retryOf),async message=>{
    const row=await findSession(id).catch(()=>null);
    const threadId=String(row?.codex_thread_id||row?.id||id);
    await updateMessageReceipt(threadId,messageId,'failed',message).catch(()=>{});
    broadcast(threadId,{type:'messageStatus',clientMessageId:messageId,status:'failed',error:message});
  });
}
async function sendTurnClaimed(id:string, text:string, attachments:any[] = [], clientMessageId = '', planMode:'direct'|'plan' = 'direct',retryOf=''){
  const row = await findSession(id);
  if(!row) throw new Error('session not found');
  const threadId = String(row.codex_thread_id || row.id);
  clientMessageId=clientMessageId||crypto.randomUUID();
  const claimed=await claimMessageReceipt(threadId,clientMessageId,retryOf);
  if(!claimed.created){
    if(claimed.canonicalClientMessageId&&claimed.canonicalClientMessageId!==clientMessageId)broadcast(threadId,{type:'messageStatus',clientMessageId,status:'cancelled',retryOf,canonicalClientMessageId:claimed.canonicalClientMessageId});
    broadcast(threadId,{type:'messageStatus',clientMessageId:claimed.canonicalClientMessageId||clientMessageId,status:claimed.status,error:claimed.error||undefined,retryOf:retryOf||undefined});
    return;
  }
  const submission = parsePlanSubmission(text, planMode);
  const originalText = submission.originalText;
  const effectivePlanMode = submission.planMode;
  const providerText = effectivePlanMode === 'plan' ? planOnlyPrompt(originalText) : originalText;
  const planTurnOptions = effectivePlanMode === 'plan' ? { approvalPolicy:'on-request', sandboxMode:'read-only' } : null;
  const planId = effectivePlanMode === 'plan' ? await createPlanTask(threadId, originalText, row) : '';
  const ack = async (status:string, error?:string) => {
    await updateMessageReceipt(threadId,clientMessageId,status,error);
    const current=await db.get('SELECT status,error FROM message_receipts WHERE session_id=?1 AND client_message_id=?2',[threadId,clientMessageId]);
    broadcast(threadId, { type:'messageStatus', clientMessageId, status:String(current?.status||status), error:current?.error||error });
  };
  await ack('received');
  const turnId = clientMessageId || crypto.randomUUID();
  const messageId=canonicalUserMessageId(threadId,clientMessageId),segmentId=clientMessageId;
  if (planId) await db.run('UPDATE plan_tasks SET execution_turn_id=?1 WHERE plan_id=?2', [turnId, planId]).catch(()=>{});
  activeArtifactTurns.set(threadId, turnId);
  const generatedTitle=autoTitle(originalText,String(row.project_dir),String(row.title||''));
  if(generatedTitle){
    if(USE_AGENT_RUNTIME)await runtime.setSessionTitle(threadId,generatedTitle).catch(()=>{});
    else if(normalizeProvider(row.provider_id)==='codex')await codex.setName(threadId,generatedTitle).catch(()=>{});
    await db.run('UPDATE sessions SET title=?1,updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[generatedTitle,Date.now(),threadId]);
    row.title=generatedTitle;
    broadcast(threadId,{type:'sessionTitle',title:generatedTitle});
  }
  if (normalizeProvider(row.provider_id) === 'antigravity') {
    if(!USE_AGENT_RUNTIME)throw new Error('Antigravity 需要 persistent runtime');
    const dto:any=await getActiveAntigravityProfile();if(!dto?.id||!dto?.home_dir)throw new Error('请先登录 Antigravity');
    const legacyHistory=await antigravityLegacyHistory(threadId),providerSessionId=validAntigravityConversationId(row.provider_session_id,threadId);
    await runtime.createAntigravitySession({sessionId:threadId,accountId:dto.id,profile:{id:dto.id,homeDir:dto.home_dir},accountSnapshot:{id:dto.id,name:dto.name||'Antigravity Account'},cwd:String(row.project_dir),title:String(row.title||''),mode:sessionMode(row),model:cleanAgentModel(row.model)||undefined,providerSessionId,legacyHistory,createdAt:Number(row.created_at||Date.now())});
    const attachmentPaths=await antigravityAttachmentPaths(threadId,attachments),providerInput=antigravityProviderInput(providerText,attachmentPaths),input=[{type:'text',text:providerInput}];
    const subscription=ensureSessionSubscription(id,threadId);broadcast(threadId,{type:'runtimeConnection',status:runtimeConnectionStatus(subscription),error:subscription.lastError});
    await saveCanonicalUserMessage(threadId,originalText,attachments,clientMessageId,turnId,retryOf,messageId);await ack('persisted');broadcast(threadId,canonicalUserBroadcast(threadId,originalText,attachments,clientMessageId,turnId,retryOf,effectivePlanMode));
    await recordArtifactBaseline(threadId,String(row.project_dir),turnId).catch(()=>{});activeRuntimeProviderSessions.add(threadId);
    await runtime.startTurn(threadId,{input,text:providerInput,attachments:attachmentPaths,originalText,clientMessageId,messageId,segmentId,localTurnId:turnId,provisionalTurnId:turnId,retryOf,turnId,planMode:effectivePlanMode,accountId:dto.id,profile:{id:dto.id,homeDir:dto.home_dir},accountSnapshot:{id:dto.id,name:dto.name||'Antigravity Account'},cwd:String(row.project_dir),permissionMode:sessionMode(row),model:cleanAgentModel(row.model)||undefined});
    await ack('accepted');
    return;
  }
  if (normalizeProvider(row.provider_id) === 'gemini') {
    const dto:any = await getActiveGeminiProfile();
    if (!dto?.id || dto.status !== 'authenticated' || !dto.login?.ok) throw new Error('请先登录 Gemini');
    const input = await buildTurnInput(threadId, providerText, attachments);
    const userMessage=canonicalUserBroadcast(threadId,originalText,attachments,clientMessageId,turnId,retryOf,effectivePlanMode);
    const subscription = ensureSessionSubscription(id, threadId);
    broadcast(threadId, { type:'runtimeConnection', status:runtimeConnectionStatus(subscription), error:subscription.lastError });
    if (effectivePlanMode === 'plan') await saveCanonicalUserMessage(threadId, originalText, attachments, clientMessageId, turnId,retryOf,messageId);
    else await saveCanonicalUserMessage(threadId, text, attachments, clientMessageId, turnId,retryOf,messageId);
    await recordArtifactBaseline(threadId, String(row.project_dir), turnId).catch((e:any)=>app.log.warn({ sessionId:threadId, error:e?.message || String(e) }, 'artifact baseline failed'));
    broadcast(threadId, userMessage);
    await ack('persisted');
    await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[effectivePlanMode === 'plan' ? 'planning' : 'submitting',Date.now(),threadId]);
    activeRuntimeProviderSessions.add(threadId);
    try {
      await runtime.startTurn(threadId, { input, text:providerText, planMode:effectivePlanMode, originalText, clientMessageId,messageId,segmentId,localTurnId:turnId,provisionalTurnId:turnId,retryOf,turnId,accountId:dto.id, accountSnapshot:geminiAccountSnapshot(dto), cwd:String(row.project_dir), approvalPolicy:planTurnOptions?.approvalPolicy || row.approval_policy, sandboxMode:planTurnOptions?.sandboxMode || row.sandbox_mode, model:cleanAgentModel(row.model) || undefined });
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[effectivePlanMode === 'plan' ? 'planning' : 'running',Date.now(),threadId]).catch(()=>{});
      await ack('accepted');
    } catch (e:any) {
      activeRuntimeProviderSessions.delete(threadId);
      const message = e?.message || String(e);
      if (isGeminiAuthenticationErrorMessage(message)) await markGeminiProfileNeedsLogin(String(dto.id), message);
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[submissionFailureStatus(row),Date.now(),threadId]).catch(()=>{});
      await ack('failed', message);
      throw e;
    }
    return;
  }
  if (normalizeProvider(row.provider_id) === 'claude') {
    const dto:any = await activeClaudeProfileSummary();
    if (!dto?.id) throw new Error('请先配置 Claude Code profile');
    const input = effectivePlanMode === 'plan'
      ? await buildClaudeTurnInput(threadId, providerText, attachments)
      : await buildClaudeTurnInput(threadId, text, attachments);
    const userMessage=canonicalUserBroadcast(threadId,originalText,attachments,clientMessageId,turnId,retryOf,effectivePlanMode);
    const subscription = ensureSessionSubscription(id, threadId);
    broadcast(threadId, { type:'runtimeConnection', status:runtimeConnectionStatus(subscription), error:subscription.lastError });
    if (effectivePlanMode === 'plan') await saveCanonicalUserMessage(threadId, originalText, attachments, clientMessageId, turnId,retryOf,messageId);
    else await saveCanonicalUserMessage(threadId, text, attachments, clientMessageId, turnId,retryOf,messageId);
    await recordArtifactBaseline(threadId, String(row.project_dir), turnId).catch((e:any)=>app.log.warn({ sessionId:threadId, error:e?.message || String(e) }, 'artifact baseline failed'));
    broadcast(threadId, userMessage);
    await ack('persisted');
    await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[effectivePlanMode === 'plan' ? 'planning' : 'submitting',Date.now(),threadId]);
    activeRuntimeProviderSessions.add(threadId);
    try {
      await runtime.startTurn(threadId, { input, text:providerText, planMode:effectivePlanMode, originalText, clientMessageId,messageId,segmentId,localTurnId:turnId,provisionalTurnId:turnId,retryOf,accountId:dto.id, profile:dto, accountSnapshot:claudeAccountSnapshot(dto), cwd:String(row.project_dir), approvalPolicy:planTurnOptions?.approvalPolicy || row.approval_policy, sandboxMode:planTurnOptions?.sandboxMode || row.sandbox_mode, permissionMode:effectivePlanMode === 'plan' ? 'plan' : sessionMode(row), model:cleanAgentModel(row.model) || undefined, turnId });
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[effectivePlanMode === 'plan' ? 'planning' : 'running',Date.now(),threadId]).catch(()=>{});
      await ack('accepted');
    } catch (e:any) {
      activeRuntimeProviderSessions.delete(threadId);
      const message = e?.message || String(e);
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[submissionFailureStatus(row),Date.now(),threadId]).catch(()=>{});
      await ack('failed', message);
      throw e;
    }
    return;
  }
  const input = await buildCodexTurnInput(threadId, providerText, attachments);
  const opts = modeOptions(sessionMode(row), await effectiveModel(row));
  const continuePreflight = await codexContinueSessionPreflight();
  if (!continuePreflight.ok) {
    await ack('failed', continuePreflight.body.message);
    throw Object.assign(new Error(continuePreflight.body.message), { statusCode:continuePreflight.statusCode, body:continuePreflight.body });
  }
  const activeProfile:any = continuePreflight.profile;
  const execution = codexExecutionContext(activeProfile);
  const executionSnapshotJson = JSON.stringify(execution.accountSnapshot || null);
  const userMessage=canonicalUserBroadcast(threadId,originalText,attachments,clientMessageId,turnId,retryOf,effectivePlanMode);
  if (USE_AGENT_RUNTIME) {
    await saveCanonicalUserMessage(threadId, originalText, attachments, clientMessageId, turnId,retryOf,messageId);
    await ack('persisted');
    broadcast(threadId, userMessage);
    await recordArtifactBaseline(threadId, String(row.project_dir), turnId).catch((e:any)=>app.log.warn({ sessionId:threadId, error:e?.message || String(e) }, 'artifact baseline failed'));
    const subscription = ensureSessionSubscription(id, threadId);
    broadcast(threadId, { type:'runtimeConnection', status:runtimeConnectionStatus(subscription), error:subscription.lastError });
    await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[effectivePlanMode === 'plan' ? 'planning' : 'submitting',Date.now(),threadId]).catch(async () => {
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[effectivePlanMode === 'plan' ? 'planning' : 'running',Date.now(),threadId]);
    });
    await db.run(
      'UPDATE sessions SET selected_profile_id=?1,executing_profile_id=?1,last_execution_account_id=?1,account_snapshot_json=?2,updated_at=?3 WHERE codex_thread_id=?4 OR id=?4',
      [execution.executingProfileId, executionSnapshotJson, Date.now(), threadId]
    ).catch(()=>{});
    activeCodexSessions.add(threadId);
    try {
      app.log.info({
        localSessionId:threadId,
        creatorProfileId:row.creator_profile_id || row.account_id || null,
        selectedProfileId:execution.selectedProfileId,
        executingProfileId:execution.executingProfileId,
        upstreamBindingProfileId:row.upstream_binding_profile_id || row.current_upstream_account_id || null,
        providerSessionId:row.provider_session_id || row.upstream_thread_id || row.codex_thread_id || threadId,
        appServerUnit:execution.runtime.appServerUnit,
        endpoint:execution.runtime.endpoint,
        codexHome:execution.runtime.codexHome,
        account:execution.accountSnapshot,
      }, 'codex sendTurn execution profile selected');
      await runtime.startTurn(threadId, { input, text:providerText, planMode:effectivePlanMode, originalText, clientMessageId,messageId,segmentId,localTurnId:turnId,provisionalTurnId:turnId,retryOf,turnId,accountId:execution.executingProfileId, codexHome:execution.runtime.codexHome, accountSnapshot:execution.accountSnapshot, executionContext:execution, cwd:String(row.project_dir), approvalPolicy:planTurnOptions?.approvalPolicy || opts.approvalPolicy, sandboxMode:planTurnOptions?.sandboxMode || opts.sandboxMode, model:opts.model });
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[effectivePlanMode === 'plan' ? 'planning' : 'running',Date.now(),threadId]).catch(()=>{});
      await ack('accepted');
    } catch(e:any) {
      const message = e?.message || String(e);
      activeCodexSessions.delete(threadId);
      await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[submissionFailureStatus(row),Date.now(),threadId]).catch(()=>{});
      await ack('failed', message);
      maybeExitAfterDrain();
      throw e;
    }
    return;
  }
  await saveCanonicalUserMessage(threadId, originalText, attachments, clientMessageId, turnId,retryOf,messageId);
  await ack('persisted');
  broadcast(threadId, userMessage);
  await recordArtifactBaseline(threadId, String(row.project_dir), turnId).catch((e:any)=>app.log.warn({ sessionId:threadId, error:e?.message || String(e) }, 'artifact baseline failed'));
  await codex.resumeThread(threadId, String(row.project_dir), opts).catch(()=>null);
  await db.run(
    'UPDATE sessions SET status=?1,selected_profile_id=?2,executing_profile_id=?2,last_execution_account_id=?2,account_snapshot_json=?3,updated_at=?4 WHERE codex_thread_id=?5 OR id=?5',
    [effectivePlanMode === 'plan' ? 'planning' : 'running', execution.executingProfileId, executionSnapshotJson, Date.now(), threadId]
  );
  activeCodexSessions.add(threadId);
  try {
    await codex.startTurn(threadId, input, String(row.project_dir), planTurnOptions ? { ...opts, ...planTurnOptions } : opts);
    await ack('accepted');
  } catch(e:any) {
    activeCodexSessions.delete(threadId);
    await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['interrupted',Date.now(),threadId]).catch(()=>{});
    await ack('failed', e?.message || String(e));
    maybeExitAfterDrain();
    throw e;
  }
}
function submissionFailureStatus(row:any){const status=String(row?.status||'idle');return['running','planning','submitting','output_draining','waiting_approval','waiting_input','waiting_plan_approval','executing_approved_plan'].includes(status)?status:'failed';}
async function claimMessageReceipt(sessionId:string,clientMessageId:string,retryOf=''){
  if(retryOf)return claimRetryReceipt(db,sessionId,clientMessageId,retryOf);
  const now=Date.now();
  const result=await db.run("INSERT OR IGNORE INTO message_receipts(session_id,client_message_id,status,retry_of,created_at,updated_at) VALUES (?1,?2,'received',?3,?4,?4)",[sessionId,clientMessageId,retryOf||null,now]);
  if(result.changes)return{created:true,status:'received',error:null,canonicalClientMessageId:clientMessageId};
  const row=await db.get('SELECT status,error FROM message_receipts WHERE session_id=?1 AND client_message_id=?2',[sessionId,clientMessageId]);
  return{created:false,status:String(row?.status||'received'),error:row?.error||null,canonicalClientMessageId:clientMessageId};
}
async function updateMessageReceipt(sessionId:string,clientMessageId:string,status:string,error?:string){
  await db.run(`UPDATE message_receipts SET status=?1,error=?2,updated_at=?3 WHERE session_id=?4 AND client_message_id=?5${status==='accepted'?" AND status NOT IN ('failed','cancelled')":''}`,[status,error||null,Date.now(),sessionId,clientMessageId]);
  await db.run(`UPDATE agent_messages SET status=?1 WHERE session_id=?2 AND client_message_id=?3${status==='accepted'?" AND status NOT IN ('failed','cancelled')":''}`,[status,sessionId,clientMessageId]).catch(()=>{});
}
function canonicalUserMessageId(sessionId:string,clientMessageId:string){return`user-${crypto.createHash('sha256').update(`${sessionId}:${clientMessageId}`).digest('base64url').slice(0,24)}`;}
function canonicalUserBroadcast(threadId:string,text:string,attachments:any[],clientMessageId:string,turnId:string,retryOf:string,planMode:string){return{type:'user',messageId:canonicalUserMessageId(threadId,clientMessageId),clientMessageId,turnId,segmentId:turnId,retryOf:retryOf||undefined,createdAt:Date.now(),status:'persisted',planMode,text,attachments:attachments.map((a:any)=>({id:String(a.id),name:String(a.name||'attachment'),type:String(a.type||''),size:Number(a.size||0),url:`/api/sessions/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(String(a.id))}`}))};}
async function stopTurn(id:string){ const row = await findSession(id); const threadId = String(row?.codex_thread_id || id); if(USE_AGENT_RUNTIME&&normalizeProvider(row?.provider_id)==='antigravity'){await runtime.stopTurn(threadId);return;} if (USE_AGENT_RUNTIME) await runtime.stopTurn(threadId); else await interruptTurn(threadId, row?.project_dir ? String(row.project_dir) : undefined); activeCodexSessions.delete(threadId); activeRuntimeProviderSessions.delete(threadId); activeArtifactTurns.delete(threadId); await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['interrupted',Date.now(),threadId]); broadcast(threadId,{type:'system',text:'已停止生成'}); maybeExitAfterDrain(); }
async function saveCanonicalUserMessage(threadId:string, text:string, attachments:any[], clientMessageId = '', turnId = '', retryOf='', id:string = crypto.randomUUID(), createdAt = Date.now()) {
  if(canonicalMessageFaults>0){canonicalMessageFaults--;throw new Error('canonical user message persistence failed');}
  const safeAttachments = attachments.map((a:any)=>({ id:String(a.id), name:String(a.name || 'attachment'), type:String(a.type || ''), size:Number(a.size || 0), url:`/api/sessions/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(String(a.id))}` }));
  await db.run(
    `INSERT INTO agent_messages (id,session_id,role,text,created_at,client_message_id,turn_id,segment_id,retry_of,original_text,attachments_json,status)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?7,?8,?9,?10,?11)
     ON CONFLICT(session_id,client_message_id) WHERE client_message_id IS NOT NULL DO UPDATE SET
       text=excluded.text,
       original_text=excluded.original_text,
       attachments_json=excluded.attachments_json,
       turn_id=COALESCE(agent_messages.turn_id, excluded.turn_id),
       segment_id=COALESCE(agent_messages.segment_id, excluded.segment_id),
       retry_of=COALESCE(agent_messages.retry_of, excluded.retry_of),
       status=excluded.status`,
    [id, threadId, 'user', String(text || ''), createdAt, clientMessageId || null, turnId || null, retryOf||null, String(text || ''), JSON.stringify(safeAttachments), 'persisted']
  );
}
async function findCanonicalUserForRuntimeEvent(threadId:string, payload:any, text:string) {
  const clientMessageId = String(payload?.clientMessageId || payload?.client_message_id || '').trim();
  const messageId=String(payload?.messageId||payload?.message_id||'').trim(),turnId=String(payload?.turnId||payload?.params?.turn?.id||'').trim(),segmentId=String(payload?.segmentId||payload?.params?.segmentId||'').trim();
  if(messageId){const byMessage=await db.get(`SELECT * FROM agent_messages WHERE session_id=?1 AND role='user' AND id=?2`,[threadId,messageId]);if(byMessage)return byMessage;}
  if (clientMessageId) {
    const byClient = await db.get(
      `SELECT * FROM agent_messages WHERE session_id=?1 AND role='user' AND client_message_id=?2`,
      [threadId, clientMessageId]
    );
    if (byClient) return byClient;
  }
  if(turnId||segmentId){const byLineage=await db.get(`SELECT * FROM agent_messages WHERE session_id=?1 AND role='user' AND (turn_id=?2 OR segment_id=?3) ORDER BY created_at DESC,id DESC LIMIT 1`,[threadId,turnId||'__missing__',segmentId||'__missing__']);if(byLineage)return byLineage;}
  if(messageId||clientMessageId||turnId||segmentId)return null;
  const cleanText = stripProviderOnlyText(stripInternalAttachmentPrompt(String(text || ''))).trim();
  if (!cleanText) return null;
  return db.get(
    `SELECT * FROM agent_messages
     WHERE session_id=?1 AND role='user' AND TRIM(COALESCE(original_text,text,''))=?2
     ORDER BY created_at ASC
     LIMIT 1`,
    [threadId, cleanText]
  );
}
async function providerInputText(threadId:string, text:string, attachments:any[]) {
  const lines = [String(text || '')].filter(Boolean);
  if (!attachments.length) return lines.join('\n\n');
  const attachmentLines = ['Attachments are available to the provider as server-side resources. Use them only when needed:'];
  for (const a of attachments) {
    const meta = await readAttachmentMeta(threadId, String(a.id));
    attachmentLines.push(`- ${meta.name} | ${meta.type || meta.mime} | ${meta.size} bytes | resource:${meta.id}`);
  }
  lines.push(attachmentLines.join('\n'));
  return lines.join('\n\n');
}
function validAntigravityConversationId(value:any,localId:string){const id=String(value||'');return id!==localId&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)?id:null;}
async function antigravityLegacyHistory(threadId:string){return loadAntigravityLegacyHistory(db,threadId);}
async function antigravityAttachmentPaths(threadId:string,attachments:any[]){const out:any[]=[];for(const attachment of attachments){const meta=await readAttachmentMeta(threadId,String(attachment.id));out.push({id:String(meta.id||attachment.id),name:String(meta.name||attachment.name||'attachment'),mime:String(meta.mime||meta.type||''),size:Number(meta.size||0),path:String(meta.path)});}return out;}
function antigravityProviderInput(text:string,attachments:any[]){const lines=[String(text||'')];if(attachments.length){lines.push('Attachments are available at these verified local paths:');for(const item of attachments)lines.push(`- ${item.name} (${item.mime||'application/octet-stream'}): ${item.path}`);}return lines.filter(Boolean).join('\n\n');}
async function runtimeLatestSequence(threadId:string) {
  const row = await runtimeDb.get('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE session_id=?1', [threadId]);
  return Number(row?.sequence || 0);
}
async function currentCommit() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd:process.cwd(), maxBuffer:64 * 1024 });
    return stdout.trim() || 'unknown';
  } catch {
    return process.env.AGENTDECK_COMMIT || 'unknown';
  }
}
async function diagnosticSession() {
  const row = await runtimeDb.get(
    `SELECT id,status,active_turn_id,creator_profile_id,selected_profile_id,executing_profile_id,upstream_binding_profile_id,last_sequence,upstream_generation,provider_id,provider,updated_at
       FROM sessions
      ORDER BY CASE WHEN status IN ('running','submitting') THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1`
  ).catch(()=>null);
  if (!row) return null;
  return {
    currentSessionId:String(row.id || ''),
    currentTurnId:row.active_turn_id || null,
    provider:normalizeProvider(row.provider_id || row.provider) || 'codex',
    status:String(row.status || 'unknown'),
    creatorProfileId:row.creator_profile_id || null,
    selectedProfileId:row.selected_profile_id || null,
    executingProfileId:row.executing_profile_id || null,
    upstreamBindingProfileId:row.upstream_binding_profile_id || null,
    runtimeLatestSequence:Number(row.last_sequence || 0),
    runtimeGeneration:row.upstream_generation || null,
  };
}
function diagnosticCodexAppServer(profileId:string) {
  const safe = /^[a-f0-9]{16}$/i.test(profileId) || profileId === 'default' ? profileId : '';
  if (!safe) return null;
  return {
    unit: codexAppServerUnitName(safe),
    endpoint: codexAppServerEndpoint(safe),
    health: 'checked_by_runtime',
    providerProcessPid: null,
  };
}
async function inferredRuntimeStatus(threadId:string, fallback:string) {
  const row = await runtimeDb.get(
    `SELECT event_type,payload_json,sequence
     FROM events
     WHERE session_id=?1
       AND (event_type IN ('turn/completed','turn/failed','turn/interrupted')
         OR (event_type='item/completed' AND payload_json LIKE '%"phase":"final_answer"%'))
     ORDER BY sequence DESC
     LIMIT 1`,
    [threadId]
  );
  if (!row) return fallback;
  const eventType = String(row.event_type || '');
  let payload:any = {};
  try { payload = JSON.parse(String(row.payload_json || '{}')); } catch {}
  const method = String(payload?.method || eventType);
  if (method === 'turn/failed' || method === 'turn/interrupted') return 'interrupted';
  if (method === 'turn/completed') return turnFailed(payload?.params?.turn || payload?.turn) ? 'interrupted' : 'idle';
  const item = payload?.params?.item || payload?.item;
  if (eventType === 'item/completed' && item?.type === 'agentMessage' && item?.phase === 'final_answer' && String(item.text || '').trim()) return 'idle';
  return fallback;
}
// Only the ingestion lane may call this.  Browser delivery consumes the frames
// it produced; it never calls Runtime or repeats these projections.
async function ingestAndBuildRuntimeFrames(threadId:string,event:any) {
  const eventType = String(event.event_type || '');
  const runtimeSequence = Number(event.sequence || 0);
  const runtimeGeneration = String(event.generation || '');
  const base:any = { runtimeSequence, runtimeGeneration, threadId };
  let payload:any = {};
  try { payload = JSON.parse(String(event.payload_json || '{}')); } catch {}
  const eventTurnId=String(payload?.params?.turn?.id||payload?.result?.turn?.id||payload?.params?.turnId||payload?.turnId||payload?.segmentId||'');if(eventTurnId){base.turnId=eventTurnId;base.segmentId=String(payload?.segmentId||payload?.params?.segmentId||eventTurnId);}
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
    if (payload?.provider === 'claude') out.push({ type:'approval', requestId:payload?.approvalId || payload?.requestId, method:'claude/canUseTool', params:payload, ...base });
    else out.push({ type:'approval', requestId:payload?.requestId, method:'gemini/session/request_permission', params:payload?.request || {}, ...base });
    return out;
  }
  if (eventType === 'assistant/delta') {
    out.push({ type:'codex', method:'item/agentMessage/delta', params:{ itemId:payload?.itemId || `claude-${threadId}`, delta:String(payload?.delta || '') }, ...base });
    return out;
  }
  if (eventType === 'reasoning/delta') {
    out.push({ type:'activity', activityId:payload?.itemId || `thinking-${threadId}`, role:'reasoning', title:'正在思考', detail:'分析上下文并整理下一步', phase:'running', ...base });
    return out;
  }
  if (eventType === 'assistant/message') {
    out.push({type:'codex',method:'item/completed',params:{item:{id:payload?.itemId||`claude-message-${runtimeSequence}`,type:'agentMessage',turnId:payload?.turnId||base.turnId,segmentId:payload?.segmentId||base.segmentId,text:String(payload?.text||'')}},...base});
    return out;
  }
  if (eventType === 'assistant/final') {
    out.push({type:'codex',method:'item/completed',params:{item:{id:payload?.itemId||`claude-final-${runtimeSequence}`,type:'agentMessage',turnId:payload?.turnId||base.turnId,segmentId:payload?.segmentId||base.segmentId,phase:'final_answer',text:String(payload?.text||'')}},...base});
    return out;
  }
  if (eventType === 'tool/use') {
    out.push({ type:'codex', method:'item/completed', params:{ item:{ id:payload?.toolCallId || `claude-tool-${runtimeSequence}`, type:'toolCall', title:payload?.toolName || 'Claude tool', text:compactJson(payload?.input || {}) } }, ...base });
    return out;
  }
  if (eventType === 'tool/result') {
    out.push({ type:'codex', method:'item/completed', params:{ item:{ id:`${payload?.toolCallId || runtimeSequence}-result`, type:'toolResult', title:'Tool result', text:typeof payload?.content === 'string' ? payload.content : compactJson(payload?.content || {}) } }, ...base });
    return out;
  }
  if (eventType === 'claude/session_init') {
    out.push({ type:'system', text:`Claude Code 已初始化 · ${payload?.model || 'default'} · ${payload?.permissionMode || 'default'}`, ...base });
    return out;
  }
  if (eventType === 'system' && payload?.provider === 'claude') {
    out.push({ type:'system', text:String(payload?.text || ''), ...base });
    return out;
  }
  if (eventType === 'thread_snapshot') {
    const row = await findSession(threadId);
    const thread = payload?.thread;
    if (thread && row) {
      decorateThreadImages(thread, threadId, String(row.project_dir));
      await injectArtifacts(thread, threadId).catch(()=>{});
      await ensureCanonicalUsersInThreadSnapshot(thread, threadId).catch(()=>{});
      sanitizeThreadForMobile(thread);
    }
    out.push({ type:'thread_snapshot', thread, status:payload?.status, activeTurnId:payload?.activeTurnId || null, activeTurn:payload?.activeTurn || (payload?.activeTurnId ? { turnId:payload.activeTurnId, status:payload?.status || 'running' } : null), snapshot:{ generation:runtimeGeneration, coveredSequence:runtimeSequence, throughSequence:runtimeSequence, latestSequence:runtimeSequence }, ...base });
    out.push({ type:'runtimeConnection', status:'connected', ...base });
    return out;
  }
  if (eventType === 'output_gap') {
    out.push({ type:'runtimeConnection', status:'recovering', ...base });
    return out;
  }
  if (eventType === 'user') {
    const input = Array.isArray(payload?.input) ? payload.input : [];
    if (inputHasProviderOnlyRecovery(input)) return out;
    const text = input
      .filter((item:any) => item?.type === 'text')
      .map((item:any) => stripProviderOnlyText(stripInternalAttachmentPrompt(String(item.text || '').replace(MOBILE_CONTEXT_MARKER, ''))).trim())
      .filter(Boolean)
      .join('\n');
    const canonical = await findCanonicalUserForRuntimeEvent(threadId, payload, text).catch(()=>null);
    if (canonical) {
      out.push({ type:'user', messageId:String(canonical.id), clientMessageId:canonical.client_message_id || '', turnId:canonical.turn_id||payload?.turnId||'',segmentId:canonical.segment_id||canonical.turn_id||payload?.segmentId||payload?.turnId||'',retryOf:canonical.retry_of||undefined,createdAt:Number(canonical.created_at||0),status:canonical.status || 'persisted', text:stripInternalAttachmentPrompt(String(canonical.original_text || canonical.text || '')), attachments:userMessageAttachmentsFromRow(canonical), ...base });
    } else if (text) out.push({ type:'user',turnId:payload?.turnId||'',segmentId:payload?.segmentId||payload?.turnId||'',clientMessageId:payload?.clientMessageId||'', text, attachments:[], ...base });
    return out;
  }
  if (eventType === 'thread/read') return out;
  if (eventType === 'turn/start') {
    const turn = payload?.result?.turn || payload?.turn || null;
    if(turn?.id&&payload?.clientMessageId)await db.run('UPDATE agent_messages SET turn_id=?1 WHERE session_id=?2 AND client_message_id=?3',[String(turn.id),threadId,String(payload.clientMessageId)]).catch(()=>{});
    if (turn?.id) activeTurns.set(threadId, String(turn.id));
    out.push({ type:'codex', method:'turn/started', params:{ turn }, ...base });
    return out;
  }
  if (eventType.includes('/')) {
    const msg = payload?.method ? payload : { method:eventType, params:payload?.params || payload };
    const activity = compactCodexActivity(msg, base);
    if (activity) out.push(activity);
    if (shouldBroadcastCodexNotification(msg)) out.push({ type:'codex', method:msg.method, params:msg.params, ...base });
    if (msg.method === 'turn/started' && msg.params?.turn?.id) activeTurns.set(threadId, String(msg.params.turn.id));
    if (msg.method === 'turn/completed' || msg.method === 'turn/failed' || msg.method === 'turn/interrupted') {
      if(msg.method!=='turn/completed'&&payload?.clientMessageId){const deliveryError=String(msg.params?.error?.message||msg.method);await updateMessageReceipt(threadId,String(payload.clientMessageId),'failed',deliveryError).catch(()=>{});out.push({type:'messageStatus',clientMessageId:String(payload.clientMessageId),status:'failed',error:deliveryError,...base});}
      const artifactTurnId=String(msg.params?.turn?.id||payload?.params?.turn?.id||payload?.turnId||'')||activeArtifactTurns.get(threadId)||activeTurns.get(threadId)||'';
      activeCodexSessions.delete(threadId);
      activeRuntimeProviderSessions.delete(threadId);
      activeTurns.delete(threadId);
      activeArtifactTurns.delete(threadId);
      const row = await findSession(threadId);
      const read = msg.method === 'turn/completed' && row ? await runtime.readSession(threadId).catch(()=>null) : null;
      const anchorItemId = read?.thread ? latestAgentItemIdFromThread(read.thread) : null;
      const found = msg.method === 'turn/completed' && row ? await scanArtifactsForTurn(threadId, String(row.project_dir), artifactTurnId, anchorItemId) : {artifacts:[],codeChanges:[]};
      const wasPlanning = String(row?.status || '') === 'planning';
      const nextStatus = msg.method === 'turn/completed' && !turnFailed(msg.params?.turn) ? 'idle' : 'interrupted';
      if (wasPlanning && msg.method === 'turn/completed' && !turnFailed(msg.params?.turn)) await completePlanTask(threadId, '', '', found.artifacts);
      if (!wasPlanning) await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[nextStatus,Date.now(),threadId]);
      if (found.artifacts.length) out.push({ type:'codex', method:'item/completed', params:{ item:artifactMessageItem(found.artifacts, Date.now()) }, ...base });
      if(found.codeChanges.length)out.push({type:'codex',method:'item/completed',params:{item:codeChangesItem(artifactTurnId,found.codeChanges)},...base});
      maybeExitAfterDrain();
    }
    if (msg.method === 'item/completed' && isFinalAnswerItem(msg.params?.item)) {
      activeCodexSessions.delete(threadId);
      activeTurns.delete(threadId);
      const row = await findSession(threadId);
      if (String(row?.status || '') === 'planning') {
        await completePlanTask(threadId, String(msg.params.item.text || ''), String(msg.params.item.id || ''), []);
      } else {
        await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['idle',Date.now(),threadId]);
      }
      maybeExitAfterDrain();
    }
    if (msg.method === 'thread/status/changed') {
      const rawStatus = rawStatusName(msg.params?.status);
      const row = rawStatus === 'active' ? await findSession(threadId).catch(()=>null) : null;
      const currentRow = row || await findSession(threadId).catch(()=>null);
      if (['planning','waiting_plan_approval','executing_approved_plan'].includes(String(currentRow?.status || ''))) return out;
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
function autoTitle(text:string,cwd:string,current:string){const base=path.basename(cwd).trim().toLocaleLowerCase();const value=current.trim().toLocaleLowerCase();const generic=new Set([base,'default workspace','default-workspace','session','new task','new-task','untitled','新任务']);if(!generic.has(value))return null;const raw=text.split(/\r?\n/).map(s=>s.trim()).find(Boolean)||'';const cleaned=raw.replace(/\s+/g,' ').replace(/^#+\s*/,'').trim();if(!cleaned)return null;return cleaned.slice(0,42);}
function startChunkedMessage(msg:any){ const id = String(msg.messageId || ''); const sessionId = String(msg.sessionId || ''); if (!id || !sessionId) throw new Error('bad chunked message'); chunkedMessages.set(id, { sessionId, clientMessageId:String(msg.clientMessageId || id), chunks: [], size: 0, createdAt: Date.now() }); cleanupChunkedMessages(); }
function appendChunkedMessage(msg:any){ const id = String(msg.messageId || ''); const state = chunkedMessages.get(id); if (!state) throw new Error('chunked message not found'); const chunk = String(msg.chunk || ''); state.size += Buffer.byteLength(chunk); if (state.size > 25 * 1024 * 1024) { chunkedMessages.delete(id); throw new Error('message too large'); } state.chunks.push(chunk); }
async function finishChunkedMessage(msg:any){ const id = String(msg.messageId || ''); const state = chunkedMessages.get(id); if (!state) throw new Error('chunked message not found'); chunkedMessages.delete(id); const payload = JSON.parse(state.chunks.join('')); await sendTurn(state.sessionId, String(payload.text || ''), Array.isArray(payload.attachments) ? payload.attachments : [], state.clientMessageId, payload.planMode === 'plan' ? 'plan' : 'direct',String(payload.retryOf||'')); }
function cleanupChunkedMessages(){ const cutoff = Date.now() - 10 * 60 * 1000; for (const [id, state] of chunkedMessages) if (state.createdAt < cutoff) chunkedMessages.delete(id); }
function cleanupPendingApprovals(){ const cutoff = Date.now() - 10 * 60 * 1000; for (const [id, state] of pendingApprovals) if (state.createdAt < cutoff) pendingApprovals.delete(id); }
function statusName(status:any){ if (!status) return 'idle'; const value = rawStatusName(status); return value === 'active' ? 'idle' : value; }
function rawStatusName(status:any){ if (!status) return 'idle'; return typeof status === 'string' ? status : status.type || 'idle'; }
function isFinalAnswerItem(item:any){ return item?.type === 'agentMessage' && item?.phase === 'final_answer' && String(item?.text || '').trim(); }
function turnFailed(turn:any){ const status=String(turn?.status || ''); return status === 'failed' || status === 'interrupted'; }
function compactJson(value:any){ try { return JSON.stringify(value).slice(0, 500); } catch { return String(value).slice(0, 500); } }
function approvalResponse(method:string, decision:'accept'|'decline' = 'accept'){
  if (method.includes('permissions')) return decision === 'decline'
    ? { permissions:{}, scope:'turn' }
    : { permissions:{ network:null, fileSystem:null }, scope:'session' };
  if (method.includes('fileChange')) return { decision };
  return { decision };
}
type PlanModeState = 'none' | 'planning' | 'awaiting_approval' | 'executing' | 'completed' | 'cancelled' | 'failed';
function parsePlanSubmission(text:string, requestedMode:'direct'|'plan') {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const command = raw.match(/^\s*(?:\/plan|\$plan)\b(?:[ \t]*(?:\n)?([\s\S]*))?$/i);
  const commandText = command ? String(command[1] || '').trimStart() : raw;
  return {
    planMode: (requestedMode === 'plan' || !!command) ? 'plan' as const : 'direct' as const,
    originalText: command ? commandText : raw,
  };
}
function planOnlyPrompt(text:string) {
  return [
    '$plan',
    '',
    'AgentDeck Plan Mode is active. Inspect the repository and reason about the task, but do not modify files, run write commands, install dependencies, commit, push, deploy, restart services, or change external state.',
    'The runtime enforces read-only execution for this planning turn. If implementation is needed, describe the intended changes and validation steps instead of making them.',
    'Ask concise clarifying questions only when the task cannot be planned safely from the available context. Otherwise produce a practical implementation plan that the user can review, refine, or approve for execution.',
    'Include the likely files, key changes, risks, and validation approach when they are relevant. Keep the structure natural for the task instead of forcing a fixed template.',
    '',
    '用户原始任务：',
    String(text || ''),
  ].join('\n');
}
function approvedPlanPrompt(originalTask:string, planText:string, note = '') {
  return [
    'Implement the approved plan from the previous Plan Mode review.',
    '',
    'Original task:',
    originalTask,
    '',
    'Approved plan:',
    planText,
    note ? `\nAdditional instruction from the user:\n${note}` : '',
  ].filter(Boolean).join('\n');
}
function revisePlanPrompt(originalTask:string, planText:string, note = '') {
  return [
    'Revise the previous Plan Mode proposal. Stay in Plan Mode and do not modify files.',
    '',
    'Original task:',
    originalTask,
    '',
    'Previous plan:',
    planText,
    '',
    'Requested changes:',
    note || 'Improve the plan based on the current conversation.',
  ].join('\n');
}
function regeneratePlanPrompt(originalTask:string, planText:string, note = '') {
  return [
    'Regenerate the Plan Mode proposal from scratch. Stay in Plan Mode and do not modify files.',
    '',
    'Original task:',
    originalTask,
    '',
    'Prior plan to reconsider:',
    planText,
    '',
    'User guidance:',
    note || 'Create a clearer implementation and validation plan.',
  ].join('\n');
}
async function createPlanTask(sessionId:string, originalUserTask:string, row:any) {
  const planId = `plan-${crypto.randomUUID()}`;
  const now = Date.now();
  await db.run(
    `INSERT INTO plan_tasks (plan_id,session_id,original_user_task,status,created_at,provider,model)
     VALUES (?1,?2,?3,'planning',?4,?5,?6)`,
    [planId, sessionId, originalUserTask, now, normalizeProvider(row?.provider_id) || 'codex', cleanAgentModel(row?.model) || null]
  ).catch(()=>{});
  return planId;
}
async function failPlanningTask(sessionId:string, error:string) {
  if (!sessionId) return;
  const now=Date.now();
  const failed:any=await db.run("UPDATE plan_tasks SET status='failed',policy_violation=COALESCE(policy_violation,?1) WHERE session_id=?2 AND status='planning'", [String(error || 'Plan generation failed').slice(0,500),sessionId]).catch(()=>null);
  if (!Number(failed?.changes || 0)) return;
  await db.run("UPDATE sessions SET status='interrupted',updated_at=?1 WHERE (id=?2 OR codex_thread_id=?2) AND status='planning'", [now,sessionId]).catch(()=>{});
  broadcast(sessionId,{type:'system',text:'计划生成失败，可以修改描述后重试'});
}
async function restorePlanReviewAfterFailure(requestId:string, sessionId:string, planId:string, error:unknown) {
  const now=Date.now();
  await db.run("UPDATE interactive_requests SET status='pending',answer_json=NULL,answered_at=NULL WHERE request_id=?1", [requestId]).catch(()=>{});
  await db.run("UPDATE plan_tasks SET status='awaiting_approval',policy_violation=COALESCE(policy_violation,?1) WHERE plan_id=?2", [`Plan follow-up failed: ${String((error as any)?.message || error).slice(0,400)}`,planId]).catch(()=>{});
  await db.run("UPDATE sessions SET status='waiting_plan_approval',updated_at=?1 WHERE id=?2 OR codex_thread_id=?2", [now,sessionId]).catch(()=>{});
  const restored=await db.get('SELECT * FROM interactive_requests WHERE request_id=?1',[requestId]).catch(()=>null);
  if (restored) broadcast(sessionId,{type:'interactive_request',request:interactiveRequestDto(restored)});
}
async function completePlanTask(sessionId:string, planText:string, assistantMessageId:string, changedFiles:any[] = []) {
  const row = await db.get("SELECT * FROM plan_tasks WHERE session_id=?1 AND status='planning' ORDER BY created_at DESC LIMIT 1", [sessionId]).catch(()=>null);
  if (!row) return;
  const changed = changedFiles.map((file:any)=>String(file?.relativePath || file?.name || file?.path || '')).filter(Boolean);
  if (!String(planText || '').trim() && !String(assistantMessageId || '').trim() && !changed.length) return;
  const violation = changed.length ? 'Plan mode produced workspace changes during a read-only turn.' : null;
  await db.run(
    `UPDATE plan_tasks
     SET status='completed', approved_plan_text=COALESCE(NULLIF(?1,''), approved_plan_text), plan_assistant_message_id=COALESCE(NULLIF(?2,''), plan_assistant_message_id), executed_at=?3, changed_files_json=?4, diff_summary=?5, policy_violation=?6
     WHERE plan_id=?7`,
    [planText, assistantMessageId, Date.now(), JSON.stringify(changed), changed.length ? changed.join('\n') : null, violation, row.plan_id]
  ).catch(()=>{});
  if (!changed.length) await createPlanReviewRequest(sessionId, String(row.plan_id || ''), assistantMessageId, planText).catch(()=>{});
}
async function createPlanReviewRequest(sessionId:string, planId:string, assistantMessageId:string, planText:string) {
  const existing = await db.get("SELECT request_id FROM interactive_requests WHERE session_id=?1 AND kind='plan_review' AND status='pending' ORDER BY created_at DESC LIMIT 1", [sessionId]).catch(()=>null);
  if (existing) return;
  const requestId = `plan-review-${crypto.randomUUID()}`;
  const now = Date.now();
  const options = [
    { id:'approve', label:'开始实现', description:'按这份计划继续执行当前任务。', variant:'primary' },
    { id:'revise', label:'调整计划', description:'带着你的补充要求重新规划。' },
    { id:'regenerate', label:'重新生成', description:'丢开当前方案，从头生成一版计划。' },
    { id:'cancel', label:'取消', description:'结束本次计划流程。', variant:'danger' },
  ];
  await db.run(
    `INSERT INTO interactive_requests (request_id,session_id,turn_id,provider_id,kind,title,body,options_json,allow_free_text,default_option_id,status,metadata_json,created_at)
     VALUES (?1,?2,?3,'codex','plan_review','计划已生成',?4,?5,1,'approve','pending',?6,?7)`,
    [requestId, sessionId, assistantMessageId, planText, JSON.stringify(options), JSON.stringify({ planId }), now]
  );
  await db.run('UPDATE plan_tasks SET status=?1 WHERE plan_id=?2', ['awaiting_approval', planId]).catch(()=>{});
  await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3', ['waiting_plan_approval', now, sessionId]).catch(()=>{});
  broadcast(sessionId, { type:'interactive_request', request:interactiveRequestDto(await db.get('SELECT * FROM interactive_requests WHERE request_id=?1', [requestId])) });
}
async function recordPlanPolicyViolation(sessionId:string, message:string) {
  await db.run(
    `UPDATE plan_tasks
     SET policy_violation=COALESCE(policy_violation || char(10), '') || ?1
     WHERE plan_id=(SELECT plan_id FROM plan_tasks WHERE session_id=?2 AND status='planning' ORDER BY created_at DESC LIMIT 1)`,
    [message, sessionId]
  ).catch(()=>{});
}
function interactiveRequestDto(row:any) {
  let options:any[] = [];
  let answer:any = undefined;
  let metadata:any = undefined;
  try { options = JSON.parse(String(row?.options_json || '[]')); } catch {}
  try { answer = row?.answer_json ? JSON.parse(String(row.answer_json)) : undefined; } catch {}
  try { metadata = row?.metadata_json ? JSON.parse(String(row.metadata_json)) : undefined; } catch {}
  return { requestId:String(row.request_id), sessionId:String(row.session_id), turnId:String(row.turn_id || ''), providerId:normalizeProvider(row.provider_id) || 'codex', kind:String(row.kind), title:String(row.title || ''), body:String(row.body || ''), options, allowFreeText:!!row.allow_free_text, defaultOptionId:row.default_option_id || undefined, status:String(row.status || 'pending'), createdAt:Number(row.created_at || 0), answeredAt:row.answered_at ? Number(row.answered_at) : undefined, answer, metadata };
}
async function listInteractiveRequests(sessionId:string, status = 'pending') {
  const rows = await db.all('SELECT * FROM interactive_requests WHERE session_id=?1 AND status=?2 ORDER BY created_at ASC', [sessionId, status]).catch(()=>[]);
  return rows.map(interactiveRequestDto);
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
  for(const id of unique) deleteSessionRelations(db,id,'DELETE FROM sessions WHERE id=?1 OR codex_thread_id=?1 OR provider_session_id=?1',['turn_code_changes']);
  for (const id of unique) {
    result.webRows++;
    if(USE_AGENT_RUNTIME)await runtime.deleteSession(id).catch((error:any)=>{if(error?.statusCode!==404)throw error;});
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
  const before = await database.get('SELECT COUNT(*) AS count FROM sessions WHERE id=?1 OR codex_thread_id=?1 OR provider_session_id=?1' + (includeUpstream ? ' OR upstream_thread_id=?1' : ''), [id]);
  await database.run('DELETE FROM sessions WHERE id=?1 OR codex_thread_id=?1 OR provider_session_id=?1' + (includeUpstream ? ' OR upstream_thread_id=?1' : ''), [id]);
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
async function buildCodexTurnInput(threadId:string,text:string,attachments:any[]){
  if(attachments.length>MAX_ATTACHMENTS_PER_MESSAGE)throw Object.assign(new Error(`最多添加 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`),{statusCode:413});
  const ids=new Set<string>(),metas:any[]=[];let total=0;
  for(const attachment of attachments){
    const id=String(attachment?.id||'');
    if(!id||ids.has(id))throw Object.assign(new Error('附件 ID 无效或重复'),{statusCode:400});
    ids.add(id);
    const meta=await readAttachmentMeta(threadId,id);
    total+=Number(meta.size||0);
    if(total>MAX_TOTAL_ATTACHMENT_BYTES)throw Object.assign(new Error(`附件总大小超过 ${MAX_TOTAL_ATTACHMENT_BYTES} bytes`),{statusCode:413});
    metas.push(meta);
  }
  const input:any[]=[];
  if(text.trim())input.push({type:'text',text,text_elements:[]});
  for(const meta of metas){
    if(String(meta.kind||'').startsWith('image')||String(meta.type||meta.mime||'').startsWith('image/'))input.push({type:'localImage',path:meta.path,detail:'high'});
    else input.push({type:'text',text:`Attachment: ${meta.name}\nMIME: ${meta.type||meta.mime}\nSize: ${meta.size} bytes\nLocal path: ${meta.path}\nRead this file from the local path if needed.`,text_elements:[]});
  }
  if(!input.length)throw new Error('empty message');
  return input;
}
async function buildClaudeTurnInput(threadId:string, text:string, attachments:any[]){
  const input:any[] = [];
  if (text.trim()) input.push({ type:'text', text, text_elements: [] });
  for (const a of attachments) {
    const meta = await readAttachmentMeta(threadId, String(a.id));
    input.push({
      type:'attachment_path',
      id:String(meta.id),
      name:String(meta.name || 'attachment'),
      mime:String(meta.type || meta.mime || ''),
      kind:String(meta.kind || ''),
      size:Number(meta.size || 0),
      path:String(meta.path),
    });
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
  const dir = path.join(attachmentSessionDir(threadId), attachmentId);
  const tmpDir = path.join(ATTACHMENTS_DIR, '.tmp');
  await mkdir(dir, { recursive:true, mode:0o700 });
  await mkdir(tmpDir, { recursive:true, mode:0o700 });
  const tmp = path.join(tmpDir, `${attachmentId}.upload`);
  let size = 0;
  part.file.on('data', (chunk:Buffer) => { size += chunk.length; });
  try {
    await pipeline(part.file, createWriteStream(tmp, { flags:'wx', mode:0o600 }));
    if(part.file.truncated)throw Object.assign(new Error(`file exceeds ${MAX_ATTACHMENT_BYTES} bytes`),{statusCode:413});
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
  const handle=await open(filePath,'r');
  try{const buffer=Buffer.allocUnsafe(Math.max(0,bytes));const {bytesRead}=await handle.read(buffer,0,buffer.length,0);return buffer.subarray(0,bytesRead);}
  finally{await handle.close();}
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
  const dir = attachmentSessionDir(threadId);
  const nested = path.join(dir, attachmentId, 'meta.json');
  const legacy = path.join(dir, `${attachmentId}.json`);
  const meta = JSON.parse(await readFile(existsSync(nested) ? nested : legacy, 'utf8'));
  const rp = realpathSync(String(meta.path||''));
  const root = realpathSync(dir);
  if (!rp.startsWith(root + path.sep)) throw new Error('attachment outside session');
  return { ...meta, type:meta.type || meta.mime, mime:meta.mime || meta.type, path: rp };
}
function attachmentSessionDir(threadId:string){
  const root=path.resolve(ATTACHMENTS_DIR),dir=path.resolve(root,String(threadId||''));
  if(!threadId||!dir.startsWith(root+path.sep))throw new Error('invalid attachment session path');
  return dir;
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
function attachmentUrlFromPath(threadId:string, filePath:string){ try { const root = realpathSync(attachmentSessionDir(threadId)); const rp = realpathSync(filePath); if (!rp.startsWith(root + path.sep)) return null; const id = path.basename(rp).replace(/\.[^.]+$/, ''); return `/api/sessions/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(id)}`; } catch { return null; } }
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
        item.content = (item.content || []).map((c:any) => c?.type === 'text' ? { ...c, text:stripProviderOnlyText(stripInternalAttachmentPrompt(String(c.text || ''))) } : c)
          .filter((c:any) => !(c.type === 'text' && (String(c.text || '').includes(MOBILE_CONTEXT_MARKER) || String(c.text || '').includes(RECOVERY_CONTEXT_MARKER))));
      }
    }
    turn.items = (turn.items || []).filter((item:any) => {
      if (!item?.type) return false;
      if (item.type === 'userMessage') return (item.content || []).some((c:any) => (c.type === 'text' && String(c.text || '').trim()) || c.type === 'image' || c.type === 'localImage');
      if (item.type === 'agentMessage') return !!String(item.text || '').trim();
      if (item.type === 'imageView' || item.type === 'imageGeneration') return true;
      if (item.type === 'artifactCollection') return Array.isArray(item.artifacts) && item.artifacts.length > 0;
      if (item.type === 'codeChanges') return Array.isArray(item.changes) && item.changes.length > 0;
      return false;
    });
  }
}
async function ensureCanonicalUsersInThreadSnapshot(thread:any, threadId:string) {
  const canonicalUsers = await db.all(
    `SELECT * FROM (
       SELECT * FROM agent_messages
       WHERE session_id=?1 AND role='user'
       ORDER BY created_at DESC, id DESC
       LIMIT 80
     ) ORDER BY created_at ASC, id ASC`,
    [threadId]
  ).catch(()=>[]);
  if (!canonicalUsers.length) return;
  const existing = new Set<string>();
  for (const turn of thread?.turns || []) {
    for (const item of turn.items || []) {
      if (item?.type !== 'userMessage') continue;
      if (item.id) existing.add(`id:${String(item.id)}`);
      if (item.clientMessageId) existing.add(`client:${String(item.clientMessageId)}`);
      const text = userMessageItemText(item);
      if (text) existing.add(`text:${text}`);
    }
  }
  const missing = canonicalUsers.filter((row:any) => {
    const id = String(row.id || '');
    const client = String(row.client_message_id || '');
    const text = normalizeUserSnapshotText(String(row.original_text || row.text || ''));
    const stable=!!(id||client);
    return !(id && existing.has(`id:${id}`)) && !(client && existing.has(`client:${client}`)) && !(!stable&&text&&existing.has(`text:${text}`));
  });
  if (!missing.length) return;
  if (!Array.isArray(thread.turns)) thread.turns = [];
  for(const row of missing){const turnId=String(row.turn_id||row.segment_id||'');let target=turnId?thread.turns.find((turn:any)=>String(turn?.id||turn?.turnId||'')===turnId):null;if(!target){const createdAt=Number(row.created_at||Date.now());target={id:turnId||`canonical-${row.id}`,turnId:turnId||null,userMessageIds:[String(row.id)],items:[],startedAt:Math.floor(createdAt/1000)};insertCanonicalTurnChronologically(thread.turns,target,createdAt);}else target.userMessageIds=Array.from(new Set([...(target.userMessageIds||[]),String(row.id)]));if(!Array.isArray(target.items))target.items=[];target.items.unshift(canonicalUserMessageItem(row));}
}
function insertCanonicalTurnChronologically(turns:any[], target:any, createdAt:number) {
  const index=turns.findIndex((turn:any)=>{const raw=turn?.startedAt??turn?.createdAt;const numeric=Number(raw);const timestamp=Number.isFinite(numeric)&&numeric>0?(numeric>1e12?numeric:numeric*1000):(typeof raw==='string'?Date.parse(raw):NaN);return Number.isFinite(timestamp)&&timestamp>=createdAt;});
  if(index<0)turns.push(target);else turns.splice(index,0,target);
}
function userMessageItemText(item:any) {
  const content = Array.isArray(item?.content) ? item.content : [];
  return normalizeUserSnapshotText(content.filter((part:any) => part?.type === 'text').map((part:any) => part.text || '').join('\n'));
}
function normalizeUserSnapshotText(text:string) {
  return stripProviderOnlyText(stripInternalAttachmentPrompt(String(text || ''))).replace(/\s+/g, ' ').trim();
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
async function recordArtifactBaseline(threadId:string, projectDir:string, turnId:string) {
  if (!turnId || !pathAllowed(projectDir)) return;
  const root = realpathSync(projectDir);
  const artifacts = await artifactManifest(root),workspace=await workspaceChangeManifest(root);
  await db.run(
    'INSERT OR REPLACE INTO artifact_baselines (session_id,turn_id,project_dir,manifest_json,created_at) VALUES (?1,?2,?3,?4,?5)',
    [threadId, turnId, root, JSON.stringify({version:2,artifacts,workspace}), Date.now()]
  );
}
async function latestArtifactBaseline(threadId:string) {
  const row = await db.get('SELECT * FROM artifact_baselines WHERE session_id=?1 ORDER BY created_at DESC LIMIT 1', [threadId]);
  if (!row) return null;
  let manifest:any = {};
  try { manifest = JSON.parse(String(row.manifest_json || '{}')); } catch {}
  return { turnId:String(row.turn_id), projectDir:String(row.project_dir), manifest:manifest?.version===2?manifest.artifacts||{}:manifest, workspace:manifest?.version===2?manifest.workspace||null:null };
}
async function scanArtifactsForTurn(threadId:string, projectDir:string, turnId?:string|null, anchorItemId?:string|null){
  if (!anchorItemId || !turnId) return {artifacts:[],codeChanges:[]};
  const baseline = turnId ? await db.get('SELECT * FROM artifact_baselines WHERE session_id=?1 AND turn_id=?2', [threadId, turnId]).then((row:any)=>{
    if (!row) return null;
    let manifest:any = {};
    try { manifest = JSON.parse(String(row.manifest_json || '{}')); } catch {}
    return { turnId:String(row.turn_id), projectDir:String(row.project_dir), manifest:manifest?.version===2?manifest.artifacts||{}:manifest, workspace:manifest?.version===2?manifest.workspace||null:null };
  }) : null;
  if (!baseline) return {artifacts:[],codeChanges:[]};
  const root = realpathSync(projectDir);
  const before = baseline.manifest || {};
  const after = await artifactManifest(root,before);
  const saved:any[] = [];
  const eligibleChanged = Object.values(after).map((f:any) => {
    const old = before[f.relativePath];
    const operation = !old ? 'created' : (artifactContentChanged(old,f) ? 'modified' : '');
    return operation ? { ...f, operation } : null;
  }).filter((f:any)=>f&&artifactEligibleForDownload(f.relativePath,f.operation));
  const downloadableCreatedPaths=new Set(eligibleChanged.filter((f:any)=>f.operation==='created').map((f:any)=>String(f.relativePath)));
  const changed=eligibleChanged.sort((a:any,b:any)=>Number(a.modifiedAt)-Number(b.modifiedAt)).slice(-12);
  for (const f of changed as any[]) {
    if (artifactPathIsInternal(f.relativePath)) continue;
    const id = crypto.createHash('sha256').update(`${threadId}\0${baseline.turnId}\0${f.relativePath}\0${f.operation}`).digest('base64url').slice(0, 32);
    const existed = await db.get('SELECT id FROM artifacts WHERE id=?1 AND session_id=?2', [id, threadId]);
    await db.run(
      `INSERT INTO artifacts (id, session_id, path, name, mime, size, created_at, anchor_item_id, turn_id, relative_path, content_hash, modified_at, operation)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
       ON CONFLICT(session_id, turn_id, relative_path, operation) DO UPDATE SET
         id=excluded.id,
         path=excluded.path,
         name=excluded.name,
         mime=excluded.mime,
         size=excluded.size,
         created_at=excluded.created_at,
         anchor_item_id=COALESCE(excluded.anchor_item_id, artifacts.anchor_item_id),
         content_hash=excluded.content_hash,
         modified_at=excluded.modified_at`,
      [id, threadId, f.path, f.name, f.mime, f.size, Date.now(), anchorItemId || null, baseline.turnId, f.relativePath, f.contentHash, f.modifiedAt, f.operation]
    );
    if (anchorItemId) await db.run('UPDATE artifacts SET anchor_item_id=?1 WHERE id=?2 AND anchor_item_id IS NULL', [anchorItemId, id]);
    if (existed) continue;
    const row = await artifactForSession(threadId, id);
    if (row) saved.push(artifactDto(row));
  }
  const codeChanges=baseline.workspace?workspaceCodeChangesForDisplay(baseline.workspace,await workspaceChangeManifest(root,baseline.workspace),downloadableCreatedPaths):[];
  if(codeChanges.length)await db.run(`INSERT INTO turn_code_changes(session_id,turn_id,anchor_item_id,changes_json,created_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(session_id,turn_id) DO UPDATE SET anchor_item_id=excluded.anchor_item_id,changes_json=excluded.changes_json,created_at=excluded.created_at`,[threadId,baseline.turnId,anchorItemId||null,JSON.stringify(codeChanges),Date.now()]);else await db.run('DELETE FROM turn_code_changes WHERE session_id=?1 AND turn_id=?2',[threadId,baseline.turnId]);
  return {artifacts:saved,codeChanges};
}
async function artifactManifest(root:string,previous?:Record<string,any>){return buildArtifactManifest(root,{types:ARTIFACT_TYPES,skipDirs:ARTIFACT_SKIP_DIRS,isInternal:artifactPathIsInternal,previous});}
async function workspaceChangeManifest(root:string,previous?:Record<string,any>){return buildArtifactManifest(root,{types:ARTIFACT_TYPES,skipDirs:ARTIFACT_SKIP_DIRS,isInternal:artifactPathIsInternal,previous,includeAll:true,maxFiles:5000,maxDepth:12,maxBytes:5*1024*1024});}
function artifactPathIsInternal(relativePath:string) {
  const parts = String(relativePath || '').split(path.sep).filter(Boolean);
  const base = parts[parts.length - 1] || '';
  if (!parts.length) return true;
  if (parts.includes('deploy-state') || parts.includes('releases') || parts.includes('candidate') || parts.includes('current') || parts.includes('previous')) return true;
  if (parts.includes('node_modules') || parts.includes('.git') || parts.includes('coverage') || parts.includes('dist') || parts.includes('build')) return true;
  if (isArtifactTestAssetPath(relativePath)) return true;
  if (/^deploy-.*\.(log|json)$/i.test(base) || base === 'deploy-manifest.json') return true;
  if (/\.(sqlite|sqlite3|db|db-wal|db-shm|sqlite-wal|sqlite-shm)$/i.test(base)) return true;
  return false;
}
async function injectArtifacts(thread:any, threadId:string){
  const rows = (await db.all('SELECT * FROM artifacts WHERE session_id=?1 AND anchor_item_id IS NOT NULL ORDER BY created_at ASC LIMIT 100', [threadId])).filter((row:any)=>artifactEligibleForDownload(String(row.relative_path||row.name),String(row.operation||'created')));
  const codeRows=await db.all('SELECT * FROM turn_code_changes WHERE session_id=?1 AND anchor_item_id IS NOT NULL ORDER BY created_at ASC LIMIT 100',[threadId]);
  if (!rows.length&&!codeRows.length) return;
  if (!thread.turns) thread.turns = [];
  const groups = groupArtifacts(rows);
  for (const group of groups) {
    const newest = Math.max(...group.map((row:any)=>Number(row.created_at || Date.now())));
    const turn = { items:[artifactMessageItem(group.map(artifactDto), newest)], startedAt:Math.floor(newest/1000), completedAt:Math.floor(newest/1000), durationMs:null };
    const insertAfter = turnIndexForAnchor(thread.turns, group[0]?.anchor_item_id);
    if (insertAfter !== null && insertAfter >= 0) thread.turns.splice(insertAfter + 1, 0, turn);
    else thread.turns.push(turn);
  }
  for(const row of codeRows){let changes:any[]=[];try{changes=JSON.parse(String(row.changes_json||'[]'));}catch{}if(!changes.length)continue;const stamp=Number(row.created_at||Date.now()),turn={items:[codeChangesItem(String(row.turn_id),changes)],startedAt:Math.floor(stamp/1000),completedAt:Math.floor(stamp/1000),durationMs:null},insertAfter=turnIndexForAnchor(thread.turns,row.anchor_item_id);if(insertAfter!==null&&insertAfter>=0)thread.turns.splice(insertAfter+1,0,turn);else thread.turns.push(turn);}
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
function artifactDto(row:any){ return { id:String(row.id), name:String(row.name), type:String(row.mime), size:Number(row.size || 0), operation:String(row.operation || 'created'), relativePath:row.relative_path || null, turnId:row.turn_id || null, anchorItemId:row.anchor_item_id || null, contentHash:row.content_hash || null, url:`/api/sessions/${encodeURIComponent(String(row.session_id))}/files/${encodeURIComponent(String(row.id))}` }; }
function artifactMessageItem(artifacts:any[], stamp:number){
  return { type:'artifactCollection', id:`artifacts-${stamp}`, title:'可下载文件', artifacts };
}
function codeChangesItem(turnId:string,changes:any[]){return{type:'codeChanges',id:`code-changes-${turnId}`,title:'本轮代码变更',changes};}
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
    const item = msg.params?.item;
    const type = item?.type;
    if (!['userMessage','agentMessage','imageView','imageGeneration'].includes(type)) return false;
    if (type === 'userMessage' && itemHasProviderOnlyRecovery(item)) return false;
    if (type === 'agentMessage' && !String(msg.params?.item?.text || '').trim()) return false;
  }
  if (msg.method && (msg.method.includes('fileChange') || msg.method.includes('command'))) return false;
  return true;
}
function compactCodexActivity(msg:any, base:Record<string,any> = {}) {
  const method = String(msg?.method || '');
  const item = msg?.params?.item || {};
  const type = String(item?.type || '');
  const activityId = String(item?.id || msg?.params?.itemId || '');
  if (!activityId) return null;
  const turnId=String(item?.turnId||msg?.params?.turnId||msg?.turnId||base.turnId||''),segmentId=String(item?.segmentId||msg?.params?.segmentId||msg?.segmentId||base.segmentId||turnId),phase=structuredActivityPhase(item?.status||msg?.params?.status,method);
  if (type === 'commandExecution' || method.includes('commandExecution')) {
    const command = String(item?.command || msg?.params?.command || '').replace(/\s+/g,' ').trim();
    return {...base,type:'activity',activityId,turnId,segmentId,role:'command',title:phase==='completed'?'命令已完成':phase==='interrupted'?'命令已中断':phase==='failed'?'命令失败':'正在运行命令',detail:command.slice(0,180)||'执行工作区命令',phase};
  }
  if (type === 'fileChange' || method.includes('fileChange')) {
    const paths = (item?.changes || msg?.params?.changes || []).map((change:any)=>String(change?.path || change || '')).filter(Boolean);
    return {...base,type:'activity',activityId,turnId,segmentId,role:'file',title:phase==='completed'?'文件已更新':phase==='interrupted'?'文件操作已中断':phase==='failed'?'文件操作失败':'正在修改文件',detail:paths.slice(0,3).join(' · ').slice(0,180)||'更新工作区内容',phase};
  }
  if (type === 'reasoning' || method.includes('reasoning')) {
    const detail = [...(item?.summary || []), ...(item?.content || [])].join(' ').replace(/\s+/g,' ').trim();
    if (!detail || detail === '[object Object]') return null;
    return {...base,type:'activity',activityId,turnId,segmentId,role:'reasoning',title:'正在梳理思路',detail:detail.slice(0,180),phase};
  }
  return null;
}
function structuredActivityPhase(status:any,method:string){const value=String(status||'').toLowerCase();if(['interrupted','cancelled','canceled'].includes(value)||/interrupted|cancelled|canceled/i.test(method))return'interrupted';if(['failed','error'].includes(value)||/failed|error/i.test(method))return'failed';if(['completed','complete','success','succeeded'].includes(value)||/completed|succeeded/i.test(method))return'completed';return'running';}
function itemHasProviderOnlyRecovery(item:any) {
  if (String(item?.text || '').includes(RECOVERY_CONTEXT_MARKER)) return true;
  return Array.isArray(item?.content) && item.content.some((part:any) => part?.type === 'text' && String(part.text || '').includes(RECOVERY_CONTEXT_MARKER));
}
function inputHasProviderOnlyRecovery(input:any) {
  return Array.isArray(input) && input.some((item:any) => item?.type === 'text' && String(item.text || '').includes(RECOVERY_CONTEXT_MARKER));
}
