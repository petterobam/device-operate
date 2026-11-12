#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: archive_codex_automation_runs.sh [--dry-run] [--limit N]

Archives completed, unarchived Codex runs created by these automations:
  - Codex 受阻目标续跑监控 (Automation ID: codex)
  - Codex × Kairn 全局调度专家 (Automation ID: codex-kairn)

Options:
  --dry-run  List eligible runs without archiving them.
  --limit N  Inspect at most N matching runs, oldest first.
  -h, --help Show this help.

Environment overrides:
  CODEX_STATE_DB                Codex state database path.
  CODEX_ARCHIVE_TIMEOUT_SECONDS Timeout for each archive command (default: 30).
EOF
}

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

DRY_RUN=0
LIMIT_CLAUSE=""

while (( $# > 0 )); do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --limit)
      (( $# >= 2 )) || die "--limit requires a positive integer"
      [[ "$2" =~ ^[1-9][0-9]*$ ]] || die "invalid --limit value: $2"
      LIMIT_CLAUSE="LIMIT $2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

for dependency in jq sqlite3; do
  command -v "$dependency" >/dev/null 2>&1 || die "missing dependency: $dependency"
done

CODEX_DATA_DIR="${CODEX_HOME:-$HOME/.codex}"
STATE_DB="${CODEX_STATE_DB:-$CODEX_DATA_DIR/state_5.sqlite}"
ARCHIVE_TIMEOUT_SECONDS="${CODEX_ARCHIVE_TIMEOUT_SECONDS:-30}"

[[ -f "$STATE_DB" ]] || die "Codex state database not found: $STATE_DB"
[[ "$ARCHIVE_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || \
  die "CODEX_ARCHIVE_TIMEOUT_SECONDS must be a positive integer"

if command -v codex >/dev/null 2>&1; then
  CODEX_BIN="$(command -v codex)"
elif [[ -x /Applications/Codex.app/Contents/Resources/codex ]]; then
  CODEX_BIN="/Applications/Codex.app/Contents/Resources/codex"
else
  die "codex executable not found"
fi

LOCK_DIR="${TMPDIR:-/tmp}/com.device-operate.archive-codex-automation-runs.lock"
LOCK_ACQUIRED=0
CANDIDATE_FILE=""

cleanup() {
  if [[ -n "$CANDIDATE_FILE" && -f "$CANDIDATE_FILE" ]]; then
    rm -f "$CANDIDATE_FILE"
  fi
  if (( LOCK_ACQUIRED == 1 )) && [[ -d "$LOCK_DIR" ]]; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    LOCK_ACQUIRED=1
    return
  fi

  local existing_pid=""
  if [[ -f "$LOCK_DIR/pid" ]]; then
    existing_pid="$(sed -n '1p' "$LOCK_DIR/pid")"
  fi
  if [[ "$existing_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
    log "Another archive run is active (pid=$existing_pid); exiting."
    exit 0
  fi

  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || die "cannot clear stale lock: $LOCK_DIR"
  mkdir "$LOCK_DIR" || die "cannot acquire lock: $LOCK_DIR"
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  LOCK_ACQUIRED=1
}

sqlite_read() {
  sqlite3 -readonly -cmd '.timeout 5000' "$STATE_DB" "$@"
}

run_archive_with_timeout() {
  local thread_id="$1"
  local output_file timeout_marker archive_pid watchdog_pid archive_status

  output_file="$(mktemp "${TMPDIR:-/tmp}/codex-archive-output.XXXXXX")"
  timeout_marker="$(mktemp "${TMPDIR:-/tmp}/codex-archive-timeout.XXXXXX")"
  rm -f "$timeout_marker"

  "$CODEX_BIN" archive "$thread_id" >"$output_file" 2>&1 &
  archive_pid=$!
  (
    sleep "$ARCHIVE_TIMEOUT_SECONDS"
    if kill -0 "$archive_pid" 2>/dev/null; then
      : > "$timeout_marker"
      kill -TERM "$archive_pid" 2>/dev/null || true
      sleep 2
      kill -KILL "$archive_pid" 2>/dev/null || true
    fi
  ) &
  watchdog_pid=$!

  if wait "$archive_pid"; then
    archive_status=0
  else
    archive_status=$?
  fi
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true

  if [[ -f "$timeout_marker" ]]; then
    archive_status=124
  fi
  if (( archive_status != 0 )); then
    if [[ -s "$output_file" ]]; then
      sed 's/^/  codex: /' "$output_file" >&2
    fi
    if (( archive_status == 124 )); then
      log "ERROR: codex archive timed out after ${ARCHIVE_TIMEOUT_SECONDS}s: $thread_id" >&2
    fi
  fi

  rm -f "$output_file" "$timeout_marker"
  return "$archive_status"
}

trap cleanup EXIT INT TERM
acquire_lock
CANDIDATE_FILE="$(mktemp "${TMPDIR:-/tmp}/codex-archive-candidates.XXXXXX")"

# Use exact line prefixes for both name and Automation ID. The state database is
# only read; all archive mutations go through the official Codex CLI.
CANDIDATE_PREDICATE="
  thread_source = 'automation'
  AND archived = 0
  AND (
    substr(first_user_message, 1, length(
      'Automation: Codex 受阻目标续跑监控' || char(10) ||
      'Automation ID: codex' || char(10)
    )) =
      'Automation: Codex 受阻目标续跑监控' || char(10) ||
      'Automation ID: codex' || char(10)
    OR
    substr(first_user_message, 1, length(
      'Automation: Codex × Kairn 全局调度专家' || char(10) ||
      'Automation ID: codex-kairn' || char(10)
    )) =
      'Automation: Codex × Kairn 全局调度专家' || char(10) ||
      'Automation ID: codex-kairn' || char(10)
  )
"

sqlite_read -separator $'\t' "
  SELECT
    id,
    rollout_path,
    CASE
      WHEN first_user_message LIKE 'Automation: Codex 受阻目标续跑监控' || char(10) || '%'
        THEN 'monitor'
      ELSE 'scheduler'
    END
  FROM threads
  WHERE $CANDIDATE_PREDICATE
  ORDER BY created_at_ms ASC
  $LIMIT_CLAUSE;
" > "$CANDIDATE_FILE"

discovered_count="$(awk 'END { print NR + 0 }' "$CANDIDATE_FILE")"
eligible_count=0
archived_count=0
running_count=0
invalid_count=0
failed_count=0

log "Discovered $discovered_count matching unarchived run(s)."

while IFS=$'\t' read -r thread_id initial_rollout_path automation_kind; do
  [[ -n "$thread_id" ]] || continue
  if [[ ! "$thread_id" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    log "SKIP invalid thread id: $thread_id" >&2
    ((invalid_count += 1))
    continue
  fi

  # Re-read the exact row immediately before acting so an already archived or
  # remapped task cannot be processed from a stale candidate list.
  current_rollout_path="$(sqlite_read "
    SELECT rollout_path
    FROM threads
    WHERE id = '$thread_id' AND $CANDIDATE_PREDICATE
    LIMIT 1;
  ")"
  if [[ -z "$current_rollout_path" ]]; then
    log "SKIP no longer eligible: $thread_id ($automation_kind)"
    ((invalid_count += 1))
    continue
  fi
  if [[ "$current_rollout_path" != "$initial_rollout_path" ]]; then
    log "SKIP rollout path changed: $thread_id ($automation_kind)" >&2
    ((invalid_count += 1))
    continue
  fi
  if [[ ! -f "$current_rollout_path" ]]; then
    log "SKIP missing rollout: $thread_id ($automation_kind)" >&2
    ((invalid_count += 1))
    continue
  fi

  # A run is terminal only when its latest task_complete follows its latest
  # task_started. Unread state and final-response presence are intentionally
  # irrelevant.
  if ! jq -e -s --arg thread_id "$thread_id" '
    ([.[] | select(.type == "session_meta") | .payload] | last) as $meta
    | ([.[]
        | select(.type == "event_msg" and .payload.type == "task_started")
        | .timestamp] | max) as $started
    | ([.[]
        | select(.type == "event_msg" and .payload.type == "task_complete")
        | .timestamp] | max) as $completed
    | (($meta.id == $thread_id or $meta.session_id == $thread_id)
       and $meta.thread_source == "automation"
       and $started != null
       and $completed != null
       and $completed > $started)
  ' "$current_rollout_path" >/dev/null 2>&1; then
    log "SKIP active or incomplete: $thread_id ($automation_kind)"
    ((running_count += 1))
    continue
  fi

  ((eligible_count += 1))
  if (( DRY_RUN == 1 )); then
    log "DRY-RUN eligible: $thread_id ($automation_kind)"
    continue
  fi

  log "ARCHIVE $thread_id ($automation_kind)"
  if ! run_archive_with_timeout "$thread_id"; then
    ((failed_count += 1))
    continue
  fi

  archive_verified=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [[ "$(sqlite_read "SELECT archived FROM threads WHERE id = '$thread_id' LIMIT 1;")" == "1" ]]; then
      archive_verified=1
      break
    fi
    sleep 0.2
  done
  if (( archive_verified == 1 )); then
    ((archived_count += 1))
    log "ARCHIVED $thread_id ($automation_kind)"
  else
    ((failed_count += 1))
    log "ERROR: archive was not reflected in Codex state: $thread_id" >&2
  fi
done < "$CANDIDATE_FILE"

log "Summary: discovered=$discovered_count eligible=$eligible_count archived=$archived_count active_or_incomplete=$running_count invalid=$invalid_count failed=$failed_count dry_run=$DRY_RUN"

if (( failed_count > 0 )); then
  exit 1
fi
