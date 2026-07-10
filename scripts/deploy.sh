#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CTL="${AGENTDECKCTL:-$ROOT/scripts/agentdeckctl}"

usage() {
  echo "usage: scripts/deploy.sh --check|--deploy [--components web,runtime|--changed] [--wait] [--force]|--rollback [--components ...] [--wait] [--force]" >&2
}

MODE="${1:-}"
shift || true
COMPONENTS=""
WAIT=()
FORCE=()
CHANGED=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --components) [ "$#" -ge 2 ] || { usage; exit 2; }; COMPONENTS="$2"; shift 2 ;;
    --changed) CHANGED=1; shift ;;
    --wait) WAIT=(--wait); shift ;;
    --force) FORCE=(--force); shift ;;
    *) usage; exit 2 ;;
  esac
done

normalize_target() {
  local components="${1:-all}"
  components="${components// /}"
  case "$components" in
    web) echo web ;;
    runtime) echo runtime ;;
    web,runtime|runtime,web|all|"") echo all ;;
    none) echo none ;;
    *) echo "unknown component set: $components (expected web, runtime, or all)" >&2; return 2 ;;
  esac
}

changed_components() {
  local range="${AGENTDECK_CHANGED_RANGE:-HEAD~1..HEAD}"
  local files
  files="$(git -C "$ROOT" diff --name-only "$range" || true)"
  if [ -z "$files" ]; then
    echo "none"
    return
  fi
  node - "$files" <<'NODE'
const files = process.argv[2].split(/\n/).filter(Boolean);
const components = new Set();
for (const file of files) {
  if (/^(docs|tests|README|.*\.md$)/.test(file)) continue;
  if (/^(client|public)\//.test(file)) components.add('web');
  else if (/^(server|deploy|scripts)\//.test(file)) { components.add('web'); components.add('runtime'); }
}
console.log(components.size ? [...components].join(',') : 'none');
NODE
}

case "$MODE" in
  --check)
    exec "$CTL" check
    ;;
  --deploy)
    if [ "$CHANGED" = "1" ]; then COMPONENTS="$(changed_components)"; fi
    TARGET="$(normalize_target "${COMPONENTS:-all}")"
    if [ "$TARGET" = "none" ]; then echo "No deployable changes; nothing to deploy."; exit 0; fi
    exec "$CTL" deploy "$TARGET" "${WAIT[@]}" "${FORCE[@]}"
    ;;
  --rollback)
    exec "$CTL" rollback "$(normalize_target "${COMPONENTS:-all}")" "${WAIT[@]}" "${FORCE[@]}"
    ;;
  *)
    usage
    exit 2
    ;;
esac
