#!/usr/bin/env node
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);
const runtimeEnv = await readRuntimeEnvironment();
const dataDir = process.env.DATA_DIR || runtimeEnv.DATA_DIR || '/opt/data/agentdeck';
const webDbPath = process.env.AGENTDECK_DB || runtimeEnv.AGENTDECK_DB || `${dataDir}/agentdeck.sqlite3`;
const runtimeDbPath = process.env.RUNTIME_DB || runtimeEnv.RUNTIME_DB || `${dataDir}/agentdeck-runtime.sqlite3`;
const portBase = Number(process.env.CODEX_APP_SERVER_PORT_BASE || runtimeEnv.CODEX_APP_SERVER_PORT_BASE || 4520);
const defaultPort = Number(process.env.CODEX_APP_SERVER_DEFAULT_PORT || runtimeEnv.CODEX_APP_SERVER_DEFAULT_PORT || 4668);

const webDb = new Database(webDbPath, { readonly:true, fileMustExist:true });
const runtimeDb = new Database(runtimeDbPath, { readonly:true, fileMustExist:true });

const webProfiles = selectAll(webDb, 'codex_profiles', ['id','name','codex_home','active','status','created_at','updated_at'], 'updated_at DESC');
const runtimeAccounts = selectRuntimeAccounts();
const activeProvider = settingValue(webDb, 'activeProvider') || 'codex';
const runtimeSessions = selectRuntimeSessions();

const ids = [...new Set([...webProfiles.map(row => row.id), ...runtimeAccounts.map(row => row.id)])];
const rows = [];
for (const id of ids) {
  const web = webProfiles.find(row => row.id === id) || null;
  const runtime = runtimeAccounts.find(row => row.id === id) || null;
  const port = portForProfile(id);
  const unit = systemdUnitName(id);
  const systemd = await systemdShow(unit);
  const endpoint = `ws://127.0.0.1:${port}`;
  const process = await processForPort(port);
  const owningUnit = process.pid ? unitForPid(process.pid) : null;
  const account = process.listening ? await accountRead(port) : null;
  rows.push({
    profileId:id,
    providerAccountId:account?.providerAccountId || null,
    email:account?.email || null,
    displayName:account?.displayName || web?.name || null,
    status:web?.status || null,
    active:Boolean(web?.active),
    codexHome:web?.codex_home || runtime?.codex_home || null,
    runtimeInstanceId:runtime?.runtime_instance_id || null,
    unit,
    endpoint,
    processPid:process.pid,
    owningUnit,
    unitState:systemd.activeState,
    unitFragment:systemd.fragmentPath,
    appServerAccount:account,
    mismatches: mismatchSummary({ web, runtime, account, unit, owningUnit, process }),
  });
}

const byCodexHome = duplicates(rows, row => row.codexHome);
const byUnit = duplicates(rows, row => row.unit);
const byEndpoint = duplicates(rows, row => row.endpoint);
const byOwningUnit = duplicates(rows, row => row.owningUnit);
const byAccountEmail = duplicates(rows, row => normalizeEmail(row.email));
const activeProfiles = rows.filter(row => row.active);
const sessionAccounts = summarizeSessionAccounts(runtimeSessions, rows);

console.log(JSON.stringify({
  generatedAt:new Date().toISOString(),
  webDb:webDbPath,
  runtimeDb:runtimeDbPath,
  portBase,
  activeProvider,
  activeProfileIds:activeProfiles.map(row => row.profileId),
  profiles:rows,
  sessionAccounts,
  answers:{
    profile6063Email:rows.find(row => row.profileId === '6063e1b041d4798f')?.email || null,
    codexAccountRows:rows.filter(row => row.displayName === 'Codex Account' || row.profileId === '6063e1b041d4798f').map(row => ({
      profileId:row.profileId,
      email:row.email,
      codexHome:row.codexHome,
      unit:row.unit,
      endpoint:row.endpoint,
      owningUnit:row.owningUnit,
    })),
    webActiveProfileId:activeProfiles[0]?.profileId || null,
    runtimeActiveSessionAccountIds:[...new Set(runtimeSessions.filter(s => s.status === 'running' || s.active_turn_id).map(s => s.account_id).filter(Boolean))],
    manual4733:rows.find(row => row.endpoint === 'ws://127.0.0.1:4733') || null,
  },
  duplicates:{
    codexHome:byCodexHome,
    unit:byUnit,
    endpoint:byEndpoint,
    owningUnit:byOwningUnit,
    accountEmail:byAccountEmail,
  },
}, null, 2));

webDb.close();
runtimeDb.close();

async function readRuntimeEnvironment() {
  const env = {};
  for (const file of ['/opt/data/agentdeck/runtime.env', '/etc/agentdeck/runtime.env']) {
    Object.assign(env, readEnvFile(file));
  }
  try {
    const { stdout } = await execFileAsync('systemctl', ['show', 'agentdeck-runtime.service', '-p', 'Environment', '--no-pager'], { maxBuffer:128 * 1024 });
    Object.assign(env, parseSystemdEnvironment(stdout.replace(/^Environment=/, '').trim()));
  } catch {}
  return env;
}

function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const env = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (isSensitiveKey(key)) continue;
    env[key] = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function parseSystemdEnvironment(text) {
  const env = {};
  for (const part of text.split(/\s+/).filter(Boolean)) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx);
    if (isSensitiveKey(key)) continue;
    env[key] = part.slice(idx + 1);
  }
  return env;
}

function isSensitiveKey(key) {
  return /TOKEN|SECRET|KEY|PASSWORD|COOKIE|AUTH|OAUTH/i.test(String(key || ''));
}

