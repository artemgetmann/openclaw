#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/heavy-local-slot.sh
source "$ROOT_DIR/scripts/lib/heavy-local-slot.sh"
RUNNER="$ROOT_DIR/scripts/lib/heavy-local-slot-runner.pl"

# These are product safety policy, not tuning knobs. Ambient environment values
# must never weaken admission or stretch monitoring beyond the documented
# protection window.
readonly MIN_MEMORY_FREE_PERCENT=25
readonly PREFLIGHT_MIN_CPU_IDLE_PERCENT=35
readonly RUNTIME_MIN_CPU_IDLE_PERCENT=20
readonly MONITOR_INTERVAL_SECONDS=15
readonly UNHEALTHY_STRIKES_BEFORE_STOP=2
readonly HOST_HEALTH_HTTP_TIMEOUT_SECONDS=3
readonly WAIT_POLL_SECONDS=5
readonly MAX_WAIT_SECONDS=86400

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/with-heavy-local-slot.sh --label <owner> --check
  scripts/with-heavy-local-slot.sh --label <owner> --wait-seconds <seconds> -- <command> [args...]
  scripts/with-heavy-local-slot.sh --label <owner> -- <command> [args...]

Serializes CPU- or memory-intensive local work across all worktrees and clones
owned by this user. On macOS it also refuses to start when memory, CPU
headroom, Tailscale, or the managed Jarvis gateway are unhealthy.

--wait-seconds performs one bounded acquire-and-run transaction. It waits
without holding the lease, prints at most one queue notice, and executes the
guarded command exactly once after admission.
EOF
  exit 2
}

label=''
check_only=false
policy='standard'
wait_seconds=0
display_label=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --label)
      [ "$#" -ge 2 ] || usage
      label=$2
      shift 2
      ;;
    --check)
      check_only=true
      shift
      ;;
    --policy)
      [ "$#" -ge 2 ] || usage
      policy=$2
      shift 2
      ;;
    --wait-seconds)
      [ "$#" -ge 2 ] || usage
      wait_seconds=$2
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      usage
      ;;
  esac
done

[ -n "$label" ] || usage
display_label="$(openclaw_heavy_local_slot_safe_text "$label")"
[ -n "$display_label" ] || usage
[[ "$wait_seconds" =~ ^(0|[1-9][0-9]*)$ ]] || usage
[ "${#wait_seconds}" -le "${#MAX_WAIT_SECONDS}" ] || usage
[ "$wait_seconds" -le "$MAX_WAIT_SECONDS" ] || usage
if [ "$check_only" = false ] && [ "$#" -eq 0 ]; then
  usage
fi
if [ "$check_only" = true ] && [ "$#" -ne 0 ]; then
  usage
fi
if [ "$check_only" = true ] && [ "$wait_seconds" -ne 0 ]; then
  usage
fi

child_pid=''
child_pgid=''
monitor_pid=''
health_stop_file=''
child_cleanup_safe=1
committed_identity_status=1
PERL_BIN="$(command -v perl 2>/dev/null || true)"
queue_notice_emitted=0
wait_started=$SECONDS
last_refusal_class=''
last_refusal_code=''
last_refusal_message=''
last_refusal_data=''

emit_refusal() {
  local refusal_class="$1"
  local refusal_code="$2"
  local refusal_message="$3"
  local refusal_data="${4:-}"

  printf 'HEAVY_LOCAL_SLOT_REFUSAL class=%s code=%s' \
    "$refusal_class" \
    "$refusal_code" >&2
  if [ -n "$refusal_data" ]; then
    printf ' %s' "$refusal_data" >&2
  fi
  printf '\n' >&2
  printf 'Refusing heavy work: %s\n' "$refusal_message" >&2
}

wait_deadline_has_expired() {
  [ "$wait_seconds" -gt 0 ] &&
    [ "$queue_notice_emitted" -eq 1 ] &&
    [ "$((SECONDS - wait_started))" -ge "$wait_seconds" ]
}

