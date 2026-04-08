#!/usr/bin/env bash

# Shared shell helpers for worktree hygiene gates. These stay intentionally
# small: the heavy lifting belongs in scripts/worktree-doctor.sh so every
# entrypoint enforces the same rules instead of drifting.

worktree_guard_is_linked_checkout() {
  local root_dir="$1"
  local absolute_git_dir=""

  absolute_git_dir="$(git -C "$root_dir" rev-parse --absolute-git-dir 2>/dev/null || true)"
  [[ "$absolute_git_dir" == *"/worktrees/"* ]]
}

worktree_guard_current_branch() {
  local root_dir="$1"
  git -C "$root_dir" branch --show-current 2>/dev/null || true
}

worktree_guard_sacred_home_clone_path() {
  local lane_name="$1"

  case "$lane_name" in
    main)
      printf '%s\n' "${OPENCLAW_MAIN_HOME_CLONE:-$HOME/Programming_Projects/openclaw}"
      ;;
    consumer)
      printf '%s\n' "${OPENCLAW_CONSUMER_HOME_CLONE:-$HOME/Programming_Projects/openclaw-consumer}"
      ;;
    *)
      return 1
      ;;
  esac
}

worktree_guard_sacred_home_clone_branch() {
  local lane_name="$1"

  case "$lane_name" in
    main)
      printf 'main'
      ;;
    consumer)
      printf 'codex/consumer-openclaw-project'
      ;;
    *)
      return 1
      ;;
  esac
}

worktree_guard_sacred_home_clone_path_for_branch() {
  local branch_name="$1"
  local lane_name=""

  case "$branch_name" in
    main)
      lane_name="main"
      ;;
    codex/consumer-openclaw-project)
      lane_name="consumer"
      ;;
    *)
      return 1
      ;;
  esac

  worktree_guard_sacred_home_clone_path "$lane_name"
}

worktree_guard_sacred_home_clone_label() {
  local lane_name="$1"

  case "$lane_name" in
    main)
      printf 'main sacred home clone'
      ;;
    consumer)
      printf 'consumer sacred home clone'
      ;;
    *)
      return 1
      ;;
  esac
}

