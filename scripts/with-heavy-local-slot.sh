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
readonly MIN_DISK_FREE_KIB=$((25 * 1024 * 1024))
readonly DISK_REPORT_BELOW_KIB=$((35 * 1024 * 1024))
readonly TASK_DISK_RECEIPT_THRESHOLD_KIB=$((1024 * 1024))
readonly MONITOR_INTERVAL_SECONDS=15
readonly UNHEALTHY_STRIKES_BEFORE_STOP=2
readonly HOST_HEALTH_HTTP_TIMEOUT_SECONDS=3
readonly WAIT_POLL_SECONDS=5
readonly MAX_WAIT_SECONDS=86400

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/with-heavy-local-slot.sh --label <owner> --check
  scripts/with-heavy-local-slot.sh --cpu-policy dedicated-agent --label <owner> --check
  scripts/with-heavy-local-slot.sh --label <owner> --wait-seconds <seconds> -- <command> [args...]
  scripts/with-heavy-local-slot.sh --label <owner> -- <command> [args...]

Serializes CPU- or memory-intensive local work across all worktrees and clones
owned by this user. On macOS it also refuses to start when memory, CPU
headroom, Tailscale, or the managed Jarvis gateway are unhealthy.

--wait-seconds performs one bounded acquire-and-run transaction. It waits
without holding the lease, prints at most one queue notice, and executes the
guarded command exactly once after admission.

--cpu-policy dedicated-agent is an explicit per-transaction mode for Macs
reserved for agent workloads. It records CPU-idle telemetry but does not use
CPU idle to refuse admission or stop work. Every non-CPU safety gate remains
enforced. The default CPU policy retains the 35%/20% idle floors.
EOF
  exit 2
}

label=''
check_only=false
policy='standard'
cpu_policy='standard'
wait_seconds=0
display_label=''
telemetry_label=''

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
    --cpu-policy)
      [ "$#" -ge 2 ] || usage
      cpu_policy=$2
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
telemetry_label="$(printf '%s' "$display_label" | /usr/bin/tr ' ' '_')"
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
task_worktree=''
task_generated_before_kib=''
task_disk_before_kib=''
dedicated_jarvis_baseline_pid=''

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

measure_task_generated_kib() {
  local worktree_root="$1"
  local generated_path=""
  local size_kib=""
  local total_kib=0

  # Keep ownership attribution narrow and identical before/after the guarded
  # command. An unreadable generated tree is indeterminate, never zero.
  for generated_path in \
    node_modules \
    dist \
    .build \
    .build-ui-smoke \
    dist-ui-smoke \
    DerivedData \
    .swiftpm \
    .turbo \
    coverage; do
    [ -e "$worktree_root/$generated_path" ] || continue
    size_kib="$(du -sk "$worktree_root/$generated_path" 2>/dev/null | awk '{ print $1; exit }')" ||
      return 1
    [[ "$size_kib" =~ ^[0-9]+$ ]] || return 1
    total_kib=$((total_kib + size_kib))
  done
  printf '%s\n' "$total_kib"
}

disk_available_kib_for_path() {
  df -Pk "$1" 2>/dev/null |
    awk 'NR == 2 && $4 ~ /^[0-9]+$/ { print $4; exit }'
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
    gateway-lifecycle)
      # Gateway restart is itself the operation that may repair or replace the
      # managed Jarvis listener. It still needs the machine lease and all host
      # headroom checks, but requiring that same listener to answer /healthz
      # would deadlock an in-process detached handoff.
      guarded_command="$(resolve_command_path "${1:-}" || true)"
      allowed_command="$(resolve_command_path "$ROOT_DIR/scripts/gateway-lifecycle-command.sh" || true)"
      if [[ -z "$guarded_command" || "$guarded_command" != "$allowed_command" ]]; then
        emit_refusal \
          "guard_internal" \
          "invalid_gateway_lifecycle_command" \
          "gateway-lifecycle policy requires the canonical lifecycle command"
        return 75
      fi
      case "$label:${2:-}" in
        gateway-restart:*:cli | gateway-restart-handoff:*:handoff)
          return 0
          ;;
        *)
          emit_refusal \
            "guard_internal" \
            "invalid_gateway_lifecycle_label" \
            "gateway-lifecycle policy requires a gateway restart label"
          return 75
          ;;
      esac
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

