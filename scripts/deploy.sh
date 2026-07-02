#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-/opt/data/agentdeck}"
ENV_DIR="${AGENTDECK_ENV_DIR:-${ENV_DIR:-$DATA_DIR}}"
RUN_USER="${AGENTDECK_RUN_USER:-${CODEX_APP_SERVER_USER:-ubuntu}}"
RUN_GROUP="${AGENTDECK_RUN_GROUP:-${CODEX_APP_SERVER_GROUP:-$RUN_USER}}"
LOCK_DIR="${AGENTDECK_DEPLOY_LOCK:-/tmp/agentdeck-deploy.lock}"

usage() {
  echo "usage: scripts/deploy.sh --check|--deploy|--rollback" >&2
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

with_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "ERROR: another deploy appears to be running: $LOCK_DIR" >&2
    exit 1
  fi
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
}

run_deploy() {
  with_lock
  if [ "${AGENTDECK_ALLOW_ACTIVE_TURN:-0}" = "1" ]; then
    log "active turn override enabled"
    check_active_turns warn
  else
    check_active_turns fail
  fi
  ROOT="$ROOT" DATA_DIR="$DATA_DIR" ENV_DIR="$ENV_DIR" "$ROOT/deploy/cutover.sh"
}

run_rollback() {
  with_lock
  ROOT="$ROOT" DATA_DIR="$DATA_DIR" ENV_DIR="$ENV_DIR" "$ROOT/deploy/rollback.sh"
}

case "${1:-}" in
  --check) run_check ;;
  --deploy) run_deploy ;;
  --rollback) run_rollback ;;
  *) usage; exit 2 ;;
esac
