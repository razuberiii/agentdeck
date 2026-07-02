#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-/opt/data/agentdeck}"
ENV_DIR="${ENV_DIR:-/etc/agentdeck}"
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
    if command -v systemd-analyze >/dev/null 2>&1; then
      tmp="$(mktemp)"
      if ! systemd-analyze verify "$file" >"$tmp" 2>&1; then
        if grep -Fq "$file" "$tmp" || grep -Fq "$(basename "$file")" "$tmp"; then
          cat "$tmp" >&2
          rm -f "$tmp"
          exit 1
        fi
        cat "$tmp" >&2
      fi
      rm -f "$tmp"
    fi
    if grep -q 'Restart=always' "$file"; then
      echo "ERROR: Restart=always is not allowed in $file" >&2
      exit 1
    fi
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
  ROOT="$ROOT" DATA_DIR="$DATA_DIR" "$ROOT/deploy/cutover.sh"
}

run_rollback() {
  with_lock
  ROOT="$ROOT" DATA_DIR="$DATA_DIR" "$ROOT/deploy/rollback.sh"
}

case "${1:-}" in
  --check) run_check ;;
  --deploy) run_deploy ;;
  --rollback) run_rollback ;;
  *) usage; exit 2 ;;
esac