worktree_guard_sacred_home_clone_role() {
  local root_dir="$1"
  local absolute_root=""
  local candidate=""
  local candidate_path=""

  absolute_root="$(cd "$root_dir" && pwd -P)"
  for candidate in main consumer; do
    candidate_path="$(worktree_guard_sacred_home_clone_path "$candidate" 2>/dev/null || true)"
    [[ -n "$candidate_path" ]] || continue
    if [[ -d "$candidate_path" ]] && [[ "$absolute_root" == "$(cd "$candidate_path" && pwd -P)" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

worktree_guard_is_sacred_home_clone() {
  local root_dir="$1"
  worktree_guard_sacred_home_clone_role "$root_dir" >/dev/null 2>&1
}

worktree_guard_allow_sacred_home_hotfix() {
  [[ "${OPENCLAW_ALLOW_SACRED_HOME_HOTFIX:-0}" == "1" ]] || \
    [[ "${OPENCLAW_ALLOW_SACRED_HOME_EDITS:-0}" == "1" ]] || \
    [[ "${OPENCLAW_ALLOW_SHARED_ROOT_MAIN_EDITS:-0}" == "1" ]]
}

worktree_guard_forbid_sacred_home_checkout_drift() {
  local root_dir="$1"
  local context_label="${2:-}"
  local lane_name=""
  local branch_name=""
  local base_branch=""

  lane_name="$(worktree_guard_sacred_home_clone_role "$root_dir" 2>/dev/null || true)"
  [[ -n "$lane_name" ]] || return 0

  branch_name="$(worktree_guard_current_branch "$root_dir")"
  base_branch="$(worktree_guard_sacred_home_clone_branch "$lane_name")" || return 0

  if [[ "$branch_name" == "$base_branch" ]]; then
    return 0
  fi

  if worktree_guard_allow_sacred_home_hotfix; then
    cat >&2 <<EOF
ERROR: break-glass sacred-home hotfixes must run from '${base_branch}', not '${branch_name:-<detached>}'.

Checkout: ${root_dir}
${context_label:+Context:  ${context_label}
}
Restore the sacred home clone first:
  git checkout ${base_branch}
  git pull --ff-only origin ${base_branch}

Then, if this is a real runtime hotfix, rerun with:
  OPENCLAW_ALLOW_SACRED_HOME_HOTFIX=1
EOF
    return 1
  fi

  cat >&2 <<EOF
ERROR: sacred home clone drifted off its base branch.

Checkout: ${root_dir}
Branch:   ${branch_name:-<detached>}
Expected: ${base_branch}
${context_label:+Context:  ${context_label}
}
Sacred home clones are pull-only runtime anchors. They do not host feature
branches anymore. Restore the base branch, fast-forward it, then spawn a temp
worktree for implementation:
  git checkout ${base_branch}
  git pull --ff-only origin ${base_branch}
  $(if [[ "$lane_name" == "main" ]]; then printf 'oc-main-task'; else printf 'oc-consumer-task'; fi) <feature-name>

Only a true runtime hotfix may bypass this, and only from '${base_branch}':
  OPENCLAW_ALLOW_SACRED_HOME_HOTFIX=1
EOF
  return 1
}

worktree_guard_protected_base_branch() {
  local branch_name="$1"

  case "$branch_name" in
    main | codex/consumer-openclaw-project)
      printf '%s\n' "$branch_name"
      ;;
    *)
      return 1
      ;;
  esac
}

worktree_guard_forbid_protected_base_branch_commit() {
  local root_dir="$1"
  local branch_name=""

  if [[ "${OPENCLAW_ALLOW_PROTECTED_BRANCH_COMMITS:-0}" == "1" ]]; then
    return 0
  fi

  if [[ "${OPENCLAW_ALLOW_SACRED_HOME_HOTFIX:-0}" == "1" ]]; then
    worktree_guard_forbid_sacred_home_checkout_drift "$root_dir" "protected-base-commit" || return 1
    return 0
  fi

  branch_name="$(worktree_guard_current_branch "$root_dir")"
  worktree_guard_protected_base_branch "$branch_name" >/dev/null 2>&1 || return 0

  cat >&2 <<EOF
ERROR: refusing commit on protected base branch '${branch_name}'.

Checkout: ${root_dir}
Branch:   ${branch_name}

Base branches are pull-only. Create a short-lived feature branch, open a draft
PR early, validate there, then mark the PR ready once validation is complete.

Example:
  git checkout -b codex/<task-name>

If you intentionally need to bypass this once, set:
  OPENCLAW_ALLOW_PROTECTED_BRANCH_COMMITS=1
EOF
  return 1
}

worktree_guard_reject_sacred_home_edits() {
  local root_dir="$1"
  local mode="${2:-worktree}"
  shift 2 || true

  local lane_name=""
  local base_branch=""
  local branch_name=""
  local label=""
  local -a paths=()
  local path=""
  local context_label=""

  lane_name="$(worktree_guard_sacred_home_clone_role "$root_dir" 2>/dev/null || true)"
  [[ -n "$lane_name" ]] || return 0

  label="$(worktree_guard_sacred_home_clone_label "$lane_name" 2>/dev/null || printf 'sacred home clone')"
  base_branch="$(worktree_guard_sacred_home_clone_branch "$lane_name" 2>/dev/null || true)"
  branch_name="$(worktree_guard_current_branch "$root_dir")"

  if [[ "$#" -gt 0 && "$1" == --context ]]; then
    context_label="${2:-}"
    shift 2 || true
  fi

  if worktree_guard_allow_sacred_home_hotfix; then
    if [[ -n "$base_branch" && "$branch_name" == "$base_branch" ]]; then
      return 0
    fi
    worktree_guard_forbid_sacred_home_checkout_drift "$root_dir" "$context_label"
    return 1
  fi

  if [[ "$#" -gt 0 ]]; then
    for path in "$@"; do
      [[ -n "$path" ]] || continue
      paths+=("$path")
    done
  else
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      paths+=("$path")
    done < <(worktree_guard_list_tracked_changes "$root_dir" "$mode")
  fi

  if [[ "${#paths[@]}" -eq 0 ]]; then
    return 0
  fi

  cat >&2 <<EOF
ERROR: tracked edits are blocked in the ${label}.

Checkout: ${root_dir}
Branch:   ${branch_name:-<detached>}
Base:     ${base_branch:-unknown}
${context_label:+Context:  ${context_label}
}
Detected paths:
$(printf '  %s\n' "${paths[@]}")

Sacred home clones are pull-only runtime anchors. Implementation work must
happen in a temporary worktree created from the correct sacred home clone:
  $(if [[ "$lane_name" == "main" ]]; then printf 'oc-main-task'; else printf 'oc-consumer-task'; fi) <feature-name>

Only a true runtime hotfix may bypass this, and only from '${base_branch}':
  OPENCLAW_ALLOW_SACRED_HOME_HOTFIX=1
EOF
  return 1
}

worktree_guard_forbid_sacred_home_commit() {
  local root_dir="$1"
  local lane_name=""
  local branch_name=""
  local base_branch=""
  local label=""

  lane_name="$(worktree_guard_sacred_home_clone_role "$root_dir" 2>/dev/null || true)"
  [[ -n "$lane_name" ]] || return 0

  branch_name="$(worktree_guard_current_branch "$root_dir")"
  base_branch="$(worktree_guard_sacred_home_clone_branch "$lane_name")" || return 0
  label="$(worktree_guard_sacred_home_clone_label "$lane_name" 2>/dev/null || printf 'sacred home clone')"

  if worktree_guard_allow_sacred_home_hotfix; then
    if [[ "$branch_name" == "$base_branch" ]]; then
      return 0
    fi
    worktree_guard_forbid_sacred_home_checkout_drift "$root_dir" "commit"
    return 1
  fi

  cat >&2 <<EOF
ERROR: refusing commit from the ${label}.

Checkout: ${root_dir}
Branch:   ${branch_name:-<detached>}
Base:     ${base_branch}

Sacred home clones are pull-only runtime anchors. Agents do not land feature
commits here, even on short-lived branches. Restore the home clone to its base
branch, fast-forward it, and create a temporary worktree for the task:
  $(if [[ "$lane_name" == "main" ]]; then printf 'oc-main-task'; else printf 'oc-consumer-task'; fi) <feature-name>

Only a true runtime hotfix may bypass this, and only from '${base_branch}':
  OPENCLAW_ALLOW_SACRED_HOME_HOTFIX=1
EOF
  return 1
}

worktree_guard_require_sacred_home_clone_base_branch() {
  local root_dir="$1"
  local context_label="${2:-}"

  if worktree_guard_is_linked_checkout "$root_dir"; then
    return 0
  fi

  worktree_guard_forbid_sacred_home_checkout_drift "$root_dir" "$context_label"
}

worktree_guard_durable_lane_upstream() {
  local branch_name="$1"

  case "$branch_name" in
    main)
      printf 'origin/main'
      ;;
    codex/consumer-openclaw-project)
      printf 'origin/codex/consumer-openclaw-project'
      ;;
    *)
      return 1
      ;;
  esac
}

