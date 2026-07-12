#!/usr/bin/env bash
# shellcheck disable=SC2269
set -euo pipefail

INSTALL_MODE=all
case "${1:-}" in
  '') ;;
  --runtime-drop-in) INSTALL_MODE=runtime-drop-in ;;
  *) echo "usage: deploy/install-units.sh [--runtime-drop-in]" >&2; exit 2 ;;
esac

ROOT=${ROOT:-/opt/agentdeck}
DATA_DIR=${AGENTDECK_DATA_DIR:-${DATA_DIR:-/opt/data/agentdeck}}
ENV_DIR=${AGENTDECK_ENV_DIR:-${ENV_DIR:-/etc/agentdeck}}
SYSTEMD_DIR=${AGENTDECK_SYSTEMD_DIR:-/etc/systemd/system}
detect_install_profile() {
  local profile="${AGENTDECK_INSTALL_PROFILE:-}"
  if [ -n "$profile" ]; then
    case "$profile" in personal|standard|hardened) printf '%s\n' "$profile" ;; *) echo "ERROR: invalid AGENTDECK_INSTALL_PROFILE: $profile" >&2; exit 1 ;; esac
    return
  fi
  if [ -f "$SYSTEMD_DIR/agentdeck-app-server@.service" ] && grep -Eq 'User=ubuntu|danger-full-access' "$SYSTEMD_DIR/agentdeck-app-server@.service"; then
    printf '%s\n' personal
    return
  fi
  printf '%s\n' personal
}
INSTALL_PROFILE="$(detect_install_profile)"
if [ -n "${AGENTDECK_RUN_USER:-}" ]; then
  RUN_USER="$AGENTDECK_RUN_USER"
elif [ "$INSTALL_PROFILE" = "standard" ] || [ "$INSTALL_PROFILE" = "hardened" ]; then
  RUN_USER=agentdeck
else
  RUN_USER=ubuntu
fi
RUN_GROUP=${AGENTDECK_RUN_GROUP:-$RUN_USER}
if [ -n "${AGENTDECK_HOME:-}" ]; then
  AGENTDECK_HOME="$AGENTDECK_HOME"
elif [ "$RUN_USER" = "ubuntu" ]; then
  AGENTDECK_HOME=/home/ubuntu
else
  AGENTDECK_HOME=/var/lib/agentdeck
fi
CURRENT_DIR=${AGENTDECK_CURRENT_DIR:-/opt/stacks/agentdeck/current}
BIN_DIR=${AGENTDECK_BIN_DIR:-/usr/local/bin}
CODEX_BIN=${AGENTDECK_CODEX_BIN:-${CODEX_BIN:-}}
if [ -z "$CODEX_BIN" ]; then
  CODEX_BIN="$AGENTDECK_HOME/.local/bin/codex"
fi
case "$INSTALL_PROFILE" in
  personal)
    CODEX_APPROVAL_POLICY=${AGENTDECK_CODEX_APPROVAL_POLICY:-never}
    CODEX_SANDBOX_MODE=${AGENTDECK_CODEX_SANDBOX_MODE:-danger-full-access}
    ;;
  standard)
    CODEX_APPROVAL_POLICY=${AGENTDECK_CODEX_APPROVAL_POLICY:-on-request}
    CODEX_SANDBOX_MODE=${AGENTDECK_CODEX_SANDBOX_MODE:-workspace-write}
    ;;
  hardened)
    CODEX_APPROVAL_POLICY=${AGENTDECK_CODEX_APPROVAL_POLICY:-on-request}
    CODEX_SANDBOX_MODE=${AGENTDECK_CODEX_SANDBOX_MODE:-read-only}
    ;;
esac
LOG=${LOG:-$ROOT/.tools/install-units.log}
mkdir -p "$ROOT/.tools" "$DATA_DIR"
exec >>"$LOG" 2>&1

