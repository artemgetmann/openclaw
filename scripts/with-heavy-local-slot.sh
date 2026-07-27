#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/with-heavy-local-slot.sh --label <owner> --check
  scripts/with-heavy-local-slot.sh --label <owner> -- <command> [args...]

Serializes CPU- or memory-intensive local work across all worktrees in this
clone. On macOS it also refuses to start when memory, CPU headroom, Tailscale,
or the managed Jarvis gateway are unhealthy.
EOF
  exit 2
}

label=''
check_only=false

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
if [ "$check_only" = false ] && [ "$#" -eq 0 ]; then
  usage
fi
if [ "$check_only" = true ] && [ "$#" -ne 0 ]; then
  usage
fi

# The Git common directory is shared by every worktree belonging to this clone,
# so one atomic directory lock protects the whole local fleet rather than only
# the current checkout.
git_common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
  printf 'Refusing heavy work: not inside a Git checkout.\n' >&2
  exit 1
}
lock_dir="$git_common_dir/openclaw-heavy-local.lock"
owner_token="$$-$(date +%s)-${RANDOM:-0}"
child_pid=''

remove_owned_lock() {
  # A late trap from an old owner must never delete a newer owner's lock.
  if [ -f "$lock_dir/token" ] && [ "$(cat "$lock_dir/token" 2>/dev/null || true)" = "$owner_token" ]; then
    rm -f \
      "$lock_dir/pid" \
      "$lock_dir/child_pid" \
      "$lock_dir/label" \
      "$lock_dir/token" \
      "$lock_dir/started_at"
    rmdir "$lock_dir" 2>/dev/null || true
  fi
}

signal_descendants() {
  local parent_pid=$1
  local signal_name=$2
  local descendant_pid

  # Walk children before parents so test-worker pools cannot immediately spawn
  # replacements after their coordinator receives the signal.
  while IFS= read -r descendant_pid; do
    [ -n "$descendant_pid" ] || continue
    signal_descendants "$descendant_pid" "$signal_name"
  done < <(pgrep -P "$parent_pid" 2>/dev/null || true)

  kill "-$signal_name" "$parent_pid" 2>/dev/null || true
}

stop_guarded_child() {
  [ -n "$child_pid" ] || return 0
  kill -0 "$child_pid" 2>/dev/null || return 0

  signal_descendants "$child_pid" TERM
  local attempt=0
  while kill -0 "$child_pid" 2>/dev/null && [ "$attempt" -lt 10 ]; do
    sleep 0.5
    attempt=$((attempt + 1))
  done

  # A wedged compiler or worker must not keep starving the remote desktop after
  # its graceful shutdown window. Scope KILL to the exact guarded tree.
  if kill -0 "$child_pid" 2>/dev/null; then
    signal_descendants "$child_pid" KILL
  fi
}

handle_interrupt() {
  local status=$1
  stop_guarded_child
  exit "$status"
}

clear_stale_lock() {
  [ -d "$lock_dir" ] || return 0

  local existing_pid existing_token
  existing_pid=$(cat "$lock_dir/pid" 2>/dev/null || true)
  existing_token=$(cat "$lock_dir/token" 2>/dev/null || true)

  # A live PID owns the lease. Missing or non-numeric metadata is treated as
  # unsafe instead of guessed away because two heavy jobs are worse than a
  # briefly stuck queue.
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
    return 1
  fi
  if [ -z "$existing_token" ]; then
    return 1
  fi

  # Re-read the token before cleanup so a concurrent owner cannot be removed
  # after replacing a stale lease.
  [ "$(cat "$lock_dir/token" 2>/dev/null || true)" = "$existing_token" ] || return 1
  rm -f \
    "$lock_dir/pid" \
    "$lock_dir/child_pid" \
    "$lock_dir/label" \
    "$lock_dir/token" \
    "$lock_dir/started_at"
  rmdir "$lock_dir" 2>/dev/null
}

if ! mkdir "$lock_dir" 2>/dev/null; then
  if clear_stale_lock && mkdir "$lock_dir" 2>/dev/null; then
    :
  else
    current_label=$(cat "$lock_dir/label" 2>/dev/null || printf 'unknown')
    current_pid=$(cat "$lock_dir/pid" 2>/dev/null || printf 'unknown')
    printf 'Refusing heavy work: slot held by "%s" (PID %s).\n' "$current_label" "$current_pid" >&2
    exit 75
  fi
fi

printf '%s\n' "$owner_token" >"$lock_dir/token"
printf '%s\n' "$$" >"$lock_dir/pid"
printf '%s\n' "$label" >"$lock_dir/label"
date -u '+%Y-%m-%dT%H:%M:%SZ' >"$lock_dir/started_at"
trap remove_owned_lock EXIT
trap 'handle_interrupt 130' INT
trap 'handle_interrupt 143' TERM HUP