validate_cpu_policy() {
  # CPU policy is deliberately separate from internal admission policies such
  # as gateway lifecycle. This public mode changes one metric only and cannot
  # inherit the Jarvis-health exemptions attached to internal policies.
  case "$cpu_policy" in
    standard | dedicated-agent)
      return 0
      ;;
    *)
      emit_refusal \
        "guard_internal" \
        "unknown_cpu_policy" \
        "unknown CPU policy '$cpu_policy'" \
        "cpu_policy=$(openclaw_heavy_local_slot_safe_text "$cpu_policy")"
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

if validate_policy_for_command "$@"; then
  :
else
  policy_status=$?
  exit "$policy_status"
fi
if validate_cpu_policy; then
  :
else
  cpu_policy_status=$?
  exit "$cpu_policy_status"
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

dedicated_resource_health_reason() {
  local sample_phase="$1"
  local pressure_level="" pressure_state=""
  local swap_line="" swap_used_kib="" swap_free_kib=""
  local vm_stat_output="" pageouts_total="" swapouts_total=""
  local thermal_output="" thermal_status=0 thermal_state=""

  # The kernel memory-pressure level is a platform decision, not a guessed
  # percentage. Its values match the public dispatch memory-pressure states:
  # normal=1, warn=2, and critical=4. Keep the existing 25% floor as a separate
  # conservative boundary; this signal catches compressor/swap stress that a
  # single free-memory percentage can miss.
  pressure_level="$(
    /usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null || true
  )"
  case "$pressure_level" in
    1) pressure_state="normal" ;;
    2) pressure_state="warn" ;;
    4) pressure_state="critical" ;;
    *)
      printf '%s' \
        'guard_internal|memory_state_measurement_failed|could not measure the macOS memory-pressure state|metric=memory_pressure_state status=unavailable'
      return 0
      ;;
  esac

  # Absolute swap use is intentionally telemetry only. macOS can retain a large
  # historical swap allocation after pressure has recovered, so refusing at an
  # arbitrary absolute value would strand a healthy dedicated host. Repeated
  # samples expose the real used/free and paging trend without recording argv,
  # environment values, or unrelated process details.
  swap_line="$(/usr/sbin/sysctl -n vm.swapusage 2>/dev/null || true)"
  swap_used_kib="$(
    printf '%s\n' "$swap_line" |
      /usr/bin/awk '{
        for (field = 1; field <= NF; field++) {
          if ($field == "used") {
            value = $(field + 2)
            sub(/M$/, "", value)
            if (value ~ /^[0-9]+([.][0-9]+)?$/) {
              printf "%.0f", value * 1024
            }
            exit
          }
        }
      }'
  )"
  swap_free_kib="$(
    printf '%s\n' "$swap_line" |
      /usr/bin/awk '{
        for (field = 1; field <= NF; field++) {
          if ($field == "free") {
            value = $(field + 2)
            sub(/M$/, "", value)
            if (value ~ /^[0-9]+([.][0-9]+)?$/) {
              printf "%.0f", value * 1024
            }
            exit
          }
        }
      }'
  )"
  vm_stat_output="$(/usr/bin/vm_stat 2>/dev/null || true)"
  pageouts_total="$(
    printf '%s\n' "$vm_stat_output" |
      /usr/bin/awk -F': ' '/^Pageouts:/ {
        gsub(/[.[:space:]]/, "", $2)
        if ($2 ~ /^[0-9]+$/) print $2
        exit
      }'
  )"
  swapouts_total="$(
    printf '%s\n' "$vm_stat_output" |
      /usr/bin/awk -F': ' '/^Swapouts:/ {
        gsub(/[.[:space:]]/, "", $2)
        if ($2 ~ /^[0-9]+$/) print $2
        exit
      }'
  )"
  if [[ ! "$swap_used_kib" =~ ^[0-9]+$ ||
    ! "$swap_free_kib" =~ ^[0-9]+$ ||
    ! "$pageouts_total" =~ ^[0-9]+$ ||
    ! "$swapouts_total" =~ ^[0-9]+$ ]]; then
    printf '%s' \
      'guard_internal|paging_measurement_failed|could not measure swap and pageout counters|metric=paging_trend status=unavailable'
    return 0
  fi

  # pmset reports the macOS thermal and performance-pressure decisions that
  # actually cause throttling. CPU utilization itself remains telemetry-only;
  # a platform warning is the independent hardware-protection boundary.
  # Keep command failure separate from the report body. pmset includes the
  # words "thermal" and "performance" in its error text, so parsing a failed
  # invocation as a real pressure warning would misclassify an unavailable
  # platform signal as host heat.
  if thermal_output="$(/usr/bin/pmset -g therm 2>/dev/null)"; then
    thermal_status=0
  else
    thermal_status=$?
  fi
  if [ "$thermal_status" -ne 0 ]; then
    printf '%s' \
      'guard_internal|thermal_measurement_failed|could not measure macOS thermal and performance pressure|metric=thermal_pressure status=unavailable'
    return 0
  fi
  if printf '%s\n' "$thermal_output" |
      /usr/bin/grep -Fq 'No thermal warning level has been recorded' &&
    printf '%s\n' "$thermal_output" |
      /usr/bin/grep -Fq 'No performance warning level has been recorded'; then
    thermal_state="normal"
  elif printf '%s\n' "$thermal_output" |
      /usr/bin/grep -Eiq 'thermal|performance'; then
    thermal_state="pressure"
  else
    printf '%s' \
      'guard_internal|thermal_measurement_failed|could not measure macOS thermal and performance pressure|metric=thermal_pressure status=unavailable'
    return 0
  fi

  printf 'HEAVY_LOCAL_RESOURCE_TELEMETRY cpu_policy=dedicated-agent phase=%s elapsed_seconds=%s memory_pressure=%s memory_pressure_level=%s swap_used_kib=%s swap_free_kib=%s pageouts_total=%s swapouts_total=%s thermal_state=%s\n' \
    "$sample_phase" \
    "$SECONDS" \
    "$pressure_state" \
    "$pressure_level" \
    "$swap_used_kib" \
    "$swap_free_kib" \
    "$pageouts_total" \
    "$swapouts_total" \
    "$thermal_state" >&2

  if [ "$pressure_state" != "normal" ]; then
    printf 'host_unhealthy|memory_pressure_state|macOS memory pressure is %s|metric=memory_pressure_state observed=%s expected=normal' \
      "$pressure_state" \
      "$pressure_state"
    return 0
  fi
  if [ "$thermal_state" != "normal" ]; then
    printf '%s' \
      'host_unhealthy|thermal_pressure|macOS reports thermal or performance pressure|metric=thermal_pressure observed=pressure expected=normal'
    return 0
  fi
}

