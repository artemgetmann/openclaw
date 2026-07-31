#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPORARY_UNAVAILABLE_EXIT_CODE=75

fail_closed() {
  printf 'Gateway restart temporarily unavailable: %s\n' "$1" >&2
  exit "$TEMPORARY_UNAVAILABLE_EXIT_CODE"
}

resolve_path() {
  /usr/bin/perl -MCwd=abs_path -e '
    my $resolved = abs_path($ARGV[0]);
    defined $resolved or exit 1;
    print "$resolved\n";
  ' "$1" 2>/dev/null
}

validate_cli_restart() {
  [[ "${1:-}" == "--" ]] || fail_closed "invalid guarded CLI separator"
  shift
  [[ "$#" -ge 4 ]] || fail_closed "incomplete guarded CLI command"

  local command_path=""
  command_path="$(resolve_path "$1" || true)"
  [[ -n "$command_path" ]] || fail_closed "guarded runtime executable is unreadable"
  case "$(basename "$command_path")" in
    node | nodejs) ;;
    *) fail_closed "guarded runtime executable is not Node.js" ;;
  esac
  shift

  local allowed=""
  local candidate_path=""
  local args=("$@")
  local allowed_entrypoints=(
    "$ROOT_DIR/openclaw.mjs"
    "$ROOT_DIR/dist/index.js"
  )

  # The wrapper controls this argv and intentionally omits process.execArgv.
  # Requiring the package entrypoint in argv[0] prevents `node -e`, `-p`, or a
  # preload mode from executing before a later decoy entrypoint argument.
  candidate_path="$(resolve_path "${args[0]}" || true)"
  local entrypoint_allowed=0
  for allowed in "${allowed_entrypoints[@]}"; do
    if [[ -n "$candidate_path" && "$candidate_path" == "$(resolve_path "$allowed" || true)" ]]; then
      entrypoint_allowed=1
      break
    fi
  done
  [[ "$entrypoint_allowed" -eq 1 ]] || fail_closed "guarded command is not this package's OpenClaw CLI"

  # Global CLI flags can appear before the subcommand. Require the exact
  # consecutive service mutation pair after the canonical entrypoint.
  local restart_pair_found=0
  local index=1
  while [[ "$index" -lt $((${#args[@]} - 1)) ]]; do
    case "${args[$index]}:${args[$((index + 1))]}" in
      gateway:restart | daemon:restart)
        # `daemon restart` is the registered compatibility alias for the same
        # gateway lifecycle action and must inherit the identical lock.
        restart_pair_found=1
        break
        ;;
    esac
    index=$((index + 1))
  done
  [[ "$restart_pair_found" -eq 1 ]] || fail_closed "guarded CLI is not a gateway restart command"

  exec "$command_path" "${args[@]}"
}

validate_handoff_target() {
  local service_target="$1"
  local domain="$2"
  local plist_path="$3"
  local label="${service_target#"$domain"/}"
  local expected_plist="${HOME}/Library/LaunchAgents/${label}.plist"

  [[ "$domain" == "gui/$(id -u)" ]] || fail_closed "launchd handoff domain does not match this UID"
  [[ "$service_target" == "$domain/$label" && -n "$label" ]] ||
    fail_closed "launchd handoff target is malformed"
  local configured_label="${OPENCLAW_LAUNCHD_LABEL:-}"
  configured_label="${configured_label#"${configured_label%%[![:space:]]*}"}"
  configured_label="${configured_label%"${configured_label##*[![:space:]]}"}"
  case "$label" in
    ai.openclaw.gateway | ai.jarvis.gateway | ai.openclaw.*) ;;
    *)
      # Explicit custom labels are a supported gateway identity. Accept one
      # only when the guarded target exactly matches the active runtime
      # configuration; an arbitrary handoff argument remains fail-closed.
      [[ -n "$configured_label" && "$label" == "$configured_label" ]] ||
        fail_closed "launchd handoff label does not match the active OpenClaw gateway"
      ;;
  esac
  [[ "$plist_path" == "$expected_plist" ]] ||
    fail_closed "launchd handoff plist does not match its gateway label"
}

run_handoff() {
  [[ "$#" -eq 9 ]] || fail_closed "incomplete launchd handoff command"
  local mode="$1"
  local service_target="$2"
  local domain="$3"
  local plist_path="$4"
  local wait_pid="$5"
  local delay_ms="$6"
  local receipt_dir="$7"
  local wait_pid_start="$8"
  local lifecycle_helper="$9"
  local expected_helper="$ROOT_DIR/scripts/lib/heavy-local-slot.sh"
  local temp_root="${TMPDIR:-/tmp}"
  temp_root="${temp_root%/}"

  [[ "$mode" == "kickstart" || "$mode" == "start-after-exit" ]] ||
    fail_closed "unknown launchd handoff mode"
  validate_handoff_target "$service_target" "$domain" "$plist_path"
  [[ "$(resolve_path "$lifecycle_helper" || true)" == "$(resolve_path "$expected_helper" || true)" ]] ||
    fail_closed "launchd handoff helper is not canonical"
  [[ "$receipt_dir" == "$temp_root/openclaw-gateway-lifecycle-$(id -u)-"* ]] ||
    fail_closed "launchd handoff receipt is outside the private UID namespace"
  [[ -d "$receipt_dir" ]] || fail_closed "launchd handoff receipt directory is missing"

  local ready_path="$receipt_dir/ready"
  local ack_path="$receipt_dir/ack"
  local cancel_path="$receipt_dir/cancel"
  local ready_tmp="$receipt_dir/ready.tmp.$$"
  umask 077
  printf 'admitted\n' >"$ready_tmp"
  /bin/mv "$ready_tmp" "$ready_path"
  cleanup_receipt() {
    /bin/rm -f "$ready_path" "$ready_tmp" "$ack_path" "$cancel_path" "$cancel_path.tmp."*
    /bin/rmdir "$receipt_dir" 2>/dev/null || true
  }
  trap cleanup_receipt EXIT

  # Mutation starts only after the caller observes admission. A dead caller
  # cannot pin the machine lifecycle lease indefinitely.
  local ack_wait_count=0
  while [[ ! -f "$ack_path" ]]; do
    [[ ! -f "$cancel_path" ]] || exit "$TEMPORARY_UNAVAILABLE_EXIT_CODE"
    ack_wait_count=$((ack_wait_count + 1))
    [[ "$ack_wait_count" -lt 800 ]] || exit "$TEMPORARY_UNAVAILABLE_EXIT_CODE"
    sleep 0.025
  done

  if [[ "$delay_ms" =~ ^[0-9]+$ && "$delay_ms" -gt 0 ]]; then
    local delay_seconds=$((delay_ms / 1000))
    local delay_millis=$((delay_ms % 1000))
    sleep "${delay_seconds}.$(printf '%03d' "$delay_millis")"
  fi
  [[ ! -f "$cancel_path" ]] || exit "$TEMPORARY_UNAVAILABLE_EXIT_CODE"

  if [[ "$wait_pid" =~ ^[1-9][0-9]*$ && "$wait_pid" -gt 1 ]]; then
    [[ -n "$wait_pid_start" ]] || fail_closed "launchd caller start identity is missing"
    # shellcheck source=scripts/lib/heavy-local-slot.sh
    source "$lifecycle_helper"
    local wait_pid_count=0
    local wait_status=0
    while true; do
      [[ ! -f "$cancel_path" ]] || exit "$TEMPORARY_UNAVAILABLE_EXIT_CODE"
      if openclaw_heavy_local_slot_owner_is_live "$wait_pid" "$wait_pid_start"; then
        wait_pid_count=$((wait_pid_count + 1))
        [[ "$wait_pid_count" -lt 300 ]] || exit "$TEMPORARY_UNAVAILABLE_EXIT_CODE"
        sleep 0.1
        continue
      else
        wait_status=$?
      fi
      [[ "$wait_status" -eq 1 ]] && break
      exit "$TEMPORARY_UNAVAILABLE_EXIT_CODE"
    done
  fi

  # The caller may convert an admitted restart into an explicit stop while its
  # listener is closing. Honor that newer intent before any launchctl mutation.
  [[ ! -f "$cancel_path" ]] || exit "$TEMPORARY_UNAVAILABLE_EXIT_CODE"

  if [[ "$mode" == "kickstart" ]]; then
    if ! launchctl kickstart -k "$service_target" >/dev/null 2>&1; then
      launchctl enable "$service_target" >/dev/null 2>&1
      if launchctl bootstrap "$domain" "$plist_path" >/dev/null 2>&1; then
        launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
      fi
    fi
    # EXIT still protects every early failure above. On the normal path clean
    # while the function-local receipt paths remain in scope, then disarm it.
    cleanup_receipt
    trap - EXIT
    return
  fi

  if ! launchctl start "$service_target" >/dev/null 2>&1; then
    launchctl enable "$service_target" >/dev/null 2>&1
    if launchctl bootstrap "$domain" "$plist_path" >/dev/null 2>&1; then
      launchctl start "$service_target" >/dev/null 2>&1 ||
        launchctl kickstart -k "$service_target" >/dev/null 2>&1 ||
        true
    else
      launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
    fi
  fi
  cleanup_receipt
  trap - EXIT
}

case "${1:-}" in
  cli)
    shift
    validate_cli_restart "$@"
    ;;
  handoff)
    shift
    run_handoff "$@"
    ;;
  *)
    fail_closed "unknown canonical lifecycle command mode"
    ;;
esac