worktree_guard_is_durable_lane_checkout() {
  local root_dir="$1"
  local branch_name=""

  if ! worktree_guard_is_linked_checkout "$root_dir"; then
    return 1
  fi

  branch_name="$(worktree_guard_current_branch "$root_dir")"
  [[ -n "$branch_name" ]] || return 1
  worktree_guard_durable_lane_upstream "$branch_name" >/dev/null
}

worktree_guard_fetch_durable_lane_upstream() {
  local root_dir="$1"
  local branch_name=""

  branch_name="$(worktree_guard_current_branch "$root_dir")"
  [[ -n "$branch_name" ]] || return 1

  if ! worktree_guard_durable_lane_upstream "$branch_name" >/dev/null; then
    return 1
  fi

  git -C "$root_dir" fetch --quiet origin "$branch_name"
}

worktree_guard_durable_lane_counts() {
  local root_dir="$1"
  local branch_name=""
  local upstream_ref=""
  local ahead=0
  local behind=0

  branch_name="$(worktree_guard_current_branch "$root_dir")"
  [[ -n "$branch_name" ]] || return 1
  upstream_ref="$(worktree_guard_durable_lane_upstream "$branch_name")" || return 1

  if ! git -C "$root_dir" show-ref --verify --quiet "refs/remotes/${upstream_ref}"; then
    return 1
  fi

  read -r ahead behind < <(git -C "$root_dir" rev-list --left-right --count "${branch_name}...${upstream_ref}")
  printf '%s %s\n' "$ahead" "$behind"
}