deny() {
  printf 'Refusing heavy work: %s\n' "$1" >&2
  exit 75
}

host_health_reason() {
  local required_cpu_idle=$1

  [ "$(uname -s)" = "Darwin" ] || return 0

  min_memory_free=${OPENCLAW_FLEET_MIN_MEMORY_FREE_PERCENT:-25}

  # memory_pressure already accounts for compressed memory. Raw "free pages"
  # alone would falsely reject healthy Macs that are using their cache.
  memory_free=$(
    /usr/bin/memory_pressure 2>/dev/null |
      awk -F': ' '/System-wide memory free percentage/{gsub(/%/, "", $2); print int($2); exit}'
  )
  if [ -z "$memory_free" ]; then
    printf 'could not measure memory pressure'
    return 0
  fi
  if [ "$memory_free" -lt "$min_memory_free" ]; then
    printf 'memory headroom is %s%% (minimum %s%%)' "$memory_free" "$min_memory_free"
    return 0
  fi

  # Heavy jobs are admitted only while the interactive desktop still has
  # substantial CPU headroom. This protects WindowServer, VNC, and Tailscale.
  cpu_idle=$(
    /usr/bin/top -l 1 -n 0 2>/dev/null |
      awk '/CPU usage:/{gsub(/%/, "", $7); print int($7); exit}'
  )
  if [ -z "$cpu_idle" ]; then
    printf 'could not measure CPU headroom'
    return 0
  fi
  if [ "$cpu_idle" -lt "$required_cpu_idle" ]; then
    printf 'CPU idle is %s%% (minimum %s%%)' "$cpu_idle" "$required_cpu_idle"
    return 0
  fi

  # If Tailscale is configured on this Mac, disconnected means the remote
  # operator may already be losing access. Local work must wait.
  tailscale_line=$(scutil --nc list 2>/dev/null | grep -i '"Tailscale"' | head -n 1 || true)
  if [ -n "$tailscale_line" ] && ! printf '%s\n' "$tailscale_line" | grep -q '(Connected)'; then
    printf 'Tailscale is configured but not connected'
    return 0
  fi

  # Only require Jarvis health when this user actually owns the managed
  # LaunchAgent. Development Macs without that service remain supported.
  if launchctl print "gui/$(id -u)/ai.jarvis.gateway" >/dev/null 2>&1; then
    if ! curl -fsS --max-time 3 http://127.0.0.1:18789/healthz >/dev/null; then
      printf 'managed Jarvis health check failed'
      return 0
    fi
  fi
}

min_cpu_idle=${OPENCLAW_FLEET_MIN_CPU_IDLE_PERCENT:-35}
preflight_reason=$(host_health_reason "$min_cpu_idle")
if [ -n "$preflight_reason" ]; then
  deny "$preflight_reason"
fi

printf 'Heavy-local slot granted to "%s".\n' "$label"
if [ "$check_only" = true ]; then
  exit 0
fi

# Background scheduling reduces competition with the interactive desktop.
# The lock remains held by this wrapper until the child exits.
if [ "$(uname -s)" = "Darwin" ] && command -v taskpolicy >/dev/null 2>&1; then
  taskpolicy -b nice -n 15 "$@" &
else
  nice -n 15 "$@" &
fi
child_pid=$!
printf '%s\n' "$child_pid" >"$lock_dir/child_pid"

runtime_min_cpu_idle=${OPENCLAW_FLEET_RUNTIME_MIN_CPU_IDLE_PERCENT:-20}
monitor_interval=${OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS:-15}
unhealthy_strikes=0
terminated_for_health=false

while kill -0 "$child_pid" 2>/dev/null; do
  runtime_reason=$(host_health_reason "$runtime_min_cpu_idle")
  if [ -n "$runtime_reason" ]; then
    unhealthy_strikes=$((unhealthy_strikes + 1))
  else
    unhealthy_strikes=0
  fi

  # Two consecutive unhealthy samples ignore a transient spike while still
  # stopping a runaway job before a multi-minute VNC/Jarvis starvation event.
  if [ "$unhealthy_strikes" -ge 2 ] && kill -0 "$child_pid" 2>/dev/null; then
    printf 'Stopping guarded work after repeated host-health failures: %s\n' "$runtime_reason" >&2
    terminated_for_health=true
    stop_guarded_child
    break
  fi
  sleep "$monitor_interval"
done

set +e
wait "$child_pid"
child_status=$?
set -e

if [ "$terminated_for_health" = true ]; then
  exit 75
fi
exit "$child_status"
