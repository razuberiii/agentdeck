#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/opt/stacks/codex-mobile}
DATA_DIR=${DATA_DIR:-/opt/data/codex-mobile}
LOG=${LOG:-$ROOT/.tools/install-units.log}
mkdir -p "$ROOT/.tools" "$DATA_DIR"
exec >>"$LOG" 2>&1

echo "== install-units $(date -Is) =="
before=$(findmnt -T /etc -o TARGET,SOURCE,FSTYPE,OPTIONS,PROPAGATION -n || true)
echo "before: $before"

remounted=0
if findmnt -T /etc -n -o OPTIONS | grep -qw ro; then
  sudo mount -o remount,bind,rw /etc || sudo mount -o remount,rw /etc
  remounted=1
fi

cleanup() {
  if [ "$remounted" = 1 ]; then
    sudo mount -o remount,bind,ro /etc || sudo mount -o remount,ro /etc || true
    echo "after: $(findmnt -T /etc -o TARGET,SOURCE,FSTYPE,OPTIONS,PROPAGATION -n || true)"
  fi
}
trap cleanup EXIT

sudo install -m 0644 "$ROOT/deploy/systemd/codex-mobile-web.service" /etc/systemd/system/codex-mobile-web.service
sudo install -m 0644 "$ROOT/deploy/systemd/agent-runtime.service" /etc/systemd/system/agent-runtime.service
sudo install -m 0644 "$ROOT/deploy/systemd/codex-app-server@.service" /etc/systemd/system/codex-app-server@.service

if [ ! -f "$DATA_DIR/web.env" ]; then
  if [ -f "$DATA_DIR/.env" ]; then
    sudo cp "$DATA_DIR/.env" "$DATA_DIR/web.env"
  else
    sudo install -m 0600 "$ROOT/deploy/systemd/env/web.env.example" "$DATA_DIR/web.env"
  fi
fi

if [ ! -f "$DATA_DIR/runtime.env" ]; then
  sudo install -m 0600 "$ROOT/deploy/systemd/env/runtime.env.example" "$DATA_DIR/runtime.env"
fi

if [ ! -f "$DATA_DIR/codex-app-server-default.env" ]; then
  {
    echo "HOME=/home/ubuntu"
    echo "CODEX_HOME=${CODEX_HOME:-/home/ubuntu/.codex}"
    echo "CODEX_APP_SERVER_LISTEN=ws://127.0.0.1:4668"
  } | sudo tee "$DATA_DIR/codex-app-server-default.env" >/dev/null
  sudo chmod 0600 "$DATA_DIR/codex-app-server-default.env"
fi

sudo systemctl daemon-reload
echo "installed units"