emit_wait_timeout() {
  emit_refusal \
    "$last_refusal_class" \
    "wait_timeout" \
    "timed out after ${wait_seconds}s; last reason: $last_refusal_message" \
    "last_code=$last_refusal_code${last_refusal_data:+ $last_refusal_data}"
}

queue_or_refuse() {
  local refusal_class="$1"
  local refusal_code="$2"
  local refusal_message="$3"
  local refusal_data="${4:-}"
  local elapsed=0
  local remaining=0
  local sleep_seconds=0

  last_refusal_class="$refusal_class"
  last_refusal_code="$refusal_code"
  last_refusal_message="$refusal_message"
  last_refusal_data="$refusal_data"

  if [ "$wait_seconds" -eq 0 ]; then
    emit_refusal "$refusal_class" "$refusal_code" "$refusal_message" "$refusal_data"
    return 1
  fi
  if [ "$refusal_class" != "occupied" ] && [ "$refusal_class" != "host_unhealthy" ]; then
    emit_refusal "$refusal_class" "$refusal_code" "$refusal_message" "$refusal_data"
    return 1
  fi

  if [ "$queue_notice_emitted" -eq 0 ]; then
    printf 'Heavy-local slot queued for "%s" (class=%s, code=%s); waiting up to %ss.\n' \
      "$display_label" \
      "$refusal_class" \
      "$refusal_code" \
      "$wait_seconds" >&2
    queue_notice_emitted=1
  fi

  elapsed=$((SECONDS - wait_started))
  remaining=$((wait_seconds - elapsed))
  if [ "$remaining" -le 0 ]; then
    emit_wait_timeout
    return 1
  fi

  sleep_seconds=$WAIT_POLL_SECONDS
  if [ "$remaining" -lt "$sleep_seconds" ]; then
    sleep_seconds=$remaining
  fi
  sleep "$sleep_seconds"

  # A final sleep may end at or after the deadline. Refuse here instead of
  # returning to acquisition, where a newly free slot could launch late work.
  if wait_deadline_has_expired; then
    emit_wait_timeout
    return 1
  fi
  return 0
}

resolve_command_path() {
  local candidate="$1"
  [ -n "$PERL_BIN" ] || return 1
  "$PERL_BIN" -MCwd=abs_path -e '
    my $resolved = abs_path($ARGV[0]);
    defined $resolved or exit 1;
    print "$resolved\n";
  ' "$candidate" 2>/dev/null
}

validate_policy_for_command() {
  local guarded_command=""
  local allowed_command=""

  case "$policy" in
    standard)
      return 0
      ;;
    jarvis-remediation)
      [ "$check_only" = false ] || {
        emit_refusal \
          "guard_internal" \
          "invalid_remediation_request" \
          "Jarvis remediation requires the canonical hotfix command"
        return 75
      }
      guarded_command="$(resolve_command_path "${1:-}" || true)"
      allowed_command="$(resolve_command_path "$ROOT_DIR/scripts/ship-jarvis-hotfix.sh" || true)"
      if [ -z "$guarded_command" ] || [ "$guarded_command" != "$allowed_command" ]; then
        emit_refusal \
          "guard_internal" \
          "invalid_remediation_command" \
          "Jarvis remediation is restricted to the canonical ship-jarvis-hotfix entrypoint"
        return 75
      fi
      return 0
      ;;
    *)
      emit_refusal \
        "guard_internal" \
        "unknown_policy" \
        "unknown admission policy '$policy'"
      return 75
      ;;
  esac
}

guarded_group_is_live() {
  [ -n "$child_pgid" ] || return 1
  kill -0 -- "-$child_pgid" 2>/dev/null
}

load_guarded_group_identity() {
  local metadata_path="$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_pid"
  local status=0

  [ -f "$metadata_path" ] || return 1
  child_pgid="$(openclaw_heavy_local_slot_value "$metadata_path" pgid)"
  if openclaw_heavy_local_slot_child_group_status "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH"; then
    status=0
  else
    status=$?
  fi
  [ "$status" -ne 2 ] || return 2
  return 0
}

