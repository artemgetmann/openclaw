#!/usr/bin/env bash
# Home-clone entry helpers for the two sacred OpenClaw branch homes.
#
# Source this from your shell rc so the wrappers can refresh the sacred home
# clone safely, then either enter it or spawn a temp worktree from it:
#   source /absolute/path/to/openclaw/scripts/shell-helpers/home-clone-helpers.sh

if [[ -n "${OPENCLAW_HOME_CLONE_HELPERS_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
export OPENCLAW_HOME_CLONE_HELPERS_LOADED=1

_openclaw_home_clone_path() {
  local target="$1"

  case "$target" in
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

_openclaw_home_clone_branch() {
  local target="$1"

  case "$target" in
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

_openclaw_require_clean_base_clone() {
  local clone_path="$1"
  local expected_branch="$2"
  local current_branch=""

  if [[ ! -d "$clone_path/.git" ]]; then
    echo "Error: expected home clone not found: $clone_path" >&2
    return 1
  fi

  current_branch="$(git -C "$clone_path" branch --show-current 2>/dev/null || true)"
  if [[ "$current_branch" != "$expected_branch" ]]; then
    cat >&2 <<EOF
Error: home clone is on '${current_branch:-<detached>}' instead of '${expected_branch}'.

Checkout: ${clone_path}

Home clones stay on their base branch between tasks. Finish or move any active
feature branch work first, then restore this clone to:
  git checkout ${expected_branch}
  git pull --ff-only origin ${expected_branch}
EOF
    return 1
  fi

  if [[ -n "$(git -C "$clone_path" status --short)" ]]; then
    cat >&2 <<EOF
Error: home clone is dirty and cannot be refreshed safely.

Checkout: ${clone_path}
Branch:   ${expected_branch}

Commit, move, or discard the local changes first. Base branches are pull-only.
EOF
    return 1
  fi
}

_openclaw_enter_home_clone() {
  local target="$1"
  local clone_path=""
  local base_branch=""

  clone_path="$(_openclaw_home_clone_path "$target")" || {
    echo "Error: unknown home clone target '$target'" >&2
    return 1
  }
  clone_path="$(cd "$clone_path" 2>/dev/null && pwd -P)" || {
    echo "Error: could not resolve home clone path: $clone_path" >&2
    return 1
  }
  base_branch="$(_openclaw_home_clone_branch "$target")" || return 1

  # Enforce the intended low-overhead state: the home clone sits on the base
  # branch, clean, and can be fast-forwarded before a new task starts.
  _openclaw_require_clean_base_clone "$clone_path" "$base_branch" || return 1
  git -C "$clone_path" pull --ff-only origin "$base_branch" || return 1

  builtin cd "$clone_path" || return 1

  printf 'branch=%s\n' "$base_branch"
  printf 'checkout=%s\n' "$clone_path"
  printf 'head=%s\n' "$(git -C "$clone_path" rev-parse HEAD)"
  printf 'status_dirty=no\n'
}

_openclaw_spawn_task_lane() {
  local target="$1"
  shift

  local base_branch=""
  local output=""
  local status=0
  local worktree_path=""
  local lane_ready=""
  local arg=""

  if [[ "$#" -lt 1 ]]; then
    echo "Error: feature name is required." >&2
    echo "Usage: $(if [[ "$target" == "main" ]]; then printf 'oc-main-task'; else printf 'oc-consumer-task'; fi) <feature-name> [scripts/new-worktree.sh args]" >&2
    return 1
  fi

  base_branch="$(_openclaw_home_clone_branch "$target")" || return 1

  for arg in "$@"; do
    if [[ "$arg" == "--base" ]]; then
      echo "Error: --base is fixed by the sacred home clone wrapper. Use oc-main-task or oc-consumer-task without overriding the base branch." >&2
      return 1
    fi
  done

  _openclaw_enter_home_clone "$target" >/dev/null || return 1

  if output="$(bash scripts/new-worktree.sh "$@" --base "$base_branch" 2>&1)"; then
    printf '%s\n' "$output"
  else
    status=$?
    printf '%s\n' "$output" >&2
    return "$status"
  fi

  worktree_path="$(printf '%s\n' "$output" | sed -n 's/^worktree=//p' | tail -n 1)"
  lane_ready="$(printf '%s\n' "$output" | sed -n 's/^lane_ready=//p' | tail -n 1)"
  if [[ -z "$worktree_path" ]]; then
    echo "Error: could not parse worktree path from scripts/new-worktree.sh output." >&2
    return 1
  fi
  if [[ "$lane_ready" != "yes" ]]; then
    echo "Error: scripts/new-worktree.sh did not prove lane readiness; refusing handoff." >&2
    return 1
  fi

  builtin cd "$worktree_path" || return 1
  printf 'entered_worktree=%s\n' "$worktree_path"
}

oc-main() {
  _openclaw_enter_home_clone main
}

oc-consumer() {
  _openclaw_enter_home_clone consumer
}

oc-main-task() {
  _openclaw_spawn_task_lane main "$@"
}

oc-consumer-task() {
  _openclaw_spawn_task_lane consumer "$@"
}

# Backward-compatible aliases for older shell setups that still use the lane
# naming. Keep the task names as the primary workflow surface.
oc-main-lane() {
  oc-main-task "$@"
}

oc-consumer-lane() {
  oc-consumer-task "$@"
}