dedicated_group_health_reason() {
  local sample_phase="$1"
  local group_sample="" process_count="" group_rss_kib=""

  # Preflight has no guarded process group yet. At runtime the exact committed
  # PGID/session remains the enforcement boundary; process count and aggregate
  # RSS make unexpected fanout observable without inventing a machine-wide cap
  # from workload-specific experiments.
  [ "$sample_phase" = "runtime" ] || return 0
  [[ "$child_pgid" =~ ^[1-9][0-9]*$ ]] || {
    printf '%s' \
      'guard_internal|fanout_measurement_failed|guarded process group identity is unavailable|metric=guarded_group_fanout status=unavailable'
    return 0
  }
  group_sample="$(
    /bin/ps -axo pgid=,rss= 2>/dev/null |
      /usr/bin/awk -v expected_pgid="$child_pgid" '
        $1 == expected_pgid && $2 ~ /^[0-9]+$/ {
          process_count += 1
          rss_kib += $2
        }
        END {
          if (process_count > 0) print process_count "|" rss_kib
        }
      '
  )"
  IFS='|' read -r process_count group_rss_kib <<<"$group_sample"
  if [[ ! "$process_count" =~ ^[1-9][0-9]*$ ||
    ! "$group_rss_kib" =~ ^[0-9]+$ ]]; then
    printf '%s' \
      'guard_internal|fanout_measurement_failed|could not measure the guarded process group|metric=guarded_group_fanout status=unavailable'
    return 0
  fi
  printf 'HEAVY_LOCAL_GROUP_TELEMETRY cpu_policy=dedicated-agent phase=runtime pgid=%s process_count=%s rss_kib=%s enforcement=single_guarded_group\n' \
    "$child_pgid" \
    "$process_count" \
    "$group_rss_kib" >&2
}