function selectRuntimeAccounts() {
  if (!hasTable(runtimeDb, 'accounts')) return [];
  return runtimeDb.prepare('SELECT id,provider,codex_home,runtime_instance_id,created_at,updated_at FROM accounts WHERE provider=? ORDER BY updated_at DESC').all('codex');
}

function selectRuntimeSessions() {
  if (!hasTable(runtimeDb, 'sessions')) return [];
  const cols = tableColumns(runtimeDb, 'sessions');
  const wanted = ['id','provider','provider_id','account_id','current_upstream_account_id','last_execution_account_id','status','active_turn_id','updated_at'];
  const selected = wanted.map(col => cols.includes(col) ? col : `NULL AS ${col}`).join(',');
  return runtimeDb.prepare(`SELECT ${selected} FROM sessions ORDER BY updated_at DESC LIMIT 1000`).all();
}

function selectAll(db, table, columns, orderBy) {
  if (!hasTable(db, table)) return [];
  const cols = tableColumns(db, table);
  const selected = columns.map(col => cols.includes(col) ? col : `NULL AS ${col}`).join(',');
  return db.prepare(`SELECT ${selected} FROM ${table} ORDER BY ${orderBy}`).all();
}

function hasTable(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
}

function settingValue(db, key) {
  if (!hasTable(db, 'settings')) return null;
  return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || null;
}

function portForProfile(id) {
  if (id === 'default') return defaultPort;
  const hash = crypto.createHash('sha256').update(id).digest();
  return portBase + (hash.readUInt16BE(0) % 200);
}

function systemdUnitName(id) {
  return id === 'default' ? 'agentdeck-app-server@default.service' : `agentdeck-app-server-${safeUnitPart(id)}.service`;
}

function safeUnitPart(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64) || 'default';
}

async function systemdShow(unit) {
  try {
    const { stdout } = await execFileAsync('systemctl', ['show', unit, '-p', 'ActiveState', '-p', 'FragmentPath', '--no-pager'], { maxBuffer:128 * 1024 });
    const values = Object.fromEntries(stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx), line.slice(idx + 1)];
    }));
    return { activeState:values.ActiveState || 'unknown', fragmentPath:values.FragmentPath || null };
  } catch {
    return { activeState:'not-found', fragmentPath:null };
  }
}

async function processForPort(port) {
  try {
    const { stdout } = await execFileAsync('ss', ['-ltnp', `sport = :${port}`], { maxBuffer:128 * 1024 });
    const match = stdout.match(/pid=(\d+)/);
    return { listening:!!match, pid:match ? Number(match[1]) : null };
  } catch {
    return { listening:false, pid:null };
  }
}

function unitForPid(pid) {
  try {
    const cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    const match = cgroup.match(/\/system\.slice\/(?:[^/\n]+\/)*([^/\n]+\.service)/);
    return match ? decodeURIComponent(match[1].replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))) : null;
  } catch {
    return null;
  }
}

async function accountRead(port) {
  return await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let id = 1;
    const timer = setTimeout(() => finish({ error:'timeout' }), 8000);
    function finish(value) {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(value);
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ id:id++, method:'initialize', params:{ clientInfo:{ name:'agentdeck-diagnostic', version:'1.0.0' }, capabilities:{ experimentalApi:true, requestAttestation:false } } }));
    };
    ws.onerror = () => finish({ error:'websocket_error' });
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id === 1) {
        ws.send(JSON.stringify({ method:'initialized' }));
        ws.send(JSON.stringify({ id:id++, method:'account/read', params:{ refreshToken:false } }));
      }
      if (msg.id === 2) {
        const account = msg.result?.account || msg.result || {};
        finish({
          providerAccountId:account.id || account.providerAccountId || null,
          email:account.email || null,
          displayName:account.displayName || account.name || null,
          authType:account.authType || account.auth_type || null,
          error:msg.error?.message || null,
        });
      }
    };
  });
}

function duplicates(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(item.profileId);
    groups.set(key, group);
  }
  return [...groups.entries()].filter(([, group]) => group.length > 1).map(([value, profileIds]) => ({ value, profileIds }));
}

function mismatchSummary({ web, runtime, account, unit, owningUnit, process }) {
  const mismatches = [];
  const webName = normalizeEmail(web?.name);
  const accountEmail = normalizeEmail(account?.email);
  if (webName && accountEmail && webName !== accountEmail && web?.name !== 'Codex Account') {
    mismatches.push('web_profile_name_email_differs_from_app_server_account');
  }
  if (web?.name === 'Codex Account' && accountEmail) mismatches.push('placeholder_name_with_resolved_app_server_email');
  if (runtime?.codex_home && web?.codex_home && runtime.codex_home !== web.codex_home) {
    mismatches.push('web_runtime_codex_home_differs');
  }
  if (process.listening && owningUnit && owningUnit !== unit) mismatches.push('endpoint_owned_by_different_systemd_unit');
  if (process.listening && !accountEmail && !account?.error) mismatches.push('app_server_account_identity_missing_email');
  if (account?.error) mismatches.push('app_server_account_read_error');
  return mismatches;
}

function summarizeSessionAccounts(sessions, profiles) {
  const counts = new Map();
  for (const session of sessions) {
    const key = session.account_id || 'unknown';
    const current = counts.get(key) || { accountId:key, total:0, running:0, activeTurn:0, interrupted:0 };
    current.total++;
    if (session.status === 'running') current.running++;
    if (session.active_turn_id) current.activeTurn++;
    if (session.status === 'interrupted') current.interrupted++;
    counts.set(key, current);
  }
  return [...counts.values()].map(row => {
    const profile = profiles.find(p => p.profileId === row.accountId);
    return { ...row, email:profile?.email || null, displayName:profile?.displayName || null };
  });
}

function normalizeEmail(value) {
  const text = String(value || '').trim().toLowerCase();
  return text.includes('@') ? text : '';
}
