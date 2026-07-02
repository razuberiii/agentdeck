#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-/opt/data/agentdeck}"
ENV_DIR="${AGENTDECK_ENV_DIR:-${ENV_DIR:-$DATA_DIR}}"
RUN_USER="${AGENTDECK_RUN_USER:-${CODEX_APP_SERVER_USER:-ubuntu}}"
RUN_GROUP="${AGENTDECK_RUN_GROUP:-${CODEX_APP_SERVER_GROUP:-$RUN_USER}}"
LOCK_DIR="${AGENTDECK_DEPLOY_LOCK:-/tmp/agentdeck-deploy.lock}"

usage() {
  echo "usage: scripts/deploy.sh --check|--deploy [--components web,runtime|--changed]|--rollback [--components ...]" >&2
}

log() {
  printf '[agentdeck-deploy] %s\n' "$*"
}

require_user_group() {
  getent passwd "$RUN_USER" >/dev/null || { echo "ERROR: configured service user does not exist: $RUN_USER" >&2; exit 1; }
  getent group "$RUN_GROUP" >/dev/null || { echo "ERROR: configured service group does not exist: $RUN_GROUP" >&2; exit 1; }
}

check_active_turns() {
  local mode="${1:-fail}"
  node - "$DATA_DIR" "$mode" <<'NODE'
const dataDir = process.argv[2];
const mode = process.argv[3] || 'fail';
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const dbPath = process.env.RUNTIME_DB || path.join(dataDir, 'agentdeck-runtime.sqlite3');
if (!fs.existsSync(dbPath)) process.exit(0);
const db = new Database(dbPath, { readonly:true, fileMustExist:true });
const row = db.prepare("SELECT id,status,active_turn_id FROM sessions WHERE status IN ('running','submitting') OR active_turn_id IS NOT NULL LIMIT 1").get();
if (row) {
  const message = `active turn exists: ${row.id} ${row.status || ''} ${row.active_turn_id || ''}`;
  if (mode === 'warn') {
    console.error(`WARN: ${message}`);
    process.exit(0);
  }
  console.error(`ERROR: ${message}`);
  process.exit(2);
}
NODE
}

