#!/usr/bin/env node
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);
const apply = process.argv.includes('--apply');
const dataDir = process.env.DATA_DIR || '/opt/data/agentdeck';
const webDbPath = process.env.AGENTDECK_DB || `${dataDir}/agentdeck.sqlite3`;
const runtimeDbPath = process.env.RUNTIME_DB || `${dataDir}/agentdeck-runtime.sqlite3`;
const portBase = Number(process.env.CODEX_APP_SERVER_PORT_BASE || await runtimeEnvValue('CODEX_APP_SERVER_PORT_BASE') || 4620);
const defaultPort = Number(process.env.CODEX_APP_SERVER_DEFAULT_PORT || 4668);

const webDb = new Database(webDbPath, { readonly:!apply, fileMustExist:true });
const runtimeDb = new Database(runtimeDbPath, { readonly:!apply, fileMustExist:true });

const profiles = selectProfiles();
const plans = [];
for (const profile of profiles) {
  const identity = await resolveIdentity(profile);
  const existing = identity.email ? findExistingProfileByEmail(identity.email, profile.id) : null;
  const placeholder = isPlaceholderProfile(profile);
  const shared = existing ? sharedMapping(profile, existing) : {};
  const action = !identity.email
    ? 'mark_unresolved_identity'
    : existing
      ? 'merge_into_existing_profile'
      : placeholder
        ? 'update_placeholder_identity'
        : 'no_change';
  plans.push({
    profileId:profile.id,
    currentName:profile.name,
    active:Boolean(profile.active),
    status:profile.status || 'authenticated',
    codexHome:profile.codex_home,
    resolvedEmail:identity.email,
    identitySource:identity.source,
    action,
    mergeTargetProfileId:existing?.id || null,
    shared,
  });
}

if (apply) applyPlans(plans);

console.log(JSON.stringify({
  mode:apply ? 'apply' : 'dry-run',
  generatedAt:new Date().toISOString(),
  webDb:webDbPath,
  runtimeDb:runtimeDbPath,
  summary:{
    total:plans.length,
    updatePlaceholder:plans.filter(p => p.action === 'update_placeholder_identity').length,
    merge:plans.filter(p => p.action === 'merge_into_existing_profile').length,
    unresolved:plans.filter(p => p.action === 'mark_unresolved_identity').length,
    unchanged:plans.filter(p => p.action === 'no_change').length,
  },
  plans,
}, null, 2));

webDb.close();
runtimeDb.close();

function selectProfiles() {
  if (!hasTable(webDb, 'codex_profiles')) return [];
  return webDb.prepare("SELECT id,name,codex_home,active,status,created_at,updated_at FROM codex_profiles ORDER BY updated_at DESC").all();
}

function isPlaceholderProfile(profile) {
  const name = String(profile.name || '').trim();
  const status = String(profile.status || 'authenticated');
  return name === 'Codex Account' || name === 'Default' || (!/@/.test(name) && status === 'authenticated');
}

async function resolveIdentity(profile) {
  const endpoint = `ws://127.0.0.1:${portForProfile(profile.id)}`;
  const live = await portListening(portForProfile(profile.id));
  if (live) {
    const account = await accountRead(portForProfile(profile.id)).catch(error => ({ error:String(error?.message || error) }));
    if (account?.email) return { email:normalizeEmail(account.email), source:'account/read', endpoint };
    if (account?.error) return { email:null, source:`account/read_error:${account.error}`, endpoint };
  }
  const email = await readAuthJsonEmail(String(profile.codex_home || '')).catch(()=>null);
  return email ? { email:normalizeEmail(email), source:'auth_json_email_scan', endpoint } : { email:null, source:live ? 'account/read_no_email' : 'endpoint_not_running', endpoint };
}

function findExistingProfileByEmail(email, excludeId) {
  const normalized = normalizeEmail(email);
  for (const profile of profiles) {
    if (profile.id === excludeId) continue;
    if (normalizeEmail(profile.name) === normalized) return profile;
  }
  return null;
}

function sharedMapping(profile, existing) {
  return {
    codexHome: profile.codex_home === existing.codex_home,
    runtimeInstanceId: runtimeInstanceId(profile.id) === runtimeInstanceId(existing.id),
    unit: systemdUnitName(profile.id) === systemdUnitName(existing.id),
    endpoint: portForProfile(profile.id) === portForProfile(existing.id),
  };
}