load_committed_guarded_group_identity() {
  local attempt=0
  local status=0

  [ -f "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_committed" ] || return 1
  [ ! -e "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_pending" ] || return 1

  # A fast command can exit between child_group_status's live-PID probe and its
  # syscall-backed identity read. Retry only that transient ambiguous result:
  # the next read must either validate the same live identity or prove the
  # committed process group is gone. Persistent ambiguity remains fail-closed.
  while [ "$attempt" -lt 5 ]; do
    if load_guarded_group_identity; then
      return 0
    else
      status=$?
    fi
    [ "$status" -eq 2 ] || return "$status"
    attempt=$((attempt + 1))
    [ "$attempt" -lt 5 ] || break
    sleep 0.01
  done
  return 2
}

authorize_committed_guarded_child() {
  local authorized_path="$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_authorized"
  local authorized_tmp="${authorized_path}.tmp.$$"

  # The runner cannot exec until this exact owner publishes its lease token.
  # Atomic rename prevents a signal-interrupted partial record from becoming
  # execution authority; cleanup removes only this owner's known temp path.
  (umask 077 && printf 'token=%s\n' "$OPENCLAW_HEAVY_LOCAL_SLOT_TOKEN" >"$authorized_tmp") ||
    return 1
  /bin/mv "$authorized_tmp" "$authorized_path"
}

stop_guarded_child() {
  local attempt=0
  local status=0

  # Acquisition publishes the shared path before it knows whether this wrapper
  # won the mkdir race. A losing contender must never interpret the winner's
  # child metadata as its own cleanup authority.
  [ "$OPENCLAW_HEAVY_LOCAL_SLOT_HELD" = "1" ] || return 0

  # A signal can arrive after spawn but before Bash assigns `$!`. Recover the
  # published leader when possible; an incomplete pending handshake is not
  # proof that no child exists and therefore retains the lease.
  if [ -z "$child_pid" ] &&
    [ -n "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH" ] &&
    [ -f "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_pid" ]; then
    child_pid="$(
      openclaw_heavy_local_slot_value \
        "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_pid" \
        pid
    )"
  fi
  if [ -z "$child_pid" ] &&
    [ -n "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH" ] &&
    [ -e "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_pending" ]; then
    child_cleanup_safe=0
    echo "Refusing unsafe cleanup: guarded child spawn is still pending." >&2
    return 1
  fi
  [ -n "$child_pid" ] || return 0
  if load_guarded_group_identity; then
    :
  else
    status=$?
    if [ "$status" -eq 2 ]; then
      child_cleanup_safe=0
      echo "Refusing unsafe cleanup: guarded process-group identity is ambiguous." >&2
      return 1
    fi
    kill -0 "$child_pid" 2>/dev/null || return 0
    child_cleanup_safe=0
    echo "Refusing unsafe cleanup: guarded child metadata was not published." >&2
    return 1
  fi

  guarded_group_is_live || return 0
  kill -TERM -- "-$child_pgid" 2>/dev/null || true
  while guarded_group_is_live && [ "$attempt" -lt 10 ]; do
    sleep 0.2
    attempt=$((attempt + 1))
  done

  # The command runs in a dedicated session whose leader PID, PGID, start time,
  # and session ID were verified above. KILL therefore cannot touch the caller,
  # coordinator, or any unrelated process group.
  if guarded_group_is_live; then
    kill -KILL -- "-$child_pgid" 2>/dev/null || true
  fi
  wait "$child_pid" 2>/dev/null || true

  attempt=0
  while guarded_group_is_live && [ "$attempt" -lt 40 ]; do
    sleep 0.05
    attempt=$((attempt + 1))
  done
  if guarded_group_is_live; then
    child_cleanup_safe=0
    echo "Refusing lease release: guarded process group survived KILL." >&2
    return 1
  fi
  return 0
}

stop_health_monitor() {
  [ -n "$monitor_pid" ] || return 0
  kill -0 "$monitor_pid" 2>/dev/null || return 0

  kill -TERM "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
}

