#!/usr/bin/env bash
set -euo pipefail

JARVIS_LABEL="ai.jarvis.gateway"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
JARVIS_HOME="${OPENCLAW_JARVIS_HOME:-${HOME}/Library/Application Support/Jarvis}"
JARVIS_STATE_DIR="${OPENCLAW_JARVIS_STATE_DIR:-${JARVIS_HOME}/.jarvis}"
JARVIS_CONFIG_PATH="${OPENCLAW_JARVIS_CONFIG_PATH:-${JARVIS_STATE_DIR}/openclaw.json}"
JARVIS_LOG_DIR="${OPENCLAW_JARVIS_LOG_DIR:-${JARVIS_STATE_DIR}/logs}"
JARVIS_NODE="${OPENCLAW_JARVIS_NODE_BIN:-${JARVIS_STATE_DIR}/tools/node/bin/node}"
JARVIS_ENTRYPOINT="${OPENCLAW_JARVIS_ENTRYPOINT:-${JARVIS_STATE_DIR}/lib/openclaw-bundled/dist/index.js}"
JARVIS_RUNTIME_ROOT="$(dirname -- "$(dirname -- "${JARVIS_ENTRYPOINT}")")"
JARVIS_WORKSPACE_BIN="${OPENCLAW_JARVIS_WORKSPACE_BIN:-${JARVIS_STATE_DIR}/workspace/bin}"
UNLOCK_SESSION_SCRIPT="${OPENCLAW_MAC_UNLOCK_SESSION_SCRIPT:-${JARVIS_WORKSPACE_BIN}/openclaw-mac-unlock-session.sh}"
UNLOCK_SCRIPT="${OPENCLAW_UNLOCK_SCRIPT:-${JARVIS_WORKSPACE_BIN}/openclaw-unlock.sh}"
LEASE_SCRIPT="${OPENCLAW_GUI_LEASE_SCRIPT:-${JARVIS_WORKSPACE_BIN}/openclaw-gui-lease.sh}"
PLIST_PATH="${OPENCLAW_JARVIS_LAUNCHAGENT_PLIST:-${HOME}/Library/LaunchAgents/${JARVIS_LABEL}.plist}"

LAUNCHCTL_BIN="${OPENCLAW_LAUNCHCTL_BIN:-launchctl}"
PLISTBUDDY_BIN="${OPENCLAW_PLISTBUDDY_BIN:-/usr/libexec/PlistBuddy}"
SQLITE3_BIN="${OPENCLAW_SQLITE3_BIN:-sqlite3}"
JQ_BIN="${OPENCLAW_JQ_BIN:-jq}"
ID_BIN="${OPENCLAW_ID_BIN:-id}"

REPAIR_LAUNCHAGENT_DRIFT=0
FULL_UNLOCK_REQUESTED=0
FULL_UNLOCK_APPROVED=0

STATUS_STDOUT_FILE=""
STATUS_STDERR_FILE=""
STATUS_JSON_FILE=""

usage() {
  cat <<'EOF'
Usage: scripts/prove-jarvis-unlock-runtime.sh [options]

Safe Jarvis GUI-unlock preflight. By default this command is read-only:
no deliberate lock, no unlock attempt, no password access, no persistent GUI
lease, no screensaver password weakening, and no LaunchAgent restart.

Options:
  --repair-launchagent-drift
      If the on-disk ai.jarvis.gateway plist is valid Jarvis app-support
      runtime state but launchd cached a different command, bootout/bootstrap/
      kickstart the intended plist. This mutates launchd and must only be used
      after fresh user approval in the current lane.
  --full-unlock
      Request a live unlock proof. This always requires
      --i-approve-live-unlock because it can affect the user's Mac session.
  --i-approve-live-unlock
      Explicit approval gate for --full-unlock. The current script still stops
      before live unlock unless the approval flag is present.
  -h, --help
      Show this help.
EOF
}

log() {
  printf '[prove-jarvis-unlock-runtime] %s\n' "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

warn() {
  log "WARN: $*" >&2
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repair-launchagent-drift)
        REPAIR_LAUNCHAGENT_DRIFT=1
        shift
        ;;
      --full-unlock)
        FULL_UNLOCK_REQUESTED=1
        shift
        ;;
      --i-approve-live-unlock)
        FULL_UNLOCK_APPROVED=1
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done
}