probe_dedicated_jarvis() {
  local expected_pid="${1:-}"
  local sample_phase="${2:-preflight}"
  local domain="gui/$(id -u)/ai.jarvis.gateway"
  local launch_state="" launch_pid=""
  local listener_pids="" listener_count="" listener_pid=""
  local http_sample="" http_code="" latency_seconds="" latency_ms=""

  if ! launch_state="$(launchctl print "$domain" 2>/dev/null)"; then
    if [ -n "$expected_pid" ] && [ "$expected_pid" != "absent" ]; then
      printf '%s' \
        'error|host_unhealthy|jarvis_identity_changed|managed Jarvis disappeared during guarded work|metric=jarvis_identity observed=absent expected=stable'
    else
      printf '%s' 'ok|absent'
    fi
    return 0
  fi
  launch_pid="$(
    printf '%s\n' "$launch_state" |
      /usr/bin/awk '$1 == "pid" && $2 == "=" && $3 ~ /^[0-9]+$/ { print $3; exit }'
  )"
  if [[ ! "$launch_pid" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s' \
      'error|guard_internal|jarvis_identity_measurement_failed|managed Jarvis has no readable LaunchAgent PID|metric=jarvis_launch_pid status=unavailable'
    return 0
  fi

  listener_pids="$(
    /usr/sbin/lsof -nP -tiTCP:18789 -sTCP:LISTEN 2>/dev/null |
      /usr/bin/sort -u || true
  )"
  listener_count="$(printf '%s\n' "$listener_pids" | /usr/bin/awk 'NF { count += 1 } END { print count + 0 }')"
  listener_pid="$(printf '%s\n' "$listener_pids" | /usr/bin/awk 'NF { print; exit }')"
  if [ "$listener_count" -ne 1 ] || [ "$listener_pid" != "$launch_pid" ]; then
    printf 'error|host_unhealthy|jarvis_listener_mismatch|managed Jarvis LaunchAgent PID does not exclusively own port 18789|metric=jarvis_listener_pid observed=%s expected=%s listener_count=%s' \
      "${listener_pid:-missing}" \
      "$launch_pid" \
      "$listener_count"
    return 0
  fi
  if [ -n "$expected_pid" ] && [ "$expected_pid" != "$launch_pid" ]; then
    printf 'error|host_unhealthy|jarvis_identity_changed|managed Jarvis PID changed during guarded work|metric=jarvis_launch_pid observed=%s expected=%s' \
      "$launch_pid" \
      "$expected_pid"
    return 0
  fi

  if ! http_sample="$(
    curl -fsS -o /dev/null \
      --max-time "$HOST_HEALTH_HTTP_TIMEOUT_SECONDS" \
      -w '%{http_code}|%{time_total}' \
      http://127.0.0.1:18789/healthz 2>/dev/null
  )"; then
    printf '%s' \
      'error|host_unhealthy|jarvis_unhealthy|managed Jarvis health check failed|metric=jarvis_health observed=unhealthy expected=healthy'
    return 0
  fi
  IFS='|' read -r http_code latency_seconds <<<"$http_sample"
  latency_ms="$(
    /usr/bin/awk -v seconds="$latency_seconds" \
      'BEGIN { if (seconds ~ /^[0-9]+([.][0-9]+)?$/) printf "%.0f", seconds * 1000 }'
  )"
  if [ "$http_code" != "200" ] || [[ ! "$latency_ms" =~ ^[0-9]+$ ]]; then
    printf '%s' \
      'error|guard_internal|jarvis_health_measurement_failed|managed Jarvis health telemetry is invalid|metric=jarvis_health status=unavailable'
    return 0
  fi

  printf 'HEAVY_LOCAL_JARVIS_TELEMETRY cpu_policy=dedicated-agent phase=%s elapsed_seconds=%s launch_pid=%s listener_pid=%s http_status=%s latency_ms=%s identity=stable\n' \
    "$sample_phase" \
    "$SECONDS" \
    "$launch_pid" \
    "$listener_pid" \
    "$http_code" \
    "$latency_ms" >&2
  printf 'ok|%s' "$launch_pid"
}

