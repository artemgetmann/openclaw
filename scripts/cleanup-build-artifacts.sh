#!/usr/bin/env bash
set -euo pipefail

# Report or remove rebuildable OpenClaw artifacts.
#
# Safety model:
# - dry-run is the default; --apply is required to delete
# - default behavior stays worktree artifact cleanup for backwards compatibility
# - every destructive path passes age, protected-path, process, and lsof checks
# - runtime state cleanup is intentionally conservative: it only removes generated
#   smoke/proof/test/isolated instances and old generated logs from inactive dirs

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/build-artifacts.sh"

APPLY=0
INCLUDE_DEPS=0
INCLUDE_CURRENT=0
INCLUDE_RUNTIME_CACHE=0
JSON=0
WORKTREES=0
BUILD_CACHE=0
RUNTIME_INSTANCES=0
EXPLICIT_MODE=0

OLDER_THAN_DAYS="${OPENCLAW_CLEANUP_OLDER_THAN_DAYS:-7}"
DEPS_OLDER_THAN_DAYS="${OPENCLAW_CLEANUP_DEPS_OLDER_THAN_DAYS:-21}"
BUILD_RUNS_OLDER_THAN_HOURS="${OPENCLAW_CLEANUP_BUILD_RUNS_OLDER_THAN_HOURS:-24}"
BUILD_TEMP_OLDER_THAN_DAYS="${OPENCLAW_CLEANUP_BUILD_TEMP_OLDER_THAN_DAYS:-3}"
RUNTIME_CACHE_OLDER_THAN_DAYS="${OPENCLAW_CLEANUP_RUNTIME_CACHE_OLDER_THAN_DAYS:-14}"
RUNTIME_INSTANCE_OLDER_THAN_DAYS="${OPENCLAW_CLEANUP_RUNTIME_INSTANCE_OLDER_THAN_DAYS:-7}"
RUNTIME_LOGS_OLDER_THAN_DAYS="${OPENCLAW_CLEANUP_RUNTIME_LOGS_OLDER_THAN_DAYS:-3}"

WORKTREES_ROOT="${OPENCLAW_WORKTREES_ROOT:-}"
BUILD_ARTIFACT_ROOT="$(openclaw_build_artifact_root)"
RUNTIME_INSTANCES_ROOT="${OPENCLAW_RUNTIME_INSTANCES_ROOT:-$HOME/Library/Application Support/OpenClaw/instances}"
CURRENT_ROOT="$(cd "$ROOT_DIR" && pwd -P)"
NOW_EPOCH="$(date +%s)"
TOTAL_KIB=0
CANDIDATE_COUNT=0
DELETED_COUNT=0
DISK_BEFORE_KIB=""
DISK_AFTER_KIB=""

