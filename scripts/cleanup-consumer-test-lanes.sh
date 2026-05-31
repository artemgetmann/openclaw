#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/cleanup-consumer-test-lanes.sh --preserve-main [--dry-run]

Safely disables stale consumer/test macOS lanes while preserving the main Jarvis
runtime. Matching LaunchAgent plists are booted out and moved into a timestamped
quarantine directory instead of being deleted.

Options:
  --preserve-main  Required acknowledgement that sacred main runtime is preserved.
  --dry-run        Print actions without booting out, moving files, or killing processes.
  --help           Show this help.
USAGE
}

dry_run=0
preserve_main=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      ;;
    --preserve-main)
      preserve_main=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$preserve_main" -ne 1 ]]; then
  echo "error: refusing to run without --preserve-main" >&2
  usage >&2
  exit 2
fi

readonly uid="$(id -u)"
readonly launch_agents_dir="${HOME}/Library/LaunchAgents"
readonly quarantine_dir="${launch_agents_dir}/openclaw-test-disabled-$(date +%Y%m%d-%H%M%S)"

actions=0
bootouts=0
quarantined=0
killed=0
skipped=0

log() {
  printf '%s\n' "$*"
}

run_action() {
  actions=$((actions + 1))
  if [[ "$dry_run" -eq 1 ]]; then
    log "DRY-RUN: $*"
  else
    log "RUN: $*"
    "$@"
  fi
}

is_preserved_label() {
  case "$1" in
    ai.openclaw.gateway|\
    ai.openclaw.gateway-watchdog|\
    ai.openclaw.consumer.mac)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_target_label() {
  local label="$1"

  if is_preserved_label "$label"; then
    return 1
  fi

  case "$label" in
    ai.openclaw.consumer.mac.debug*|\
    ai.openclaw.consumer.mac.ui-smoke*|\
    ai.openclaw.consumer.*.gateway*|\
    ai.openclaw.consumer.gateway*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

ensure_quarantine_dir() {
  if [[ "$dry_run" -eq 1 ]]; then
    log "DRY-RUN: mkdir -p ${quarantine_dir}"
  else
    mkdir -p "$quarantine_dir"
  fi
}

plist_label() {
  local plist="$1"

  /usr/libexec/PlistBuddy -c 'Print :Label' "$plist" 2>/dev/null || \
    basename "$plist" .plist
}

cleanup_launch_agents() {
  local plist label destination
  local found=0

  if [[ ! -d "$launch_agents_dir" ]]; then
    log "LaunchAgents directory not found: ${launch_agents_dir}"
    return
  fi

  while IFS= read -r -d '' plist; do
    label="$(plist_label "$plist")"

    if is_preserved_label "$label"; then
      skipped=$((skipped + 1))
      log "SKIP preserved LaunchAgent: ${label} (${plist})"
      continue
    fi

    if ! is_target_label "$label"; then
      continue
    fi

    found=1
    ensure_quarantine_dir
    destination="${quarantine_dir}/$(basename "$plist")"

    log "Target LaunchAgent: ${label} (${plist})"
    run_action launchctl bootout "gui/${uid}/${label}" || true
    bootouts=$((bootouts + 1))

    if [[ "$dry_run" -eq 1 ]]; then
      log "DRY-RUN: mv ${plist} ${destination}"
    else
      mv "$plist" "$destination"
    fi
    actions=$((actions + 1))
    quarantined=$((quarantined + 1))
  done < <(find "$launch_agents_dir" -maxdepth 1 -type f -name 'ai.openclaw.consumer*.plist' -print0)

  if [[ "$found" -eq 0 ]]; then
    log "No matching stale consumer/test LaunchAgents found."
  fi
}

is_preserved_process() {
  local command="$1"

  case "$command" in
    */Applications/Jarvis.app/*|\
    *'/Applications/Jarvis.app'*|\
    *'ai.openclaw.gateway'*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_target_process() {
  local command="$1"

  if is_preserved_process "$command"; then
    return 1
  fi

  case "$command" in
    *'/Programming_Projects/openclaw/.worktrees/'*'/dist-ui-smoke/'*'consumer'*|\
    *'/Programming_Projects/openclaw/.worktrees/'*'consumer'*'/dist-ui-smoke/'*|\
    *'/Programming_Projects/openclaw/.worktrees/'*'/debug/'*'consumer'*|\
    *'/Programming_Projects/openclaw/.worktrees/'*'consumer'*'/debug/'*|\
    *'/dist-ui-smoke/'*'consumer'*|\
    *'/debug/'*'consumer'*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

cleanup_processes() {
  local pid command
  local found=0

  while IFS= read -r line; do
    pid="${line%% *}"
    command="${line#* }"

    if [[ -z "$pid" || "$pid" == "$command" ]]; then
      continue
    fi

    if [[ "$pid" -eq "$$" || "$pid" -eq "$PPID" ]]; then
      continue
    fi

    if ! is_target_process "$command"; then
      continue
    fi

    found=1
    log "Target process: pid=${pid} command=${command}"
    run_action kill "$pid" || true
    killed=$((killed + 1))
  done < <(ps -axo pid=,command=)

  if [[ "$found" -eq 0 ]]; then
    log "No matching stale consumer/test processes found."
  fi
}

log "OpenClaw consumer/test lane cleanup"
log "Mode: $([[ "$dry_run" -eq 1 ]] && echo dry-run || echo live)"
log "Preserved LaunchAgents: ai.openclaw.gateway.plist, ai.openclaw.gateway-watchdog.plist, ai.openclaw.consumer.mac.plist"
log "Preserved app: /Applications/Jarvis.app"

cleanup_launch_agents
cleanup_processes

log "Summary: actions=${actions} bootouts=${bootouts} quarantined=${quarantined} killed=${killed} skipped=${skipped}"
if [[ "$dry_run" -ne 1 && "$quarantined" -gt 0 ]]; then
  log "Quarantine directory: ${quarantine_dir}"
fi
