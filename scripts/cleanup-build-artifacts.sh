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
RELEASE_STAGING_OLDER_THAN_DAYS="${OPENCLAW_CLEANUP_RELEASE_STAGING_OLDER_THAN_DAYS:-3}"
RUNTIME_CACHE_OLDER_THAN_DAYS="${OPENCLAW_CLEANUP_RUNTIME_CACHE_OLDER_THAN_DAYS:-14}"
RUNTIME_INSTANCE_OLDER_THAN_DAYS="${OPENCLAW_CLEANUP_RUNTIME_INSTANCE_OLDER_THAN_DAYS:-7}"
RUNTIME_LOGS_OLDER_THAN_DAYS="${OPENCLAW_CLEANUP_RUNTIME_LOGS_OLDER_THAN_DAYS:-3}"
PS_BIN="${OPENCLAW_CLEANUP_PS_BIN:-/bin/ps}"
LSOF_BIN="${OPENCLAW_CLEANUP_LSOF_BIN:-/usr/sbin/lsof}"

WORKTREES_ROOT="${OPENCLAW_WORKTREES_ROOT:-}"
WORKTREES_ROOT_EXPLICIT=0
if [[ -n "$WORKTREES_ROOT" ]]; then
  WORKTREES_ROOT_EXPLICIT=1
fi
BUILD_ARTIFACT_ROOT="$(openclaw_build_artifact_root)"
RUNTIME_INSTANCES_ROOT="${OPENCLAW_RUNTIME_INSTANCES_ROOT:-$HOME/Library/Application Support/OpenClaw/instances}"
CURRENT_ROOT="$(cd "$ROOT_DIR" && pwd -P)"
NOW_EPOCH="$(date +%s)"
TOTAL_KIB=0
CANDIDATE_COUNT=0
DELETED_COUNT=0
PROCESS_SNAPSHOT_READY=0
PROCESS_SNAPSHOT_FAILED=0
PROCESS_SNAPSHOT=""
OPEN_FILE_SNAPSHOT_READY=0
OPEN_FILE_SNAPSHOT_FAILED=0
OPEN_FILE_SNAPSHOT=""
DISK_BEFORE_KIB=""
DISK_AFTER_KIB=""