usage() {
  cat <<'EOF'
Usage: scripts/cleanup-build-artifacts.sh [options]

Reports rebuildable OpenClaw worktree artifacts by default.

Modes:
  --worktrees             Scan sibling worktree artifacts. Default when no mode is set.
  --build-cache           Scan ~/Library/Caches/OpenClaw/build-artifacts.
  --runtime-instances     Scan ~/Library/Application Support/OpenClaw/instances.

Options:
  --apply                 Delete candidates that pass safety checks.
  --deps                  Include old worktree node_modules directories.
  --include-current       Allow worktree cleanup in the current checkout.
  --include-runtime-cache Include runtime-cache pruning under the build cache.
  --older-than-days <n>   Worktree artifact age threshold. Default: 7.
  --deps-older-than-days <n>
                          node_modules age threshold. Default: 21.
  --worktrees-root <dir>  Override the worktree root. Default: canonical .worktrees.
  --json                  Emit machine-readable JSON lines.
  --help                  Show this help.

Build-cache retention:
  runs/* older than 24h, tmp/temp/smoke entries older than 3d.
  runtime-cache is reported by default. With --include-runtime-cache, old entries
  older than 14d are pruned while keeping the newest entry per parent group.

Runtime-instance retention:
  all instance dirs are reported with risk labels. Apply only deletes generated
  smoke/proof/test/isolated dirs older than 7d and generated logs older than 3d
  when inactive. Protected app/user state is never deleted by this command.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

human_kib() {
  openclaw_build_human_kib "${1:-0}"
}

path_mtime_epoch() {
  local target_path="$1"
  if stat -f %m "$target_path" >/dev/null 2>&1; then
    stat -f %m "$target_path"
  else
    stat -c %Y "$target_path"
  fi
}

path_age_days() {
  local target_path="$1"
  local mtime
  mtime="$(path_mtime_epoch "$target_path")"
  echo $(((NOW_EPOCH - mtime) / 86400))
}

path_age_hours() {
  local target_path="$1"
  local mtime
  mtime="$(path_mtime_epoch "$target_path")"
  echo $(((NOW_EPOCH - mtime) / 3600))
}

path_size_kib() {
  local target_path="$1"
  du -sk "$target_path" 2>/dev/null | awk '{print $1}'
}

path_size_kib_or_zero() {
  local size_kib
  size_kib="$(path_size_kib "$1" || true)"
  printf '%s\n' "${size_kib:-0}"
}

disk_available_kib() {
  local target_path="$1"
  local existing_path="$target_path"

  while [[ ! -e "$existing_path" && "$existing_path" != "/" ]]; do
    existing_path="$(dirname "$existing_path")"
  done
  openclaw_build_disk_available_kib "$existing_path"
}

print_record() {
  local action="$1"
  local kind="$2"
  local size_kib="$3"
  local age_days="$4"
  local scope="$5"
  local target_path="$6"
  local reason="$7"
  local risk="${8:-}"

  if [[ "$JSON" == "1" ]]; then
    printf '{"action":"%s","kind":"%s","size_kib":%s,"age_days":%s,"scope":"%s","path":"%s","reason":"%s","risk":"%s"}\n' \
      "$(json_escape "$action")" \
      "$(json_escape "$kind")" \
      "${size_kib:-0}" \
      "${age_days:-0}" \
      "$(json_escape "$scope")" \
      "$(json_escape "$target_path")" \
      "$(json_escape "$reason")" \
      "$(json_escape "$risk")"
  else
    printf '%-8s %-22s %8s %4sd %-14s %s\n' \
      "$action" "$kind" "$(human_kib "${size_kib:-0}")" "${age_days:-0}" "$scope" "$target_path"
    if [[ -n "$reason" ]]; then
      printf '  reason: %s\n' "$reason"
    fi
    if [[ -n "$risk" ]]; then
      printf '  risk: %s\n' "$risk"
    fi
  fi
}

record_candidate_total() {
  local size_kib="$1"
  TOTAL_KIB=$((TOTAL_KIB + size_kib))
  CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
}

path_has_process_ref() {
  local target_path="$1"
  ps axww -o args= | grep -F "$target_path" | grep -v 'grep -F' >/dev/null 2>&1
}

path_has_open_files() {
  local target_path="$1"
  local lsof_output
  if ! command -v lsof >/dev/null 2>&1; then
    return 1
  fi
  lsof_output="$(lsof +D "$target_path" 2>/dev/null || true)"
  [[ -n "$lsof_output" ]]
}

path_is_active() {
  local target_path="$1"
  path_has_process_ref "$target_path" || path_has_open_files "$target_path"
}

delete_or_report_candidate() {
  local kind="$1"
  local scope="$2"
  local target_path="$3"
  local age_days="$4"
  local size_kib="$5"

  record_candidate_total "$size_kib"

  if [[ "$APPLY" == "1" ]]; then
    rm -rf "$target_path"
    DELETED_COUNT=$((DELETED_COUNT + 1))
    print_record "deleted" "$kind" "$size_kib" "$age_days" "$scope" "$target_path" "" "rebuildable-generated"
  else
    print_record "would_rm" "$kind" "$size_kib" "$age_days" "$scope" "$target_path" "" "rebuildable-generated"
  fi
}

consider_generated_path() {
  local kind="$1"
  local scope="$2"
  local target_path="$3"
  local min_age_days="$4"
  local age_days
  local size_kib

  [[ -e "$target_path" ]] || return 0
  age_days="$(path_age_days "$target_path")"
  size_kib="$(path_size_kib_or_zero "$target_path")"

  if (( age_days < min_age_days )); then
    print_record "skip" "$kind" "$size_kib" "$age_days" "$scope" "$target_path" "too-new" "rebuildable-generated"
    return 0
  fi
  if path_has_process_ref "$target_path"; then
    print_record "skip" "$kind" "$size_kib" "$age_days" "$scope" "$target_path" "active-process" "rebuildable-generated"
    return 0
  fi
  if path_has_open_files "$target_path"; then
    print_record "skip" "$kind" "$size_kib" "$age_days" "$scope" "$target_path" "open-files" "rebuildable-generated"
    return 0
  fi

  delete_or_report_candidate "$kind" "$scope" "$target_path" "$age_days" "$size_kib"
}

canonical_checkout_root() {
  local common_dir
  common_dir="$(git -C "$ROOT_DIR" rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -n "$common_dir" ]]; then
    if [[ "$common_dir" != /* ]]; then
      common_dir="$ROOT_DIR/$common_dir"
    fi
    common_dir="$(cd "$common_dir" && pwd -P)"
    if [[ "$(basename "$common_dir")" == ".git" ]]; then
      dirname "$common_dir"
      return 0
    fi
  fi
  printf '%s\n' "$ROOT_DIR"
}

default_worktrees_root() {
  local checkout_root
  checkout_root="$(canonical_checkout_root)"
  printf '%s/.worktrees\n' "$checkout_root"
}

worktree_is_dirty() {
  local worktree="$1"
  [[ -n "$(git -C "$worktree" status --short --untracked-files=no 2>/dev/null || true)" ]]
}

consider_worktree_candidate() {
  local worktree="$1"
  local target_path="$2"
  local kind="$3"
  local min_age_days="$4"
  local age_days=0
  local size_kib=0

  [[ -d "$target_path" ]] || return 0

  age_days="$(path_age_days "$target_path")"
  size_kib="$(path_size_kib_or_zero "$target_path")"

  if (( age_days < min_age_days )); then
    return 0
  fi
  if [[ "$INCLUDE_CURRENT" != "1" && "$(cd "$worktree" && pwd -P)" == "$CURRENT_ROOT" ]]; then
    print_record "skip" "$kind" "$size_kib" "$age_days" "$worktree" "$target_path" "protected" "current-checkout"
    return 0
  fi
  if worktree_is_dirty "$worktree"; then
    print_record "skip" "$kind" "$size_kib" "$age_days" "$worktree" "$target_path" "dirty" "worktree-generated"
    return 0
  fi
  if path_has_process_ref "$target_path"; then
    print_record "skip" "$kind" "$size_kib" "$age_days" "$worktree" "$target_path" "active-process" "worktree-generated"
    return 0
  fi
  if path_has_open_files "$target_path"; then
    print_record "skip" "$kind" "$size_kib" "$age_days" "$worktree" "$target_path" "open-files" "worktree-generated"
    return 0
  fi

  delete_or_report_candidate "$kind" "$worktree" "$target_path" "$age_days" "$size_kib"
}

scan_worktree() {
  local worktree="$1"
  local generated_names=(
    "dist"
    ".build"
    ".build-ui-smoke"
    "dist-ui-smoke"
    "DerivedData"
    ".swiftpm"
    ".turbo"
    "coverage"
  )
  local name=""

  [[ -d "$worktree" ]] || return 0
  git -C "$worktree" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0

  for name in "${generated_names[@]}"; do
    consider_worktree_candidate "$worktree" "$worktree/$name" "$name" "$OLDER_THAN_DAYS"
  done

  if [[ "$INCLUDE_DEPS" == "1" ]]; then
    consider_worktree_candidate "$worktree" "$worktree/node_modules" "node_modules" "$DEPS_OLDER_THAN_DAYS"
  fi
}

scan_worktrees() {
  [[ -d "$WORKTREES_ROOT" ]] || return 0
  while IFS= read -r -d '' worktree; do
    scan_worktree "$worktree"
  done < <(find "$WORKTREES_ROOT" -mindepth 1 -maxdepth 1 -type d -print0)
}

scan_build_cache_standard_bucket() {
  local bucket="$1"
  local min_age_days="$2"
  local artifact_dir

  [[ -d "$BUILD_ARTIFACT_ROOT/$bucket" ]] || return 0
  while IFS= read -r -d '' artifact_dir; do
    consider_generated_path "build-cache-$bucket" "build-cache" "$artifact_dir" "$min_age_days"
  done < <(find "$BUILD_ARTIFACT_ROOT/$bucket" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
}

scan_build_cache_runs() {
  local run_dir
  local age_hours
  local age_days
  local size_kib

  [[ -d "$BUILD_ARTIFACT_ROOT/runs" ]] || return 0
  while IFS= read -r -d '' run_dir; do
    age_hours="$(path_age_hours "$run_dir")"
    age_days="$(path_age_days "$run_dir")"
    size_kib="$(path_size_kib_or_zero "$run_dir")"
    if (( age_hours < BUILD_RUNS_OLDER_THAN_HOURS )); then
      print_record "skip" "build-cache-runs" "$size_kib" "$age_days" "build-cache" "$run_dir" "too-new" "rebuildable-generated"
      continue
    fi
    if path_has_process_ref "$run_dir"; then
      print_record "skip" "build-cache-runs" "$size_kib" "$age_days" "build-cache" "$run_dir" "active-process" "rebuildable-generated"
      continue
    fi
    if path_has_open_files "$run_dir"; then
      print_record "skip" "build-cache-runs" "$size_kib" "$age_days" "build-cache" "$run_dir" "open-files" "rebuildable-generated"
      continue
    fi
    delete_or_report_candidate "build-cache-runs" "build-cache" "$run_dir" "$age_days" "$size_kib"
  done < <(find "$BUILD_ARTIFACT_ROOT/runs" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
}

runtime_cache_group_key() {
  local target_path="$1"
  dirname "$target_path"
}

runtime_cache_is_newest_in_group() {
  local target_path="$1"
  local group_dir
  local candidate
  local candidate_mtime
  local newest_path=""
  local newest_mtime=0

  group_dir="$(runtime_cache_group_key "$target_path")"
  while IFS= read -r -d '' candidate; do
    candidate_mtime="$(path_mtime_epoch "$candidate")"
    if (( candidate_mtime > newest_mtime )); then
      newest_mtime="$candidate_mtime"
      newest_path="$candidate"
    fi
  done < <(find "$group_dir" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
  [[ "$newest_path" == "$target_path" ]]
}

scan_runtime_cache() {
  local runtime_cache_root="$BUILD_ARTIFACT_ROOT/runtime-cache"
  local cache_dir
  local age_days
  local size_kib

  [[ -d "$runtime_cache_root" ]] || return 0
  size_kib="$(path_size_kib_or_zero "$runtime_cache_root")"
  print_record "report" "runtime-cache" "$size_kib" "$(path_age_days "$runtime_cache_root")" "build-cache" "$runtime_cache_root" "protected" "kept-by-default"

  [[ "$INCLUDE_RUNTIME_CACHE" == "1" ]] || return 0
  while IFS= read -r -d '' cache_dir; do
    age_days="$(path_age_days "$cache_dir")"
    size_kib="$(path_size_kib_or_zero "$cache_dir")"
    if (( age_days < RUNTIME_CACHE_OLDER_THAN_DAYS )); then
      print_record "skip" "runtime-cache-entry" "$size_kib" "$age_days" "build-cache" "$cache_dir" "too-new" "rebuildable-generated"
      continue
    fi
    if runtime_cache_is_newest_in_group "$cache_dir"; then
      print_record "skip" "runtime-cache-entry" "$size_kib" "$age_days" "build-cache" "$cache_dir" "protected" "newest-in-group"
      continue
    fi
    if path_has_process_ref "$cache_dir"; then
      print_record "skip" "runtime-cache-entry" "$size_kib" "$age_days" "build-cache" "$cache_dir" "active-process" "rebuildable-generated"
      continue
    fi
    if path_has_open_files "$cache_dir"; then
      print_record "skip" "runtime-cache-entry" "$size_kib" "$age_days" "build-cache" "$cache_dir" "open-files" "rebuildable-generated"
      continue
    fi
    delete_or_report_candidate "runtime-cache-entry" "build-cache" "$cache_dir" "$age_days" "$size_kib"
  done < <(find "$runtime_cache_root" -mindepth 1 -maxdepth 3 -type d -print0 2>/dev/null)
}

scan_build_cache() {
  scan_build_cache_runs
  scan_build_cache_standard_bucket "tmp" "$BUILD_TEMP_OLDER_THAN_DAYS"
  scan_build_cache_standard_bucket "temp" "$BUILD_TEMP_OLDER_THAN_DAYS"
  scan_build_cache_standard_bucket "smoke" "$BUILD_TEMP_OLDER_THAN_DAYS"
  scan_runtime_cache
}

runtime_instance_is_generated() {
  local instance_name="$1"
  case "$instance_name" in
    *smoke*|*proof*|*test*|*isolated*|telegram-live-*|jarvis-consumer-rc*|consumer-smoke*|worktree-*|tmp-*|temp-*)
      return 0
      ;;
  esac
  return 1
}

runtime_instance_is_protected_name() {
  local instance_name="$1"
  case "$instance_name" in
    ""|main|default|prod|production|user|personal|jarvis|openclaw|.openclaw|browser|memory|credentials)
      return 0
      ;;
  esac
  return 1
}

runtime_instance_has_protected_state() {
  local instance_dir="$1"
  [[ -e "$instance_dir/browser" || -e "$instance_dir/memory" || -e "$instance_dir/credentials" || -e "$instance_dir/openclaw.json" ]]
}

scan_runtime_instance_logs() {
  local instance_dir="$1"
  local instance_name="$2"
  local logs_dir="$instance_dir/logs"
  local log_entry

  [[ -d "$logs_dir" ]] || return 0
  if path_is_active "$instance_dir"; then
    print_record "skip" "runtime-logs" "$(path_size_kib_or_zero "$logs_dir")" "$(path_age_days "$logs_dir")" "$instance_name" "$logs_dir" "active-process" "generated-logs"
    return 0
  fi
  while IFS= read -r -d '' log_entry; do
    consider_generated_path "runtime-logs" "$instance_name" "$log_entry" "$RUNTIME_LOGS_OLDER_THAN_DAYS"
  done < <(find "$logs_dir" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
}

scan_runtime_instance() {
  local instance_dir="$1"
  local instance_name
  local age_days
  local size_kib
  local generated=0
  local risk="manual-review"

  instance_name="$(basename "$instance_dir")"
  age_days="$(path_age_days "$instance_dir")"
  size_kib="$(path_size_kib_or_zero "$instance_dir")"

  if runtime_instance_is_protected_name "$instance_name" || runtime_instance_has_protected_state "$instance_dir"; then
    print_record "skip" "runtime-instance" "$size_kib" "$age_days" "$instance_name" "$instance_dir" "protected" "stateful-or-default"
    return 0
  fi

  if runtime_instance_is_generated "$instance_name"; then
    generated=1
    risk="generated-candidate"
  fi

  if (( generated == 0 )); then
    print_record "report" "runtime-instance" "$size_kib" "$age_days" "$instance_name" "$instance_dir" "protected" "$risk"
    scan_runtime_instance_logs "$instance_dir" "$instance_name"
    return 0
  fi

  if (( age_days < RUNTIME_INSTANCE_OLDER_THAN_DAYS )); then
    print_record "skip" "runtime-instance" "$size_kib" "$age_days" "$instance_name" "$instance_dir" "too-new" "$risk"
    scan_runtime_instance_logs "$instance_dir" "$instance_name"
    return 0
  fi
  if path_has_process_ref "$instance_dir"; then
    print_record "skip" "runtime-instance" "$size_kib" "$age_days" "$instance_name" "$instance_dir" "active-process" "$risk"
    scan_runtime_instance_logs "$instance_dir" "$instance_name"
    return 0
  fi
  if path_has_open_files "$instance_dir"; then
    print_record "skip" "runtime-instance" "$size_kib" "$age_days" "$instance_name" "$instance_dir" "open-files" "$risk"
    scan_runtime_instance_logs "$instance_dir" "$instance_name"
    return 0
  fi

  delete_or_report_candidate "runtime-instance" "$instance_name" "$instance_dir" "$age_days" "$size_kib"
}

scan_runtime_instances() {
  local instance_dir

  [[ -d "$RUNTIME_INSTANCES_ROOT" ]] || return 0
  while IFS= read -r -d '' instance_dir; do
    scan_runtime_instance "$instance_dir"
  done < <(find "$RUNTIME_INSTANCES_ROOT" -mindepth 1 -maxdepth 1 -type d -print0)
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    --deps)
      INCLUDE_DEPS=1
      shift
      ;;
    --include-current)
      INCLUDE_CURRENT=1
      shift
      ;;
    --include-runtime-cache)
      INCLUDE_RUNTIME_CACHE=1
      shift
      ;;
    --older-than-days)
      [[ $# -ge 2 ]] || die "--older-than-days requires a value"
      OLDER_THAN_DAYS="$2"
      shift 2
      ;;
    --deps-older-than-days)
      [[ $# -ge 2 ]] || die "--deps-older-than-days requires a value"
      DEPS_OLDER_THAN_DAYS="$2"
      shift 2
      ;;
    --worktrees-root)
      [[ $# -ge 2 ]] || die "--worktrees-root requires a value"
      WORKTREES_ROOT="$2"
      shift 2
      ;;
    --json)
      JSON=1
      shift
      ;;
    --worktrees)
      WORKTREES=1
      EXPLICIT_MODE=1
      shift
      ;;
    --build-cache)
      BUILD_CACHE=1
      EXPLICIT_MODE=1
      shift
      ;;
    --runtime-instances)
      RUNTIME_INSTANCES=1
      EXPLICIT_MODE=1
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

[[ "$OLDER_THAN_DAYS" =~ ^[0-9]+$ ]] || die "--older-than-days must be a non-negative integer"
[[ "$DEPS_OLDER_THAN_DAYS" =~ ^[0-9]+$ ]] || die "--deps-older-than-days must be a non-negative integer"
[[ "$BUILD_RUNS_OLDER_THAN_HOURS" =~ ^[0-9]+$ ]] || die "OPENCLAW_CLEANUP_BUILD_RUNS_OLDER_THAN_HOURS must be a non-negative integer"
[[ "$BUILD_TEMP_OLDER_THAN_DAYS" =~ ^[0-9]+$ ]] || die "OPENCLAW_CLEANUP_BUILD_TEMP_OLDER_THAN_DAYS must be a non-negative integer"
[[ "$RUNTIME_CACHE_OLDER_THAN_DAYS" =~ ^[0-9]+$ ]] || die "OPENCLAW_CLEANUP_RUNTIME_CACHE_OLDER_THAN_DAYS must be a non-negative integer"
[[ "$RUNTIME_INSTANCE_OLDER_THAN_DAYS" =~ ^[0-9]+$ ]] || die "OPENCLAW_CLEANUP_RUNTIME_INSTANCE_OLDER_THAN_DAYS must be a non-negative integer"
[[ "$RUNTIME_LOGS_OLDER_THAN_DAYS" =~ ^[0-9]+$ ]] || die "OPENCLAW_CLEANUP_RUNTIME_LOGS_OLDER_THAN_DAYS must be a non-negative integer"

if [[ "$EXPLICIT_MODE" == "0" ]]; then
  WORKTREES=1
fi
if [[ -z "$WORKTREES_ROOT" ]]; then
  WORKTREES_ROOT="$(default_worktrees_root)"
fi

if [[ "$JSON" != "1" ]]; then
  echo "OpenClaw build artifact cleanup"
  echo "  mode=$([[ "$APPLY" == "1" ]] && echo apply || echo report)"
  echo "  worktrees=$WORKTREES"
  echo "  build_cache=$BUILD_CACHE"
  echo "  runtime_instances=$RUNTIME_INSTANCES"
  echo "  worktrees_root=$WORKTREES_ROOT"
  echo "  build_artifact_root=$BUILD_ARTIFACT_ROOT"
  echo "  runtime_instances_root=$RUNTIME_INSTANCES_ROOT"
  echo "  current_checkout=$CURRENT_ROOT"
  echo "  generated_older_than_days=$OLDER_THAN_DAYS"
  echo "  deps=$INCLUDE_DEPS"
  if [[ "$INCLUDE_DEPS" == "1" ]]; then
    echo "  deps_older_than_days=$DEPS_OLDER_THAN_DAYS"
  fi
  echo "  include_runtime_cache=$INCLUDE_RUNTIME_CACHE"
fi

if [[ "$APPLY" == "1" ]]; then
  DISK_BEFORE_KIB="$(disk_available_kib "$ROOT_DIR")"
fi

if [[ "$WORKTREES" == "1" ]]; then
  scan_worktrees
fi
if [[ "$BUILD_CACHE" == "1" ]]; then
  scan_build_cache
fi
if [[ "$RUNTIME_INSTANCES" == "1" ]]; then
  scan_runtime_instances
fi

if [[ "$JSON" == "1" ]]; then
  if [[ "$APPLY" == "1" ]]; then
    DISK_AFTER_KIB="$(disk_available_kib "$ROOT_DIR")"
  fi
  printf '{"summary":{"mode":"%s","worktrees":%s,"build_cache":%s,"runtime_instances":%s,"candidates":%s,"deleted":%s,"total_kib":%s}}\n' \
    "$([[ "$APPLY" == "1" ]] && echo apply || echo report)" \
    "$WORKTREES" \
    "$BUILD_CACHE" \
    "$RUNTIME_INSTANCES" \
    "$CANDIDATE_COUNT" \
    "$DELETED_COUNT" \
    "$TOTAL_KIB"
else
  echo "Summary:"
  echo "  candidates=$CANDIDATE_COUNT"
  echo "  deleted=$DELETED_COUNT"
  echo "  reclaimable=$(human_kib "$TOTAL_KIB")"
  if [[ "$APPLY" == "1" ]]; then
    DISK_AFTER_KIB="$(disk_available_kib "$ROOT_DIR")"
    echo "  disk_before=$(human_kib "${DISK_BEFORE_KIB:-0}")"
    echo "  disk_after=$(human_kib "${DISK_AFTER_KIB:-0}")"
    echo "  disk_delta=$(human_kib "$((DISK_AFTER_KIB - DISK_BEFORE_KIB))")"
  fi
fi
