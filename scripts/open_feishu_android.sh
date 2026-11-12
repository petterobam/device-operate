#!/usr/bin/env bash
set -euo pipefail

ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/device-operate}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/open-feishu.log}"
CONFIG_FILE="${CONFIG_FILE:-$HOME/.config/device-operate/open-feishu.env}"
DEVICE_SERIAL="${DEVICE_SERIAL:-}"
ADB_CONNECT="${ADB_CONNECT:-}"
ANDROID_PIN="${ANDROID_PIN:-}"
FEISHU_PACKAGE="${FEISHU_PACKAGE:-}"
FEISHU_PACKAGES="${FEISHU_PACKAGES:-com.ss.android.lark com.larksuite.suite}"
FEISHU_CLOSE_DELAY_SECONDS="${FEISHU_CLOSE_DELAY_SECONDS:-10}"
ADB_WAIT_SECONDS="${ADB_WAIT_SECONDS:-20}"
RANDOM_DELAY_MIN_SECONDS="${RANDOM_DELAY_MIN_SECONDS:-0}"
RANDOM_DELAY_MAX_SECONDS="${RANDOM_DELAY_MAX_SECONDS:-0}"
REMINDER_TITLE="${REMINDER_TITLE:-飞书提醒}"
REMINDER_TEXT="${REMINDER_TEXT:-请进入假勤快机器人，由你本人手动完成打卡。}"

if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
fi

show_usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --no-random                  Disable random startup delay for this run.
  --random-delay-min SECONDS   Override RANDOM_DELAY_MIN_SECONDS for this run.
  --random-delay-max SECONDS   Override RANDOM_DELAY_MAX_SECONDS for this run.
  --close-delay SECONDS        Override FEISHU_CLOSE_DELAY_SECONDS for this run.
  --help                       Show this help message.
EOF
}

parse_cli_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-random)
        RANDOM_DELAY_MIN_SECONDS=0
        RANDOM_DELAY_MAX_SECONDS=0
        shift
        ;;
      --random-delay-min)
        if [[ $# -lt 2 ]]; then
          echo "Missing value for $1" >&2
          exit 2
        fi
        RANDOM_DELAY_MIN_SECONDS="${2:-}"
        shift 2
        ;;
      --random-delay-max)
        if [[ $# -lt 2 ]]; then
          echo "Missing value for $1" >&2
          exit 2
        fi
        RANDOM_DELAY_MAX_SECONDS="${2:-}"
        shift 2
        ;;
      --close-delay)
        if [[ $# -lt 2 ]]; then
          echo "Missing value for $1" >&2
          exit 2
        fi
        FEISHU_CLOSE_DELAY_SECONDS="${2:-}"
        shift 2
        ;;
      --help|-h)
        show_usage
        exit 0
        ;;
      *)
        echo "Unknown option: $1" >&2
        show_usage >&2
        exit 2
        ;;
    esac
  done
}

parse_cli_args "$@"

mkdir -p "$LOG_DIR"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"
}

run_adb() {
  if [[ -n "$DEVICE_SERIAL" ]]; then
    "$ADB" -s "$DEVICE_SERIAL" "$@"
  else
    "$ADB" "$@"
  fi
}

refresh_device_list() {
  "$ADB" devices | awk 'NR > 1 && $2 == "device" {print $1}'
}

wait_for_configured_device() {
  local deadline=$((SECONDS + ADB_WAIT_SECONDS))
  local lines=""

  while (( SECONDS <= deadline )); do
    lines="$(refresh_device_list)"
    if [[ -n "$ADB_CONNECT" ]] && printf '%s\n' "$lines" | grep -qx "$ADB_CONNECT"; then
      DEVICE_SERIAL="$ADB_CONNECT"
    fi
    if [[ -n "$DEVICE_SERIAL" ]]; then
      if printf '%s\n' "$lines" | grep -qx "$DEVICE_SERIAL"; then
        printf '%s\n' "$lines"
        return 0
      fi
    elif [[ "$(printf '%s\n' "$lines" | sed '/^$/d' | wc -l | tr -d ' ')" -gt 0 ]]; then
      printf '%s\n' "$lines"
      return 0
    fi
    sleep 1
  done

  printf '%s\n' "$lines"
  return 1
}

run_adb_checked() {
  wait_for_configured_device >/dev/null || fail "device disappeared while running adb command"
  run_adb "$@"
}

fail() {
  log "ERROR: $*"
  exit 1
}

apply_random_delay() {
  local min="$RANDOM_DELAY_MIN_SECONDS"
  local max="$RANDOM_DELAY_MAX_SECONDS"
  local delay=0

  if ! [[ "$min" =~ ^[0-9]+$ && "$max" =~ ^[0-9]+$ ]]; then
    fail "RANDOM_DELAY_MIN_SECONDS and RANDOM_DELAY_MAX_SECONDS must be non-negative integers"
  fi

  if (( max < min )); then
    fail "RANDOM_DELAY_MAX_SECONDS must be greater than or equal to RANDOM_DELAY_MIN_SECONDS"
  fi

  if (( max == 0 )); then
    return 0
  fi

  delay=$(( min + RANDOM % (max - min + 1) ))
  log "Random delay selected: ${delay}s"
  sleep "$delay"
}

notify_user() {
  log "$REMINDER_TEXT"

  if command -v osascript >/dev/null 2>&1; then
    osascript \
      -e "display notification \"$REMINDER_TEXT\" with title \"$REMINDER_TITLE\"" \
      >/dev/null 2>&1 || true
  fi
}