cleanup_wrapper() {
  stop_health_monitor
  stop_guarded_child || true
  if [ "$child_cleanup_safe" = "1" ]; then
    openclaw_heavy_local_slot_release
  else
    echo "Heavy-local lease retained because guarded process cleanup was not proven safe." >&2
  fi
}

handle_interrupt() {
  local signal_name="$1"
  local status="$2"

  # Emit the supervisor identity before cleanup can reap the child or clear its
  # metadata. This distinguishes a signal delivered to this wrapper from a
  # signal-derived status returned by the guarded command.
  printf 'Heavy-local wrapper "%s" received %s (owner PID %s, child PID %s, child PGID %s).\n' \
    "$display_label" \
    "$signal_name" \
    "$$" \
    "${child_pid:-unknown}" \
    "${child_pgid:-unknown}" >&2
  stop_health_monitor
  # Preserve the signal-derived exit status even if identity ambiguity forces
  # EXIT cleanup to retain the lease for operator recovery.
  stop_guarded_child || true
  exit "$status"
}

trap cleanup_wrapper EXIT
trap 'handle_interrupt INT 130' INT
trap 'handle_interrupt TERM 143' TERM
trap 'handle_interrupt HUP 129' HUP

if validate_policy_for_command "${1:-}"; then
  :
else
  policy_status=$?
  exit "$policy_status"
fi
[ -n "$PERL_BIN" ] && [ -r "$RUNNER" ] || {
  emit_refusal \
    "guard_internal" \
    "session_runner_unavailable" \
    "Perl session runner is unavailable"
  exit 75
}
if ! "$PERL_BIN" "$RUNNER" --inspect-process "$$" >/dev/null 2>&1; then
  emit_refusal \
    "guard_internal" \
    "process_identity_unavailable" \
    "POSIX process identity backend is unavailable"
  exit 75
fi

host_health_reason() {
  local required_cpu_idle=$1
  local require_jarvis_health=$2

  [ "$(uname -s)" = "Darwin" ] || return 0

  # memory_pressure already accounts for compressed memory. Raw "free pages"
  # alone would falsely reject healthy Macs that are using their cache.
  memory_free=$(
    /usr/bin/memory_pressure 2>/dev/null |
      awk -F': ' '/System-wide memory free percentage/{gsub(/%/, "", $2); print int($2); exit}'
  )
  if [ -z "$memory_free" ]; then
    printf '%s' \
      'guard_internal|memory_measurement_failed|could not measure memory pressure|metric=memory_pressure status=unavailable'
    return 0
  fi
  if [ "$memory_free" -lt "$MIN_MEMORY_FREE_PERCENT" ]; then
    printf 'host_unhealthy|memory_pressure|memory headroom is %s%% (minimum %s%%)|metric=memory_free_percent observed=%s threshold=%s unit=percent' \
      "$memory_free" \
      "$MIN_MEMORY_FREE_PERCENT" \
      "$memory_free" \
      "$MIN_MEMORY_FREE_PERCENT"
    return 0
  fi

  # Heavy jobs are admitted only while the interactive desktop still has
  # substantial CPU headroom. This protects WindowServer, VNC, and Tailscale.
  cpu_idle=$(
    /usr/bin/top -l 1 -n 0 2>/dev/null |
      awk '/CPU usage:/{gsub(/%/, "", $7); print int($7); exit}'
  )
  if [ -z "$cpu_idle" ]; then
    printf '%s' \
      'guard_internal|cpu_measurement_failed|could not measure CPU headroom|metric=cpu_idle_percent status=unavailable'
    return 0
  fi
  if [ "$cpu_idle" -lt "$required_cpu_idle" ]; then
    printf 'host_unhealthy|cpu_pressure|CPU idle is %s%% (minimum %s%%)|metric=cpu_idle_percent observed=%s threshold=%s unit=percent' \
      "$cpu_idle" \
      "$required_cpu_idle" \
      "$cpu_idle" \
      "$required_cpu_idle"
    return 0
  fi

  # If Tailscale is configured on this Mac, disconnected means the remote
  # operator may already be losing access. Local work must wait.
  tailscale_line=$(scutil --nc list 2>/dev/null | grep -i '"Tailscale"' | head -n 1 || true)
  if [ -n "$tailscale_line" ] && ! printf '%s\n' "$tailscale_line" | grep -q '(Connected)'; then
    printf '%s' \
      'host_unhealthy|tailscale_disconnected|Tailscale is configured but not connected|metric=tailscale_connection observed=disconnected expected=connected'
    return 0
  fi

  # Only require Jarvis health when this user actually owns the managed
  # LaunchAgent. Development Macs without that service remain supported.
  if [ "$require_jarvis_health" = "1" ] &&
    launchctl print "gui/$(id -u)/ai.jarvis.gateway" >/dev/null 2>&1; then
    if ! curl -fsS --max-time "$HOST_HEALTH_HTTP_TIMEOUT_SECONDS" \
      http://127.0.0.1:18789/healthz >/dev/null; then
      printf '%s' \
        'host_unhealthy|jarvis_unhealthy|managed Jarvis health check failed|metric=jarvis_health observed=unhealthy expected=healthy'
      return 0
    fi
  fi
}

