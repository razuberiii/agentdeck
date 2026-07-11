#!/usr/bin/env bash
# shellcheck disable=SC2015

candidate_job_path() {
  local job_id="${1:-}" root target real_root real_target
  root="${DATA_DIR:?DATA_DIR is required}/deploy-candidates"
  [ -n "$job_id" ] || return 2
  [[ "$job_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || return 2
  [[ "$job_id" != *..* ]] || return 2
  real_root="$(realpath -m "$root")" || return 2
  target="$root/$job_id"
  real_target="$(realpath -m "$target")" || return 2
  case "$real_target" in "$real_root"/*) printf '%s\n' "$real_target" ;; *) return 2 ;; esac
}

candidate_pid_is_live() {
  local pid="${1:-}" candidate_dir="${2:-}" command environment
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  environment="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null || true)"
  [[ "$command" == *"$candidate_dir"* || "$environment" == *"$candidate_dir"* ]]
}

candidate_job_has_live_process() {
  local candidate_dir="$1" pid_file pid
  for pid_file in "$candidate_dir"/web.pid "$candidate_dir"/runtime.pid; do
    [ -f "$pid_file" ] || continue
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    candidate_pid_is_live "$pid" "$candidate_dir" && return 0
  done
  return 1
}

cleanup_candidate_job() {
  local job_id="$1" candidate_dir pid_file pid deadline
  candidate_dir="$(candidate_job_path "$job_id")" || { echo "refusing unsafe candidate job id: $job_id" >&2; return 2; }
  [ -d "$candidate_dir" ] || return 0
  for pid_file in "$candidate_dir"/web.pid "$candidate_dir"/runtime.pid; do
    [ -f "$pid_file" ] || continue
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    candidate_pid_is_live "$pid" "$candidate_dir" && kill -TERM "$pid" 2>/dev/null || true
  done
  deadline=$((SECONDS + ${AGENTDECK_CANDIDATE_STOP_TIMEOUT_SECONDS:-10}))
  while candidate_job_has_live_process "$candidate_dir" && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.2; done
  if candidate_job_has_live_process "$candidate_dir"; then
    for pid_file in "$candidate_dir"/web.pid "$candidate_dir"/runtime.pid; do
      [ -f "$pid_file" ] || continue
      pid="$(cat "$pid_file" 2>/dev/null || true)"
      candidate_pid_is_live "$pid" "$candidate_dir" && kill -KILL "$pid" 2>/dev/null || true
    done
  fi
  while candidate_job_has_live_process "$candidate_dir" && [ "$SECONDS" -lt $((deadline + 2)) ]; do sleep 0.1; done
  candidate_job_has_live_process "$candidate_dir" && { echo "candidate process did not exit: $job_id" >&2; return 1; }
  rm -rf --one-file-system "$candidate_dir"
}

cleanup_stale_candidate_jobs() {
  local root candidate_dir job_id
  root="${DATA_DIR:?DATA_DIR is required}/deploy-candidates"
  [ -d "$root" ] || return 0
  while IFS= read -r -d '' candidate_dir; do
    job_id="${candidate_dir##*/}"
    candidate_job_has_live_process "$candidate_dir" && continue
    cleanup_candidate_job "$job_id"
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -mmin +1440 -print0)
}