function applyPlans(plans) {
  const now = Date.now();
  const webTx = webDb.transaction(() => {
    for (const plan of plans) {
      if (plan.action === 'update_placeholder_identity') {
        webDb.prepare("UPDATE codex_profiles SET name=?, status='authenticated', updated_at=? WHERE id=?").run(plan.resolvedEmail, now, plan.profileId);
      } else if (plan.action === 'mark_unresolved_identity') {
        webDb.prepare("UPDATE codex_profiles SET active=0, status='unresolved_identity', updated_at=? WHERE id=?").run(now, plan.profileId);
      } else if (plan.action === 'merge_into_existing_profile') {
        moveWebReferences(plan.profileId, plan.mergeTargetProfileId);
        if (plan.active) {
          webDb.prepare('UPDATE codex_profiles SET active=0').run();
          webDb.prepare('UPDATE codex_profiles SET active=1, updated_at=? WHERE id=?').run(now, plan.mergeTargetProfileId);
        }
        webDb.prepare('DELETE FROM codex_profiles WHERE id=?').run(plan.profileId);
      }
    }
  });
  const runtimeTx = runtimeDb.transaction(() => {
    for (const plan of plans) {
      if (plan.action === 'merge_into_existing_profile') moveRuntimeReferences(plan.profileId, plan.mergeTargetProfileId);
      if (plan.action === 'mark_unresolved_identity' && hasTable(runtimeDb, 'accounts')) {
        runtimeDb.prepare('DELETE FROM accounts WHERE id=? AND provider=?').run(plan.profileId, 'codex');
      }
    }
  });
  webTx();
  runtimeTx();
}

function moveWebReferences(fromId, toId) {
  if (hasColumn(webDb, 'sessions', 'account_id')) webDb.prepare("UPDATE sessions SET account_id=? WHERE provider_id='codex' AND account_id=?").run(toId, fromId);
  if (hasColumn(webDb, 'sessions', 'provider_profile_id')) webDb.prepare("UPDATE sessions SET provider_profile_id=? WHERE provider_id='codex' AND provider_profile_id=?").run(toId, fromId);
}

function moveRuntimeReferences(fromId, toId) {
  if (hasTable(runtimeDb, 'sessions') && hasColumn(runtimeDb, 'sessions', 'account_id')) runtimeDb.prepare("UPDATE sessions SET account_id=? WHERE (provider_id='codex' OR provider='codex') AND account_id=?").run(toId, fromId);
  if (hasTable(runtimeDb, 'sessions') && hasColumn(runtimeDb, 'sessions', 'current_upstream_account_id')) runtimeDb.prepare("UPDATE sessions SET current_upstream_account_id=? WHERE (provider_id='codex' OR provider='codex') AND current_upstream_account_id=?").run(toId, fromId);
  if (hasTable(runtimeDb, 'sessions') && hasColumn(runtimeDb, 'sessions', 'last_execution_account_id')) runtimeDb.prepare("UPDATE sessions SET last_execution_account_id=? WHERE (provider_id='codex' OR provider='codex') AND last_execution_account_id=?").run(toId, fromId);
  if (hasTable(runtimeDb, 'accounts')) runtimeDb.prepare('DELETE FROM accounts WHERE id=? AND provider=?').run(fromId, 'codex');
}

async function runtimeEnvValue(key) {
  try {
    const { stdout } = await execFileAsync('systemctl', ['show', 'agentdeck-runtime.service', '-p', 'Environment', '--no-pager'], { maxBuffer:128 * 1024 });
    const env = stdout.replace(/^Environment=/, '').trim().split(/\s+/);
    const found = env.find(part => part.startsWith(`${key}=`));
    return found ? found.slice(key.length + 1) : '';
  } catch {
    return '';
  }
}

function portForProfile(id) {
  if (id === 'default') return defaultPort;
  const hash = crypto.createHash('sha256').update(id).digest();
  return portBase + (hash.readUInt16BE(0) % 200);
}

function systemdUnitName(id) {
  return id === 'default' ? 'agentdeck-app-server@default.service' : `agentdeck-app-server-${safeUnitPart(id)}.service`;
}

function runtimeInstanceId(id) {
  return `agentdeck-${safeUnitPart(id)}`;
}

function safeUnitPart(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64) || 'default';
}

async function portListening(port) {
  try {
    const { stdout } = await execFileAsync('ss', ['-ltn', `sport = :${port}`], { maxBuffer:64 * 1024 });
    return stdout.includes(`:${port}`);
  } catch {
    return false;
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
    ws.onopen = () => ws.send(JSON.stringify({ id:id++, method:'initialize', params:{ clientInfo:{ name:'agentdeck-migration-dry-run', version:'1.0.0' }, capabilities:{ experimentalApi:true, requestAttestation:false } } }));
    ws.onerror = () => finish({ error:'websocket_error' });
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id === 1) {
        ws.send(JSON.stringify({ method:'initialized' }));
        ws.send(JSON.stringify({ id:id++, method:'account/read', params:{ refreshToken:false } }));
      }
      if (msg.id === 2) {
        const account = msg.result?.account || msg.result || {};
        finish({ email:account.email || null, error:msg.error?.message || null });
      }
    };
  });
}

async function readAuthJsonEmail(codexHome) {
  const file = `${codexHome}/auth.json`;
  if (!existsSync(file)) return null;
  const json = JSON.parse(await readFile(file, 'utf8'));
  return findEmail(json);
}

function findEmail(value) {
  if (!value) return null;
  if (typeof value === 'string') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEmail(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of ['email','email_address','account_email','login']) {
      const found = findEmail(value[key]);
      if (found) return found;
    }
    for (const item of Object.values(value)) {
      const found = findEmail(item);
      if (found) return found;
    }
  }
  return null;
}

function normalizeEmail(value) {
  const text = String(value || '').trim().toLowerCase();
  return text.includes('@') ? text : '';
}

function hasTable(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function hasColumn(db, table, column) {
  if (!hasTable(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}
