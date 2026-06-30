#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/opt/stacks/agentdeck}
LOG=${LOG:-$ROOT/.tools/production-cutover-result.log}
mkdir -p "$ROOT/.tools"
exec >>"$LOG" 2>&1

echo "== rollback $(date -Is) =="
sudo systemctl restart agentdeck-app-server@default.service
sudo systemctl restart agentdeck-runtime.service
sudo systemctl restart agentdeck-web.service
sleep 3
systemctl --no-pager --full status agentdeck-app-server@default.service agentdeck-runtime.service agentdeck-web.service || true
echo "rollback complete"
