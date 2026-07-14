#!/usr/bin/env bash
set -euo pipefail

PLISTBUDDY_BIN="${OPENCLAW_PLISTBUDDY_BIN:-/usr/libexec/PlistBuddy}"
LAUNCHCTL_BIN="${OPENCLAW_LAUNCHCTL_BIN:-/bin/launchctl}"
LAUNCH_AGENTS_DIR="${OPENCLAW_WORKTREE_GC_LAUNCH_AGENTS_DIR:-${HOME}/Library/LaunchAgents}"
LAUNCH_AGENT_QUARANTINE_DIR="${OPENCLAW_WORKTREE_GC_QUARANTINE_DIR:-${LAUNCH_AGENTS_DIR}/openclaw-worktree-gc-disabled-$(date +%Y%m%d-%H%M%S)-$$}"

# Read one explicit plist field. Missing fields are intentionally empty: GC
# requires positive ownership evidence and never falls back to a filename or a
# broad label pattern when deciding that it may retire a service.
plist_value() {
  local plist_path="$1"
  local key_path="$2"
  "$PLISTBUDDY_BIN" -c "Print :${key_path}" "$plist_path" 2>/dev/null || true
}

# These labels own canonical/shared product services. Preserve them even if a
# malformed plist happens to contain a worktree path; GC is not a runtime repair
# tool and therefore has no authority to unload a canonical service.
is_preserved_launchagent_label() {
  case "$1" in
    ai.jarvis.gateway|\
    ai.openclaw.gateway|\
    ai.openclaw.gateway-watchdog|\
    ai.openclaw.consumer.mac)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# Use a slash boundary so /tmp/lane does not claim /tmp/lane-old. Git worktree
# paths are physically normalized, while launchd may preserve a lexical macOS
# alias such as /var instead of /private/var. Resolve existing candidates before
# comparison so that harmless filesystem aliases do not hide an owned service.
# Missing candidates remain lexical; guessing how a nonexistent path would
# resolve could create false ownership.
path_belongs_to_worktree() {
  local candidate="$1"
  local worktree_path="$2"
  local candidate_parent=""
  local candidate_name=""
  local normalized_candidate=""

  [[ -n "$candidate" ]] || return 1

  if [[ -d "$candidate" ]]; then
    normalized_candidate="$(cd "$candidate" 2>/dev/null && pwd -P)" || normalized_candidate=""
  elif [[ -e "$candidate" || -L "$candidate" ]]; then
    candidate_parent="$(dirname "$candidate")"
    candidate_name="$(basename "$candidate")"
    normalized_candidate="$(cd "$candidate_parent" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$candidate_name")" || normalized_candidate=""
  fi
  if [[ -n "$normalized_candidate" ]]; then
    candidate="$normalized_candidate"
  fi

  [[ "$candidate" == "$worktree_path" || "$candidate" == "$worktree_path/"* ]]
}

