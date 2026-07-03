#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA_DIR="${DATA_DIR:-/opt/data/agentdeck}"
ENV_DIR="${ENV_DIR:-/etc/agentdeck}"

mkdir -p "$DATA_DIR" "$ENV_DIR"

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

echo "AgentDeck systemd units installed."
echo "Review $ENV_DIR/web.env and $ENV_DIR/runtime.env, then run: sudo agentdeckctl check && sudo agentdeckctl deploy all --wait"
