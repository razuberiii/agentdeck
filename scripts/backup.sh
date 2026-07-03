#!/usr/bin/env bash
set -euo pipefail
DATA_DIR=${DATA_DIR:-/var/lib/agentdeck}
CODEX_HOME=${CODEX_HOME:-${HOME:-/var/lib/agentdeck/home}/.codex}
BACKUP_DIR=${BACKUP_DIR:-$DATA_DIR/backups}
STAMP=$(date -u +%Y%m%d)
TMP=$(mktemp -d)
mkdir -p "$BACKUP_DIR"
if [ -d "$CODEX_HOME/sessions" ]; then
  tar -C "$CODEX_HOME" -czf "$TMP/codex-sessions.tar.gz" sessions
else
  tar -czf "$TMP/codex-sessions.tar.gz" --files-from /dev/null
fi
if [ -f "$DATA_DIR/agentdeck.sqlite3" ]; then
  sqlite3 "$DATA_DIR/agentdeck.sqlite3" ".backup '$TMP/agentdeck.sqlite3'"
fi
if [ -f "$DATA_DIR/agentdeck-runtime.sqlite3" ]; then
  sqlite3 "$DATA_DIR/agentdeck-runtime.sqlite3" ".backup '$TMP/agentdeck-runtime.sqlite3'"
fi
for dir in profiles claude/profiles gemini/profiles antigravity-profiles shared/sessions shared/generated_images attachments; do
  if [ -e "$DATA_DIR/$dir" ]; then
    mkdir -p "$TMP/$(dirname "$dir")"
    cp -a "$DATA_DIR/$dir" "$TMP/$dir"
  fi
done
tar -C "$TMP" -czf "$BACKUP_DIR/agentdeck-$STAMP.tar.gz" .
rm -rf "$TMP"
ls -1t "$BACKUP_DIR"/agentdeck-*.tar.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