worktree_guard_print_durable_lane_warning() {
  local root_dir="$1"
  local branch_name="$2"
  local ahead="$3"
  local behind="$4"

  cat >&2 <<EOF
WARN: durable lane is stale or drifted.

Checkout: ${root_dir}
Branch:   ${branch_name}
Ahead:    ${ahead}
Behind:   ${behind}

Use the lane wrapper so origin is fetched and the lane is fast-forwarded safely:
  $(if [[ "$branch_name" == "main" ]]; then printf 'oc-main'; else printf 'oc-consumer'; fi)

Manual entry into durable lanes is allowed, but stale branch truth here is how old code sneaks back in.
EOF
}

worktree_guard_warn_if_durable_lane_stale() {
  local root_dir="$1"
  local branch_name=""
  local counts=""
  local ahead=0
  local behind=0

  if ! worktree_guard_is_durable_lane_checkout "$root_dir"; then
    return 1
  fi

  branch_name="$(worktree_guard_current_branch "$root_dir")"
  if ! worktree_guard_fetch_durable_lane_upstream "$root_dir"; then
    return 1
  fi

  counts="$(worktree_guard_durable_lane_counts "$root_dir")" || return 1
  read -r ahead behind <<<"$counts"
  if [[ "$ahead" == "0" && "$behind" == "0" ]]; then
    return 0
  fi

  worktree_guard_print_durable_lane_warning "$root_dir" "$branch_name" "$ahead" "$behind"
  return 0
}

worktree_guard_forbid_stale_durable_lane_commit() {
  local root_dir="$1"
  local override="${OPENCLAW_ALLOW_STALE_DURABLE_LANE_COMMITS:-0}"
  local branch_name=""
  local counts=""
  local ahead=0
  local behind=0

  if [[ "$override" == "1" ]]; then
    return 0
  fi

  if ! worktree_guard_is_durable_lane_checkout "$root_dir"; then
    return 0
  fi

  branch_name="$(worktree_guard_current_branch "$root_dir")"
  counts="$(worktree_guard_durable_lane_counts "$root_dir")" || return 0
  read -r ahead behind <<<"$counts"

  if [[ "$behind" == "0" ]]; then
    return 0
  fi

  cat >&2 <<EOF
ERROR: refusing commit from a stale durable lane.

Checkout: ${root_dir}
Branch:   ${branch_name}
Ahead:    ${ahead}
Behind:   ${behind}

Fast-forward this lane before committing:
  $(if [[ "$branch_name" == "main" ]]; then printf 'oc-main'; else printf 'oc-consumer'; fi)

If you intentionally need to bypass this once, set:
  OPENCLAW_ALLOW_STALE_DURABLE_LANE_COMMITS=1
EOF
  return 1
}

worktree_guard_run_doctor() {
  local root_dir="$1"
  shift

  local doctor_path="$root_dir/scripts/worktree-doctor.sh"
  if [[ -x "$doctor_path" ]]; then
    bash "$doctor_path" "$@"
  fi
}

worktree_guard_run_for_linked_checkout() {
  local root_dir="$1"
  shift

  if worktree_guard_is_linked_checkout "$root_dir"; then
    worktree_guard_run_doctor "$root_dir" "$@"
  fi
}