# A plist belongs to a removable consumer/test lane only when all independent
# signals agree:
#   1. its label, profile, and instance id exactly match the generated identity
#      contract for a named consumer lane;
#   2. its explicit Label matches OPENCLAW_LAUNCHD_LABEL;
#   3. ProgramArguments contain the gateway subcommand; and
#   4. WorkingDirectory or one ProgramArgument is inside this exact worktree.
#
# Requiring exact identity agreement matters: OPENCLAW_CONSUMER_INSTANCE_ID is
# ordinary environment metadata that may also appear in a custom developer
# service. It is not, by itself, authority to unload that service. A stale job
# we cannot prove ownership for is noisy, but unloading somebody else's service
# is worse.
worktree_owns_consumer_gateway_plist() {
  local plist_path="$1"
  local worktree_path="$2"
  local label=""
  local env_label=""
  local instance_id=""
  local profile=""
  local expected_label=""
  local expected_profile=""
  local working_directory=""
  local arg=""
  local index=0
  local has_gateway_subcommand=0
  local has_worktree_path=0

  label="$(plist_value "$plist_path" "Label")"
  env_label="$(plist_value "$plist_path" "EnvironmentVariables:OPENCLAW_LAUNCHD_LABEL")"
  [[ -n "$label" && "$env_label" == "$label" ]] || return 1
  is_preserved_launchagent_label "$label" && return 1

  instance_id="$(plist_value "$plist_path" "EnvironmentVariables:OPENCLAW_CONSUMER_INSTANCE_ID")"
  profile="$(plist_value "$plist_path" "EnvironmentVariables:OPENCLAW_PROFILE")"
  [[ -n "$instance_id" ]] || return 1
  expected_label="ai.openclaw.consumer.${instance_id}.gateway"
  expected_profile="consumer-${instance_id}"
  [[ "$label" == "$expected_label" && "$profile" == "$expected_profile" ]] || return 1

  working_directory="$(plist_value "$plist_path" "WorkingDirectory")"
  if path_belongs_to_worktree "$working_directory" "$worktree_path"; then
    has_worktree_path=1
  fi

  while true; do
    arg="$(plist_value "$plist_path" "ProgramArguments:${index}")"
    [[ -n "$arg" ]] || break
    [[ "$arg" == "gateway" ]] && has_gateway_subcommand=1
    if path_belongs_to_worktree "$arg" "$worktree_path"; then
      has_worktree_path=1
    fi
    index=$((index + 1))
  done

  [[ "$has_gateway_subcommand" == "1" && "$has_worktree_path" == "1" ]]
}

# Put a quarantined plist back without overwriting anything that appeared while
# launchctl was being queried. This helper deliberately reports but does not
# hide restore failure; its caller always preserves the worktree either way.
restore_quarantined_launchagent() {
  local plist_path="$1"
  local destination="$2"
  local label="$3"
  local worktree_path="$4"
  local failure_reason="$5"

  if [[ -e "$plist_path" || -L "$plist_path" ]]; then
    echo "Error: ${failure_reason} for ${label}; ${plist_path} reappeared, so quarantined copy remains at ${destination}; preserving worktree: ${worktree_path}" >&2
  elif mv "$destination" "$plist_path"; then
    echo "Error: ${failure_reason} for ${label}; restored plist and preserved worktree: ${worktree_path}" >&2
  else
    echo "Error: ${failure_reason} for ${label} and could not restore ${plist_path}; quarantined copy remains at ${destination}; preserving worktree: ${worktree_path}" >&2
  fi
}

# launchctl print has three materially different outcomes. Success proves the
# job is loaded. A failure proves absence only when launchctl explicitly names
# this label in its service-not-found diagnostic. Domain, permission, and
# transient failures are ambiguous and must block worktree deletion.
launchctl_print_confirms_service_absent() {
  local output="$1"
  local label="$2"
  [[ "$output" == *"Could not find service \"${label}\""* ]]
}