require_tool() {
  local bin="$1"
  local label="$2"
  command -v "$bin" >/dev/null 2>&1 || die "missing ${label}: ${bin}"
}

require_readonly_tools() {
  require_tool "$LAUNCHCTL_BIN" "launchctl"
  require_tool "$PLISTBUDDY_BIN" "PlistBuddy"
  require_tool "$ID_BIN" "id"
  command -v "$JQ_BIN" >/dev/null 2>&1 || warn "missing jq; gateway JSON proof will use fallback parsing"
  [[ -x "$JARVIS_NODE" ]] || die "Jarvis node runtime is missing or not executable: ${JARVIS_NODE}"
  [[ -r "$JARVIS_ENTRYPOINT" ]] || die "Jarvis bundled entrypoint is missing: ${JARVIS_ENTRYPOINT}"
}

plist_value() {
  local key_path="$1"
  "$PLISTBUDDY_BIN" -c "Print :${key_path}" "$PLIST_PATH" 2>/dev/null || true
}

plist_program_arg() {
  local index="$1"
  plist_value "ProgramArguments:${index}"
}

plist_contains_program_arg() {
  local expected="$1"
  local index=0
  local arg=""
  while true; do
    arg="$(plist_program_arg "$index")"
    [[ -n "$arg" ]] || break
    [[ "$arg" == "$expected" ]] && return 0
    index=$((index + 1))
  done
  return 1
}

print_exact_line_present() {
  local print_output="$1"
  local expected="$2"
  awk -v expected="$expected" '
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)
      if (line == expected) found = 1
    }
    END { exit(found ? 0 : 1) }
  ' <<<"$print_output"
}

resolve_domain() {
  printf 'gui/%s\n' "$("$ID_BIN" -u)"
}

read_launchctl_print() {
  local domain="$1"
  "$LAUNCHCTL_BIN" print "${domain}/${JARVIS_LABEL}" 2>/dev/null || true
}

validate_on_disk_plist() {
  [[ -f "$PLIST_PATH" ]] || return 1
  [[ "$(plist_program_arg 0)" == "$JARVIS_NODE" ]] || return 1
  [[ "$(plist_program_arg 1)" == "$JARVIS_ENTRYPOINT" ]] || return 1
  plist_contains_program_arg "gateway" || return 1
  plist_contains_program_arg "--port" || return 1
  plist_contains_program_arg "$PORT" || return 1
  [[ "$(plist_value "WorkingDirectory")" == "$JARVIS_RUNTIME_ROOT" ]] || return 1
  [[ "$(plist_value "EnvironmentVariables:OPENCLAW_HOME")" == "$JARVIS_HOME" ]] || return 1
  [[ "$(plist_value "EnvironmentVariables:OPENCLAW_STATE_DIR")" == "$JARVIS_STATE_DIR" ]] || return 1
  [[ "$(plist_value "EnvironmentVariables:OPENCLAW_CONFIG_PATH")" == "$JARVIS_CONFIG_PATH" ]] || return 1
  [[ "$(plist_value "EnvironmentVariables:OPENCLAW_LOG_DIR")" == "$JARVIS_LOG_DIR" ]] || return 1
  [[ "$(plist_value "EnvironmentVariables:OPENCLAW_LAUNCHD_LABEL")" == "$JARVIS_LABEL" ]] || return 1
  [[ "$(plist_value "EnvironmentVariables:OPENCLAW_PROFILE")" == "consumer" ]] || return 1
  [[ "$(plist_value "EnvironmentVariables:OPENCLAW_GATEWAY_PORT")" == "$PORT" ]] || return 1
}

