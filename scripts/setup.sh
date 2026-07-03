#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA_DIR="${DATA_DIR:-/opt/data/agentdeck}"
ENV_DIR="${ENV_DIR:-/etc/agentdeck}"
RUN_USER="${AGENTDECK_SERVICE_USER:-${AGENTDECK_RUN_USER:-ubuntu}}"

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

ROOT="$ROOT" DATA_DIR="$DATA_DIR" ENV_DIR="$ENV_DIR" "$ROOT/deploy/install-units.sh"

if getent passwd "$RUN_USER" >/dev/null; then
  echo "Preparing Playwright Chromium cache in $DATA_DIR/cache/ms-playwright ..."
  if ! find "$DATA_DIR/cache/ms-playwright" -maxdepth 2 -type d -name 'chromium-*' 2>/dev/null | grep -q .; then
    runuser -u "$RUN_USER" -- env HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)" PLAYWRIGHT_BROWSERS_PATH="$DATA_DIR/cache/ms-playwright" npm_config_cache="$DATA_DIR/cache/npm" NPM_CONFIG_CACHE="$DATA_DIR/cache/npm" npx playwright install chromium
  fi
fi

echo "AgentDeck systemd units installed."
echo "Review $ENV_DIR/web.env and $ENV_DIR/runtime.env, then run: sudo agentdeckctl check && sudo agentdeckctl deploy all --wait"
