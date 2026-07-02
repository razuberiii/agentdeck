#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/opt/agentdeck}
DATA_DIR=${DATA_DIR:-/opt/data/agentdeck}
ENV_DIR=${AGENTDECK_ENV_DIR:-${ENV_DIR:-$DATA_DIR}}
LOG=${LOG:-$ROOT/.tools/production-cutover-result.log}
mkdir -p "$ROOT/.tools"
exec >>"$LOG" 2>&1

echo "== rollback $(date -Is) =="
sudo systemctl restart agentdeck-runtime.service
sudo systemctl restart agentdeck-web.service
sleep 3
systemctl --no-pager --full status agentdeck-runtime.service agentdeck-web.service agentdeck-app-server@default.service || true
echo "rollback complete"