echo "== install-units $(date -Is) =="
echo "profile=$INSTALL_PROFILE"
echo "run_user=$RUN_USER"
echo "run_group=$RUN_GROUP"
echo "home=$AGENTDECK_HOME"
echo "data_dir=$DATA_DIR"
echo "current_dir=$CURRENT_DIR"
echo "env_dir=$ENV_DIR"
echo "codex_bin=$CODEX_BIN"
echo "codex_approval_policy=$CODEX_APPROVAL_POLICY"
echo "codex_sandbox_mode=$CODEX_SANDBOX_MODE"
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

render_unit_template() {
  local source="$1" target="$2"
  sed \
    -e "s#@AGENTDECK_RUN_USER@#$RUN_USER#g" \
    -e "s#@AGENTDECK_RUN_GROUP@#$RUN_GROUP#g" \
    -e "s#@AGENTDECK_HOME@#$AGENTDECK_HOME#g" \
    -e "s#@AGENTDECK_DATA_DIR@#$DATA_DIR#g" \
    -e "s#@AGENTDECK_CURRENT_DIR@#$CURRENT_DIR#g" \
    -e "s#@AGENTDECK_ENV_DIR@#$ENV_DIR#g" \
    -e "s#@CODEX_BIN@#$CODEX_BIN#g" \
    -e "s#@CODEX_APPROVAL_POLICY@#$CODEX_APPROVAL_POLICY#g" \
    -e "s#@CODEX_SANDBOX_MODE@#$CODEX_SANDBOX_MODE#g" \
    "$source" > "$target"
}

if ! getent passwd "$RUN_USER" >/dev/null; then
  echo "ERROR: configured service user does not exist: $RUN_USER" >&2
  exit 1
fi
if ! getent group "$RUN_GROUP" >/dev/null; then
  echo "ERROR: configured service group does not exist: $RUN_GROUP" >&2
  exit 1
fi
if [ ! -x "$CODEX_BIN" ]; then
  echo "WARNING: configured Codex binary is not executable yet: $CODEX_BIN" >&2
fi

if [ ! -d "$ENV_DIR" ]; then
  echo "ERROR: env dir does not exist: $ENV_DIR" >&2
  exit 1
fi

required_env=(runtime.env)
[ "$INSTALL_MODE" = runtime-drop-in ] || required_env+=(web.env agentdeck-app-server-default.env)
for env_file in "${required_env[@]}"; do
  if [ ! -r "$ENV_DIR/$env_file" ] && [ ! -w "$ENV_DIR" ]; then
    echo "ERROR: missing env file $ENV_DIR/$env_file and env dir is not writable" >&2
    exit 1
  fi
done

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
if [ "$INSTALL_MODE" = runtime-drop-in ]; then
  mkdir -p "$tmpdir/agentdeck-runtime.service.d"
  cat > "$tmpdir/agentdeck-runtime.service.d/90-agentdeck-contract.conf" <<'EOF'
[Service]
Environment=AGENTDECK_SYSTEMD_UNIT_VERSION=2
TimeoutStopSec=660
EOF
  sudo install -d -m 0755 "$SYSTEMD_DIR/agentdeck-runtime.service.d"
  install_if_changed 0644 "$tmpdir/agentdeck-runtime.service.d/90-agentdeck-contract.conf" "$SYSTEMD_DIR/agentdeck-runtime.service.d/90-agentdeck-contract.conf"
else
  for unit in agentdeck-web.service agentdeck-runtime.service agentdeck-app-server@.service; do
    render_unit_template "$ROOT/deploy/systemd/$unit" "$tmpdir/$unit"
    install_if_changed 0644 "$tmpdir/$unit" "$SYSTEMD_DIR/$unit"
  done
fi

