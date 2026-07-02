#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/opt/agentdeck}
DATA_DIR=${DATA_DIR:-/opt/data/agentdeck}
ENV_DIR=${AGENTDECK_ENV_DIR:-${ENV_DIR:-$DATA_DIR}}
LOG=${LOG:-$ROOT/.tools/production-cutover-result.log}
mkdir -p "$ROOT/.tools" "$DATA_DIR"
exec >>"$LOG" 2>&1

echo "== production cutover $(date -Is) =="
echo "root=$ROOT data=$DATA_DIR"
echo "env_dir=$ENV_DIR"

rollback() {
  code=$?
  echo "cutover failed with code $code at $(date -Is)"
  "$ROOT/deploy/rollback.sh" || true
  exit "$code"
}
trap rollback ERR

cd "$ROOT"
if [ ! -d "$ENV_DIR" ] || [ ! -w "$ENV_DIR" ]; then
  echo "ERROR: env dir is not writable before cutover: $ENV_DIR" >&2
  exit 1
fi
for name in web.env runtime.env agentdeck-app-server-default.env; do
  if [ ! -f "$ENV_DIR/$name" ]; then
    echo "ERROR: missing env file before cutover: $ENV_DIR/$name" >&2
    exit 1
  fi
done
npm run build

ROOT="$ROOT" DATA_DIR="$DATA_DIR" ENV_DIR="$ENV_DIR" LOG="$ROOT/.tools/install-units.log" "$ROOT/deploy/install-units.sh"

sudo grep -q '^CODEX_APP_SERVER_PORT_BASE=' "$ENV_DIR/runtime.env" && sudo sed -i 's/^CODEX_APP_SERVER_PORT_BASE=.*/CODEX_APP_SERVER_PORT_BASE=4620/' "$ENV_DIR/runtime.env" || echo 'CODEX_APP_SERVER_PORT_BASE=4620' | sudo tee -a "$ENV_DIR/runtime.env" >/dev/null
sudo grep -q '^CODEX_APP_SERVER_LISTEN=' "$ENV_DIR/agentdeck-app-server-default.env" && sudo sed -i 's#^CODEX_APP_SERVER_LISTEN=.*#CODEX_APP_SERVER_LISTEN=ws://127.0.0.1:4668#' "$ENV_DIR/agentdeck-app-server-default.env" || echo 'CODEX_APP_SERVER_LISTEN=ws://127.0.0.1:4668' | sudo tee -a "$ENV_DIR/agentdeck-app-server-default.env" >/dev/null

echo "stopping legacy service"
sudo systemctl stop agentdeck.service || true
sleep 2
ps -eo pid=,args= | awk '/codex app-server --listen stdio:\/\// && !/awk/ { print $1 }' | xargs -r kill || true

echo "ensuring independent codex app-server"
sudo systemctl start agentdeck-app-server@default.service
sleep 1
app_pid_before=$(pgrep -f 'codex app-server --listen ws://127.0.0.1:4668' | head -1 || true)
echo "app_pid_before=$app_pid_before"
test -n "$app_pid_before"

echo "starting agentdeck-runtime"
sudo systemctl restart agentdeck-runtime.service
sleep 3
runtime_pid=$(systemctl show agentdeck-runtime.service -p MainPID --value)
echo "runtime_pid=$runtime_pid"
test "$runtime_pid" != "0"
curl -fsS http://127.0.0.1:3852/healthz
curl -fsS -X POST http://127.0.0.1:3852/codex/accounts/default

echo "starting web gateway"
sudo systemctl restart agentdeck-web.service
sleep 3
web_pid=$(systemctl show agentdeck-web.service -p MainPID --value)
echo "web_pid=$web_pid"
test "$web_pid" != "0"

curl -fsS http://127.0.0.1:3842/api/status
node "$ROOT/deploy/verify-runtime.mjs"
if [ "${RUN_PRODUCTION_E2E:-0}" = "1" ]; then
  node "$ROOT/deploy/e2e-runtime.mjs"
else
  echo "skipping production e2e; set RUN_PRODUCTION_E2E=1 to enable real provider turn"
fi

app_pid_after=$(pgrep -f 'codex app-server --listen ws://127.0.0.1:4668' | head -1 || true)
echo "app_pid_after=$app_pid_after"
test -n "$app_pid_after"

if ps -eo pid=,args= | awk '/codex app-server --listen stdio:\/\// && !/awk/ { found=1 } END { exit found ? 0 : 1 }'; then
  echo "ERROR: legacy stdio Codex app-server still running"
  ps -eo pid=,ppid=,args= | awk '/codex app-server --listen stdio:\/\// && !/awk/'
  exit 1
fi

sudo systemctl is-active --quiet agentdeck-web.service
sudo systemctl is-active --quiet agentdeck-runtime.service
sudo systemctl is-active --quiet agentdeck-app-server@default.service

echo "CUTOVER_OK $(date -Is)"