# Quarantine and boot out only gateway plists positively owned by this
# worktree. Moving the plist is the first mutation: if quarantine fails, the
# service stays exactly as it was and worktree deletion is blocked. Once moved,
# a loaded job must then boot out successfully; otherwise the plist is restored
# and worktree deletion is blocked. An already-unloaded job needs no bootout.
# The move is reversible by restoring the plist manually.
retire_worktree_consumer_launchagents() {
  local worktree_path="$1"
  local plist_path=""
  local label=""
  local destination=""
  local launchctl_target=""
  local launchctl_print_output=""
  local found=0

  [[ -d "$LAUNCH_AGENTS_DIR" ]] || return 0

  while IFS= read -r -d '' plist_path; do
    if ! worktree_owns_consumer_gateway_plist "$plist_path" "$worktree_path"; then
      continue
    fi

    found=1
    label="$(plist_value "$plist_path" "Label")"
    destination="${LAUNCH_AGENT_QUARANTINE_DIR}/$(basename "$plist_path")"

    if ! mkdir -p "$LAUNCH_AGENT_QUARANTINE_DIR"; then
      echo "Error: cannot create LaunchAgent quarantine; preserving worktree: ${worktree_path}" >&2
      return 1
    fi

    # Never overwrite an older quarantine artifact. Losing the previous plist
    # would make this cleanup destructive instead of reversible.
    if [[ -e "$destination" || -L "$destination" ]]; then
      echo "Error: quarantine destination already exists for ${label}; preserving worktree: ${worktree_path}" >&2
      return 1
    fi

    if ! mv "$plist_path" "$destination"; then
      echo "Error: could not quarantine ${label}; preserving worktree: ${worktree_path}" >&2
      return 1
    fi

    # launchd caches loaded job definitions independently of the plist file. If
    # the job is still loaded, moving the plist alone cannot stop a KeepAlive
    # loop. Only an explicit service-not-found result proves bootout is
    # unnecessary; every other print failure is ambiguous and fails closed.
    launchctl_target="gui/$(id -u)/${label}"
    if launchctl_print_output="$("$LAUNCHCTL_BIN" print "$launchctl_target" 2>&1)"; then
      if ! "$LAUNCHCTL_BIN" bootout "$launchctl_target" >/dev/null 2>&1; then
        restore_quarantined_launchagent \
          "$plist_path" "$destination" "$label" "$worktree_path" "could not boot out loaded service"
        return 1
      fi
    elif ! launchctl_print_confirms_service_absent "$launchctl_print_output" "$label"; then
      restore_quarantined_launchagent \
        "$plist_path" "$destination" "$label" "$worktree_path" "launchctl print failed without service-not-found confirmation"
      return 1
    fi
    echo "Quarantined worktree LaunchAgent: ${label} -> ${destination}"
  done < <(find "$LAUNCH_AGENTS_DIR" -maxdepth 1 -type f -name '*.plist' -print0)

  if [[ "$found" == "1" ]]; then
    echo "Retired consumer/test LaunchAgents owned by: ${worktree_path}"
  fi
}

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

usage() {
  cat <<'EOF'
Usage: scripts/gc-worktrees.sh [--auto] [--include-detached] [--base-branch <branch>]
EOF
}

AUTO=0
INCLUDE_DETACHED=0
BASE_BRANCH="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto)
      AUTO=1
      shift
      ;;
    --include-detached)
      INCLUDE_DETACHED=1
      shift
      ;;
    --base-branch)
      if [[ $# -lt 2 ]]; then
        echo "Error: --base-branch requires a value." >&2
        exit 1
      fi
      BASE_BRANCH="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "Error: run this script from inside a git worktree." >&2
  exit 1
fi

git worktree prune

worktree_output="$(git worktree list --porcelain)"
if [[ -z "$worktree_output" ]]; then
  echo "Error: git worktree list returned no entries." >&2
  exit 1
fi

declare -a block_paths=()
declare -a block_branches=()
declare -a block_detached=()
declare -a block_prunable=()
declare -a display_classes=()
declare -a display_paths=()
declare -a display_tokens=()
declare -a remove_paths=()

finalize_block() {
  if [[ -z "${current_path:-}" ]]; then
    return
  fi
  block_paths+=("$current_path")
  block_branches+=("${current_branch:-}")
  block_detached+=("${current_detached:-0}")
  block_prunable+=("${current_prunable:-0}")
}

current_path=""
current_branch=""
current_detached=0
current_prunable=0

while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ -z "$line" ]]; then
    finalize_block
    current_path=""
    current_branch=""
    current_detached=0
    current_prunable=0
    continue
  fi

  case "$line" in
    worktree\ *)
      current_path="${line#worktree }"
      ;;
    branch\ *)
      current_branch="${line#branch }"
      ;;
    detached)
      current_detached=1
      ;;
    prunable*)
      current_prunable=1
      ;;
  esac
done <<< "$worktree_output"
finalize_block