if [ "$INSTALL_MODE" != runtime-drop-in ] && [ ! -f "$ENV_DIR/web.env" ]; then
  if [ -f "$ENV_DIR/.env" ]; then
    sudo cp "$ENV_DIR/.env" "$ENV_DIR/web.env"
  else
    {
      echo "HOST=127.0.0.1"; echo "PORT=3842"; echo "DATA_DIR=$DATA_DIR"
      echo "ADMIN_PASSWORD=change-me-at-least-12-chars"; echo "COOKIE_SECRET=change-me-random-32-bytes"; echo "COOKIE_SECURE=true"
      echo "ALLOWED_ORIGINS=https://agentdeck.example.com"; echo "USE_AGENT_RUNTIME=1"; echo "AGENT_RUNTIME_URL=http://127.0.0.1:3852"
      echo "PATH=$DATA_DIR/provider-tools/bin:$AGENTDECK_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
      echo "PLAYWRIGHT_BROWSERS_PATH=$DATA_DIR/cache/ms-playwright"; echo "CLAUDE_PROFILE_ROOT=$DATA_DIR/claude/profiles"; echo "CLAUDE_CONFIG_DIR=$AGENTDECK_HOME/.claude"
    } | sudo tee "$ENV_DIR/web.env" >/dev/null
    sudo chmod 0600 "$ENV_DIR/web.env"
  fi
fi

if [ ! -f "$ENV_DIR/runtime.env" ]; then
  {
    echo "DATA_DIR=$DATA_DIR"; echo "AGENTDECK_SERVICE_USER=$RUN_USER"; echo "RUNTIME_DB=$DATA_DIR/agentdeck-runtime.sqlite3"
    echo "RUNTIME_HOST=127.0.0.1"; echo "RUNTIME_PORT=3852"; echo "RUNTIME_INSTANCE_ID=runtime-main"
    echo "CODEX_HOME=$DATA_DIR/profiles/default/.codex"; echo "CLAUDE_PROFILE_ROOT=$DATA_DIR/claude/profiles"; echo "CLAUDE_CONFIG_DIR=$AGENTDECK_HOME/.claude"
    echo "HOME=$AGENTDECK_HOME"; echo "PATH=$DATA_DIR/provider-tools/bin:$AGENTDECK_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
    echo "PLAYWRIGHT_BROWSERS_PATH=$DATA_DIR/cache/ms-playwright"; echo "CODEX_APP_SERVER_USER=$RUN_USER"; echo "CODEX_APP_SERVER_GROUP=$RUN_GROUP"
  } | sudo tee "$ENV_DIR/runtime.env" >/dev/null
  sudo chmod 0600 "$ENV_DIR/runtime.env"
fi

if [ "$INSTALL_MODE" != runtime-drop-in ] && [ ! -f "$ENV_DIR/agentdeck-app-server-default.env" ]; then
  {
    echo "HOME=${AGENTDECK_HOME}"
    echo "CODEX_HOME=${AGENTDECK_CODEX_HOME:-$DATA_DIR/profiles/default/.codex}"
    echo "CODEX_APP_SERVER_LISTEN=ws://127.0.0.1:4668"
  } | sudo tee "$ENV_DIR/agentdeck-app-server-default.env" >/dev/null
  sudo chmod 0600 "$ENV_DIR/agentdeck-app-server-default.env"
fi

if [ "$changed" = "1" ]; then
  sudo systemctl daemon-reload
else
  echo "systemd units unchanged; skipping daemon-reload"
fi
case "$SYSTEMD_DIR" in
  /run/systemd/system|/run/systemd/system/*)
    reapply_arg=""
    [ "$INSTALL_MODE" = runtime-drop-in ] && reapply_arg=" --runtime-drop-in"
    echo "Runtime systemd configuration is active after daemon-reload; it is stored under /run and will disappear after host reboot."
    echo "Reapply idempotently from the host startup flow: sudo AGENTDECK_SYSTEMD_DIR=$SYSTEMD_DIR agentdeckctl install-units$reapply_arg"
    ;;
esac
install_if_changed 0755 "$ROOT/scripts/agentdeckctl" "$BIN_DIR/agentdeckctl"
echo "installed units"
