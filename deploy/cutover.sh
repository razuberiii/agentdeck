#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/opt/stacks/agentdeck}
DATA_DIR=${DATA_DIR:-/opt/data/agentdeck}
LOG=${LOG:-$ROOT/.tools/production-cutover-result.log}
mkdir -p "$ROOT/.tools" "$DATA_DIR"
exec >>"$LOG" 2>&1

echo "== production cutover $(date -Is) =="
echo "root=$ROOT data=$DATA_DIR"

rollback() {
  code=$?
  echo "cutover failed with code $code at $(date -Is)"
  "$ROOT/deploy/rollback.sh" || true
  exit "$code"
}
trap rollback ERR

cd "$ROOT"
npm run build

if [ -f /etc/systemd/system/agentdeck-web.service ] && [ -f /etc/systemd/system/agentdeck-runtime.service ] && [ -f /etc/systemd/system/agentdeck-app-server@.service ]; then
  echo "units already installed; skipping /etc writes"
else
  LOG="$ROOT/.tools/install-units.log" "$ROOT/deploy/install-units.sh"
fi

sudo sed -i 's/^CODEX_APP_SERVER_PORT_BASE=.*/CODEX_APP_SERVER_PORT_BASE=4620/' "$DATA_DIR/runtime.env"
sudo sed -i 's#^CODEX_APP_SERVER_LISTEN=.*#CODEX_APP_SERVER_LISTEN=ws://127.0.0.1:4668#' "$DATA_DIR/agentdeck-app-server-default.env"

echo "stopping legacy service"
sudo systemctl stop agentdeck.service || true
sleep 2
pkill -f 'codex app-server --listen stdio://' || true

echo "starting independent codex app-server"
sudo systemctl restart agentdeck-app-server@default.service
sleep 3
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
node "$ROOT/deploy/e2e-runtime.mjs"

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