host_health_reason() {
  local required_cpu_idle=$1
  local require_jarvis_health=$2
  local emit_disk_report="${3:-0}"
  local sample_phase="${4:-unknown}"
  local disk_target="/"
  local disk_free=""
  local cpu_status="healthy"
  local expected_jarvis_pid="${5:-}"
  local resource_result="" group_result=""
  local jarvis_probe="" jarvis_probe_status="" jarvis_probe_value=""
  local jarvis_probe_code="" jarvis_probe_reason="" jarvis_probe_data=""

  if [ "$(uname -s)" != "Darwin" ]; then
    printf 'HEAVY_LOCAL_CPU_TELEMETRY cpu_policy=%s phase=%s status=not_applicable platform=%s\n' \
      "$cpu_policy" \
      "$sample_phase" \
      "$(uname -s)" >&2
    return 0
  fi

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

  # CPU is always measured, including in dedicated-agent mode. Shared/personal
  # Macs retain interactive headroom; a dedicated agent Mac records the same
  # sample as telemetry and lets macOS scheduling govern CPU saturation.
  cpu_idle=$(
    /usr/bin/top -l 1 -n 0 2>/dev/null |
      awk '/CPU usage:/{gsub(/%/, "", $7); print int($7); exit}'
  )
  if [ -z "$cpu_idle" ]; then
    if [ "$cpu_policy" = "dedicated-agent" ]; then
      printf 'HEAVY_LOCAL_CPU_TELEMETRY cpu_policy=%s phase=%s status=unavailable enforcement=telemetry_only metric=cpu_idle_percent\n' \
        "$cpu_policy" \
        "$sample_phase" >&2
      # Missing CPU telemetry cannot silently disable any later non-CPU gate.
      # Continue through disk, remote-access, and Jarvis health checks.
    else
      printf 'HEAVY_LOCAL_CPU_TELEMETRY cpu_policy=%s phase=%s status=unavailable enforcement=threshold metric=cpu_idle_percent threshold=%s unit=percent\n' \
        "$cpu_policy" \
        "$sample_phase" \
        "$required_cpu_idle" >&2
      printf '%s' \
        'guard_internal|cpu_measurement_failed|could not measure CPU headroom|metric=cpu_idle_percent status=unavailable'
      return 0
    fi
  elif [ "$cpu_policy" = "dedicated-agent" ]; then
    printf 'HEAVY_LOCAL_CPU_TELEMETRY cpu_policy=%s phase=%s status=observed enforcement=telemetry_only metric=cpu_idle_percent observed=%s threshold=none unit=percent\n' \
      "$cpu_policy" \
      "$sample_phase" \
      "$cpu_idle" >&2
  else
    if [ "$cpu_idle" -lt "$required_cpu_idle" ]; then
      cpu_status="pressure"
    fi
    printf 'HEAVY_LOCAL_CPU_TELEMETRY cpu_policy=%s phase=%s status=%s enforcement=threshold metric=cpu_idle_percent observed=%s threshold=%s unit=percent\n' \
      "$cpu_policy" \
      "$sample_phase" \
      "$cpu_status" \
      "$cpu_idle" \
      "$required_cpu_idle" >&2
  fi
  if [ -n "$cpu_idle" ] &&
    [ "$cpu_policy" = "standard" ] &&
    [ "$cpu_idle" -lt "$required_cpu_idle" ]; then
    printf 'host_unhealthy|cpu_pressure|CPU idle is %s%% (minimum %s%%)|metric=cpu_idle_percent observed=%s threshold=%s unit=percent' \
      "$cpu_idle" \
      "$required_cpu_idle" \
      "$cpu_idle" \
      "$required_cpu_idle"
    return 0
  fi

  if [ "$cpu_policy" = "dedicated-agent" ]; then
    resource_result="$(dedicated_resource_health_reason "$sample_phase")"
    if [ -n "$resource_result" ]; then
      printf '%s' "$resource_result"
      return 0
    fi
    group_result="$(dedicated_group_health_reason "$sample_phase")"
    if [ -n "$group_result" ]; then
      printf '%s' "$group_result"
      return 0
    fi
  fi

  # Disk pressure is a machine-survival boundary just like CPU and memory.
  # Report below 35 GiB so the owner can reclaim its own generated state before
  # the 25 GiB hard floor becomes an incident. Runtime monitoring enforces only
  # the floor and does not repeat the advisory every fifteen seconds.
  if [[ -d /System/Volumes/Data ]]; then
    disk_target=/System/Volumes/Data
  fi
  disk_free="$(
    df -Pk "$disk_target" 2>/dev/null |
      awk 'NR == 2 && $4 ~ /^[0-9]+$/ { print $4; exit }'
  )"
  if [ -z "$disk_free" ]; then
    printf '%s' \
      'guard_internal|disk_measurement_failed|could not measure disk headroom|metric=disk_available_kib status=unavailable'
    return 0
  fi
  if [ "$disk_free" -lt "$MIN_DISK_FREE_KIB" ]; then
    printf 'host_unhealthy|disk_pressure|disk availability is %s KiB (minimum %s KiB)|metric=disk_available_kib observed=%s threshold=%s unit=KiB' \
      "$disk_free" \
      "$MIN_DISK_FREE_KIB" \
      "$disk_free" \
      "$MIN_DISK_FREE_KIB"
    return 0
  fi
  if [ "$emit_disk_report" = "1" ] && [ "$disk_free" -lt "$DISK_REPORT_BELOW_KIB" ]; then
    printf 'HEAVY_LOCAL_DISK_REPORT status=warning observed_kib=%s report_below_kib=%s hard_floor_kib=%s owner=%s\n' \
      "$disk_free" \
      "$DISK_REPORT_BELOW_KIB" \
      "$MIN_DISK_FREE_KIB" \
      "$telemetry_label" >&2
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
  if [ "$require_jarvis_health" = "1" ]; then
    if [ "$cpu_policy" = "dedicated-agent" ]; then
      jarvis_probe="$(probe_dedicated_jarvis "$expected_jarvis_pid" "$sample_phase")"
      IFS='|' read -r \
        jarvis_probe_status \
        jarvis_probe_value \
        jarvis_probe_code \
        jarvis_probe_reason \
        jarvis_probe_data <<<"$jarvis_probe"
      if [ "$jarvis_probe_status" = "error" ]; then
        printf '%s|%s|%s|%s' \
          "$jarvis_probe_value" \
          "$jarvis_probe_code" \
          "$jarvis_probe_reason" \
          "$jarvis_probe_data"
        return 0
      fi
    elif launchctl print "gui/$(id -u)/ai.jarvis.gateway" >/dev/null 2>&1; then
      if ! curl -fsS --max-time "$HOST_HEALTH_HTTP_TIMEOUT_SECONDS" \
        http://127.0.0.1:18789/healthz >/dev/null; then
        printf '%s' \
          'host_unhealthy|jarvis_unhealthy|managed Jarvis health check failed|metric=jarvis_health observed=unhealthy expected=healthy'
        return 0
      fi
    fi
  fi
}