active_launchagent_matches_expected() {
  local print_output="$1"
  [[ -n "$print_output" ]] || return 1
  print_exact_line_present "$print_output" "program = ${JARVIS_NODE}" || return 1
  print_exact_line_present "$print_output" "$JARVIS_ENTRYPOINT" || return 1
  print_exact_line_present "$print_output" "working directory = ${JARVIS_RUNTIME_ROOT}" || return 1
  print_exact_line_present "$print_output" "OPENCLAW_HOME => ${JARVIS_HOME}" || return 1
  print_exact_line_present "$print_output" "OPENCLAW_STATE_DIR => ${JARVIS_STATE_DIR}" || return 1
  print_exact_line_present "$print_output" "OPENCLAW_CONFIG_PATH => ${JARVIS_CONFIG_PATH}" || return 1
  print_exact_line_present "$print_output" "OPENCLAW_LOG_DIR => ${JARVIS_LOG_DIR}" || return 1
  print_exact_line_present "$print_output" "OPENCLAW_LAUNCHD_LABEL => ${JARVIS_LABEL}" || return 1
  print_exact_line_present "$print_output" "OPENCLAW_PROFILE => consumer" || return 1
  print_exact_line_present "$print_output" "OPENCLAW_GATEWAY_PORT => ${PORT}" || return 1
}

active_launchagent_has_known_bad_runtime() {
  local print_output="$1"
  [[ "$print_output" == *"/Users/user/Programming_Projects/openclaw"* ]] && return 0
  [[ "$print_output" == *"/opt/homebrew/bin/node"* ]] && return 0
  [[ "$print_output" == *"/usr/local/bin/node"* ]] && return 0
  return 1
}

repair_launchagent_drift() {
  local domain="$1"
  validate_on_disk_plist || die "refusing repair: on-disk plist is not valid Jarvis app-support runtime state: ${PLIST_PATH}"
  log "repair_launchagent_drift=running"
  "$LAUNCHCTL_BIN" bootout "${domain}/${JARVIS_LABEL}" >/dev/null 2>&1 || true
  "$LAUNCHCTL_BIN" bootout "$domain" "$PLIST_PATH" >/dev/null 2>&1 || true
  "$LAUNCHCTL_BIN" bootstrap "$domain" "$PLIST_PATH"
  "$LAUNCHCTL_BIN" kickstart -k "${domain}/${JARVIS_LABEL}"
  log "repair_launchagent_drift=ok"
}

sqlite_quote() {
  printf "%s" "$1" | sed "s/'/''/g"
}

tcc_db_candidates() {
  printf '%s\n' \
    "$HOME/Library/Application Support/com.apple.TCC/TCC.db" \
    "/Library/Application Support/com.apple.TCC/TCC.db"
}

query_tcc_accessibility() {
  local db="$1"
  local client
  client="$(sqlite_quote "$JARVIS_NODE")"
  "$SQLITE3_BIN" -readonly "$db" \
    "SELECT COALESCE(auth_value, allowed, -1) FROM access WHERE service='kTCCServiceAccessibility' AND client='${client}' ORDER BY last_modified DESC LIMIT 1;" \
    2>/dev/null || true
}

probe_accessibility_tcc() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "not_macos"
    return 0
  fi
  if ! command -v "$SQLITE3_BIN" >/dev/null 2>&1; then
    echo "needs_manual_verification:sqlite3_missing"
    return 0
  fi

  local any_readable=0
  local value=""
  local db
  while IFS= read -r db; do
    [[ -r "$db" ]] || continue
    any_readable=1
    value="$(query_tcc_accessibility "$db")"
    case "$value" in
      2|1)
        echo "granted:${db}"
        return 0
        ;;
      0)
        echo "denied:${db}"
        return 0
        ;;
    esac
  done < <(tcc_db_candidates)

  if [[ "$any_readable" == "0" ]]; then
    echo "needs_manual_verification:tcc_db_unreadable"
  else
    echo "needs_manual_verification:no_accessibility_row_for_runtime_binary"
  fi
}

print_tcc_manual_instructions() {
  log "tcc_manual_setup=System Settings > Privacy & Security > Accessibility"
  log "tcc_manual_setup=enable exact runtime binary: ${JARVIS_NODE}"
  log "tcc_manual_setup=restart Jarvis after changing Accessibility approval"
}

