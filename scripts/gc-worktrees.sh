#!/usr/bin/env bash
set -euo pipefail

PLISTBUDDY_BIN="${OPENCLAW_PLISTBUDDY_BIN:-/usr/libexec/PlistBuddy}"
LAUNCHCTL_BIN="${OPENCLAW_LAUNCHCTL_BIN:-/bin/launchctl}"
FIND_BIN="${OPENCLAW_FIND_BIN:-/usr/bin/find}"
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

# Missing optional fields are normal and handled by plist_value. Failure to
# read/parse the plist root is different: ownership and reference attribution
# become unknowable, so GC must preserve every candidate worktree.
plist_is_readable_and_parseable() {
  local plist_path="$1"
  [[ -r "$plist_path" ]] || return 1
  "$PLISTBUDDY_BIN" -c "Print" "$plist_path" >/dev/null 2>&1
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
  else
    # These are stable macOS filesystem aliases. They cannot be resolved with
    # pwd -P after the target disappears, but Git records their physical
    # /private paths. Limit lexical fallback to these exact system aliases;
    # arbitrary nonexistent symlinks remain untrusted.
    case "$candidate" in
      /var|/var/*|/tmp|/tmp/*|/etc|/etc/*)
        candidate="/private${candidate}"
        ;;
    esac
  fi

  [[ "$candidate" == "$worktree_path" || "$candidate" == "$worktree_path/"* ]]
}

# Detect a worktree reference independently from retirement authorization. A
# service can be unsafe to ignore even when its label or consumer metadata is
# malformed, custom, or explicitly preserved.
plist_references_worktree() {
  local plist_path="$1"
  local worktree_path="$2"
  local working_directory=""
  local arg=""
  local index=0

  working_directory="$(plist_value "$plist_path" "WorkingDirectory")"
  path_belongs_to_worktree "$working_directory" "$worktree_path" && return 0

  while true; do
    arg="$(plist_value "$plist_path" "ProgramArguments:${index}")"
    [[ -n "$arg" ]] || break
    path_belongs_to_worktree "$arg" "$worktree_path" && return 0
    index=$((index + 1))
  done
  return 1
}

# A referencing plist is authorized for retirement only when all independent
# identity and command signals agree:
#   1. its label, profile, and instance id exactly match the generated identity
#      contract for a named consumer lane;
#   2. its explicit Label matches OPENCLAW_LAUNCHD_LABEL;
#   3. ProgramArguments contain the gateway subcommand; and
#   4. the plist references this exact worktree.
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
  local arg=""
  local index=0
  local has_gateway_subcommand=0

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

  while true; do
    arg="$(plist_value "$plist_path" "ProgramArguments:${index}")"
    [[ -n "$arg" ]] || break
    [[ "$arg" == "gateway" ]] && has_gateway_subcommand=1
    index=$((index + 1))
  done

  [[ "$has_gateway_subcommand" == "1" ]] || return 1
  plist_references_worktree "$plist_path" "$worktree_path"
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

  # A missing worktree has no safe service state to restore. Keep the plist
  # quarantined so neither this session nor the next login can restart a
  # KeepAlive job against an entrypoint that is already gone.
  if [[ ! -d "$worktree_path" ]]; then
    echo "Error: ${failure_reason} for ${label}; worktree entrypoint is missing, so quarantined copy remains at ${destination}: ${worktree_path}" >&2
    return
  fi

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

# One GC iteration owns one retirement transaction. Parallel arrays preserve
# paths without delimiter parsing, and loaded-state records whether rollback
# must bootstrap the service after restoring its plist.
declare -a retired_launchagent_sources=()
declare -a retired_launchagent_destinations=()
declare -a retired_launchagent_labels=()
declare -a retired_launchagent_was_loaded=()
declare -a retired_launchagent_markers=()

reset_launchagent_retirement_record() {
  retired_launchagent_sources=()
  retired_launchagent_destinations=()
  retired_launchagent_labels=()
  retired_launchagent_was_loaded=()
  retired_launchagent_markers=()
}

record_retired_launchagent() {
  retired_launchagent_sources+=("$1")
  retired_launchagent_destinations+=("$2")
  retired_launchagent_labels+=("$3")
  retired_launchagent_was_loaded+=("$4")
  retired_launchagent_markers+=("$5")
}

# Roll back in reverse retirement order. A service that was loaded before GC
# is bootstrapped only after its original plist is safely restored. A service
# confirmed absent stays absent, preserving its pre-GC runtime state.
rollback_retired_launchagents() {
  local worktree_path="$1"
  local rollback_failed=0
  local index=0
  local plist_path=""
  local destination=""
  local label=""
  local was_loaded=0
  local success_marker=""

  [[ "${#retired_launchagent_sources[@]}" -gt 0 ]] || return 0

  # Git removal is expected to leave the lane intact on failure, but do not
  # assume that after an interrupted or partially completed removal. Reloading
  # KeepAlive against a missing entrypoint would recreate the original incident.
  if [[ ! -d "$worktree_path" ]]; then
    echo "Error: cannot roll back LaunchAgents because the worktree directory is missing; quarantined plists remain disabled: ${worktree_path}" >&2
    return 1
  fi

  for ((index = ${#retired_launchagent_sources[@]} - 1; index >= 0; index--)); do
    plist_path="${retired_launchagent_sources[$index]}"
    destination="${retired_launchagent_destinations[$index]}"
    label="${retired_launchagent_labels[$index]}"
    was_loaded="${retired_launchagent_was_loaded[$index]}"
    success_marker="${retired_launchagent_markers[$index]}"

    if [[ -n "$success_marker" && ( -e "$success_marker" || -L "$success_marker" ) ]]; then
      if ! rm -f "$success_marker"; then
        echo "Error: rollback could not remove retirement success marker ${success_marker}" >&2
        rollback_failed=1
        continue
      fi
    fi

    # Never overwrite a plist that appeared after retirement. The worktree is
    # already being preserved, so leaving both copies is the safest outcome.
    if [[ -e "$plist_path" || -L "$plist_path" ]]; then
      echo "Error: rollback refused to overwrite ${plist_path}; quarantined copy remains at ${destination}" >&2
      rollback_failed=1
      continue
    fi
    if ! mv "$destination" "$plist_path"; then
      echo "Error: rollback could not restore ${label} from ${destination}" >&2
      rollback_failed=1
      continue
    fi

    if [[ "$was_loaded" == "1" ]] && ! "$LAUNCHCTL_BIN" bootstrap "gui/$(id -u)" "$plist_path" >/dev/null 2>&1; then
      echo "Error: rollback restored ${label} plist but could not reload its previously loaded service" >&2
      rollback_failed=1
    fi
  done

  if [[ "$rollback_failed" == "1" ]]; then
    echo "Error: LaunchAgent rollback incomplete; preserved worktree: ${worktree_path}" >&2
    return 1
  fi
  if [[ "${#retired_launchagent_sources[@]}" -gt 0 ]]; then
    echo "Rolled back retired LaunchAgents for preserved worktree: ${worktree_path}" >&2
  fi
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
  local inventory_path=""
  local plist_parent=""
  local symlink_target=""
  local existing_plist_path=""
  local duplicate_plist=0
  local quarantine_is_internal=0
  local -a plist_paths=()
  local was_loaded=0
  local success_marker=""
  local found=0

  [[ -d "$LAUNCH_AGENTS_DIR" ]] || return 0

  # Process substitution hides `find` failures from the parent shell. Capture a
  # complete, status-checked inventory first, then delete the temp artifact
  # before touching any plist or launchd job. maxdepth=2 also retains exact-owned
  # evidence from a prior ambiguous quarantine so a retry cannot prune metadata.
  if ! inventory_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-worktree-gc-launchagents.XXXXXX")"; then
    echo "Error: cannot create LaunchAgent inventory; preserving worktree: ${worktree_path}" >&2
    return 1
  fi
  if ! "$FIND_BIN" "$LAUNCH_AGENTS_DIR" -maxdepth 2 \( -type f -o -type l \) -name '*.plist' -print0 > "$inventory_path"; then
    rm -f "$inventory_path" || true
    echo "Error: LaunchAgent inventory failed; preserving worktree: ${worktree_path}" >&2
    return 1
  fi

  # Tests and operators may place quarantine outside LaunchAgents. Scan that
  # configured root explicitly when it exists; otherwise an ambiguous plist
  # would vanish from the next run's evidence and stale Git metadata could be
  # pruned. Internal quarantine is already covered by maxdepth=2 above.
  case "$LAUNCH_AGENT_QUARANTINE_DIR" in
    "$LAUNCH_AGENTS_DIR"|"$LAUNCH_AGENTS_DIR"/*)
      quarantine_is_internal=1
      ;;
  esac
  if [[ "$quarantine_is_internal" == "0" && -d "$LAUNCH_AGENT_QUARANTINE_DIR" ]]; then
    if ! "$FIND_BIN" "$LAUNCH_AGENT_QUARANTINE_DIR" -maxdepth 1 \( -type f -o -type l \) -name '*.plist' -print0 >> "$inventory_path"; then
      rm -f "$inventory_path" || true
      echo "Error: external LaunchAgent quarantine inventory failed; preserving worktree: ${worktree_path}" >&2
      return 1
    fi
  fi

  while IFS= read -r -d '' plist_path; do
    duplicate_plist=0
    # Apple Bash 3.2 treats "${empty_array[@]}" as an unbound variable under
    # `set -u`. Guard the first-item dedupe pass instead of relying on newer
    # Bash behavior that happens to make the same expansion a no-op.
    if (( ${#plist_paths[@]} > 0 )); then
      for existing_plist_path in "${plist_paths[@]}"; do
        if [[ "$existing_plist_path" == "$plist_path" ]]; then
          duplicate_plist=1
          break
        fi
      done
    fi
    [[ "$duplicate_plist" == "1" ]] || plist_paths+=("$plist_path")
  done < "$inventory_path"
  if ! rm -f "$inventory_path"; then
    echo "Error: cannot remove LaunchAgent inventory; preserving worktree: ${worktree_path}" >&2
    return 1
  fi

  # All remaining passes expand the array directly. Return before those passes
  # when inventory is empty so scheduled GC remains safe under Apple Bash 3.2
  # with nounset enabled.
  if (( ${#plist_paths[@]} == 0 )); then
    return 0
  fi

  # `find -type l` inventories the plist link itself without following symlinked
  # directories. A readable target still goes through exact ownership checks.
  # A broken or unreadable plist link is ambiguous and must block deletion: a
  # launchd job may already have cached the definition before the link broke.
  for plist_path in "${plist_paths[@]}"; do
    if [[ -L "$plist_path" && ( ! -e "$plist_path" || ! -r "$plist_path" ) ]]; then
      echo "Error: broken or unreadable LaunchAgent plist symlink at ${plist_path}; preserving worktree: ${worktree_path}" >&2
      return 1
    fi
  done

  # Validate the complete inventory before any field inspection or mutation.
  # plist_value intentionally swallows missing-key failures, so this root read
  # is the fail-closed boundary for corrupt or genuinely unreadable plists.
  for plist_path in "${plist_paths[@]}"; do
    if ! plist_is_readable_and_parseable "$plist_path"; then
      echo "Error: LaunchAgent plist is unreadable or invalid at ${plist_path}; preserving worktree: ${worktree_path}" >&2
      return 1
    fi
  done

  # Reference detection is deliberately broader than retirement authority. A
  # canonical, custom, or malformed service that points into this lane cannot
  # be unloaded by GC, but deleting its entrypoint would still create a cached
  # KeepAlive loop. Preserve the worktree and require manual ownership repair.
  for plist_path in "${plist_paths[@]}"; do
    if plist_references_worktree "$plist_path" "$worktree_path" && ! worktree_owns_consumer_gateway_plist "$plist_path" "$worktree_path"; then
      echo "Error: LaunchAgent references worktree without authorized consumer gateway identity: ${plist_path}; preserving worktree: ${worktree_path}" >&2
      return 1
    fi
  done

  # A nested exact-owned plist is a durable record of an earlier ambiguous or
  # incomplete retirement unless it has the success receipt written only after
  # confirmed absence or successful bootout. A receipt lets a partial prunable
  # batch resume without confusing completed retirement with ambiguity.
  for plist_path in "${plist_paths[@]}"; do
    plist_parent="$(dirname "$plist_path")"
    if [[ "$plist_parent" != "$LAUNCH_AGENTS_DIR" ]] && worktree_owns_consumer_gateway_plist "$plist_path" "$worktree_path"; then
      success_marker="${plist_path}.retired-success"
      if [[ -f "$success_marker" && ! -L "$success_marker" ]]; then
        found=1
        echo "Confirmed prior LaunchAgent retirement: ${plist_path}"
      else
        echo "Error: exact-owned LaunchAgent is already quarantined without a success receipt at ${plist_path}; preserving worktree metadata: ${worktree_path}" >&2
        return 1
      fi
    fi
  done


  # Relative symlinks change meaning when moved into quarantine, and multi-hop
  # links can hide a final target that disappears with the lane. Keep the safe
  # supported shape deliberately narrow: one direct absolute link to an
  # external target.
  for plist_path in "${plist_paths[@]}"; do
    plist_parent="$(dirname "$plist_path")"
    [[ "$plist_parent" == "$LAUNCH_AGENTS_DIR" && -L "$plist_path" ]] || continue
    worktree_owns_consumer_gateway_plist "$plist_path" "$worktree_path" || continue
    if ! symlink_target="$(readlink "$plist_path")"; then
      echo "Error: cannot resolve LaunchAgent plist symlink ${plist_path}; preserving worktree: ${worktree_path}" >&2
      return 1
    fi
    if [[ "$symlink_target" != /* ]]; then
      echo "Error: relative LaunchAgent plist symlink cannot be quarantined reversibly: ${plist_path} -> ${symlink_target}" >&2
      return 1
    fi
    if [[ -L "$symlink_target" ]]; then
      echo "Error: multi-hop LaunchAgent plist symlink cannot be quarantined safely: ${plist_path} -> ${symlink_target}" >&2
      return 1
    fi
    if path_belongs_to_worktree "$symlink_target" "$worktree_path"; then
      echo "Error: LaunchAgent plist symlink target is inside the worktree and cannot be quarantined reversibly: ${plist_path} -> ${symlink_target}" >&2
      return 1
    fi
  done

  for plist_path in "${plist_paths[@]}"; do
    plist_parent="$(dirname "$plist_path")"
    [[ "$plist_parent" == "$LAUNCH_AGENTS_DIR" ]] || continue
    if ! worktree_owns_consumer_gateway_plist "$plist_path" "$worktree_path"; then
      continue
    fi

    found=1
    label="$(plist_value "$plist_path" "Label")"
    destination="${LAUNCH_AGENT_QUARANTINE_DIR}/$(basename "$plist_path")"
    success_marker="${destination}.retired-success"

    if ! mkdir -p "$LAUNCH_AGENT_QUARANTINE_DIR"; then
      echo "Error: cannot create LaunchAgent quarantine; preserving worktree: ${worktree_path}" >&2
      return 1
    fi

    # Never overwrite an older quarantine artifact. Losing the previous plist
    # would make this cleanup destructive instead of reversible.
    if [[ -e "$destination" || -L "$destination" || -e "$success_marker" || -L "$success_marker" ]]; then
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
    was_loaded=0
    if launchctl_print_output="$("$LAUNCHCTL_BIN" print "$launchctl_target" 2>&1)"; then
      was_loaded=1
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

    # Noclobber makes the empty receipt atomic. A crash before this point leaves
    # an intentionally ambiguous quarantine; a crash after it can safely resume.
    if ! (umask 077; set -C; : > "$success_marker"); then
      record_retired_launchagent "$plist_path" "$destination" "$label" "$was_loaded" ""
      echo "Error: could not record successful LaunchAgent retirement at ${success_marker}; preserving worktree: ${worktree_path}" >&2
      return 1
    fi
    record_retired_launchagent "$plist_path" "$destination" "$label" "$was_loaded" "$success_marker"
    echo "Quarantined worktree LaunchAgent: ${label} -> ${destination}"
  done

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

# Capture stale registrations before pruning. Their recorded worktree path is
# the ownership evidence needed to retire an orphaned LaunchAgent safely.
worktree_output="$(git worktree list --porcelain)"
if [[ -z "$worktree_output" ]]; then
  echo "Error: git worktree list returned no entries." >&2
  exit 1
fi

declare -a block_paths=()
declare -a block_branches=()
declare -a block_detached=()
declare -a block_prunable=()
declare -a block_locked=()
declare -a display_classes=()
declare -a display_paths=()
declare -a display_tokens=()
declare -a remove_paths=()
declare -a remove_prunable=()

finalize_block() {
  if [[ -z "${current_path:-}" ]]; then
    return
  fi
  block_paths+=("$current_path")
  block_branches+=("${current_branch:-}")
  block_detached+=("${current_detached:-0}")
  block_prunable+=("${current_prunable:-0}")
  block_locked+=("${current_locked:-0}")
}

current_path=""
current_branch=""
current_detached=0
current_prunable=0
current_locked=0

while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ -z "$line" ]]; then
    finalize_block
    current_path=""
    current_branch=""
    current_detached=0
    current_prunable=0
    current_locked=0
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
    locked*)
      current_locked=1
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
  is_locked="${block_locked[$i]}"

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

  # A lock is an explicit owner request to preserve this registration. It wins
  # over prunable/merged state, including temporarily unavailable worktrees;
  # never retire services or prune metadata behind that lock.
  if [[ "$is_locked" == "1" ]]; then
    class="locked"
    active_count=$((active_count + 1))
  elif [[ "$is_prunable" == "1" ]]; then
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
    remove_prunable+=("$is_prunable")
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
  remove_failed_count=0
  prunable_retired_count=0
  prunable_retirement_failed_count=0
  for ((remove_index = 0; remove_index < ${#remove_paths[@]}; remove_index++)); do
    path="${remove_paths[$remove_index]}"
    path_is_prunable="${remove_prunable[$remove_index]}"

    # Retire launchd ownership before either the tester runtime release or Git
    # deletion. If quarantine fails, leave the worktree intact; deleting its
    # entrypoint would turn a recoverable stale service into a KeepAlive loop.
    reset_launchagent_retirement_record
    if ! retire_worktree_consumer_launchagents "$path"; then
      rollback_retired_launchagents "$path" || true
      cleanup_failed_count=$((cleanup_failed_count + 1))
      if [[ "$path_is_prunable" == "1" ]]; then
        prunable_retirement_failed_count=$((prunable_retirement_failed_count + 1))
      fi
      continue
    fi

    # A prunable registration points at a missing worktree. There is no tester
    # runtime to release and no directory for `git worktree remove`; defer its
    # metadata cleanup until every prunable LaunchAgent retirement is safe.
    if [[ "$path_is_prunable" == "1" ]]; then
      prunable_retired_count=$((prunable_retired_count + 1))
      continue
    fi

    env_local_path="${path}/.env.local"
    if [[ -d "$path" && -f "$env_local_path" ]]; then
      claimed_token="$(read_last_env_value "$env_local_path" "TELEGRAM_BOT_TOKEN")"
      if [[ -n "$claimed_token" ]]; then
        # The release helper lives inside the worktree, so this preexisting
        # best-effort external claim release must happen before Git deletes the
        # lane. It is intentionally not represented as transactionally
        # restorable state; LaunchAgent rollback must not pretend otherwise.
        (cd "$path" && bash scripts/telegram-live-runtime.sh release) || true
      fi
    fi

    if git worktree remove --force "$path"; then
      removed_count=$((removed_count + 1))
    else
      echo "Error: git worktree remove failed; preserving worktree: ${path}" >&2
      rollback_retired_launchagents "$path" || true
      remove_failed_count=$((remove_failed_count + 1))
    fi
  done

  # `git worktree prune` is global, so run it only when every discovered stale
  # registration passed retirement. Otherwise it could erase ownership
  # evidence for a lane whose LaunchAgent state is still ambiguous.
  if [[ "$prunable_retired_count" -gt 0 && "$prunable_retirement_failed_count" == "0" ]]; then
    if git worktree prune; then
      removed_count=$((removed_count + prunable_retired_count))
    else
      echo "Error: Git metadata prune failed after retiring ${prunable_retired_count} prunable worktree(s). LaunchAgents remain quarantined." >&2
      remove_failed_count=$((remove_failed_count + prunable_retired_count))
    fi
  elif [[ "$prunable_retirement_failed_count" -gt 0 ]]; then
    echo "Error: skipped Git metadata prune because ${prunable_retirement_failed_count} prunable worktree LaunchAgent retirement(s) failed." >&2
  fi
else
  echo "re-run with --auto to apply."
fi

echo "GC complete: ${prunable_count} prunable, ${merged_count} merged (${removed_count} removed), ${detached_count} detached, ${active_count} active"
if [[ "${cleanup_failed_count:-0}" -gt 0 ]]; then
  echo "Error: ${cleanup_failed_count} worktree(s) preserved because LaunchAgent retirement failed." >&2
fi
if [[ "${remove_failed_count:-0}" -gt 0 ]]; then
  echo "Error: ${remove_failed_count} worktree(s) preserved because Git removal failed." >&2
fi
if [[ "${cleanup_failed_count:-0}" -gt 0 || "${remove_failed_count:-0}" -gt 0 ]]; then
  exit 1
fi
