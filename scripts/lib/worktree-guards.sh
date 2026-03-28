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