detect_lock_state() {
  local state=""
  state="$(/usr/sbin/scutil <<<'show State:/Users/ConsoleUser' 2>/dev/null |
    /usr/bin/awk '/kCGSSessionScreenIsLocked/ {print tolower($3); exit}' |
    /usr/bin/tr -d '\r' || true)"
  case "$state" in
    true|yes|1)
      echo "true scutil-screen-locked"
      return 0
      ;;
    false|no|0)
      echo "false scutil-screen-locked"
      return 0
      ;;
  esac

  state="$(/usr/sbin/ioreg -n Root -d1 -a 2>/dev/null |
    /usr/bin/plutil -convert json -o - - 2>/dev/null |
    /usr/bin/python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    data = None
value = None
if isinstance(data, dict):
    value = data.get("IOConsoleLocked")
elif isinstance(data, list):
    for item in data:
        if isinstance(item, dict) and "IOConsoleLocked" in item:
            value = item.get("IOConsoleLocked")
            break
if isinstance(value, bool):
    print("true" if value else "false")
elif value in (0, 1, "0", "1"):
    print("true" if str(value) == "1" else "false")
' 2>/dev/null || true)"
  case "$state" in
    true|false)
      echo "$state ioreg-root"
      return 0
      ;;
  esac
  echo "unknown unknown"
}

pid_state() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    echo "none"
    return 0
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && ps -p "$pid" >/dev/null 2>&1; then
    echo "${pid}:alive"
  elif [[ -n "$pid" ]]; then
    echo "${pid}:dead"
  else
    echo "empty"
  fi
}

print_lease_cleanup_state() {
  local lease_root="${JARVIS_STATE_DIR}/gui-lease"
  local monitor_pid="${JARVIS_STATE_DIR}/lock-monitor.pid"
  local caffeinate tickle restore monitor
  caffeinate="$(pid_state "${lease_root}/caffeinate.pid")"
  tickle="$(pid_state "${lease_root}/tickle.pid")"
  restore="$(pid_state "${lease_root}/restore.pid")"
  monitor="$(pid_state "$monitor_pid")"
  log "lease_caffeinate=${caffeinate}"
  log "lease_tickle=${tickle}"
  log "lease_restore=${restore}"
  log "lease_lock_monitor=${monitor}"
  if [[ "$caffeinate" == *":alive" || "$tickle" == *":alive" || "$restore" == *":alive" || "$monitor" == *":alive" ]]; then
    log "lease_cleanup=active_leftovers"
    return 1
  fi
  log "lease_cleanup=ok"
}

print_unlock_wrapper_capability() {
  local session_present=false
  local unlock_present=false
  local lease_present=false
  [[ -x "$UNLOCK_SESSION_SCRIPT" ]] && session_present=true
  [[ -x "$UNLOCK_SCRIPT" ]] && unlock_present=true
  [[ -x "$LEASE_SCRIPT" ]] && lease_present=true
  log "unlock_session_script=${UNLOCK_SESSION_SCRIPT}"
  log "unlock_session_script_present=${session_present}"
  log "unlock_script_present=${unlock_present}"
  log "lease_script_present=${lease_present}"
  if [[ "$session_present" == "true" ]] &&
    grep -Eq -- "--no-(auto-)?lease|OPENCLAW_MAC_UNLOCK_AUTO_LEASE|NO_AUTO_LEASE" "$UNLOCK_SESSION_SCRIPT"; then
    log "unlock_wrapper_no_auto_lease=supported"
    if grep -Eq -- "auto_relock|auto_lock=|phase=auto_relock" "$UNLOCK_SESSION_SCRIPT"; then
      log "unlock_wrapper_no_auto_lease_auto_lock=supported"
    else
      log "unlock_wrapper_no_auto_lease_auto_lock=missing"
      log "unlock_wrapper_no_auto_lease_auto_lock_detail=no-auto-lease must still arm a bounded auto-lock watchdog"
    fi
  else
    log "unlock_wrapper_no_auto_lease=missing"
    log "unlock_wrapper_no_auto_lease_detail=session wrapper must expose caller intent and skip session-level lease when requested"
    log "unlock_wrapper_no_auto_lease_auto_lock=missing"
  fi
}