require_jarvis_health=1
if [ "$policy" = "jarvis-remediation" ]; then
  # Remediation intentionally repairs ai.jarvis.gateway and cannot depend on
  # that listener already being healthy.
  require_jarvis_health=0
elif [ "$policy" = "gateway-lifecycle" ]; then
  # Only the exact Jarvis restart target gets the same self-health exemption.
  # Isolated/default OpenClaw profiles must still preserve healthy main Jarvis.
  case "$label" in
    gateway-restart:ai.jarvis.gateway | gateway-restart-handoff:ai.jarvis.gateway)
      require_jarvis_health=0
      ;;
  esac
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
      "${OPENCLAW_HEAVY_LOCAL_SLOT_REFUSAL_DATA:-}"; then
      continue
    fi
    exit "$acquire_status"
  fi

  preflight_result=$(host_health_reason "$PREFLIGHT_MIN_CPU_IDLE_PERCENT" "$require_jarvis_health" 1 preflight)
  if [ -z "$preflight_result" ] &&
    [ "$cpu_policy" = "dedicated-agent" ] &&
    [ "$require_jarvis_health" = "1" ]; then
    # Pin the exact healthy service identity after all preflight checks pass.
    # The monitor inherits this scalar into its subshell, so a restart or
    # listener takeover becomes a normal two-strike health failure without
    # adding mutable lease metadata or weakening stale recovery.
    baseline_probe="$(probe_dedicated_jarvis "" baseline)"
    IFS='|' read -r \
      baseline_status \
      baseline_value \
      baseline_code \
      baseline_reason \
      baseline_data <<<"$baseline_probe"
    if [ "$baseline_status" = "ok" ]; then
      dedicated_jarvis_baseline_pid="$baseline_value"
    else
      preflight_result="${baseline_value}|${baseline_code}|${baseline_reason}|${baseline_data}"
    fi
  fi
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

if [[ "$policy" == "gateway-lifecycle" ]]; then
  printf 'HEAVY_LOCAL_SLOT_RECEIPT status=granted policy=%s cpu_policy=%s owner=%s\n' \
    "$policy" "$cpu_policy" "$telemetry_label" >&2
  printf 'Heavy-local slot granted to "%s".\n' "$display_label" >&2
