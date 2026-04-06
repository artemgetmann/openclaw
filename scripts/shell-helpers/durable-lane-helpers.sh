#!/usr/bin/env bash
# Durable lane entry helpers for shared main / consumer worktrees.
#
# Source this from your shell rc so `wt-main` / `wt-consumer` can change the
# current shell directory and warn when you manually enter a stale durable lane:
#   source /absolute/path/to/openclaw/scripts/shell-helpers/durable-lane-helpers.sh

if [[ -n "${OPENCLAW_DURABLE_LANE_HELPERS_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
export OPENCLAW_DURABLE_LANE_HELPERS_LOADED=1

_openclaw_durable_lane_repo_candidates() {
  if [[ -n "${OPENCLAW_REPO_ROOT:-}" ]]; then
    printf '%s\n' "$OPENCLAW_REPO_ROOT"
  fi

  printf '%s\n' \
    "$HOME/Programming_Projects/openclaw" \
    "$HOME/Projects/openclaw" \
    "$HOME/openclaw"
}

_openclaw_durable_lane_repo_root() {
  local candidate=""

  for candidate in $(_openclaw_durable_lane_repo_candidates); do
    [[ -d "$candidate/.git" || -f "$candidate/package.json" ]] || continue
    if [[ -f "$candidate/scripts/lib/worktree-guards.sh" ]]; then
      printf '%s\n' "$(cd "$candidate" && pwd -P)"
      return 0
    fi
  done

  return 1
}

_openclaw_durable_lane_require_repo_root() {
  local repo_root=""

  if ! repo_root="$(_openclaw_durable_lane_repo_root)"; then
    echo "Error: could not locate the OpenClaw repo root for durable lane helpers." >&2
    echo "Set OPENCLAW_REPO_ROOT or source this file from the canonical checkout." >&2
    return 1
  fi

  printf '%s\n' "$repo_root"
}

_openclaw_durable_lane_branch_ref() {
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

_openclaw_durable_lane_wrapper_name() {
  local branch_name="$1"

  if [[ "$branch_name" == "main" ]]; then
    printf 'wt-main'
    return 0
  fi

  if [[ "$branch_name" == "codex/consumer-openclaw-project" ]]; then
    printf 'wt-consumer'
    return 0
  fi

  return 1
}

_openclaw_find_durable_lane_path() {
  local repo_root="$1"
  local branch_name="$2"
  local line=""
  local path_line=""
  local branch_line=""
  local matches=()

  while IFS= read -r line; do
    if [[ "$line" == worktree\ * ]]; then
      path_line="${line#worktree }"
      branch_line=""
      continue
    fi

    if [[ "$line" == branch\ refs/heads/* ]]; then
      branch_line="${line#branch refs/heads/}"
      if [[ -n "$path_line" && "$branch_line" == "$branch_name" ]]; then
        matches+=("$path_line")
      fi
      continue
    fi

    if [[ -z "$line" ]]; then
      path_line=""
      branch_line=""
    fi
  done < <(git -C "$repo_root" worktree list --porcelain)

  if [[ "${#matches[@]}" == "1" ]]; then
    printf '%s\n' "${matches[0]}"
    return 0
  fi

  if [[ "${#matches[@]}" -gt "1" ]]; then
    echo "Error: multiple durable lane candidates found for ${branch_name}:" >&2
    printf '  %s\n' "${matches[@]}" >&2
    echo "Set OPENCLAW_REPO_ROOT and clean up duplicate durable lanes before using the wrapper." >&2
    return 1
  fi

  echo "Error: no linked worktree found for durable lane branch ${branch_name}." >&2
  echo "Create or reattach the durable lane first, then retry." >&2
  return 1
}

_openclaw_enter_durable_lane() {
  local lane_name="$1"
  local repo_root=""
  local branch_name=""
  local lane_path=""
  local counts=""
  local ahead=0
  local behind=0

  repo_root="$(_openclaw_durable_lane_require_repo_root)" || return 1
  branch_name="$(_openclaw_durable_lane_branch_ref "$lane_name")" || {
    echo "Error: unknown durable lane ${lane_name}" >&2
    return 1
  }
  lane_path="$(_openclaw_find_durable_lane_path "$repo_root" "$branch_name")" || return 1

  # Fetch first so we compare against real origin truth, not whichever remote
  # refs happened to be cached from a previous session.
  git -C "$lane_path" fetch --quiet origin "$branch_name" || {
    echo "Error: failed to fetch origin/${branch_name} for ${lane_path}" >&2
    return 1
  }

  counts="$(git -C "$lane_path" rev-list --left-right --count "${branch_name}...origin/${branch_name}")" || {
    echo "Error: could not compare ${branch_name} with origin/${branch_name}" >&2
    return 1
  }
  read -r ahead behind <<<"$counts"

  if [[ "$ahead" != "0" ]]; then
    echo "Error: ${lane_path} is ahead of origin/${branch_name}; refusing wrapper entry." >&2
    echo "Ahead: ${ahead}" >&2
    echo "Behind: ${behind}" >&2
    echo "This lane must stay fast-forwardable. Push/merge or reset it intentionally before reuse." >&2
    return 1
  fi

  if [[ "$behind" != "0" ]]; then
    git -C "$lane_path" merge --ff-only "origin/${branch_name}" || {
      echo "Error: fast-forward failed for ${lane_path}" >&2
      return 1
    }
  fi

  builtin cd "$lane_path" || return 1

  printf 'branch=%s\n' "$branch_name"
  printf 'worktree=%s\n' "$lane_path"
  printf 'head=%s\n' "$(git -C "$lane_path" rev-parse HEAD)"
  if [[ -n "$(git -C "$lane_path" status --short)" ]]; then
    printf 'status_dirty=yes\n'
  else
    printf 'status_dirty=no\n'
  fi
}

wt-main() {
  _openclaw_enter_durable_lane main
}

wt-consumer() {
  _openclaw_enter_durable_lane consumer
}

_openclaw_warn_if_current_durable_lane_stale() {
  local repo_root=""
  local guards_path=""
  local current_root=""
  local cache_key=""
  local current_branch=""

  if ! current_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    return 0
  fi
  current_root="$(cd "$current_root" && pwd -P)"
  cache_key="$current_root"

  if [[ "${OPENCLAW_DURABLE_LANE_LAST_WARN_ROOT:-}" == "$cache_key" ]]; then
    return 0
  fi
  export OPENCLAW_DURABLE_LANE_LAST_WARN_ROOT="$cache_key"

  repo_root="$(_openclaw_durable_lane_require_repo_root 2>/dev/null)" || return 0
  guards_path="$repo_root/scripts/lib/worktree-guards.sh"
  [[ -f "$guards_path" ]] || return 0
  # shellcheck source=scripts/lib/worktree-guards.sh
  source "$guards_path"

  current_branch="$(worktree_guard_current_branch "$current_root")"
  worktree_guard_durable_lane_upstream "$current_branch" >/dev/null 2>&1 || return 0
  worktree_guard_warn_if_durable_lane_stale "$current_root" || true
}

if [[ -n "${ZSH_VERSION:-}" ]]; then
  autoload -U add-zsh-hook 2>/dev/null || true
  if command -v add-zsh-hook >/dev/null 2>&1; then
    add-zsh-hook chpwd _openclaw_warn_if_current_durable_lane_stale
  fi
elif [[ -n "${BASH_VERSION:-}" ]]; then
  if [[ "${PROMPT_COMMAND:-}" != *"_openclaw_warn_if_current_durable_lane_stale"* ]]; then
    if [[ -n "${PROMPT_COMMAND:-}" ]]; then
      PROMPT_COMMAND="_openclaw_warn_if_current_durable_lane_stale; ${PROMPT_COMMAND}"
    else
      PROMPT_COMMAND="_openclaw_warn_if_current_durable_lane_stale"
    fi
  fi
fi