require_jarvis_health=1
if [ "$policy" = "jarvis-remediation" ]; then
  # The canonical hotfix intentionally replaces ai.jarvis.gateway. Continue to
  # enforce workstation and remote-access health, but do not let the broken
  # service or its planned restart kill the repair transaction.
  require_jarvis_health=0
fi

while true; do
  if openclaw_heavy_local_slot_acquire "$label" "$policy"; then
    # Acquisition can spend time validating owner metadata or stale recovery.
    # A lease won after the caller's deadline must be released without launch.
    if wait_deadline_has_expired; then
      openclaw_heavy_local_slot_release
      emit_wait_timeout
      exit 75
    fi
  else
    acquire_status=$?
    if queue_or_refuse \
      "${OPENCLAW_HEAVY_LOCAL_SLOT_REFUSAL_CLASS:-guard_internal}" \
      "${OPENCLAW_HEAVY_LOCAL_SLOT_REFUSAL_CODE:-acquire_failed}" \
      "${OPENCLAW_HEAVY_LOCAL_SLOT_REFUSAL_MESSAGE:-heavy-local slot acquisition failed}" \
      ""; then
      continue
    fi
    exit "$acquire_status"
  fi

  preflight_result=$(host_health_reason "$PREFLIGHT_MIN_CPU_IDLE_PERCENT" "$require_jarvis_health")
  if [ -z "$preflight_result" ]; then
    # The final health probe may itself consume the remaining wait budget.
    # Preserve the same no-late-launch boundary after that probe completes.
    if wait_deadline_has_expired; then
      openclaw_heavy_local_slot_release
      emit_wait_timeout
      exit 75
    fi
    break
  fi
  IFS='|' read -r preflight_class preflight_code preflight_reason preflight_data \
    <<<"$preflight_result"
  # Host-health waiters never monopolize the serialization lease. Release
  # before sleeping, then compete atomically again on the next bounded attempt.
  openclaw_heavy_local_slot_release
  if queue_or_refuse \
    "$preflight_class" \
    "$preflight_code" \
    "$preflight_reason" \
    "$preflight_data"; then
    continue
  fi
  exit 75
done
health_stop_file="$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/health_stop_reason"

printf 'Heavy-local slot granted to "%s".\n' "$display_label"
if [ "$check_only" = true ]; then
  exit 0
fi

# Publish a pending handshake before spawn. The runner atomically renames this
# marker to child_committed only after complete identity metadata is installed.
# If either process dies mid-publication, stale recovery fails closed.
(umask 077 && : >"$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_pending")

# Background scheduling reduces competition with the interactive desktop. The
# Perl runner creates a dedicated session/process group before exec so cleanup
# remains complete even if the root command exits before stubborn descendants.
if [ "$(uname -s)" = "Darwin" ] && command -v taskpolicy >/dev/null 2>&1; then
  taskpolicy -b nice -n 15 "$PERL_BIN" "$RUNNER" "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH" "$@" &
