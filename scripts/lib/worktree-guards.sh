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

  [[ -f "$plist_path" ]] || return 1
  entry_path="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$plist_path" 2>/dev/null || true)"
  [[ "$entry_path" == "$root_dir/dist/index.js" ]]
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
