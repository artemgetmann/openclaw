#!/usr/bin/env bash
set -euo pipefail

# Trim leading/trailing whitespace for robust .env parsing.
trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Remove one pair of matching outer quotes if present.
strip_outer_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  printf '%s' "$value"
}

# Parse KEY=value (with optional "export") and return the normalized value.
parse_env_assignment() {
  local key="$1"
  local line="$2"
  local parsed=""
  if [[ "$line" =~ ^(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    parsed="$(trim "${BASH_REMATCH[2]}")"
    parsed="$(strip_outer_quotes "$parsed")"
  fi
  printf '%s' "$parsed"
}

# Return the last occurrence of KEY from an env-style file.
read_last_env_value() {
  local file_path="$1"
  local key="$2"
  local line=""
  local trimmed=""
  local parsed=""
  local last_value=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim "$line")"
    if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
      continue
    fi
    parsed="$(parse_env_assignment "$key" "$trimmed")"
    if [[ -n "$parsed" ]]; then
      last_value="$parsed"
    fi
  done < "$file_path"

  printf '%s' "$last_value"
}

# Bash 3-compatible membership test for small token lists.
contains_token() {
  local needle="$1"
  shift
  local candidate=""
  for candidate in "$@"; do
    if [[ "$candidate" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

# Mask token output so logs never leak full credentials.
mask_token() {
  local token="$1"
  local len=${#token}
  if (( len <= 4 )); then
    printf '****'
    return
  fi
  if (( len <= 8 )); then
    printf '%s...%s' "${token:0:1}" "${token:len-1:1}"
    return
  fi
  printf '%s...%s' "${token:0:4}" "${token:len-4:4}"
}

report_claimed_worktrees() {
  local worktree_path=""
  local env_local_path=""
  local token_value=""
  local branch_name=""
  local status_line=""
  local process_count=""

  for worktree_path in "${worktree_paths[@]}"; do
    env_local_path="$worktree_path/.env.local"
    [[ -f "$env_local_path" ]] || continue

    token_value="$(read_last_env_value "$env_local_path" "TELEGRAM_BOT_TOKEN")"
    [[ -n "$token_value" ]] || continue

    branch_name="unknown"
    status_line="missing"
    process_count="0"

    if [[ -d "$worktree_path" ]]; then
      branch_name="$(git -C "$worktree_path" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')"
      if [[ -n "$(git -C "$worktree_path" status --short 2>/dev/null | sed -n '1p')" ]]; then
        status_line="dirty"
      else
        status_line="clean"
      fi
      process_count="$(
        ps -axo command= | awk -v needle="$worktree_path" 'index($0, needle) > 0 { count++ } END { print count + 0 }'
      )"
    fi

    echo "  worktree=$worktree_path branch=$branch_name status=$status_line live_processes=$process_count token=$(mask_token "$token_value")" >&2
  done
}

if [[ ! -r ".env.bots" ]]; then
  echo "Error: .env.bots not found or not readable in $(pwd)." >&2
  echo "Create it from .env.bots.example and add BOT_TOKEN entries." >&2
  exit 1
fi

bot_tokens=()
line=""
trimmed=""
parsed=""
while IFS= read -r line || [[ -n "$line" ]]; do
  trimmed="$(trim "$line")"
  if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
    continue
  fi
  parsed="$(parse_env_assignment "BOT_TOKEN" "$trimmed")"
  if [[ -n "$parsed" ]]; then
    bot_tokens+=("$parsed")
  fi
done < ".env.bots"

if (( ${#bot_tokens[@]} == 0 )); then
  echo "Error: no valid BOT_TOKEN entries found in .env.bots." >&2
  exit 1
fi

worktree_paths=()
current_worktree="$(pwd -P)"
worktree_list_output=""
if ! worktree_list_output="$(git worktree list --porcelain 2>/dev/null)"; then
  echo "Error: unable to list git worktrees from $(pwd)." >&2
  echo "Run this script from within a git worktree." >&2
  exit 1
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == worktree\ * ]]; then
    worktree_paths+=("${line#worktree }")
  fi
done <<< "$worktree_list_output"

claimed_tokens=()
other_claimed_tokens=()
current_claimed_token=""
worktree_path=""
env_local_path=""
claimed=""
for worktree_path in "${worktree_paths[@]-}"; do
  env_local_path="$worktree_path/.env.local"
  if [[ ! -f "$env_local_path" ]]; then
    continue
  fi
  claimed="$(read_last_env_value "$env_local_path" "TELEGRAM_BOT_TOKEN")"
  if [[ -n "$claimed" ]]; then
    claimed_tokens+=("$claimed")
    if [[ "$worktree_path" == "$current_worktree" ]]; then
      current_claimed_token="$claimed"
    else
      other_claimed_tokens+=("$claimed")
    fi
  fi
done

# Reuse the current worktree's token when it already owns a unique claim from
# the shared pool. Without this, follow-up `ensure` runs fail after a successful
# first claim just because the pool is fully allocated again.
if [[ -n "$current_claimed_token" ]] && contains_token "$current_claimed_token" "${bot_tokens[@]-}"; then
  if ! contains_token "$current_claimed_token" "${other_claimed_tokens[@]-}"; then
    printf 'TELEGRAM_BOT_TOKEN=%s\n' "$current_claimed_token" > ".env.local"
    echo "Reusing Telegram bot token for current worktree: $current_worktree"
    echo "Token fingerprint: $(mask_token "$current_claimed_token")"
    exit 0
  fi
  echo "Error: current worktree token is also claimed by another worktree." >&2
  echo "Resolve the duplicate .env.local claim before reusing this bot." >&2
  echo "Claimed worktrees:" >&2
  report_claimed_worktrees
  exit 1
fi

selected_token=""
selected_index=0
idx=0
for idx in "${!bot_tokens[@]}"; do
  if ! contains_token "${bot_tokens[$idx]}" "${other_claimed_tokens[@]-}"; then
    selected_token="${bot_tokens[$idx]}"
    selected_index=$((idx + 1))
    break
  fi
done

if [[ -z "$selected_token" ]]; then
  echo "Error: no unclaimed bot tokens available." >&2
  echo "Claimed: ${#claimed_tokens[@]} / Total: ${#bot_tokens[@]}" >&2
  echo "Delete an unused worktree .env.local to free a token." >&2
  echo "Claimed worktrees:" >&2
  report_claimed_worktrees
  echo "Safe release candidates are usually worktrees with status=clean and live_processes=0." >&2
  exit 1
fi

printf 'TELEGRAM_BOT_TOKEN=%s\n' "$selected_token" > ".env.local"

echo "Assigned Telegram bot token #$selected_index to worktree: $(pwd -P)"
echo "Token fingerprint: $(mask_token "$selected_token")"
