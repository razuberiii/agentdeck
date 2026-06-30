#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/opt/agentdeck}
DATA_DIR=${DATA_DIR:-/var/lib/agentdeck}
ENV_DIR=${ENV_DIR:-/etc/agentdeck}
LOG=${LOG:-$ROOT/.tools/install-units.log}
mkdir -p "$ROOT/.tools" "$DATA_DIR"
sudo mkdir -p "$ENV_DIR"
exec >>"$LOG" 2>&1

echo "== install-units $(date -Is) =="
before=$(findmnt -T /etc -o TARGET,SOURCE,FSTYPE,OPTIONS,PROPAGATION -n || true)
echo "before: $before"

remounted=0
if findmnt -T /etc -n -o OPTIONS | tr ',' '\n' | grep -qx ro; then
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

sudo install -m 0644 "$ROOT/deploy/systemd/agentdeck-web.service" /etc/systemd/system/agentdeck-web.service
sudo install -m 0644 "$ROOT/deploy/systemd/agentdeck-runtime.service" /etc/systemd/system/agentdeck-runtime.service
sudo install -m 0644 "$ROOT/deploy/systemd/agentdeck-app-server@.service" /etc/systemd/system/agentdeck-app-server@.service

if [ ! -f "$ENV_DIR/web.env" ]; then
  if [ -f "$ENV_DIR/.env" ]; then
    sudo cp "$ENV_DIR/.env" "$ENV_DIR/web.env"
  else
    sudo install -m 0600 "$ROOT/deploy/systemd/env/web.env.example" "$ENV_DIR/web.env"
  fi
fi

if [ ! -f "$ENV_DIR/runtime.env" ]; then
  sudo install -m 0600 "$ROOT/deploy/systemd/env/runtime.env.example" "$ENV_DIR/runtime.env"
fi

if [ ! -f "$ENV_DIR/agentdeck-app-server-default.env" ]; then
  {
    echo "HOME=${AGENTDECK_HOME:-/var/lib/agentdeck/home}"
    echo "CODEX_HOME=${CODEX_HOME:-${AGENTDECK_HOME:-/var/lib/agentdeck/home}/.codex}"
    echo "CODEX_APP_SERVER_LISTEN=ws://127.0.0.1:4668"
  } | sudo tee "$ENV_DIR/agentdeck-app-server-default.env" >/dev/null
  sudo chmod 0600 "$ENV_DIR/agentdeck-app-server-default.env"
fi

sudo systemctl daemon-reload
echo "installed units"