if (( ${#block_paths[@]} == 0 )); then
  echo "Error: no worktrees parsed from git worktree list." >&2
  exit 1
fi

main_worktree="${block_paths[0]}"
if [[ -d "$main_worktree" ]]; then
  main_worktree="$(cd "$main_worktree" && pwd -P)"
fi
current_worktree="$(git rev-parse --show-toplevel)"
if [[ -d "$current_worktree" ]]; then
  current_worktree="$(cd "$current_worktree" && pwd -P)"
fi

prunable_count=0
merged_count=0
detached_count=0
active_count=0
removed_count=0

for ((i = 1; i < ${#block_paths[@]}; i++)); do
  worktree_path="${block_paths[$i]}"
  branch_ref="${block_branches[$i]}"
  is_detached="${block_detached[$i]}"
  is_prunable="${block_prunable[$i]}"

  normalized_path="$worktree_path"
  if [[ -d "$worktree_path" ]]; then
    normalized_path="$(cd "$worktree_path" && pwd -P)"
  fi

  if [[ "$normalized_path" == "$main_worktree" || "$normalized_path" == "$current_worktree" ]]; then
    continue
  fi

  env_local_path="${normalized_path}/.env.local"
  token_display="-"
  if [[ -f "$env_local_path" ]]; then
    token_value="$(read_last_env_value "$env_local_path" "TELEGRAM_BOT_TOKEN")"
    if [[ -n "$token_value" ]]; then
      token_display="$(mask_token "$token_value")"
    fi
  fi

  class="active"
  should_remove=0

  if [[ "$is_prunable" == "1" ]]; then
    class="prunable"
    prunable_count=$((prunable_count + 1))
    should_remove=1
  elif [[ "$is_detached" == "1" ]]; then
    class="detached"
    detached_count=$((detached_count + 1))
    if [[ "$INCLUDE_DETACHED" == "1" ]]; then
      should_remove=1
    fi
  elif [[ -n "$branch_ref" ]]; then
    if git merge-base --is-ancestor "$branch_ref" "$BASE_BRANCH" >/dev/null 2>&1; then
      class="merged"
      merged_count=$((merged_count + 1))
      should_remove=1
    else
      merge_status=$?
      if [[ "$merge_status" == "128" ]]; then
        class="active"
        active_count=$((active_count + 1))
      else
        class="active"
        active_count=$((active_count + 1))
      fi
    fi
  else
    class="active"
    active_count=$((active_count + 1))
  fi

  display_classes+=("$class")
  display_paths+=("$normalized_path")
  display_tokens+=("$token_display")
  if [[ "$should_remove" == "1" ]]; then
    remove_paths+=("$normalized_path")
  fi
done

printf '%-10s %-18s %s\n' "CLASS" "BOT" "PATH"
for ((i = 0; i < ${#display_paths[@]}; i++)); do
  printf '%-10s %-18s %s\n' \
    "${display_classes[$i]}" \
    "${display_tokens[$i]}" \
    "${display_paths[$i]}"
done

if [[ "$AUTO" == "1" ]]; then
  cleanup_failed_count=0
  for path in "${remove_paths[@]}"; do
    # Retire launchd ownership before either the tester runtime release or Git
    # deletion. If quarantine fails, leave the worktree intact; deleting its
    # entrypoint would turn a recoverable stale service into a KeepAlive loop.
    if ! retire_worktree_consumer_launchagents "$path"; then
      cleanup_failed_count=$((cleanup_failed_count + 1))
      continue
    fi

    env_local_path="${path}/.env.local"
    if [[ -d "$path" && -f "$env_local_path" ]]; then
      claimed_token="$(read_last_env_value "$env_local_path" "TELEGRAM_BOT_TOKEN")"
      if [[ -n "$claimed_token" ]]; then
        (cd "$path" && bash scripts/telegram-live-runtime.sh release) || true
      fi
    fi

    if git worktree remove --force "$path"; then
      removed_count=$((removed_count + 1))
    fi
  done
else
  echo "re-run with --auto to apply."
fi

echo "GC complete: ${prunable_count} prunable, ${merged_count} merged (${removed_count} removed), ${detached_count} detached, ${active_count} active"
if [[ "${cleanup_failed_count:-0}" -gt 0 ]]; then
  echo "Error: ${cleanup_failed_count} worktree(s) preserved because LaunchAgent retirement failed." >&2
  exit 1
fi