worktree_guard_shared_gateway_targets_root() {
  local root_dir="$1"
  local plist_path="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
  local entry_path=""
  local expected_path=""

  [[ -f "$plist_path" ]] || return 1
  entry_path="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$plist_path" 2>/dev/null || true)"
  [[ -n "$entry_path" ]] || return 1

  expected_path="$(cd "$root_dir" && pwd -P)/dist/index.js"
  if [[ -e "$entry_path" ]]; then
    entry_path="$(cd "$(dirname "$entry_path")" && pwd -P)/$(basename "$entry_path")"
  fi

  [[ "$entry_path" == "$expected_path" ]]
}

worktree_guard_is_canonical_shared_root() {
  local root_dir="$1"
  local lane_name=""

  lane_name="$(worktree_guard_sacred_home_clone_role "$root_dir" 2>/dev/null || true)"
  if [[ "$lane_name" == "main" ]]; then
    return 0
  fi

  worktree_guard_shared_gateway_targets_root "$root_dir"
}

worktree_guard_require_shared_root_main_branch() {
  local root_dir="$1"
  local branch_name=""

  # Linked worktrees are intentionally allowed to track non-main branches; the
  # danger is the canonical shared checkout that the long-lived Jarvis gateway
  # LaunchAgent points at.
  if worktree_guard_is_linked_checkout "$root_dir"; then
    return 0
  fi

  if ! worktree_guard_shared_gateway_targets_root "$root_dir"; then
    return 0
  fi

  if [[ "${OPENCLAW_ALLOW_SHARED_ROOT_BRANCH_DRIFT:-0}" == "1" ]]; then
    return 0
  fi

  if [[ "${OPENCLAW_ALLOW_SACRED_HOME_HOTFIX:-0}" == "1" ]]; then
    worktree_guard_forbid_sacred_home_checkout_drift "$root_dir" "shared-runtime" || return 1
    return 0
  fi

  branch_name="$(git -C "$root_dir" branch --show-current 2>/dev/null || true)"
  if [[ -z "$branch_name" || "$branch_name" == "main" ]]; then
    return 0
  fi

  cat >&2 <<EOF
ERROR: shared root checkout is on '${branch_name}', but ai.openclaw.gateway is pinned to:
  ${root_dir}/dist/index.js

This checkout owns the shared local Jarvis runtime. Runtime operations still
require this sacred home clone to be on 'main'. Do not park feature branches
here. Restore 'main', fast-forward it, then do implementation work in a temp
worktree instead.

Create a temporary worktree instead:
  oc-main-task <feature-name>

Only a true runtime hotfix may bypass this, and only from 'main':
  OPENCLAW_ALLOW_SACRED_HOME_HOTFIX=1
EOF
  return 1
}

worktree_guard_is_shared_root_main_checkout() {
  local root_dir="$1"
  local branch_name=""

  if worktree_guard_is_linked_checkout "$root_dir"; then
    return 1
  fi

  if ! worktree_guard_is_canonical_shared_root "$root_dir"; then
    return 1
  fi

  branch_name="$(git -C "$root_dir" branch --show-current 2>/dev/null || true)"
  [[ "$branch_name" == "main" ]]
}

worktree_guard_list_tracked_changes() {
  local root_dir="$1"
  local mode="${2:-worktree}"

  case "$mode" in
    staged)
      git -C "$root_dir" diff --cached --name-only --
      ;;
    worktree)
      {
        git -C "$root_dir" diff --name-only --
        git -C "$root_dir" diff --cached --name-only --
      } | awk 'NF && !seen[$0]++'
      ;;
    *)
      printf 'Unknown worktree guard mode: %s\n' "$mode" >&2
      return 2
      ;;
  esac
}

worktree_guard_reject_shared_root_main_edits() {
  worktree_guard_reject_sacred_home_edits "$@"
}

worktree_guard_forbid_shared_root_main_commits() {
  local root_dir="$1"

  if ! worktree_guard_is_shared_root_main_checkout "$root_dir"; then
    return 0
  fi

  worktree_guard_forbid_sacred_home_commit "$root_dir"
}

# Backward-compatible alias: some local lanes may still call the pluralized
# name while the repo standardizes on the singular helper.
worktree_guard_forbid_sacred_home_commits() {
  worktree_guard_forbid_sacred_home_commit "$@"
}
