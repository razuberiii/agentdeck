#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/opt/stacks/codex-mobile}
LOG=${LOG:-$ROOT/.tools/production-cutover-result.log}
mkdir -p "$ROOT/.tools"
exec >>"$LOG" 2>&1

echo "== rollback $(date -Is) =="
sudo systemctl stop codex-mobile-web.service || true
sudo systemctl stop agent-runtime.service || true
sudo systemctl stop codex-app-server@default.service || true
sudo systemctl start codex-mobile.service
sleep 3
systemctl --no-pager --full status codex-mobile.service || true
echo "rollback complete"