else
  nice -n 15 "$PERL_BIN" "$RUNNER" "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH" "$@" &
fi
child_pid=$!

metadata_wait=0
while [ "$metadata_wait" -lt 200 ]; do
  if [ -f "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_pid" ] &&
    [ -f "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_committed" ] &&
    [ ! -e "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_pending" ]; then
    break
  fi
  kill -0 "$child_pid" 2>/dev/null || break
  sleep 0.05
  metadata_wait=$((metadata_wait + 1))
done
if [ -f "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_committed" ] &&
  [ ! -e "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_pending" ]; then
  if load_committed_guarded_group_identity; then
    committed_identity_status=0
  else
    # Capture the helper's internal reason before the boolean admission check.
    # No raw identity status may bypass the wrapper's fail-closed exit 75.
    committed_identity_status=$?
  fi
fi
if [ "$committed_identity_status" -ne 0 ]; then
  child_cleanup_safe=0
  kill -KILL "$child_pid" 2>/dev/null || true
  wait "$child_pid" 2>/dev/null || true
  emit_refusal \
    "guard_internal" \
    "child_session_publish_failed" \
    "guarded child session metadata was not published safely"
  exit 75
fi
if ! authorize_committed_guarded_child; then
  child_cleanup_safe=0
  kill -KILL "$child_pid" 2>/dev/null || true
  wait "$child_pid" 2>/dev/null || true
  emit_refusal \
    "guard_internal" \
    "child_authorization_failed" \
    "guarded child authorization was not published safely"
  exit 75
fi

monitor_guarded_child() {
  local unhealthy_strikes=0
  local runtime_result runtime_class runtime_code runtime_reason runtime_data

  # The monitor is a background subshell. It must never inherit the parent's
  # lease-cleanup traps or release a lock still owned by the waiting wrapper.
  trap - EXIT INT TERM HUP

  while kill -0 "$child_pid" 2>/dev/null; do
    runtime_result=$(host_health_reason "$RUNTIME_MIN_CPU_IDLE_PERCENT" "$require_jarvis_health")
    if [ -n "$runtime_result" ]; then
      IFS='|' read -r runtime_class runtime_code runtime_reason runtime_data <<<"$runtime_result"
      unhealthy_strikes=$((unhealthy_strikes + 1))
    else
      unhealthy_strikes=0
    fi

    # Two consecutive unhealthy samples ignore a transient spike while still
    # stopping a runaway job before a multi-minute VNC/Jarvis starvation event.
    if [ "$unhealthy_strikes" -ge "$UNHEALTHY_STRIKES_BEFORE_STOP" ] &&
      guarded_group_is_live; then
      printf '%s|%s|%s|%s\n' \
        "$runtime_class" \
        "$runtime_code" \
        "$runtime_reason" \
        "$runtime_data" >"$health_stop_file"
      printf 'Stopping guarded work after repeated host-health failures: %s\n' "$runtime_reason" >&2
      stop_guarded_child
      return 0
    fi
    sleep "$MONITOR_INTERVAL_SECONDS"
  done
}

# Supervision runs beside the child rather than in the parent's wait path.
# Fast commands therefore finish immediately instead of waiting up to one
# monitoring interval for the next health sample.
monitor_guarded_child &
monitor_pid=$!

set +e
wait "$child_pid"
child_status=$?
set -e
stop_health_monitor

# Root exit is not proof that every worker exited. Stop and verify the dedicated
# group before returning the root status or releasing the machine lease.
stop_guarded_child || true

if [ -s "$health_stop_file" ]; then
  IFS='|' read -r health_stop_class health_stop_code health_stop_reason health_stop_data \
    <"$health_stop_file"
  emit_refusal \
    "$health_stop_class" \
    "$health_stop_code" \
    "$health_stop_reason" \
    "$health_stop_data"
  exit 75
fi
exit "$child_status"
