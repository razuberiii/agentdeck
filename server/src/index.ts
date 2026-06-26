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
import { promisify } from 'node:util';
import { realpathSync, existsSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { Db } from './db.js';
import { CodexBridge } from './codex.js';
import { existingRoots, validateProject, scanProjects, gitBranch, gitDiff } from './workspaces.js';
const execFileAsync = promisify(execFile);
const DATA_DIR = process.env.DATA_DIR || '/opt/data/codex-mobile';
const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || '/home/ubuntu/.codex';
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const SHARED_CODEX_DIR = path.join(DATA_DIR, 'shared');
const SHARED_SESSIONS_DIR = path.join(SHARED_CODEX_DIR, 'sessions');
const SHARED_GENERATED_IMAGES_DIR = path.join(SHARED_CODEX_DIR, 'generated_images');
const MAX_ATTACHMENT_BYTES = Number(process.env.MAX_ATTACHMENT_BYTES || 16 * 1024 * 1024);
const IMAGE_TYPES: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/pjpeg': '.jpg', 'image/webp': '.webp' };
const ARTIFACT_TYPES: Record<string, string> = { '.txt':'text/plain; charset=utf-8', '.log':'text/plain; charset=utf-8', '.json':'application/json; charset=utf-8', '.csv':'text/csv; charset=utf-8', '.patch':'text/plain; charset=utf-8', '.diff':'text/plain; charset=utf-8', '.zip':'application/zip', '.tar.gz':'application/gzip', '.conf':'application/x-wireguard-profile', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp' };
const ARTIFACT_SKIP_DIRS = new Set(['.git','node_modules','dist','build','.next','.vite','coverage','vendor']);
const artifactScanStarts = new Map<string, number>();
const COOKIE_NAME = 'codex_mobile_session';
const CSRF_COOKIE = 'codex_mobile_csrf';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://codex.rubusoo.com,http://codex.rubusoo.com,http://127.0.0.1:3842').split(',').map(s=>s.trim()).filter(Boolean);
const db = new Db(path.join(DATA_DIR, 'codex-mobile.sqlite3'));
const codex = new CodexBridge('/home/ubuntu', DEFAULT_CODEX_HOME);
const clients = new Map<string, Set<any>>();
const chunkedMessages = new Map<string, { sessionId:string; chunks:string[]; size:number; createdAt:number }>();
const threadTokenUsage = new Map<string, any>();
type LoginJob = { id:string; profileId:string; output:string[]; status:'running'|'done'|'error'; code?:number|null; error?:string; startedAt:number; newProfile?:boolean; loginUrl?:string; deviceCode?:string };
const loginJobs = new Map<string, LoginJob>();
const roots = await existingRoots((process.env.ALLOWED_WORKSPACES || '/opt/stacks,/opt/projects,/home/ubuntu,/opt/data,/etc/nginx,/etc/systemd/system').split(',').map(s=>s.trim()).filter(Boolean));
const PROJECTS_CACHE_MS = Number(process.env.PROJECTS_CACHE_MS || 30_000);
const CODEX_STATUS_CACHE_MS = Number(process.env.CODEX_STATUS_CACHE_MS || 60_000);
let projectsCache: { expiresAt:number; promise?:Promise<any[]>; value?:any[] } = { expiresAt: 0 };
let codexStatusCache: { expiresAt:number; promise?:Promise<any>; value?:any } = { expiresAt: 0 };
if (roots.length === 0) throw new Error('No allowed workspaces exist');
await db.init();
await db.run('ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0').catch(()=>{});
await db.run('ALTER TABLE artifacts ADD COLUMN anchor_item_id TEXT').catch(()=>{});
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
app.get('/api/status', async (req) => { const raw = req.cookies[COOKIE_NAME] || ''; const authed = !!raw && !!app.unsignCookie(raw).valid; const settings = await appSettings(); const activeProfile = await getActiveProfile(); return { authed, serverTime: Date.now(), codex: await cachedCodexStatus(), roots, mode:modeLabel(settings.defaultMode), defaultMode:settings.defaultMode, codexHome: codex.getCodexHome(), activeProfile, capabilities: { imageInput: true, imageOutput: true, attachmentTypes: Object.keys(IMAGE_TYPES), maxAttachmentBytes: MAX_ATTACHMENT_BYTES } }; });
app.get('/api/quota', { preHandler: ensureAuth }, async (req:any) => {
  const [account, limits] = await Promise.allSettled([codex.account(), codex.rateLimits()]);
  return {
    account: account.status === 'fulfilled' ? account.value : null,
    rateLimits: limits.status === 'fulfilled' ? limits.value : null,
    errors: {
      account: account.status === 'rejected' ? account.reason?.message || String(account.reason) : null,
      rateLimits: limits.status === 'rejected' ? limits.reason?.message || String(limits.reason) : null,
    },
    checkedAt: Date.now(),
  };
});
app.get('/api/settings', { preHandler: ensureAuth }, async () => ({ settings: await appSettings(), profiles: await listProfiles(), activeProfile: await getActiveProfile() }));
app.patch('/api/settings', { preHandler: ensureAuth }, async (req:any) => {
  const mode = normalizeMode(req.body?.defaultMode);
  if (mode) await setSetting('defaultMode', mode);
  return { settings: await appSettings() };
});
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
  try { await codex.switchCodexHome(String(profile.codex_home)); }
  catch (e:any) { warning = e?.message || String(e); await codex.ensure().catch(()=>{}); }
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
      await codex.switchCodexHome(String(profile.codex_home)).catch(()=>{});
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
app.post('/api/login', { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } }, async (req:any, reply) => { const { username, password } = req.body || {}; const row = await db.get('SELECT * FROM users WHERE username = ?1', [username || 'admin']); if (!row || typeof password !== 'string' || !(await argon2.verify(String(row.password_hash), password))) return reply.code(401).send({error:'invalid login'}); const sid = crypto.randomBytes(32).toString('base64url'); const csrf = crypto.randomBytes(24).toString('base64url'); reply.setCookie(COOKIE_NAME, sid, { ...secureCookie(), signed:true }); reply.setCookie(CSRF_COOKIE, csrf, csrfCookie()); return { ok:true, csrf }; });
app.post('/api/logout', { preHandler: ensureAuth }, async (_req, reply) => { reply.clearCookie(COOKIE_NAME, {path:'/'}); reply.clearCookie(CSRF_COOKIE, {path:'/'}); return {ok:true}; });
app.get('/api/projects', { preHandler: ensureAuth }, async (req:any) => ({ roots, projects: await cachedProjects(req.query?.refresh === '1') }));
app.get('/api/sessions', { preHandler: ensureAuth }, async (req:any) => ({ sessions: await listIndexedThreads(req.query?.archived === '1') }));
app.post('/api/sessions', { preHandler: ensureAuth }, async (req:any, reply) => { let projectDir:string; try { projectDir = await validateProject(req.body?.projectDir, roots); } catch { return reply.code(400).send({error:'project path is outside allowed workspace roots'}); } const title = String(req.body?.title || path.basename(projectDir)); const mode = normalizeMode(req.body?.mode) || (await appSettings()).defaultMode; const opts = modeOptions(mode); const started = await codex.startThread(projectDir, opts); const thread = started.thread; await upsertThread(thread, { title, archived: 0, status:'idle', ...modeFields(mode) }); await codex.setName(thread.id, title).catch(()=>{}); return sessionDto(thread, { title, status:'idle', archived:0, ...modeFields(mode) }); });
app.get('/api/sessions/:id', { preHandler: ensureAuth }, async (req:any, reply) => { const row = await findSession(req.params.id); const threadId = String(row?.codex_thread_id || req.params.id); let read:any; try { read = await codex.readThread(threadId, true); } catch { if (!row) return reply.code(404).send({error:'not found'}); await codex.resumeThread(threadId, String(row.project_dir)).catch(()=>null); read = await codex.readThread(threadId, true); } if (!pathAllowed(read.thread.cwd)) return reply.code(403).send({error:'workspace not allowed'}); await upsertThread(read.thread, { status: statusName(read.thread.status) }); decorateThreadImages(read.thread, threadId, String(row?.project_dir || read.thread.cwd)); await injectGeneratedImages(read.thread, threadId); await injectArtifacts(read.thread, threadId); sanitizeThreadForMobile(read.thread); return { session: await indexedSession(read.thread), thread: read.thread, branch: await gitBranch(read.thread.cwd), interrupted: (row?.status === 'interrupted') }; });
app.patch('/api/sessions/:id', { preHandler: ensureAuth }, async (req:any) => { const row = await findSession(req.params.id); const threadId = String(row?.codex_thread_id || req.params.id); const title = String(req.body?.title || '').trim(); const mode = normalizeMode(req.body?.mode); if (title) { await codex.setName(threadId, title); await db.run('UPDATE sessions SET title=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[title, Date.now(), threadId]); } if (mode) { const fields = modeFields(mode); await db.run('UPDATE sessions SET permission_mode=?1, approval_policy=?2, sandbox_mode=?3, updated_at=?4 WHERE codex_thread_id=?5 OR id=?5',[fields.permission_mode, fields.approval_policy, fields.sandbox_mode, Date.now(), threadId]); } return {ok:true}; });
app.post('/api/sessions/:id/archive', { preHandler: ensureAuth }, async (req:any) => { const row = await findSession(req.params.id); const threadId = String(row?.codex_thread_id || req.params.id); await codex.archive(threadId).catch((e:any)=>app.log.warn({err:e.message}, 'official thread archive failed; archiving local index only')); await db.run('UPDATE sessions SET archived=1, updated_at=?1 WHERE codex_thread_id=?2 OR id=?2',[Date.now(), threadId]); return {ok:true}; });
app.post('/api/sessions/:id/unarchive', { preHandler: ensureAuth }, async (req:any) => { const row = await findSession(req.params.id); const threadId = String(row?.codex_thread_id || req.params.id); await codex.unarchive(threadId).catch((e:any)=>app.log.warn({err:e.message}, 'official thread unarchive failed; restoring local index only')); await db.run('UPDATE sessions SET archived=0, updated_at=?1 WHERE codex_thread_id=?2 OR id=?2',[Date.now(), threadId]); return {ok:true}; });
app.post('/api/sessions/:id/fork', { preHandler: ensureAuth }, async (req:any) => { const row = await findSession(req.params.id); const threadId = String(row?.codex_thread_id || req.params.id); const mode = sessionMode(row); const forked = await codex.fork(threadId, row?.project_dir ? String(row.project_dir) : undefined, modeOptions(mode)); await upsertThread(forked.thread, { status:'idle', ...modeFields(mode) }); return sessionDto(forked.thread, modeFields(mode)); });
app.delete('/api/sessions/:id', { preHandler: ensureAuth }, async (req:any, reply) => { const row = await findSession(req.params.id); if (!row) return reply.code(404).send({error:'not found'}); const threadId = String(row.codex_thread_id || row.id); let filePath:string|null = null; try { const read = await codex.readThread(threadId, false); filePath = read.thread.path; await codex.archive(threadId).catch(()=>{}); } catch {} if (filePath) await deleteRollout(filePath); await db.run('DELETE FROM sessions WHERE id=?1 OR codex_thread_id=?1',[threadId]); return {ok:true}; });
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
app.post('/api/sessions/:id/stop', { preHandler: ensureAuth }, async (req:any) => { const row = await findSession(req.params.id); const threadId = String(row?.codex_thread_id || req.params.id); await codex.interrupt(threadId).catch(()=>{}); await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['interrupted',Date.now(),threadId]); return {ok:true}; });
app.post('/api/approvals/:requestId', { preHandler: ensureAuth }, async (req:any) => { const decision = req.body?.decision === 'decline' ? 'decline' : 'accept'; codex.respond(req.params.requestId, approvalResponse(String(req.body?.method || ''), decision)); return {ok:true}; });
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
app.get('/ws', { websocket: true }, async (connection:any, req:any) => { const ws = connection.socket || connection; const origin = req.headers.origin; if (origin && !ALLOWED_ORIGINS.includes(origin)) return ws.close(1008, 'origin'); const sid = req.cookies?.[COOKIE_NAME]; if (!sid || !app.unsignCookie(sid).valid) return ws.close(1008, 'auth'); ws.on('message', async (raw:Buffer) => { try { const msg = JSON.parse(raw.toString()); if (msg.type === 'join') await joinAndResume(String(msg.sessionId), ws); if (msg.type === 'send') await sendTurn(String(msg.sessionId), String(msg.text || ''), Array.isArray(msg.attachments) ? msg.attachments : []); if (msg.type === 'sendChunkStart') startChunkedMessage(msg); if (msg.type === 'sendChunk') appendChunkedMessage(msg); if (msg.type === 'sendChunkEnd') await finishChunkedMessage(msg); if (msg.type === 'stop') await stopTurn(String(msg.sessionId)); } catch (e:any) { ws.send(JSON.stringify({type:'error', error:e.message})); } }); ws.on('close', () => { for (const set of clients.values()) set.delete(ws); }); });
app.setNotFoundHandler(async (req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({error:'not found'}) : reply.sendFile('index.html'));
codex.on('notification', async (msg:any) => { const sid = await sessionIdForThread(msg.params?.threadId || msg.params?.thread?.id); if (sid) { if (msg.method === 'thread/tokenUsage/updated') threadTokenUsage.set(sid, msg.params?.tokenUsage); if (shouldBroadcastCodexNotification(msg)) broadcast(sid, { type:'codex', method:msg.method, params:msg.params }); if (msg.method === 'turn/completed') { const row = await findSession(sid); const anchorItemId = row ? await latestAgentItemId(sid, String(row.project_dir)).catch(()=>null) : null; const found = row ? await scanArtifacts(sid, String(row.project_dir), artifactScanStarts.get(sid) || Date.now(), anchorItemId) : []; artifactScanStarts.delete(sid); await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['idle',Date.now(),sid]); if (found.length) broadcast(sid, { type:'codex', method:'item/completed', params:{ item:artifactMessageItem(found, Date.now()) } }); } if (msg.method === 'thread/status/changed') await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[statusName(msg.params?.status),Date.now(),sid]).catch(()=>{}); }});
codex.on('request', async (msg:any) => {
  const sid = await sessionIdForThread(msg.params?.threadId);
  const row = sid ? await findSession(sid) : null;
  if (sid) broadcast(sid, { type:'approval', requestId: msg.id, method: msg.method, params: msg.params });
  if (!row || sessionMode(row) === 'yolo') codex.respond(msg.id, approvalResponse(msg.method, 'accept'));
});
codex.on('stderr', (line:string) => app.log.warn({ codex: line }));
await codex.ensure();
const host = process.env.HOST || '127.0.0.1'; const port = Number(process.env.PORT || 3842);
await app.listen({ host, port });
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
  if (active?.codex_home) await codex.switchCodexHome(String(active.codex_home));
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
  return { defaultMode: normalizeMode(map.defaultMode) || 'yolo' };
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
async function deleteProfileDir(codexHome:string) {
  const root = realpathSync(PROFILES_DIR);
  if (!codexHome.startsWith(PROFILES_DIR + path.sep)) return;
  const parent = path.dirname(realpathSync(codexHome));
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
function stripAnsi(text:string){ return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\u001b\u009b][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''); }
function normalizeMode(value:any) { const v = String(value || ''); return ['yolo','workspace-write','read-only'].includes(v) ? v : null; }
function modeFields(mode:string) {
  if (mode === 'read-only') return { permission_mode:'read-only', approval_policy:'on-request', sandbox_mode:'read-only' };
  if (mode === 'workspace-write') return { permission_mode:'workspace-write', approval_policy:'on-request', sandbox_mode:'workspace-write' };
  return { permission_mode:'yolo', approval_policy:'never', sandbox_mode:'danger-full-access' };
}
function modeOptions(mode:string) { const f = modeFields(mode); return { approvalPolicy:f.approval_policy, sandboxMode:f.sandbox_mode }; }
function sessionMode(row:any) { return normalizeMode(row?.permission_mode) || (row?.sandbox_mode === 'read-only' ? 'read-only' : row?.sandbox_mode === 'workspace-write' ? 'workspace-write' : 'yolo'); }
function modeLabel(mode:string) { if (mode === 'read-only') return 'Read Only'; if (mode === 'workspace-write') return 'Workspace Write'; return 'YOLO · Full Access'; }
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
function pathAllowed(p:string){ try { const rp = realpathSync(p); return roots.some(r => rp === r || rp.startsWith(r + path.sep)); } catch { return false; } }
async function findSession(id:string){ return db.get('SELECT * FROM sessions WHERE id=?1 OR codex_thread_id=?1',[id]); }
async function upsertThread(thread:any, extra:any = {}) { if (!thread?.id || !pathAllowed(thread.cwd)) return; const title = cleanTitle(extra.title || thread.name || thread.preview, thread.cwd); const now = Date.now(); const mode = normalizeMode(extra.permission_mode) || 'yolo'; const fields = { ...modeFields(mode), ...extra }; await db.run('INSERT INTO sessions (id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,archived,created_at,updated_at) VALUES (?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET codex_thread_id=excluded.codex_thread_id, project_dir=excluded.project_dir, title=excluded.title, status=excluded.status, archived=excluded.archived, updated_at=excluded.updated_at', [thread.id, thread.cwd, title, extra.status || statusName(thread.status), fields.permission_mode, fields.approval_policy, fields.sandbox_mode, extra.archived ?? 0, (thread.createdAt || Math.floor(now/1000))*1000, (thread.updatedAt || Math.floor(now/1000))*1000]); }
async function indexedSession(thread:any){ const row = await findSession(thread.id); return sessionDto(thread, row || undefined); }
function sessionDto(thread:any, row:any = {}) { const fields = modeFields(sessionMode(row)); return { id: thread.id, codex_thread_id: thread.id, project_dir: thread.cwd, title: cleanTitle(row.title || thread.name || thread.preview, thread.cwd), status: row.status || statusName(thread.status), permission_mode:row.permission_mode || fields.permission_mode, approval_policy:row.approval_policy || fields.approval_policy, sandbox_mode:row.sandbox_mode || fields.sandbox_mode, archived: Number(row.archived || 0), created_at: (thread.createdAt || 0)*1000, updated_at: (thread.updatedAt || 0)*1000, path: thread.path || null }; }
function rowSessionDto(row:any) {
  const fields = modeFields(sessionMode(row));
  return { id:String(row.codex_thread_id || row.id), codex_thread_id:String(row.codex_thread_id || row.id), project_dir:String(row.project_dir), title:String(row.title || projectNameFromPath(String(row.project_dir))), status:String(row.status || 'idle'), permission_mode:row.permission_mode || fields.permission_mode, approval_policy:row.approval_policy || fields.approval_policy, sandbox_mode:row.sandbox_mode || fields.sandbox_mode, archived:Number(row.archived || 0), created_at:Number(row.created_at || 0), updated_at:Number(row.updated_at || 0), path:null };
}
async function listIndexedThreads(archived:boolean){
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
async function joinAndResume(id:string, ws:any){ const row = await findSession(id); const threadId = String(row?.codex_thread_id || id); if(!clients.has(threadId)) clients.set(threadId,new Set()); clients.get(threadId)!.add(ws); if (row?.project_dir) await codex.resumeThread(threadId, String(row.project_dir), modeOptions(sessionMode(row))).catch(()=>{}); ws.send(JSON.stringify({type:'joined', sessionId:threadId})); }
function broadcast(id:string, msg:any){ for(const ws of clients.get(id) || []) if(ws.readyState === 1) ws.send(JSON.stringify(msg)); }
async function sendTurn(id:string, text:string, attachments:any[] = []){ const row = await findSession(id); if(!row) throw new Error('session not found'); const threadId = String(row.codex_thread_id || row.id); const input = await buildTurnInput(threadId, text, attachments); const title = autoTitle(text, String(row.project_dir), String(row.title || '')); const opts = modeOptions(sessionMode(row)); await codex.resumeThread(threadId, String(row.project_dir), opts).catch(()=>null); if (title) { await db.run('UPDATE sessions SET title=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',[title,Date.now(),threadId]); await codex.setName(threadId, title).catch(()=>{}); broadcast(threadId,{type:'sessionTitle', title}); } artifactScanStarts.set(threadId, Date.now() - 1500); await db.run('UPDATE sessions SET status=?1, updated_at=?2 WHERE codex_thread_id=?3 OR id=?3',['running',Date.now(),threadId]); broadcast(threadId,{type:'user', text, attachments: attachments.map((a:any)=>({ id:String(a.id), name:String(a.name||'image'), type:String(a.type||''), url:`/api/sessions/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(String(a.id))}` }))}); await codex.startTurn(threadId, input, String(row.project_dir), opts); }
async function stopTurn(id:string){ const row = await findSession(id); const threadId = String(row?.codex_thread_id || id); await codex.interrupt(threadId).catch(()=>{}); }
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

function cleanTitle(value:any, cwd:string){ const raw = String(value || '').split(/\r?\n/)[0].trim(); return (raw ? raw.slice(0, 120) : path.basename(cwd)); }
function autoTitle(text:string, cwd:string, current:string){ const base = path.basename(cwd); const generic = new Set([base, 'Default Workspace', 'default-workspace', 'Session']); if (!generic.has(current.trim())) return null; const raw = text.split(/\r?\n/).map(s=>s.trim()).find(Boolean) || ''; const cleaned = raw.replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim(); if (!cleaned) return null; return cleaned.slice(0, 42); }
function startChunkedMessage(msg:any){ const id = String(msg.messageId || ''); const sessionId = String(msg.sessionId || ''); if (!id || !sessionId) throw new Error('bad chunked message'); chunkedMessages.set(id, { sessionId, chunks: [], size: 0, createdAt: Date.now() }); cleanupChunkedMessages(); }
function appendChunkedMessage(msg:any){ const id = String(msg.messageId || ''); const state = chunkedMessages.get(id); if (!state) throw new Error('chunked message not found'); const chunk = String(msg.chunk || ''); state.size += Buffer.byteLength(chunk); if (state.size > 25 * 1024 * 1024) { chunkedMessages.delete(id); throw new Error('message too large'); } state.chunks.push(chunk); }
async function finishChunkedMessage(msg:any){ const id = String(msg.messageId || ''); const state = chunkedMessages.get(id); if (!state) throw new Error('chunked message not found'); chunkedMessages.delete(id); const payload = JSON.parse(state.chunks.join('')); await sendTurn(state.sessionId, String(payload.text || ''), Array.isArray(payload.attachments) ? payload.attachments : []); }
function cleanupChunkedMessages(){ const cutoff = Date.now() - 10 * 60 * 1000; for (const [id, state] of chunkedMessages) if (state.createdAt < cutoff) chunkedMessages.delete(id); }
function statusName(status:any){ if (!status) return 'idle'; if (typeof status === 'string') return status; return status.type || 'idle'; }
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
  const root = realpathSync(projectDir);
  await walkArtifacts(root, root, sinceMs, out);
  const saved:any[] = [];
  for (const f of out.sort((a,b)=>a.createdAt-b.createdAt).slice(-12)) {
    const id = crypto.createHash('sha256').update(`${threadId}\0${f.path}`).digest('base64url').slice(0, 24);
    await db.run('INSERT OR IGNORE INTO artifacts (id, session_id, path, name, mime, size, created_at, anchor_item_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)', [id, threadId, f.path, f.name, f.mime, f.size, f.createdAt, anchorItemId || null]);
    if (anchorItemId) await db.run('UPDATE artifacts SET anchor_item_id=?1 WHERE id=?2 AND anchor_item_id IS NULL', [anchorItemId, id]);
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
    if (st.mtimeMs < sinceMs || st.size <= 0 || st.size > 25 * 1024 * 1024) continue;
    const rp = realpathSync(filePath);
    if (!rp.startsWith(root + path.sep)) continue;
    out.push({ path:rp, name:path.basename(rp), mime, size:st.size, createdAt:Math.floor(st.mtimeMs) });
  }
}
async function injectArtifacts(thread:any, threadId:string){
  const rows = await db.all('SELECT * FROM artifacts WHERE session_id=?1 ORDER BY created_at ASC LIMIT 100', [threadId]);
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