usage() {
  cat <<'EOF'
Usage: scripts/cleanup-build-artifacts.sh [options]

Reports rebuildable OpenClaw worktree artifacts by default.

Modes:
  --worktrees             Scan registered worktree artifacts. Default when no mode is set.
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
  --worktrees-root <dir>  Scan immediate child directories instead of registered worktrees.
  --json                  Emit machine-readable JSON lines.
  --help                  Show this help.

Build-cache retention:
  runs/* older than 24h, tmp/temp/smoke entries older than 3d.
  Failed Jarvis release/Sparkle runs use a 3d floor and keep the newest run.
  .openclaw-active and .openclaw-protected markers always prevent deletion.
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
  local mtime=""

  # GNU stat accepts -f but reports filesystem metadata, so command success is
  # not enough to identify BSD stat. Accept only an epoch-shaped BSD result,
  # then fall back to GNU's explicit mtime format.
  mtime="$(stat -f %m "$target_path" 2>/dev/null || true)"
  if [[ "$mtime" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$mtime"
    return 0
  fi
  stat -c %Y "$target_path"
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

path_identity() {
  local target_path="$1"
  local identity=""

  # Device, inode, mtime, and ctime together detect replacement plus ordinary
  # directory-entry changes. Candidate-specific policy is still rechecked
  # after this because nested state can change without touching the root mtime.
  # As above, validate BSD output because GNU stat -f can exit successfully.
  identity="$(stat -f '%d:%i:%m:%c' "$target_path" 2>/dev/null || true)"
  if [[ "$identity" =~ ^[0-9]+:[0-9]+:[0-9]+:[0-9]+$ ]]; then
    printf '%s\n' "$identity"
    return 0
  fi
  stat -c '%d:%i:%Y:%Z' "$target_path"
}

tree_removal_protection_reason() {
  openclaw_build_tree_removal_protection_reason "$1"
}

path_has_retention_marker() {
  openclaw_build_path_has_retention_marker "$1"
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
  local size_json="$size_kib"
  local size_display=""

  # Unknown is materially different from an empty 0K directory. Preserve that
  # distinction in both human and JSON output when permissions block du.
  if [[ "$size_kib" =~ ^[0-9]+$ ]]; then
    size_display="$(human_kib "$size_kib")"
  else
    size_json="null"
    size_display="unknown"
  fi

  if [[ "$JSON" == "1" ]]; then
    printf '{"action":"%s","kind":"%s","size_kib":%s,"age_days":%s,"scope":"%s","path":"%s","reason":"%s","risk":"%s"}\n' \
      "$(json_escape "$action")" \
      "$(json_escape "$kind")" \
      "$size_json" \
      "${age_days:-0}" \
      "$(json_escape "$scope")" \
      "$(json_escape "$target_path")" \
      "$(json_escape "$reason")" \
      "$(json_escape "$risk")"
  else
    printf '%-8s %-22s %8s %4sd %-14s %s\n' \
      "$action" "$kind" "$size_display" "${age_days:-0}" "$scope" "$target_path"
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

  # One host snapshot is sufficient for report/classification and avoids
  # spawning ps once per artifact across hundreds of registered worktrees.
  # Apply mode performs an additional fresh check immediately before removal.
  if [[ "$PROCESS_SNAPSHOT_READY" != "1" ]]; then
    PROCESS_SNAPSHOT_READY=1
    if ! command -v "$PS_BIN" >/dev/null 2>&1 || ! PROCESS_SNAPSHOT="$("$PS_BIN" axww -o args= 2>/dev/null)"; then
      PROCESS_SNAPSHOT_FAILED=1
    fi
  fi
  [[ "$PROCESS_SNAPSHOT_FAILED" == "1" ]] && return 0
  printf '%s\n' "$PROCESS_SNAPSHOT" | grep -F "$target_path" | grep -v 'grep -F' >/dev/null 2>&1
}

path_has_open_files() {
  local target_path="$1"

  # A single machine-readable lsof snapshot replaces recursive +D traversal
  # for every candidate. Exact path/prefix matching preserves directory
  # semantics without making scan time proportional to dependency tree size.
  if [[ "$OPEN_FILE_SNAPSHOT_READY" != "1" ]]; then
    OPEN_FILE_SNAPSHOT_READY=1
    if ! command -v "$LSOF_BIN" >/dev/null 2>&1 || ! OPEN_FILE_SNAPSHOT="$("$LSOF_BIN" -Fn 2>/dev/null)"; then
      OPEN_FILE_SNAPSHOT_FAILED=1
    fi
  fi
  [[ "$OPEN_FILE_SNAPSHOT_FAILED" == "1" ]] && return 0
  printf '%s\n' "$OPEN_FILE_SNAPSHOT" | awk -v target="$target_path" '
    substr($0, 1, 1) == "n" {
      open_path = substr($0, 2)
      if (open_path == target || index(open_path, target "/") == 1) {
        found = 1
        exit
      }
    }
    END { exit(found ? 0 : 1) }
  '
}

path_is_active_fresh() {
  local target_path="$1"
  local process_output=""
  local lsof_output=""
  local lsof_status=0

  command -v "$PS_BIN" >/dev/null 2>&1 || return 0
  if ! process_output="$("$PS_BIN" axww -o args= 2>/dev/null)"; then
    return 0
  fi
  if printf '%s\n' "$process_output" | grep -F "$target_path" | grep -v 'grep -F' >/dev/null 2>&1; then
    return 0
  fi

  command -v "$LSOF_BIN" >/dev/null 2>&1 || return 0
  lsof_output="$("$LSOF_BIN" +D "$target_path" 2>&1)" || lsof_status=$?
  [[ "$lsof_status" == "0" ]] && return 0
  [[ "$lsof_status" == "1" && -z "$lsof_output" ]] && return 1
  return 0
}

path_is_active() {
  local target_path="$1"
  path_has_process_ref "$target_path" || path_has_open_files "$target_path"
}

generated_age_policy_block_reason() {
  local target_path="$1"
  local min_age="$2"
  local age_unit="$3"
  local current_age=0

  if [[ "$age_unit" == "hours" ]]; then
    current_age="$(path_age_hours "$target_path" 2>/dev/null)" || {
      printf 'age-inspection-failed'
      return 0
    }
  else
    current_age="$(path_age_days "$target_path" 2>/dev/null)" || {
      printf 'age-inspection-failed'
      return 0
    }
  fi
  if ((current_age < min_age)); then
    printf 'candidate-became-too-new'
    return 0
  fi
  return 1
}

worktree_artifact_policy_block_reason() {
  local target_path="$1"
  local worktree="$2"
  local kind="$3"
  local min_age_days="$4"
  local reason=""

  if [[ ! -d "$worktree" || "$target_path" != "$worktree/$kind" ]]; then
    printf 'worktree-or-candidate-identity-changed'
    return 0
  fi
  if [[ "$INCLUDE_CURRENT" != "1" && "$(cd "$worktree" 2>/dev/null && pwd -P)" == "$CURRENT_ROOT" ]]; then
    printf 'current-checkout'
    return 0
  fi
  if worktree_is_protected_control_lane "$worktree"; then
    printf 'control-or-release-worktree'
    return 0
  fi
  if reason="$(worktree_artifact_safety_block_reason "$worktree" "$target_path" "$kind")"; then
    printf '%s' "$reason"
    return 0
  fi
  if [[ "$kind" == "dist" ]] && dist_has_release_recovery_state "$target_path"; then
    printf 'release-artifact-or-receipt'
    return 0
  fi
  generated_age_policy_block_reason "$target_path" "$min_age_days" days
}

newest_release_run_path() {
  local run_dir
  local candidate_name
  local candidate_mtime
  local newest_path=""
  local newest_mtime=0
  local inventory_path=""

  if ! inventory_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-release-runs.XXXXXX")"; then
    return 2
  fi
  if ! find "$BUILD_ARTIFACT_ROOT/runs" -mindepth 1 -maxdepth 1 -type d -print0 > "$inventory_path" 2>/dev/null; then
    rm -f "$inventory_path" || true
    return 2
  fi

  while IFS= read -r -d '' run_dir; do
    candidate_name="$(basename "$run_dir")"
    case "$candidate_name" in
      *-jarvis-release-*|jarvis-release-*|*-sparkle-*|sparkle-*|*-appcast-*|appcast-*)
        candidate_mtime="$(path_mtime_epoch "$run_dir" 2>/dev/null)" || continue
        if ((candidate_mtime > newest_mtime)); then
          newest_mtime="$candidate_mtime"
          newest_path="$run_dir"
        fi
        ;;
    esac
  done < "$inventory_path"
  if ! rm -f "$inventory_path"; then
    return 2
  fi
  printf '%s\n' "$newest_path"
}

build_run_policy_block_reason() {
  local target_path="$1"
  local kind="$2"

  if [[ "$(dirname "$target_path")" != "$BUILD_ARTIFACT_ROOT/runs" ]]; then
    printf 'build-run-parent-changed'
    return 0
  fi
  if [[ "$kind" == "release-staging" ]]; then
    local newest_path=""
    if ! newest_path="$(newest_release_run_path)"; then
      printf 'release-run-inventory-failed'
      return 0
    fi
    if [[ "$newest_path" == "$target_path" ]]; then
      printf 'newest-release-staging'
      return 0
    fi
    generated_age_policy_block_reason "$target_path" "$RELEASE_STAGING_OLDER_THAN_DAYS" days
    return $?
  fi
  generated_age_policy_block_reason "$target_path" "$BUILD_RUNS_OLDER_THAN_HOURS" hours
}

runtime_cache_policy_block_reason() {
  local target_path="$1"

  if runtime_cache_is_newest_in_group "$target_path"; then
    printf 'newest-in-group'
    return 0
  fi
  generated_age_policy_block_reason "$target_path" "$RUNTIME_CACHE_OLDER_THAN_DAYS" days
}

runtime_instance_policy_block_reason() {
  local target_path="$1"
  local instance_name="$2"

  if [[ "$(basename "$target_path")" != "$instance_name" ]] ||
    ! runtime_instance_is_generated "$instance_name" ||
    runtime_instance_is_protected_name "$instance_name" ||
    runtime_instance_has_protected_state "$target_path"; then
    printf 'runtime-instance-became-stateful-or-unowned'
    return 0
  fi
  generated_age_policy_block_reason "$target_path" "$RUNTIME_INSTANCE_OLDER_THAN_DAYS" days
}

pre_delete_block_reason() {
  local target_path="$1"
  local expected_identity="$2"
  local policy_fn="$3"
  shift 3
  local reason=""
  local current_identity=""

  [[ -e "$target_path" || -L "$target_path" ]] || {
    printf 'candidate-disappeared'
    return 0
  }
  current_identity="$(path_identity "$target_path" 2>/dev/null)" || {
    printf 'identity-inspection-failed'
    return 0
  }
  if [[ "$current_identity" != "$expected_identity" ]]; then
    printf 'candidate-identity-changed'
    return 0
  fi
  if reason="$("$policy_fn" "$target_path" "$@")"; then
    printf '%s' "$reason"
    return 0
  fi
  if path_has_retention_marker "$target_path"; then
    printf 'protected-marker'
    return 0
  fi
  if reason="$(tree_removal_protection_reason "$target_path")"; then
    printf '%s' "$reason"
    return 0
  fi
  if path_is_active_fresh "$target_path"; then
    printf 'became-active-or-inspection-indeterminate'
    return 0
  fi

  # Live/process inspection can take long enough for state, receipts, markers,
  # permissions, or the path itself to change. Re-run every policy immediately
  # after it and before the exact-path rm.
  if reason="$("$policy_fn" "$target_path" "$@")"; then
    printf '%s' "$reason"
    return 0
  fi
  if path_has_retention_marker "$target_path"; then
    printf 'protected-marker'
    return 0
  fi
  if reason="$(tree_removal_protection_reason "$target_path")"; then
    printf '%s' "$reason"
    return 0
  fi
  current_identity="$(path_identity "$target_path" 2>/dev/null)" || {
    printf 'identity-inspection-failed'
    return 0
  }
  if [[ "$current_identity" != "$expected_identity" ]]; then
    printf 'candidate-identity-changed'
    return 0
  fi
  return 1
}

delete_or_report_candidate() {
  local kind="$1"
  local scope="$2"
  local target_path="$3"
  local age_days="$4"
  local size_kib="$5"
  local policy_fn="$6"
  shift 6

  local protection_reason=""
  local validated_size_kib=""
  local expected_identity=""

  if path_has_retention_marker "$target_path"; then
    print_record "skip" "$kind" "$size_kib" "$age_days" "$scope" "$target_path" "protected-marker" "explicit-retention"
    return 0
  fi
  # Validate the full directory tree before rm can touch an accessible sibling.
  # This also validates a regular file's parent removal access without requiring
  # the file itself to be executable.
  if protection_reason="$(tree_removal_protection_reason "$target_path")"; then
    print_record "skip" "$kind" "unknown" "$age_days" "$scope" "$target_path" "$protection_reason" "operator-remediation-required"
    return 0
  fi

  # A successful fresh du is the final read-only proof that traversal reaches
  # the complete candidate. Never treat a failed size probe as zero or proceed
  # to a potentially partial recursive deletion.
  if ! validated_size_kib="$(path_size_kib "$target_path")"; then
    print_record "skip" "$kind" "unknown" "$age_days" "$scope" "$target_path" \
      "pre-delete-size-validation-failed; $(openclaw_build_path_metadata "$target_path"); operator action: inspect inaccessible descendants before retrying" \
      "operator-remediation-required"
    return 0
  fi
  size_kib="$validated_size_kib"
  if ! expected_identity="$(path_identity "$target_path" 2>/dev/null)"; then
    print_record "skip" "$kind" "unknown" "$age_days" "$scope" "$target_path" "identity-inspection-failed" "operator-remediation-required"
    return 0
  fi

  record_candidate_total "$size_kib"

  if [[ "$APPLY" == "1" ]]; then
    if protection_reason="$(pre_delete_block_reason "$target_path" "$expected_identity" "$policy_fn" "$@")"; then
      print_record "skip" "$kind" "$size_kib" "$age_days" "$scope" "$target_path" "$protection_reason" "rebuildable-generated"
      return 0
    fi
    # du can itself take long enough for state to change. Require one final
    # complete traversal, then repeat the entire exact-candidate safety proof.
    if ! validated_size_kib="$(path_size_kib "$target_path")"; then
      print_record "skip" "$kind" "unknown" "$age_days" "$scope" "$target_path" "final-size-validation-failed" "operator-remediation-required"
      return 0
    fi
    size_kib="$validated_size_kib"
    if protection_reason="$(pre_delete_block_reason "$target_path" "$expected_identity" "$policy_fn" "$@")"; then
      print_record "skip" "$kind" "$size_kib" "$age_days" "$scope" "$target_path" "$protection_reason" "rebuildable-generated"
      return 0
    fi
    # rm can still lose a race with a permission or filesystem change after the
    # precheck. Keep the overall cleanup pass alive and report the exact path;
    # never compensate with chmod, sudo, or a broader deletion.
    if rm -rf "$target_path"; then
      DELETED_COUNT=$((DELETED_COUNT + 1))
      print_record "deleted" "$kind" "$size_kib" "$age_days" "$scope" "$target_path" "" "rebuildable-generated"
    else
      print_record "skip" "$kind" "$size_kib" "$age_days" "$scope" "$target_path" "remove-failed; inspect this exact path and its ownership before retrying" "operator-remediation-required"
    fi
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

  delete_or_report_candidate "$kind" "$scope" "$target_path" "$age_days" "$size_kib" \
    generated_age_policy_block_reason "$min_age_days" days
}

# Dirty source outside a generated directory must not make that directory
# immortal. Agents routinely leave valuable source changes beside multi-GiB
# dependency and build trees, and hourly retention cannot depend on a terminal
# chat remembering to clean those trees manually.
#
# Keep this exception deliberately narrower than ordinary dirtiness handling.
# Git must report no tracked files below any artifact. In a dirty worktree, the
# exact top-level directory must also be a known rebuildable kind and ignored.
# `.swiftpm` is not included in the dirty exception because it may contain
# user-authored mirror or registry settings. Any failed inspection remains a
# protection signal.
worktree_artifact_safety_block_reason() {
  local worktree="$1"
  local target_path="$2"
  local kind="$3"
  local status_output=""
  local tracked_output=""

  if ! status_output="$(git -C "$worktree" status --short 2>/dev/null)"; then
    printf 'dirty-status-indeterminate'
    return 0
  fi
  if [[ "$target_path" != "$worktree/$kind" ]]; then
    printf 'worktree-or-candidate-identity-changed'
    return 0
  fi
  if ! tracked_output="$(git -C "$worktree" ls-files -- "$kind" 2>/dev/null)"; then
    printf 'dirty-worktree-tracked-file-inspection-failed'
    return 0
  fi
  if [[ -n "$tracked_output" ]]; then
    printf 'worktree-artifact-has-tracked-files'
    return 0
  fi
  [[ -n "$status_output" ]] || return 1

  case "$kind" in
    dist|.build|.build-ui-smoke|dist-ui-smoke|DerivedData|.turbo|coverage|node_modules)
      ;;
    *)
      printf 'dirty-worktree-unsafe-artifact-kind'
      return 0
      ;;
  esac

  if ! git -C "$worktree" check-ignore --quiet --no-index -- "$kind/" 2>/dev/null; then
    printf 'dirty-worktree-artifact-not-ignored'
    return 0
  fi
  return 1
}

worktree_is_protected_control_lane() {
  local worktree="$1"
  local branch=""

  # The sacred main checkout owns source-control and shared-runtime recovery;
  # the blessed Jarvis release lane intentionally keeps expensive prewarm
  # output. Registered-worktree discovery must not turn either durable control
  # surface into an automatic cache target.
  branch="$(git -C "$worktree" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  case "$branch" in
    main|codex/jarvis-release-current)
      return 0
      ;;
  esac
  [[ "$worktree" == */.worktrees/jarvis-release-current ]]
}

