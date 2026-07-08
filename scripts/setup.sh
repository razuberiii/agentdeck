#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA_DIR="${DATA_DIR:-/opt/data/agentdeck}"
ENV_DIR="${ENV_DIR:-/etc/agentdeck}"

detect_existing_personal_unit() {
  [ -f /etc/systemd/system/agentdeck-app-server@.service ] && grep -Eq 'User=ubuntu|danger-full-access' /etc/systemd/system/agentdeck-app-server@.service
}

choose_profile() {
  if [ -n "${AGENTDECK_INSTALL_PROFILE:-}" ]; then
    case "$AGENTDECK_INSTALL_PROFILE" in personal|standard|hardened) printf '%s\n' "$AGENTDECK_INSTALL_PROFILE" ;; *) echo "ERROR: invalid AGENTDECK_INSTALL_PROFILE: $AGENTDECK_INSTALL_PROFILE" >&2; exit 1 ;; esac
    return
  fi
  if detect_existing_personal_unit; then
    printf '%s\n' personal
    return
  fi
  if [ -t 0 ]; then
    printf 'Choose AgentDeck install profile [standard/personal] (standard): ' >&2
    read -r answer
    case "${answer:-standard}" in
      standard|s) printf '%s\n' standard ;;
      personal|p) printf '%s\n' personal ;;
      *) echo "ERROR: choose standard or personal" >&2; exit 1 ;;
    esac
    return
  fi
  printf '%s\n' personal
}

INSTALL_PROFILE="$(choose_profile)"
case "$INSTALL_PROFILE" in personal|standard|hardened) ;; *) echo "ERROR: invalid install profile: $INSTALL_PROFILE" >&2; exit 1 ;; esac

if [ -n "${AGENTDECK_SERVICE_USER:-${AGENTDECK_RUN_USER:-}}" ]; then
  RUN_USER="${AGENTDECK_SERVICE_USER:-${AGENTDECK_RUN_USER:-}}"
elif [ "$INSTALL_PROFILE" = "standard" ] || [ "$INSTALL_PROFILE" = "hardened" ]; then
  RUN_USER=agentdeck
else
  RUN_USER=ubuntu
fi
RUN_HOME="${AGENTDECK_HOME:-}"
if [ -z "$RUN_HOME" ]; then
  if [ "$RUN_USER" = "ubuntu" ]; then RUN_HOME=/home/ubuntu; else RUN_HOME=/var/lib/agentdeck; fi
fi

if { [ "$INSTALL_PROFILE" = "standard" ] || [ "$INSTALL_PROFILE" = "hardened" ]; } && ! getent passwd "$RUN_USER" >/dev/null; then
  useradd --system --create-home --home-dir "$RUN_HOME" --shell /usr/sbin/nologin "$RUN_USER"
fi

mkdir -p "$DATA_DIR" "$ENV_DIR" "$DATA_DIR/cache/ms-playwright" "$DATA_DIR/cache/npm" "$DATA_DIR/provider-tools/bin"
if getent passwd "$RUN_USER" >/dev/null; then
  chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR/cache" "$DATA_DIR/provider-tools"
fi

if [[ ! -f "$ENV_DIR/web.env" ]]; then
  install -m 0600 "$ROOT/deploy/systemd/env/web.env.example" "$ENV_DIR/web.env"
fi
if [[ ! -f "$ENV_DIR/runtime.env" ]]; then
  install -m 0600 "$ROOT/deploy/systemd/env/runtime.env.example" "$ENV_DIR/runtime.env"
fi
if [[ ! -f "$ENV_DIR/agentdeck-app-server-default.env" ]]; then
  install -m 0600 "$ROOT/deploy/systemd/env/codex-app-server-default.env.example" "$ENV_DIR/agentdeck-app-server-default.env"
fi

AGENTDECK_INSTALL_PROFILE="$INSTALL_PROFILE" AGENTDECK_RUN_USER="$RUN_USER" AGENTDECK_HOME="$RUN_HOME" ROOT="$ROOT" DATA_DIR="$DATA_DIR" ENV_DIR="$ENV_DIR" "$ROOT/deploy/install-units.sh"

if getent passwd "$RUN_USER" >/dev/null; then
  echo "Preparing Playwright Chromium cache in $DATA_DIR/cache/ms-playwright ..."
  if ! find "$DATA_DIR/cache/ms-playwright" -maxdepth 2 -type d -name 'chromium-*' 2>/dev/null | grep -q .; then
    runuser -u "$RUN_USER" -- env HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)" PLAYWRIGHT_BROWSERS_PATH="$DATA_DIR/cache/ms-playwright" npm_config_cache="$DATA_DIR/cache/npm" NPM_CONFIG_CACHE="$DATA_DIR/cache/npm" npx playwright install chromium
  fi
fi

echo "AgentDeck systemd units installed."
echo "Install profile: $INSTALL_PROFILE"
echo "Review $ENV_DIR/web.env and $ENV_DIR/runtime.env, then run: sudo agentdeckctl check && sudo agentdeckctl deploy all --wait"