run_status_json() {
  local stdout_file="$1"
  local stderr_file="$2"
  OPENCLAW_HOME="$JARVIS_HOME" \
  OPENCLAW_STATE_DIR="$JARVIS_STATE_DIR" \
  OPENCLAW_CONFIG_PATH="$JARVIS_CONFIG_PATH" \
  OPENCLAW_LOG_DIR="$JARVIS_LOG_DIR" \
  OPENCLAW_PROFILE=consumer \
  OPENCLAW_LAUNCHD_LABEL="$JARVIS_LABEL" \
    "$JARVIS_NODE" "$JARVIS_ENTRYPOINT" gateway status --deep --require-rpc --json \
      >"$stdout_file" 2>"$stderr_file"
}

extract_status_json() {
  local raw_file="$1"
  local json_file="$2"
  if command -v "$JQ_BIN" >/dev/null 2>&1 && "$JQ_BIN" -e . "$raw_file" >/dev/null 2>&1; then
    cp "$raw_file" "$json_file"
    return 0
  fi
  awk 'found || /^[[:space:]]*\{/ { found = 1; print }' "$raw_file" >"$json_file"
  if command -v "$JQ_BIN" >/dev/null 2>&1 && [[ -s "$json_file" ]] && "$JQ_BIN" -e . "$json_file" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

assert_status_probe() {
  local status_file="$1"
  local rpc_ok healthy runtime_source service_label
  command -v "$JQ_BIN" >/dev/null 2>&1 || return 1
  rpc_ok="$(
    "$JQ_BIN" -r --arg probe_url "ws://127.0.0.1:${PORT}" '
      .rpc.ok // (
        [
          .targets[]?
          | select((.id == "localLoopback" or .kind == "localLoopback" or .url == $probe_url) and .connect.rpcOk == true)
        ] | length > 0
      )
    ' "$status_file"
  )"
  healthy="$(
    "$JQ_BIN" -r --arg probe_url "ws://127.0.0.1:${PORT}" '
      .health.healthy // (
        [
          .targets[]?
          | select(.id == "localLoopback" or .kind == "localLoopback" or .url == $probe_url)
          | .health as $health
          | select(($health == true) or (($health | type) == "object" and (($health.healthy // $health.ok) == true)))
        ] | length > 0
      )
    ' "$status_file"
  )"
  service_label="$("$JQ_BIN" -r '.runtimeFingerprint.serviceLabel // empty' "$status_file")"
  runtime_source="$("$JQ_BIN" -r '.runtimeFingerprint.runtimeSource // empty' "$status_file")"
  [[ "$service_label" == "$JARVIS_LABEL" ]] || return 1
  [[ "$runtime_source" == "jarvis-managed-bundle" ]] || return 1
  [[ "$rpc_ok" == "true" ]] || return 1
  [[ "$healthy" == "true" ]] || return 1
}

print_gateway_status() {
  STATUS_STDOUT_FILE="$(mktemp "${TMPDIR:-/tmp}/jarvis-unlock-status.XXXXXX")"
  STATUS_STDERR_FILE="$(mktemp "${TMPDIR:-/tmp}/jarvis-unlock-status.err.XXXXXX")"
  STATUS_JSON_FILE="$(mktemp "${TMPDIR:-/tmp}/jarvis-unlock-status.json.XXXXXX")"
  cleanup_status() {
    rm -f "$STATUS_STDOUT_FILE" "$STATUS_STDERR_FILE" "$STATUS_JSON_FILE"
  }
  trap cleanup_status EXIT
  if ! run_status_json "$STATUS_STDOUT_FILE" "$STATUS_STDERR_FILE"; then
    log "gateway_rpc_health=failed"
    log "gateway_rpc_health_detail=status_command_failed"
    return 1
  fi
  if ! extract_status_json "$STATUS_STDOUT_FILE" "$STATUS_JSON_FILE"; then
    log "gateway_rpc_health=failed"
    log "gateway_rpc_health_detail=status_json_unparseable"
    return 1
  fi
  if assert_status_probe "$STATUS_JSON_FILE"; then
    log "gateway_rpc_health=ok"
    return 0
  fi
  log "gateway_rpc_health=failed"
  log "gateway_rpc_health_detail=rpc_or_runtime_identity_mismatch"
  return 1
}

main() {
  parse_args "$@"
  require_readonly_tools

  if [[ "$FULL_UNLOCK_REQUESTED" == "1" && "$FULL_UNLOCK_APPROVED" != "1" ]]; then
    die "--full-unlock requires --i-approve-live-unlock and fresh user approval in this lane"
  fi
  if [[ "$FULL_UNLOCK_REQUESTED" == "1" ]]; then
    die "live unlock proof is approval-gated but not executed by the safe preflight script; run the approved unlock wrapper manually after reviewing this report"
  fi

  local domain print_output plist_valid=0 active_matches=0 bad_active=0 tcc_status lock_state lock_probe
  domain="$(resolve_domain)"
  print_output="$(read_launchctl_print "$domain")"

  if validate_on_disk_plist; then
    plist_valid=1
  fi
  if active_launchagent_matches_expected "$print_output"; then
    active_matches=1
  fi
  if active_launchagent_has_known_bad_runtime "$print_output"; then
    bad_active=1
  fi

  log "jarvis_unlock_preflight=true"
  log "runtime_identity=worktree=${JARVIS_RUNTIME_ROOT} stateDir=${JARVIS_STATE_DIR} configPath=${JARVIS_CONFIG_PATH} serviceLabel=${JARVIS_LABEL}"
  log "launchagent_plist=${PLIST_PATH}"
  log "launchagent_plist_valid=$([[ "$plist_valid" == "1" ]] && printf true || printf false)"
  log "launchagent_active_loaded=$([[ -n "$print_output" ]] && printf true || printf false)"
  log "launchagent_active_matches_plist=$([[ "$active_matches" == "1" ]] && printf true || printf false)"
  log "launchagent_bad_active_runtime=$([[ "$bad_active" == "1" ]] && printf true || printf false)"
  log "launchagent_expected_program=${JARVIS_NODE}"
  log "launchagent_expected_workdir=${JARVIS_RUNTIME_ROOT}"

  if [[ "$active_matches" != "1" && "$REPAIR_LAUNCHAGENT_DRIFT" == "1" ]]; then
    repair_launchagent_drift "$domain"
    print_output="$(read_launchctl_print "$domain")"
    if active_launchagent_matches_expected "$print_output"; then
      active_matches=1
      bad_active=0
      log "launchagent_active_matches_plist_after_repair=true"
    else
      die "LaunchAgent repair did not produce expected active Jarvis runtime"
    fi
  fi

  tcc_status="$(probe_accessibility_tcc)"
  log "tcc_accessibility_preflight=${tcc_status%%:*}"
  log "tcc_accessibility_target=${JARVIS_NODE}"
  [[ "$tcc_status" == *":"* ]] && log "tcc_accessibility_detail=${tcc_status#*:}"
  case "$tcc_status" in
    granted:*|not_macos)
      ;;
    *)
      print_tcc_manual_instructions
      ;;
  esac

  read -r lock_state lock_probe < <(detect_lock_state)
  log "lock_state=${lock_state}"
  log "lock_probe=${lock_probe}"
  print_unlock_wrapper_capability
  local lease_ok=0
  if print_lease_cleanup_state; then
    lease_ok=1
  fi
  local gateway_ok=0
  if print_gateway_status; then
    gateway_ok=1
  fi

  log "runtime_mutation=$([[ "$REPAIR_LAUNCHAGENT_DRIFT" == "1" ]] && printf launchagent-repair-if-needed || printf none)"
  log "lock_unlock_mutation=none"
  log "password_access=none"
  log "applications_jarvis_app=untouched"

  [[ "$plist_valid" == "1" ]] || die "on-disk LaunchAgent plist does not point at Jarvis app-support runtime"
  [[ "$active_matches" == "1" ]] || die "active launchd cached service does not match the Jarvis app-support plist"
  [[ "$bad_active" != "1" ]] || die "active launchd service points at a known bad runtime path"
  [[ "$tcc_status" == granted:* || "$tcc_status" == "not_macos" ]] || die "Accessibility/TCC preflight is not green for the exact Jarvis runtime binary"
  [[ "$lease_ok" == "1" ]] || die "GUI lease cleanup has active leftovers"
  [[ "$gateway_ok" == "1" ]] || die "gateway RPC health proof failed"
}

main "$@"
