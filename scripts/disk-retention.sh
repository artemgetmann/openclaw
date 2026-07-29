#!/usr/bin/env bash
set -euo pipefail

# Coordinate OpenClaw's existing retention owners behind one report-first
# entrypoint. This script deliberately excludes runtime-instance cleanup:
# legacy instances can contain nested auth/browser/memory state without durable
# ownership metadata, so low disk pressure must never widen deletion authority.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLEANUP_SCRIPT="${OPENCLAW_DISK_RETENTION_CLEANUP_SCRIPT:-$ROOT_DIR/scripts/cleanup-build-artifacts.sh}"
GC_SCRIPT="${OPENCLAW_DISK_RETENTION_GC_SCRIPT:-$ROOT_DIR/scripts/gc-worktrees.sh}"
DISK_TARGET="${OPENCLAW_DISK_RETENTION_TARGET:-/System/Volumes/Data}"

WARNING_KIB="${OPENCLAW_DISK_RETENTION_WARNING_KIB:-$((80 * 1024 * 1024))}"
APPLY_KIB="${OPENCLAW_DISK_RETENTION_APPLY_KIB:-$((50 * 1024 * 1024))}"
URGENT_KIB="${OPENCLAW_DISK_RETENTION_URGENT_KIB:-$((30 * 1024 * 1024))}"

AUTO=0
BASE_BRANCH="main"
INCLUDE_DETACHED=0

usage() {
  cat <<'EOF'
Usage: scripts/disk-retention.sh [options]

Reports disk pressure and OpenClaw retention candidates by default.

Options:
  --auto                  Apply only age-gated rebuildable artifact cleanup,
                          then safely retire eligible worktrees.
  --base-branch <branch>  Base branch used by whole-worktree GC. Default: main.
  --include-detached      Allow whole-worktree GC to consider detached lanes.
  --help                  Show this help.

Pressure policy:
  warning below 80 GiB free
  automatic rebuildable cleanup below 50 GiB free
  urgent nonzero result below 30 GiB free after cleanup

Runtime instances, Codex sessions/history/browser state, and ambiguous
authenticated state are never automatic targets.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 2
}

is_positive_integer() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

available_kib() {
  local existing_path="$DISK_TARGET"
  local free_kib=""

  if [[ -n "${OPENCLAW_DISK_RETENTION_AVAILABLE_KIB_OVERRIDE:-}" ]]; then
    printf '%s\n' "$OPENCLAW_DISK_RETENTION_AVAILABLE_KIB_OVERRIDE"
    return 0
  fi

  # A configured target may not exist in a Linux fixture or alternate volume.
  # Resolve upward without creating anything so report mode remains read-only.
  while [[ ! -e "$existing_path" && "$existing_path" != "/" ]]; do
    existing_path="$(dirname "$existing_path")"
  done
  [[ -e "$existing_path" ]] || return 1

  free_kib="$(df -Pk "$existing_path" 2>/dev/null | awk 'NR == 2 { print $4 }')"
  [[ "$free_kib" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$free_kib"
}

pressure_level() {
  local free_kib="$1"
  if ((free_kib < URGENT_KIB)); then
    printf '%s\n' urgent
  elif ((free_kib < APPLY_KIB)); then
    printf '%s\n' pressure
  elif ((free_kib < WARNING_KIB)); then
    printf '%s\n' warning
  else
    printf '%s\n' healthy
  fi
}

run_artifact_retention() {
  local apply="$1"
  local -a args=(--worktrees --deps --build-cache --json)

  if [[ "$apply" == "1" ]]; then
    args+=(--apply)
  fi
  /bin/bash "$CLEANUP_SCRIPT" "${args[@]}"
}

run_worktree_gc() {
  local apply="$1"
  local -a args=(--base-branch "$BASE_BRANCH")

  if [[ "$apply" == "1" ]]; then
    args=(--auto "${args[@]}")
  fi
  if [[ "$INCLUDE_DETACHED" == "1" ]]; then
    args+=(--include-detached)
  fi
  (
    cd "$ROOT_DIR"
    /bin/bash "$GC_SCRIPT" "${args[@]}"
  )
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto)
      AUTO=1
      shift
      ;;
    --base-branch)
      [[ $# -ge 2 ]] || die "--base-branch requires a value"
      BASE_BRANCH="$2"
      shift 2
      ;;
    --include-detached)
      INCLUDE_DETACHED=1
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

for threshold in "$WARNING_KIB" "$APPLY_KIB" "$URGENT_KIB"; do
  is_positive_integer "$threshold" || die "disk thresholds must be positive integer KiB values"
done
if ! ((URGENT_KIB < APPLY_KIB && APPLY_KIB < WARNING_KIB)); then
  die "disk thresholds must satisfy urgent < apply < warning"
fi
[[ -x "$CLEANUP_SCRIPT" || -f "$CLEANUP_SCRIPT" ]] || die "cleanup script not found: $CLEANUP_SCRIPT"
[[ -x "$GC_SCRIPT" || -f "$GC_SCRIPT" ]] || die "worktree GC script not found: $GC_SCRIPT"

free_before_kib="$(available_kib)" || die "could not resolve free space for $DISK_TARGET"
level_before="$(pressure_level "$free_before_kib")"
artifact_apply=0
gc_apply=0

# Automatic artifact deletion is pressure-triggered and remains constrained by
# the owning cleaner's age, dirty, process, open-file, marker, and release-state
# gates. Whole-worktree GC is independent of pressure because completed lanes
# should be retired before their generated output becomes an incident.
if [[ "$AUTO" == "1" ]]; then
  gc_apply=1
  if ((free_before_kib < APPLY_KIB)); then
    artifact_apply=1
  fi
fi

printf 'mode=%s\n' "$([[ "$AUTO" == "1" ]] && printf auto || printf report)"
printf 'disk_target=%s\n' "$DISK_TARGET"
printf 'free_before_kib=%s\n' "$free_before_kib"
printf 'pressure_before=%s\n' "$level_before"
printf 'artifact_action=%s\n' "$([[ "$artifact_apply" == "1" ]] && printf apply || printf report)"
printf 'worktree_gc_action=%s\n' "$([[ "$gc_apply" == "1" ]] && printf apply || printf report)"

run_artifact_retention "$artifact_apply"
run_worktree_gc "$gc_apply"

free_after_kib="$(available_kib)" || die "could not recheck free space for $DISK_TARGET"
level_after="$(pressure_level "$free_after_kib")"
printf 'free_after_kib=%s\n' "$free_after_kib"
printf 'pressure_after=%s\n' "$level_after"

if [[ "$AUTO" == "1" && "$level_after" == "urgent" ]]; then
  printf 'status=urgent\n'
  printf 'operator_action=stop heavy builds and review protected candidates\n'
  exit 3
fi

printf 'status=ok\n'
