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
  local absolute_root=""
  local candidate=""

  absolute_root="$(cd "$root_dir" && pwd -P)"
  for candidate in \
    "$HOME/Programming_Projects/openclaw" \
    "$HOME/Projects/openclaw"; do
    if [[ -d "$candidate" ]] && [[ "$absolute_root" == "$(cd "$candidate" && pwd -P)" ]]; then
      return 0
    fi
  done

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

  if [[ "${OPENCLAW_ALLOW_SHARED_ROOT_BRANCH_DRIFT:-0}" == "1" ]]; then
    return 0
  fi

  if ! worktree_guard_shared_gateway_targets_root "$root_dir"; then
    return 0
  fi

  branch_name="$(git -C "$root_dir" branch --show-current 2>/dev/null || true)"
  if [[ -z "$branch_name" || "$branch_name" == "main" ]]; then
    return 0
  fi

  cat >&2 <<EOF
ERROR: shared root checkout is on '${branch_name}', but ai.openclaw.gateway is pinned to:
  ${root_dir}/dist/index.js

This checkout owns the shared local Jarvis runtime. Keep it on 'main'.
For consumer or feature work, create a worktree instead:
  bash scripts/new-worktree.sh <feature-name> --base codex/consumer-openclaw-project

If you intentionally need to bypass this guard, set:
  OPENCLAW_ALLOW_SHARED_ROOT_BRANCH_DRIFT=1
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
  local root_dir="$1"
  local mode="${2:-worktree}"
  shift 2 || true

  local override="${OPENCLAW_ALLOW_SHARED_ROOT_MAIN_EDITS:-0}"
  local -a paths=()
  local path=""
  local context_label=""

  if [[ "$override" == "1" ]]; then
    return 0
  fi

  if ! worktree_guard_is_shared_root_main_checkout "$root_dir"; then
    return 0
  fi

  if [[ "$#" -gt 0 && "$1" == --context ]]; then
    context_label="${2:-}"
    shift 2 || true
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
ERROR: tracked edits are blocked in the canonical shared main checkout.

Checkout: ${root_dir}
Branch:   main
${context_label:+Context:  ${context_label}
}
Detected paths:
$(printf '  %s\n' "${paths[@]}")

Move this work into a worktree before continuing:
  bash scripts/new-worktree.sh <feature-name> --base main

If you absolutely must bypass this guard, set:
  OPENCLAW_ALLOW_SHARED_ROOT_MAIN_EDITS=1
EOF
  return 1
}

worktree_guard_forbid_shared_root_main_commits() {
  local root_dir="$1"

  if [[ "${OPENCLAW_ALLOW_SHARED_ROOT_COMMITS:-0}" == "1" ]] || \
    [[ "${OPENCLAW_ALLOW_SHARED_ROOT_MAIN_EDITS:-0}" == "1" ]]; then
    return 0
  fi

  if ! worktree_guard_is_shared_root_main_checkout "$root_dir"; then
    return 0
  fi

  cat >&2 <<EOF
ERROR: refusing commit from the canonical shared main checkout:
  ${root_dir}

This checkout owns ai.openclaw.gateway. Code work must happen in a worktree so
we do not dirty the live runtime while other agents are running.

Create one instead:
  bash scripts/new-worktree.sh <feature-name> --base main

If you intentionally need to bypass this once, set:
  OPENCLAW_ALLOW_SHARED_ROOT_COMMITS=1
EOF
  return 1
}
