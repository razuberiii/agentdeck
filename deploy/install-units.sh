#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/opt/agentdeck}
DATA_DIR=${DATA_DIR:-/opt/data/agentdeck}
ENV_DIR=${AGENTDECK_ENV_DIR:-${ENV_DIR:-$DATA_DIR}}
RUN_USER=${AGENTDECK_RUN_USER:-ubuntu}
RUN_GROUP=${AGENTDECK_RUN_GROUP:-$RUN_USER}
AGENTDECK_HOME=${AGENTDECK_HOME:-/home/$RUN_USER}
LOG=${LOG:-$ROOT/.tools/install-units.log}
mkdir -p "$ROOT/.tools" "$DATA_DIR"
exec >>"$LOG" 2>&1

echo "== install-units $(date -Is) =="
echo "env_dir=$ENV_DIR"
sudo install -d -m 0755 /run/agentdeck
changed=0

install_if_changed() {
  local mode="$1" source="$2" target="$3"
  if [ -f "$target" ] && cmp -s "$source" "$target"; then
    echo "unchanged $target"
    return 0
  fi
  sudo install -m "$mode" "$source" "$target"
  changed=1
  echo "installed $target"
}

if ! getent passwd "$RUN_USER" >/dev/null; then
  echo "ERROR: configured service user does not exist: $RUN_USER" >&2
  exit 1
fi
if ! getent group "$RUN_GROUP" >/dev/null; then
  echo "ERROR: configured service group does not exist: $RUN_GROUP" >&2
  exit 1
fi

if [ ! -d "$ENV_DIR" ]; then
  echo "ERROR: env dir does not exist: $ENV_DIR" >&2
  exit 1
fi
if [ ! -w "$ENV_DIR" ]; then
  echo "ERROR: env dir is not writable: $ENV_DIR" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
for unit in agentdeck-web.service agentdeck-runtime.service agentdeck-app-server@.service; do
  sed "s#@AGENTDECK_ENV_DIR@#$ENV_DIR#g" "$ROOT/deploy/systemd/$unit" > "$tmpdir/$unit"
  install_if_changed 0644 "$tmpdir/$unit" "/etc/systemd/system/$unit"
done

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
    echo "HOME=${AGENTDECK_HOME}"
    echo "CODEX_HOME=${CODEX_HOME:-$DATA_DIR/profiles/default/.codex}"
    echo "CODEX_APP_SERVER_LISTEN=ws://127.0.0.1:4668"
  } | sudo tee "$ENV_DIR/agentdeck-app-server-default.env" >/dev/null
  sudo chmod 0600 "$ENV_DIR/agentdeck-app-server-default.env"
fi

if [ "$changed" = "1" ]; then
  sudo systemctl daemon-reload
else
  echo "systemd units unchanged; skipping daemon-reload"
fi
install_if_changed 0755 "$ROOT/scripts/agentdeckctl" /usr/local/bin/agentdeckctl
echo "installed units"
