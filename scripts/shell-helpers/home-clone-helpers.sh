#!/usr/bin/env bash
# Home-clone entry helpers for the two default OpenClaw branch homes.
#
# Source this from your shell rc so `oc-main` / `oc-consumer` can update the
# clone safely, then cd your current shell into it:
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

oc-main() {
  _openclaw_enter_home_clone main
}

oc-consumer() {
  _openclaw_enter_home_clone consumer
}
