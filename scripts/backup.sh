#!/usr/bin/env bash
set -euo pipefail
BACKUP_DIR=/opt/data/codex-mobile/backups
STAMP=$(date -u +%Y%m%d)
TMP=$(mktemp -d)
mkdir -p "$BACKUP_DIR"
if [ -d /home/ubuntu/.codex/sessions ]; then
  tar -C /home/ubuntu/.codex -czf "$TMP/codex-sessions.tar.gz" sessions
else
  tar -czf "$TMP/codex-sessions.tar.gz" --files-from /dev/null
fi
if [ -f /opt/data/codex-mobile/codex-mobile.sqlite3 ]; then
  sqlite3 /opt/data/codex-mobile/codex-mobile.sqlite3 ".backup '$TMP/codex-mobile.sqlite3'"
fi
tar -C "$TMP" -czf "$BACKUP_DIR/codex-mobile-$STAMP.tar.gz" .
rm -rf "$TMP"
ls -1t "$BACKUP_DIR"/codex-mobile-*.tar.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