find_recent_task_id() {
  local package="$1"

  run_adb_checked shell dumpsys activity recents 2>/dev/null \
    | awk -v package="$package" '
        $0 ~ "Task\\{.*" package { in_task = 1 }
        in_task && match($0, /taskId=[0-9]+/) {
          print substr($0, RSTART + 7, RLENGTH - 7)
          exit
        }
      '
}

remove_recent_task() {
  local package="$1"
  local task_id=""

  task_id="$(find_recent_task_id "$package" | tr -d '\r' | head -n 1)"
  if [[ -z "$task_id" ]]; then
    log "No recent task found for $package"
    return 0
  fi

  log "Removing recent task $task_id for $package"
  run_adb_checked shell cmd activity stack remove "$task_id" >/dev/null 2>&1 || true
}

close_feishu_and_lock() {
  local package="$1"

  log "Waiting ${FEISHU_CLOSE_DELAY_SECONDS}s before closing $package"
  sleep "$FEISHU_CLOSE_DELAY_SECONDS"

  remove_recent_task "$package"

  log "Force-stopping $package"
  run_adb_checked shell am force-stop "$package" >/dev/null 2>&1 || true

  log "Locking screen"
  run_adb_checked shell input keyevent KEYCODE_SLEEP >/dev/null 2>&1 || run_adb_checked shell input keyevent 223 >/dev/null
}

explain_missing_adb_device() {
  local serial="$1"

  if command -v system_profiler >/dev/null 2>&1 && [[ -n "$serial" ]]; then
    if system_profiler SPUSBDataType 2>/dev/null | grep -q "$serial"; then
      log "USB sees serial $serial, but adb does not. On the phone, re-check USB debugging authorization and USB mode."
      log "Try: unlock phone, set USB mode to File Transfer/Android Auto, toggle USB debugging off/on, then accept the RSA prompt."
    fi
  fi
}

if [[ ! -x "$ADB" ]]; then
  fail "adb not found or not executable at $ADB"
fi

log "Starting Android wake/unlock/open Feishu flow"

apply_random_delay

"$ADB" start-server >/dev/null

if [[ -n "$ADB_CONNECT" ]]; then
  log "Connecting to wireless adb endpoint: $ADB_CONNECT"
  "$ADB" connect "$ADB_CONNECT" | tee -a "$LOG_FILE" >/dev/null || true
fi

device_lines="$(wait_for_configured_device || true)"
device_count="$(printf '%s\n' "$device_lines" | sed '/^$/d' | wc -l | tr -d ' ')"

if [[ -n "$DEVICE_SERIAL" ]]; then
  if ! printf '%s\n' "$device_lines" | grep -qx "$DEVICE_SERIAL"; then
    explain_missing_adb_device "$DEVICE_SERIAL"
    fail "configured device $DEVICE_SERIAL is not connected or not authorized"
  fi
elif [[ "$device_count" -eq 0 ]]; then
  "$ADB" devices -l | tee -a "$LOG_FILE"
  explain_missing_adb_device ""
  fail "no authorized Android device detected; enable USB debugging and approve this computer, or set ADB_CONNECT for wireless adb"
elif [[ "$device_count" -gt 1 ]]; then
  "$ADB" devices -l | tee -a "$LOG_FILE"
  fail "multiple devices detected; set DEVICE_SERIAL to the target serial"
fi

target_serial="${DEVICE_SERIAL:-$(printf '%s\n' "$device_lines" | sed '/^$/d' | head -n 1)}"
log "Using device: $target_serial"

screen_state="$(run_adb_checked shell dumpsys power 2>/dev/null | awk -F= '/mWakefulness=|Display Power: state=|mHoldingDisplaySuspendBlocker=|mScreenOn=/ {print}' | tr '\n' ' ')"
log "Power state: ${screen_state:-unknown}"

run_adb_checked shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || run_adb_checked shell input keyevent 224 >/dev/null
sleep 1

# Swipe up to dismiss the keyguard on devices without a secure lock, or to reveal PIN entry.
run_adb_checked shell input swipe 540 1800 540 500 300 >/dev/null 2>&1 || true
sleep 1

if [[ -n "$ANDROID_PIN" ]]; then
  log "Entering configured PIN"
  run_adb_checked shell input text "$ANDROID_PIN" >/dev/null
  run_adb_checked shell input keyevent KEYCODE_ENTER >/dev/null 2>&1 || run_adb_checked shell input keyevent 66 >/dev/null
  sleep 1
fi

if [[ -n "$FEISHU_PACKAGE" ]]; then
  package_candidates="$FEISHU_PACKAGE"
else
  package_candidates="$FEISHU_PACKAGES"
fi

for package in $package_candidates; do
  if ! run_adb_checked shell pm path "$package" >/dev/null 2>&1; then
    log "Package not installed: $package"
    continue
  fi

  log "Launching Feishu/Lark package: $package"
  if run_adb_checked shell monkey -p "$package" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; then
    log "Launch command sent successfully for $package"
    notify_user
    close_feishu_and_lock "$package"
    exit 0
  fi

  log "monkey launch failed for $package; trying cmd package launcher discovery"
  activity="$(run_adb_checked shell cmd package resolve-activity --brief "$package" 2>/dev/null | tail -n 1 | tr -d '\r')"
  if [[ "$activity" == */* ]]; then
    run_adb_checked shell am start -n "$activity" >/dev/null
    log "Activity launched: $activity"
    notify_user
    close_feishu_and_lock "$package"
    exit 0
  fi
done

fail "could not launch Feishu/Lark; set FEISHU_PACKAGE in $CONFIG_FILE if your package name is different"