else
  printf 'HEAVY_LOCAL_SLOT_RECEIPT status=granted policy=%s cpu_policy=%s owner=%s\n' \
    "$policy" "$cpu_policy" "$telemetry_label"
  printf 'Heavy-local slot granted to "%s".\n' "$display_label"
fi
if [ "$check_only" = true ]; then
  exit 0
fi

task_worktree="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$task_worktree" ] && [ -d "$task_worktree" ]; then
  task_generated_before_kib="$(measure_task_generated_kib "$task_worktree" || true)"
  task_disk_before_kib="$(disk_available_kib_for_path "$task_worktree")"
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
    runtime_result=$(
      host_health_reason \
        "$RUNTIME_MIN_CPU_IDLE_PERCENT" \
        "$require_jarvis_health" \
        0 \
        runtime \
        "$dedicated_jarvis_baseline_pid"
    )
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

# Attribute only generated directories inside the guarded command's starting
# worktree. The receipt never scans source, shared caches, sessions, browser
# state, or another lane. It is advisory because successful task output can be
# intentionally needed until the PR or release handoff is complete.
if [ -n "$task_worktree" ] && [ -n "$task_generated_before_kib" ]; then
  task_generated_after_kib="$(measure_task_generated_kib "$task_worktree" || true)"
  task_disk_after_kib="$(disk_available_kib_for_path "$task_worktree")"
  task_worktree_telemetry="$(
    openclaw_heavy_local_slot_safe_text "$task_worktree" |
      /usr/bin/sed 's/ /%20/g'
  )"
  if [ -z "$task_generated_after_kib" ]; then
    printf 'HEAVY_LOCAL_DISK_RECEIPT status=measurement_unavailable worktree=%s disk_before_kib=%s disk_after_kib=%s threshold_kib=%s\n' \
      "$task_worktree_telemetry" \
      "${task_disk_before_kib:-unknown}" \
      "${task_disk_after_kib:-unknown}" \
      "$TASK_DISK_RECEIPT_THRESHOLD_KIB" >&2
  else
    task_generated_created_kib=$((task_generated_after_kib - task_generated_before_kib))
    task_disk_consumed_kib=0
    if [[ "${task_disk_before_kib:-}" =~ ^[0-9]+$ ]] &&
      [[ "${task_disk_after_kib:-}" =~ ^[0-9]+$ ]] &&
      [ "$task_disk_before_kib" -gt "$task_disk_after_kib" ]; then
      task_disk_consumed_kib=$((task_disk_before_kib - task_disk_after_kib))
    fi
    if [ "$task_generated_created_kib" -ge "$TASK_DISK_RECEIPT_THRESHOLD_KIB" ] ||
      [ "$task_disk_consumed_kib" -ge "$TASK_DISK_RECEIPT_THRESHOLD_KIB" ]; then
      printf 'HEAVY_LOCAL_DISK_RECEIPT status=owner_cleanup_required worktree=%s generated_before_kib=%s generated_after_kib=%s created_kib=%s disk_before_kib=%s disk_after_kib=%s disk_consumed_kib=%s threshold_kib=%s\n' \
        "$task_worktree_telemetry" \
        "$task_generated_before_kib" \
        "$task_generated_after_kib" \
        "$task_generated_created_kib" \
        "${task_disk_before_kib:-unknown}" \
        "${task_disk_after_kib:-unknown}" \
        "$task_disk_consumed_kib" \
        "$TASK_DISK_RECEIPT_THRESHOLD_KIB" >&2
      printf 'Owner action: preserve needed outputs; otherwise report this exact worktree with cleanup-build-artifacts.sh and retire it with gc-worktrees.sh only after its branch is recoverable.\n' >&2
    fi
  fi
elif [ -n "$task_worktree" ]; then
  task_worktree_telemetry="$(
    openclaw_heavy_local_slot_safe_text "$task_worktree" |
      /usr/bin/sed 's/ /%20/g'
  )"
  printf 'HEAVY_LOCAL_DISK_RECEIPT status=measurement_unavailable worktree=%s disk_before_kib=%s disk_after_kib=unknown threshold_kib=%s\n' \
    "$task_worktree_telemetry" \
    "${task_disk_before_kib:-unknown}" \
    "$TASK_DISK_RECEIPT_THRESHOLD_KIB" >&2
fi

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