check_systemd_units() {
  for file in "$ROOT"/deploy/systemd/*.service; do
    [ -f "$file" ] || continue
    verify_file="$file"
    tmp_rendered=""
    if grep -q '@AGENTDECK_ENV_DIR@' "$file"; then
      tmp_rendered="$(mktemp --suffix=.service)"
      sed "s#@AGENTDECK_ENV_DIR@#$ENV_DIR#g" "$file" > "$tmp_rendered"
      verify_file="$tmp_rendered"
    fi
    if command -v systemd-analyze >/dev/null 2>&1; then
      tmp="$(mktemp)"
      if ! systemd-analyze verify "$verify_file" >"$tmp" 2>&1; then
        if grep -Fq "$verify_file" "$tmp" || grep -Fq "$(basename "$file")" "$tmp"; then
          cat "$tmp" >&2
          rm -f "$tmp"
          [ -z "$tmp_rendered" ] || rm -f "$tmp_rendered"
          exit 1
        fi
        cat "$tmp" >&2
      fi
      rm -f "$tmp"
    fi
    if grep -q 'Restart=always' "$file"; then
      echo "ERROR: Restart=always is not allowed in $file" >&2
      [ -z "$tmp_rendered" ] || rm -f "$tmp_rendered"
      exit 1
    fi
    [ -z "$tmp_rendered" ] || rm -f "$tmp_rendered"
  done
}

check_profile_mapping() {
  node - "$DATA_DIR" <<'NODE'
const dataDir = process.argv[2];
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const dbPath = path.join(dataDir, 'agentdeck.sqlite3');
if (!fs.existsSync(dbPath)) process.exit(0);
const db = new Database(dbPath, { readonly:true, fileMustExist:true });
const cols = new Set(db.prepare("PRAGMA table_info(codex_profiles)").all().map(c => c.name));
if (!cols.has('codex_home') && !cols.has('home_dir')) process.exit(0);
const homeExpr = cols.has('home_dir') && cols.has('codex_home') ? 'COALESCE(home_dir,codex_home)' : cols.has('home_dir') ? 'home_dir' : 'codex_home';
const statusExpr = cols.has('status') ? "COALESCE(status,'authenticated')" : "'authenticated'";
const rows = db.prepare(`SELECT id,${homeExpr} AS home_dir FROM codex_profiles WHERE ${statusExpr} NOT IN ('deleted','tombstone')`).all();
const homes = new Map();
for (const row of rows) {
  if (!row.home_dir) continue;
  const previous = homes.get(row.home_dir);
  if (previous && previous !== row.id) {
    console.error(`ERROR: multiple Codex profiles share home_dir: ${previous} and ${row.id}`);
    process.exit(2);
  }
  homes.set(row.home_dir, row.id);
}

NODE
}

check_env_dir() {
  [ -d "$ENV_DIR" ] || { echo "ERROR: env dir does not exist: $ENV_DIR" >&2; exit 1; }
  [ -w "$ENV_DIR" ] || { echo "ERROR: env dir is not writable: $ENV_DIR" >&2; exit 1; }
  for name in web.env runtime.env agentdeck-app-server-default.env; do
    [ -f "$ENV_DIR/$name" ] || { echo "ERROR: missing env file: $ENV_DIR/$name" >&2; exit 1; }
  done
}

check_provider_binaries() {
  node - "$ENV_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const envDir = process.argv[2];
function readEnv(name) {
  const file = path.join(envDir, name);
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) out[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}
const web = readEnv('web.env');
const runtime = readEnv('runtime.env');
const checks = [
  ['ANTIGRAVITY_BIN', web.ANTIGRAVITY_BIN || '/home/ubuntu/.local/bin/agy'],
  ['GEMINI_BIN', runtime.GEMINI_BIN || web.GEMINI_BIN || '/usr/bin/gemini'],
];
for (const [name, value] of checks) {
  if (!value.startsWith('/')) {
    console.error(`ERROR: ${name} must be an absolute path: ${value}`);
    process.exit(1);
  }
  try {
    fs.accessSync(value, fs.constants.X_OK);
  } catch {
    console.error(`ERROR: configured provider binary is not executable: ${name}=${value}`);
    process.exit(1);
  }
}
NODE
}

run_check() {
  cd "$ROOT"
  log "root=$ROOT data=$DATA_DIR"
  log "checking Node and npm"
  node --version
  npm --version
  log "checking dependencies"
  npm ls --depth=0 >/dev/null
  log "checking service user"
  require_user_group
  log "checking env dir"
  check_env_dir
  log "checking provider binaries"
  check_provider_binaries
  log "checking active turns"
  check_active_turns warn
  log "checking systemd unit files"
  check_systemd_units
  log "checking profile mappings"
  check_profile_mapping
  log "running placeholder migration dry-run"
  DATA_DIR="$DATA_DIR" node "$ROOT/scripts/migrate-codex-placeholder-identities.mjs" --dry-run >/dev/null
  log "running typecheck"
  npm run typecheck
  log "running build"
  npm run build
  log "running unit tests"
  npm test
  log "running mock e2e"
  npm run test:e2e
  log "CHECK_OK commit=$(git rev-parse --short=12 HEAD)"
}

health_web() {
  curl -fsS http://127.0.0.1:3842/api/status >/dev/null
}

health_runtime() {
  curl -fsS http://127.0.0.1:3852/healthz >/dev/null
}

runtime_drain_start() {
  curl -fsS -X POST http://127.0.0.1:3852/drain/start >/dev/null
}

runtime_drain_cancel() {
  curl -fsS -X POST http://127.0.0.1:3852/drain/cancel >/dev/null || true
}

runtime_drain_wait() {
  node - <<'NODE'
const deadline = Date.now() + Number(process.env.RUNTIME_DRAIN_TIMEOUT_MS || 600000);
async function main() {
  while (Date.now() < deadline) {
    const res = await fetch('http://127.0.0.1:3852/drain/status');
    if (!res.ok) throw new Error(`drain status failed: ${res.status}`);
    const state = await res.json();
    if (state.drained) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('runtime drain timed out');
}
main().catch(err => { console.error(`ERROR: ${err.message}`); process.exit(2); });
NODE
}

normalize_components() {
  local raw="${1:-web,runtime}"
  raw="${raw// /}"
  [ -n "$raw" ] || raw="web,runtime"
  printf '%s\n' "$raw"
}

changed_components() {
  local range="${AGENTDECK_CHANGED_RANGE:-HEAD~1..HEAD}"
  local files
  files="$(git diff --name-only "$range" || true)"
  if [ -z "$files" ]; then
    echo "none"
    return
  fi
  node - "$files" <<'NODE'
const files = process.argv[2].split(/\n/).filter(Boolean);
const components = new Set();
for (const file of files) {
  if (/^(docs|tests|README|.*\.md$)/.test(file)) continue;
  if (/^(client|public)\//.test(file)) components.add('web');
  else if (/^(server\/src\/agentdeck-runtime|server\/src\/runtime-client|server\/src\/acp|server\/src\/providers|server\/src\/provider-|server\/src\/db|migrations)\b/.test(file)) components.add('runtime');
  else if (/^(deploy\/systemd\/agentdeck-app-server@|server\/src\/codex|server\/src\/providers)\b/.test(file)) components.add('runtime');
  else if (/^(server|deploy|scripts)\//.test(file)) { components.add('web'); components.add('runtime'); }
}
console.log(components.size ? [...components].join(',') : 'none');
NODE
}

install_units() {
  ROOT="$ROOT" DATA_DIR="$DATA_DIR" ENV_DIR="$ENV_DIR" LOG="$ROOT/.tools/install-units.log" "$ROOT/deploy/install-units.sh"
}

deploy_web() {
  log "deploying component=web"
  npm run build
  install_units
  sudo systemctl restart agentdeck-web.service
  sleep 2
  health_web
}

deploy_runtime() {
  log "deploying component=runtime"
  npm run build
  install_units
  runtime_drain_start
  if ! runtime_drain_wait; then
    runtime_drain_cancel
    echo "ERROR: runtime did not drain; deployment cancelled before restart" >&2
    exit 2
  fi
  sudo systemctl restart agentdeck-runtime.service
  sleep 3
  health_runtime
}

deploy_provider() {
  local spec="$1"
  log "deploying component=$spec"
  local provider profile unit
  provider="$(printf '%s' "$spec" | cut -d: -f2)"
  profile="$(printf '%s' "$spec" | cut -d: -f3)"
  [ -n "$provider" ] && [ -n "$profile" ] || { echo "ERROR: provider component requires provider:name:profileId" >&2; exit 2; }
  check_active_turns fail
  case "$provider" in
    codex)
      unit="agentdeck-app-server@${profile}.service"
      sudo systemctl restart "$unit"
      ;;
    gemini)
      curl -fsS -X POST "http://127.0.0.1:3852/gemini/profiles/${profile}/restart" >/dev/null
      ;;
    *) echo "ERROR: unsupported provider component: $provider" >&2; exit 2 ;;
  esac
}

deploy_components() {
  local components="$1"
  if [ "$components" = "none" ]; then
    log "no deployable component changes"
    return
  fi
  IFS=',' read -r -a parts <<<"$components"
  for component in "${parts[@]}"; do
    case "$component" in
      web) deploy_web ;;
      runtime) deploy_runtime ;;
      provider:*) deploy_provider "$component" ;;
      *) echo "ERROR: unknown component: $component" >&2; exit 2 ;;
    esac
  done
}

rollback_components() {
  local components="$1"
  if [ "$components" = "none" ]; then
    log "no rollback components requested"
    return
  fi
  IFS=',' read -r -a parts <<<"$components"
  for component in "${parts[@]}"; do
    case "$component" in
      web) sudo systemctl restart agentdeck-web.service; health_web ;;
      runtime) sudo systemctl restart agentdeck-runtime.service; sleep 3; health_runtime ;;
      provider:codex:*) sudo systemctl restart "agentdeck-app-server@${component##*:}.service" ;;
      provider:gemini:*) curl -fsS -X POST "http://127.0.0.1:3852/gemini/profiles/${component##*:}/restart" >/dev/null ;;
      *) echo "ERROR: unknown rollback component: $component" >&2; exit 2 ;;
    esac
  done
}

with_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "ERROR: another deploy appears to be running: $LOCK_DIR" >&2
    exit 1
  fi
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
}

run_deploy() {
  with_lock
  local components="${COMPONENTS:-web,runtime}"
  if [ "${CHANGED:-0}" = "1" ]; then
    components="$(changed_components)"
  fi
  components="$(normalize_components "$components")"
  if [[ "$components" == *runtime* || "$components" == *provider:* ]]; then
    if [ "${AGENTDECK_ALLOW_ACTIVE_TURN:-0}" = "1" ]; then
      log "active turn override enabled"
      check_active_turns warn
    else
      check_active_turns fail
    fi
  fi
  deploy_components "$components"
}

run_rollback() {
  with_lock
  rollback_components "$(normalize_components "${COMPONENTS:-web,runtime}")"
}

MODE="${1:-}"
shift || true
COMPONENTS=""
CHANGED=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --components) COMPONENTS="${2:-}"; shift 2 ;;
    --changed) CHANGED=1; shift ;;
    *) usage; exit 2 ;;
  esac
done

case "$MODE" in
  --check) run_check ;;
  --deploy) run_deploy ;;
  --rollback) run_rollback ;;
  *) usage; exit 2 ;;
esac