dist_has_release_recovery_state() {
  local dist_dir="$1"
  local protected_path

  # Worktree cleanup may remove ordinary generated dist/ output, but Jarvis
  # release artifacts and receipts are resumable operator state. A final app,
  # upload artifact, appcast, notary receipt, build receipt, or manifest keeps
  # the entire dist directory out of automatic cleanup.
  for protected_path in \
    "$dist_dir"/Jarvis.app \
    "$dist_dir"/Jarvis*.dmg \
    "$dist_dir"/Jarvis*.zip \
    "$dist_dir"/*appcast*.xml \
    "$dist_dir"/*.app.release.env \
    "$dist_dir"/*.app.notary.env \
    "$dist_dir"/*.dmg.notary.env \
    "$dist_dir"/*release-manifest.env \
    "$dist_dir"/*public-release-summary.env \
    "$dist_dir"/*release-timing.tsv; do
    if [[ -e "$protected_path" ]]; then
      return 0
    fi
  done

  return 1
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
  if worktree_is_protected_control_lane "$worktree"; then
    print_record "skip" "$kind" "$size_kib" "$age_days" "$worktree" "$target_path" "protected" "control-or-release-worktree"
    return 0
  fi
  if [[ "$kind" == "dist" ]] && dist_has_release_recovery_state "$target_path"; then
    print_record "skip" "$kind" "$size_kib" "$age_days" "$worktree" "$target_path" "protected" "release-artifact-or-receipt"
    return 0
  fi
  local dirty_block_reason=""
  if dirty_block_reason="$(worktree_artifact_safety_block_reason "$worktree" "$target_path" "$kind")"; then
    print_record "skip" "$kind" "$size_kib" "$age_days" "$worktree" "$target_path" "$dirty_block_reason" "worktree-generated"
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

  delete_or_report_candidate "$kind" "$worktree" "$target_path" "$age_days" "$size_kib" \
    worktree_artifact_policy_block_reason "$worktree" "$kind" "$min_age_days"
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

scan_worktrees_root() {
  [[ -d "$WORKTREES_ROOT" ]] || return 0
  while IFS= read -r -d '' worktree; do
    scan_worktree "$worktree"
  done < <(find "$WORKTREES_ROOT" -mindepth 1 -maxdepth 1 -type d -print0)
}

scan_registered_worktrees() {
  local field
  local worktree

  # Git's registry is the authority for linked worktrees. NUL-delimited
  # porcelain output preserves spaces and other shell-sensitive path bytes,
  # while avoiding assumptions about whether a checkout lives under
  # .worktrees/name or a nested Codex UUID/openclaw directory.
  while IFS= read -r -d '' field; do
    case "$field" in
      "worktree "*)
        worktree="${field#worktree }"
        scan_worktree "$worktree"
        ;;
    esac
  done < <(git -C "$ROOT_DIR" worktree list --porcelain -z)
}

scan_worktrees() {
  if [[ "$WORKTREES_ROOT_EXPLICIT" == "1" ]]; then
    scan_worktrees_root
  else
    scan_registered_worktrees
  fi
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
  local kind
  local newest_release_run=""
  local newest_release_mtime=0
  local candidate_mtime
  local candidate_name

  # Release runs can contain expensive notarization inputs useful for a narrow
  # retry. Find the newest one first so cleanup always retains a recovery point,
  # even when every run is older than the normal generic cache threshold.
  while IFS= read -r -d '' run_dir; do
    candidate_name="$(basename "$run_dir")"
    case "$candidate_name" in
      *-jarvis-release-*|jarvis-release-*|*-sparkle-*|sparkle-*|*-appcast-*|appcast-*)
        candidate_mtime="$(path_mtime_epoch "$run_dir")"
        if ((candidate_mtime > newest_release_mtime)); then
          newest_release_mtime="$candidate_mtime"
          newest_release_run="$run_dir"
        fi
        ;;
    esac
  done < <(find "$BUILD_ARTIFACT_ROOT/runs" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)

  [[ -d "$BUILD_ARTIFACT_ROOT/runs" ]] || return 0
  while IFS= read -r -d '' run_dir; do
    age_hours="$(path_age_hours "$run_dir")"
    age_days="$(path_age_days "$run_dir")"
    kind="build-cache-runs"

    candidate_name="$(basename "$run_dir")"
    case "$candidate_name" in
      *-jarvis-release-*|jarvis-release-*|*-sparkle-*|sparkle-*|*-appcast-*|appcast-*)
        kind="release-staging"
        ;;
    esac

    # du returning no trustworthy size is a protection signal, not 0K. This is
    # the root-owned mode-700 failure that previously made dry-runs misleading.
    if ! size_kib="$(path_size_kib "$run_dir")"; then
      print_record "skip" "$kind" "unknown" "$age_days" "build-cache" "$run_dir" "size-unreadable; $(openclaw_build_path_metadata "$run_dir"); operator action: ask the owner to inspect this exact stale cache path" "operator-remediation-required"
      continue
    fi
    if path_has_retention_marker "$run_dir"; then
      print_record "skip" "$kind" "$size_kib" "$age_days" "build-cache" "$run_dir" "protected-marker" "explicit-retention"
      continue
    fi
    if [[ "$kind" == "release-staging" ]]; then
      if ((age_days < RELEASE_STAGING_OLDER_THAN_DAYS)); then
        print_record "skip" "$kind" "$size_kib" "$age_days" "build-cache" "$run_dir" "too-new" "resumable-release-staging"
        continue
      fi
      if [[ "$run_dir" == "$newest_release_run" ]]; then
        print_record "skip" "$kind" "$size_kib" "$age_days" "build-cache" "$run_dir" "protected" "newest-release-staging"
        continue
      fi
    elif ((age_hours < BUILD_RUNS_OLDER_THAN_HOURS)); then
      print_record "skip" "$kind" "$size_kib" "$age_days" "build-cache" "$run_dir" "too-new" "rebuildable-generated"
      continue
    fi
    if path_has_process_ref "$run_dir"; then
      print_record "skip" "$kind" "$size_kib" "$age_days" "build-cache" "$run_dir" "active-process" "rebuildable-generated"
      continue
    fi
    if path_has_open_files "$run_dir"; then
      print_record "skip" "$kind" "$size_kib" "$age_days" "build-cache" "$run_dir" "open-files" "rebuildable-generated"
      continue
    fi
    delete_or_report_candidate "$kind" "build-cache" "$run_dir" "$age_days" "$size_kib" \
      build_run_policy_block_reason "$kind"
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
  local inventory_path=""

  group_dir="$(runtime_cache_group_key "$target_path")"
  if ! inventory_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-runtime-cache.XXXXXX")"; then
    return 0
  fi
  if ! find "$group_dir" -mindepth 1 -maxdepth 1 -type d -print0 > "$inventory_path" 2>/dev/null; then
    rm -f "$inventory_path" || true
    return 0
  fi
  while IFS= read -r -d '' candidate; do
    if ! candidate_mtime="$(path_mtime_epoch "$candidate")"; then
      rm -f "$inventory_path" || true
      return 0
    fi
    if (( candidate_mtime > newest_mtime )); then
      newest_mtime="$candidate_mtime"
      newest_path="$candidate"
    fi
  done < "$inventory_path"
  if ! rm -f "$inventory_path"; then
    return 0
  fi
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
    delete_or_report_candidate "runtime-cache-entry" "build-cache" "$cache_dir" "$age_days" "$size_kib" \
      runtime_cache_policy_block_reason
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
  local protected_path

  # Legacy/runtime-instance layouts may place operator identity and control
  # state under instance/.openclaw rather than at the instance root. Check the
  # known layouts explicitly and fail closed before generated-name heuristics
  # can classify the entire instance as rebuildable.
  for protected_path in \
    "$instance_dir"/browser \
    "$instance_dir"/memory \
    "$instance_dir"/credentials \
    "$instance_dir"/identity \
    "$instance_dir"/openclaw.json \
    "$instance_dir"/config/openclaw.json \
    "$instance_dir"/.openclaw/browser \
    "$instance_dir"/.openclaw/memory \
    "$instance_dir"/.openclaw/credentials \
    "$instance_dir"/.openclaw/identity \
    "$instance_dir"/.openclaw/openclaw.json \
    "$instance_dir"/.openclaw/config/openclaw.json; do
    if [[ -e "$protected_path" ]]; then
      return 0
    fi
  done

  return 1
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

  delete_or_report_candidate "runtime-instance" "$instance_name" "$instance_dir" "$age_days" "$size_kib" \
    runtime_instance_policy_block_reason "$instance_name"
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
      WORKTREES_ROOT_EXPLICIT=1
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
[[ "$RELEASE_STAGING_OLDER_THAN_DAYS" =~ ^[0-9]+$ ]] || die "OPENCLAW_CLEANUP_RELEASE_STAGING_OLDER_THAN_DAYS must be a non-negative integer"
[[ "$RUNTIME_CACHE_OLDER_THAN_DAYS" =~ ^[0-9]+$ ]] || die "OPENCLAW_CLEANUP_RUNTIME_CACHE_OLDER_THAN_DAYS must be a non-negative integer"
[[ "$RUNTIME_INSTANCE_OLDER_THAN_DAYS" =~ ^[0-9]+$ ]] || die "OPENCLAW_CLEANUP_RUNTIME_INSTANCE_OLDER_THAN_DAYS must be a non-negative integer"
[[ "$RUNTIME_LOGS_OLDER_THAN_DAYS" =~ ^[0-9]+$ ]] || die "OPENCLAW_CLEANUP_RUNTIME_LOGS_OLDER_THAN_DAYS must be a non-negative integer"

if [[ "$EXPLICIT_MODE" == "0" ]]; then
  WORKTREES=1
fi
if [[ "$JSON" != "1" ]]; then
  echo "OpenClaw build artifact cleanup"
  echo "  mode=$([[ "$APPLY" == "1" ]] && echo apply || echo report)"
  echo "  worktrees=$WORKTREES"
  echo "  build_cache=$BUILD_CACHE"
  echo "  runtime_instances=$RUNTIME_INSTANCES"
  if [[ "$WORKTREES_ROOT_EXPLICIT" == "1" ]]; then
    echo "  worktrees_source=root"
    echo "  worktrees_root=$WORKTREES_ROOT"
  else
    echo "  worktrees_source=git-registry"
  fi
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
