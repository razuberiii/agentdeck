#!/usr/bin/env bash
# Shared by installation and read-only unit rendering.
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
# Read only identity fields; runtime.env may contain secrets or shell syntax.
read_identity_value() {
  [ -r "$ENV_DIR/runtime.env" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*['\"]\{0,1\}\([^'\"#]*\).*/\1/p" "$ENV_DIR/runtime.env" | tail -1
}
existing_user="$(read_identity_value AGENTDECK_SERVICE_USER)"
existing_group="$(read_identity_value CODEX_APP_SERVER_GROUP)"
existing_home="$(read_identity_value HOME)"
if [ -n "${AGENTDECK_RUN_USER:-}" ]; then
  RUN_USER="$AGENTDECK_RUN_USER"
elif [ -n "$existing_user" ]; then
  RUN_USER="$existing_user"
elif [ "$INSTALL_PROFILE" = "standard" ] || [ "$INSTALL_PROFILE" = "hardened" ]; then
  RUN_USER=agentdeck
else
  RUN_USER=ubuntu
fi
if [ "$RUN_USER" != "$existing_user" ]; then
  existing_group=""
  existing_home=""
fi
RUN_GROUP=${AGENTDECK_RUN_GROUP:-${existing_group:-$RUN_USER}}
if [ -n "${AGENTDECK_HOME:-}" ]; then
  AGENTDECK_HOME="$AGENTDECK_HOME"
elif [ -n "$existing_home" ]; then
  AGENTDECK_HOME="$existing_home"
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
