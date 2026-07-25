#!/usr/bin/env bash

# Enforce one local Jarvis macOS tester lane at a time.
#
# The installed /Applications/Jarvis.app and ai.jarvis.gateway are deliberately
# outside this contract. This helper only recognizes debug/test app bundle IDs.
# A replacing launcher may retire the previous tester and its exact named
# gateway; a non-replacing launcher fails before creating another Dock app.

consumer_mac_test_registry_path() {
  printf '%s\n' "${OPENCLAW_CONSUMER_TEST_REGISTRY_PATH:-${HOME}/Library/Application Support/OpenClaw/test-lanes/current-mac-app.tsv}"
}

consumer_mac_test_parallel_registry_dir() {
  printf '%s\n' "${OPENCLAW_CONSUMER_PARALLEL_TEST_REGISTRY_DIR:-$(dirname "$(consumer_mac_test_registry_path)")/parallel}"
}

consumer_mac_test_parallel_receipt_files() {
  local registry_dir=""
  local receipt_path=""

  registry_dir="$(consumer_mac_test_parallel_registry_dir)"
  [[ -d "$registry_dir" ]] || return 0
  shopt -s nullglob
  for receipt_path in "$registry_dir"/*.tsv; do
    printf '%s\n' "$receipt_path"
  done
  shopt -u nullglob
}

consumer_mac_test_lock_path() {
  printf '%s.lock\n' "$(consumer_mac_test_registry_path)"
}

consumer_mac_test_list_process_lines() {
  /bin/ps -axo pid=,command=
}

consumer_mac_test_plist_value() {
  local plist_path="$1"
  local key="$2"
  /usr/libexec/PlistBuddy -c "Print :${key}" "$plist_path" 2>/dev/null || true
}

consumer_mac_test_is_debug_bundle_id() {
  case "${1:-}" in
    ai.openclaw.consumer.mac.debug|ai.openclaw.consumer.mac.debug.*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

consumer_mac_test_app_path_from_command() {
  printf '%s\n' "$1" | /usr/bin/sed -n 's#^\(.*\.app\)/Contents/MacOS/OpenClaw.*#\1#p'
}

consumer_mac_test_is_protected_app_path() {
  local app_path="$1"
  local resolved_path=""
  local installed_path="/Applications/Jarvis.app"

  [[ "$app_path" == "$installed_path" ]] && return 0
  if [[ -d "$app_path" ]]; then
    resolved_path="$(cd "$app_path" && pwd -P 2>/dev/null || true)"
    [[ "$resolved_path" == "$installed_path" ]] && return 0
  fi
  return 1
}

consumer_mac_test_validate_launch_record() {
  local instance_id="${1:-}"
  local app_path="$2"

  [[ -z "$instance_id" || "$instance_id" =~ ^[a-z0-9][a-z0-9-]*$ ]] || return 1
  [[ "$app_path" == /*.app && "$app_path" != *$'\n'* && "$app_path" != *$'\t'* ]] || return 1
  if consumer_mac_test_is_protected_app_path "$app_path"; then
    echo "ERROR: refusing to register installed production Jarvis as a tester: $app_path" >&2
    return 1
  fi
}

consumer_mac_test_app_record_from_line() {
  local line="$1"
  local pid=""
  local command=""
  local app_path=""
  local info_plist=""
  local bundle_id=""
  local instance_id=""

  [[ "$line" == *"/Contents/MacOS/OpenClaw"* ]] || return 1
  pid="$(printf '%s\n' "$line" | /usr/bin/awk '{ print $1 }')"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1

  command="${line#*"$pid"}"
  command="${command#"${command%%[![:space:]]*}"}"
  app_path="$(consumer_mac_test_app_path_from_command "$command")"
  [[ -n "$app_path" ]] || return 1
  consumer_mac_test_is_protected_app_path "$app_path" && return 1

  info_plist="${app_path}/Contents/Info.plist"
  [[ -f "$info_plist" ]] || return 1
  bundle_id="$(consumer_mac_test_plist_value "$info_plist" "CFBundleIdentifier")"
  consumer_mac_test_is_debug_bundle_id "$bundle_id" || return 1

  instance_id="$(consumer_mac_test_plist_value "$info_plist" "OpenClawConsumerInstanceID")"
  [[ -z "$instance_id" || "$instance_id" =~ ^[a-z0-9][a-z0-9-]*$ ]] || return 1
  # Use a non-whitespace separator so an empty default instance remains an
  # empty middle field when Bash parses the record.
  printf '%s\x1f%s\x1f%s\n' "$pid" "$instance_id" "$app_path"
}

consumer_mac_test_read_registry() {
  local registry_path="${1:-}"
  local line=""
  local key=""
  local value=""

  CONSUMER_MAC_TEST_PREVIOUS_INSTANCE=""
  CONSUMER_MAC_TEST_PREVIOUS_APP=""
  if [[ -z "$registry_path" ]]; then
    registry_path="$(consumer_mac_test_registry_path)"
  fi
  [[ -f "$registry_path" ]] || return 1

  while IFS= read -r line; do
    key="${line%%$'\t'*}"
    value="${line#*$'\t'}"
    case "$key" in
      instance_id)
        CONSUMER_MAC_TEST_PREVIOUS_INSTANCE="$value"
        ;;
      app_path)
        CONSUMER_MAC_TEST_PREVIOUS_APP="$value"
        ;;
    esac
  done <"$registry_path"

  # The receipt is later used to select an exact process and launchd label.
  # Treat malformed state as a hard stop instead of turning it into a broad
  # process match or path traversal primitive.
  if [[ -n "$CONSUMER_MAC_TEST_PREVIOUS_INSTANCE" && ! "$CONSUMER_MAC_TEST_PREVIOUS_INSTANCE" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    echo "ERROR: malformed tester-lane instance in registry: $registry_path" >&2
    return 2
  fi
  if [[ "$CONSUMER_MAC_TEST_PREVIOUS_APP" != /*.app ]]; then
    echo "ERROR: malformed tester-lane app path in registry: $registry_path" >&2
    return 2
  fi
  return 0
}

consumer_mac_test_terminate_pid() {
  local pid="$1"

  /bin/kill "$pid" 2>/dev/null || true
  /bin/sleep 1
  if /bin/ps -p "$pid" >/dev/null 2>&1; then
    /bin/kill -9 "$pid" 2>/dev/null || true
  fi
}

consumer_mac_test_terminate_app_path() {
  local target_app="$1"
  local line=""
  local pid=""
  local command=""
  local app_path=""

  # A registry receipt can outlive the debug bundle it described. If that path
  # is later replaced by, or resolves to, the installed production app, the
  # stale receipt loses all authority to terminate it.
  if consumer_mac_test_is_protected_app_path "$target_app"; then
    echo "Preserving installed production Jarvis during tester handoff: $target_app"
    return 0
  fi

  # The registry remains authoritative after a worktree or app bundle is
  # deleted. Match its exact executable path without requiring Info.plist to
  # survive, so a still-running stale process cannot escape replacement.
  while IFS= read -r line; do
    [[ "$line" == *"/Contents/MacOS/OpenClaw"* ]] || continue
    pid="$(printf '%s\n' "$line" | /usr/bin/awk '{ print $1 }')"
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    command="${line#*"$pid"}"
    command="${command#"${command%%[![:space:]]*}"}"
    app_path="$(consumer_mac_test_app_path_from_command "$command")"
    [[ "$app_path" == "$target_app" ]] || continue
    consumer_mac_test_terminate_pid "$pid"
  done < <(consumer_mac_test_list_process_lines)
}

consumer_mac_test_app_path_has_process() {
  local target_app="$1"
  local line=""
  local command=""
  local app_path=""
  local pid=""

  while IFS= read -r line; do
    [[ "$line" == *"/Contents/MacOS/OpenClaw"* ]] || continue
    pid="$(printf '%s\n' "$line" | /usr/bin/awk '{ print $1 }')"
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    command="${line#*"$pid"}"
    command="${command#"${command%%[![:space:]]*}"}"
    app_path="$(consumer_mac_test_app_path_from_command "$command")"
    [[ "$app_path" == "$target_app" ]] && return 0
  done < <(consumer_mac_test_list_process_lines)
  return 1
}

consumer_mac_test_wait_for_app_path() {
  local target_app="$1"
  local attempt=0
  local max_attempts="${OPENCLAW_CONSUMER_TEST_APP_WAIT_ATTEMPTS:-100}"

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    consumer_mac_test_app_path_has_process "$target_app" && return 0
    /bin/sleep 0.1
  done
  echo "ERROR: launched Jarvis tester did not appear before slot transfer: $target_app" >&2
  return 1
}

consumer_mac_test_process_start_identity() {
  /bin/ps -p "$1" -o lstart= 2>/dev/null | /usr/bin/awk '{$1=$1; print}'
}

consumer_mac_test_lock_token_matches_process() {
  local token_path="$1"
  local expected_pid="$2"
  local token_pid=""
  local token_start=""
  local actual_start=""

  IFS=$'\t' read -r token_pid token_start <"$token_path" 2>/dev/null || return 1
  [[ "$token_pid" == "$expected_pid" && -n "$token_start" ]] || return 1
  actual_start="$(consumer_mac_test_process_start_identity "$expected_pid")"
  [[ -n "$actual_start" && "$token_start" == "$actual_start" ]]
}

consumer_mac_test_lock_token_alive() {
  local token_path="$1"
  local token_pid=""

  IFS=$'\t' read -r token_pid _ <"$token_path" 2>/dev/null || return 1
  [[ "$token_pid" =~ ^[0-9]+$ ]] || return 1
  consumer_mac_test_lock_token_matches_process "$token_path" "$token_pid"
}

consumer_mac_test_acquire_lock() {
  local lock_path=""
  local candidate_path=""
  local reap_path=""
  local reap_candidate_path=""
  local owner_start=""
  local attempt=0
  local max_attempts="${OPENCLAW_CONSUMER_TEST_LOCK_ATTEMPTS:-600}"

  lock_path="$(consumer_mac_test_lock_path)"
  candidate_path="${lock_path}.candidate.$$"
  reap_path="${lock_path}.reap"
  reap_candidate_path="${reap_path}.candidate.$$"
  if ! /bin/mkdir -p "$(dirname "$lock_path")"; then
    echo "ERROR: could not create Jarvis tester lock directory: $(dirname "$lock_path")" >&2
    return 1
  fi
  owner_start="$(consumer_mac_test_process_start_identity "$$")"
  if [[ -z "$owner_start" ]]; then
    echo "ERROR: could not resolve Jarvis tester lock process identity: $$" >&2
    return 1
  fi
  if ! printf '%s\t%s\n' "$$" "$owner_start" >"$candidate_path"; then
    echo "ERROR: could not create Jarvis tester lock candidate: $candidate_path" >&2
    return 1
  fi
  if ! printf '%s\t%s\n' "$$" "$owner_start" >"$reap_candidate_path"; then
    /bin/rm -f "$candidate_path"
    echo "ERROR: could not create Jarvis tester reaper candidate: $reap_candidate_path" >&2
    return 1
  fi

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    # Reaping has its own atomic owner token. If that owner crashes, another
    # contender compares both PID and process start time before recovering it.
    if [[ -e "$reap_path" ]]; then
      if ! consumer_mac_test_lock_token_alive "$reap_path"; then
        /bin/rm -f "$reap_path"
        continue
      fi
      /bin/sleep 0.1
      continue
    fi

    # Publish a complete lock owner token atomically.
    if /bin/ln "$candidate_path" "$lock_path" 2>/dev/null; then
      CONSUMER_MAC_TEST_LOCK_OWNED="$lock_path"
      /bin/rm -f "$candidate_path" "$reap_candidate_path"
      return 0
    fi

    if ! consumer_mac_test_lock_token_alive "$lock_path"; then
      if /bin/ln "$reap_candidate_path" "$reap_path" 2>/dev/null; then
        # Re-read after winning the reaper claim. A live owner that appeared in
        # the meantime keeps its lock; only an unchanged stale token is removed.
        if ! consumer_mac_test_lock_token_alive "$lock_path"; then
          /bin/rm -f "$lock_path"
        fi
        /bin/rm -f "$reap_path"
      fi
      continue
    fi
    /bin/sleep 0.1
  done

  /bin/rm -f "$candidate_path" "$reap_candidate_path"
  echo "ERROR: timed out waiting for the Jarvis macOS tester slot lock: $lock_path" >&2
  return 1
}

consumer_mac_test_release_lock() {
  local lock_path="${CONSUMER_MAC_TEST_LOCK_OWNED:-}"

  [[ -n "$lock_path" ]] || return 0
  if consumer_mac_test_lock_token_matches_process "$lock_path" "$$"; then
    /bin/rm -f "$lock_path"
  fi
  CONSUMER_MAC_TEST_LOCK_OWNED=""
}

consumer_mac_test_quarantine_gateway() {
  local instance_id="$1"
  local label=""
  local plist_path=""
  local quarantine_dir=""
  local destination=""

  # The empty instance is the default Jarvis lane. Never derive or stop its
  # gateway from tester cleanup, even when a source-built debug app was open.
  [[ -n "$instance_id" ]] || return 0
  label="$(consumer_instance_gateway_launchd_label "$instance_id")"
  [[ "$label" == ai.openclaw.consumer.*.gateway ]] || {
    echo "ERROR: refusing unexpected tester gateway label: $label" >&2
    return 1
  }

  if launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
    if ! launchctl bootout "gui/$(id -u)/${label}" >/dev/null 2>&1; then
      if launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
        echo "ERROR: could not stop previous tester gateway: $label" >&2
        return 1
      fi
    fi
    if launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
      echo "ERROR: previous tester gateway remained loaded after bootout: $label" >&2
      return 1
    fi
  fi
  plist_path="${HOME}/Library/LaunchAgents/${label}.plist"
  [[ -f "$plist_path" ]] || return 0

  quarantine_dir="${OPENCLAW_CONSUMER_TEST_QUARANTINE_DIR:-${HOME}/Library/LaunchAgents/openclaw-test-disabled}"
  if ! /bin/mkdir -p "$quarantine_dir"; then
    echo "ERROR: could not create tester gateway quarantine: $quarantine_dir" >&2
    return 1
  fi
  destination="${quarantine_dir}/$(date +%Y%m%d-%H%M%S)-$$-${label}.plist"
  if ! /bin/mv "$plist_path" "$destination"; then
    echo "ERROR: could not quarantine tester gateway plist: $plist_path" >&2
    return 1
  fi
  echo "Quarantined previous tester gateway: $destination"
}

consumer_mac_test_prepare_launch() {
  local current_instance="${1:-}"
  local current_app="$2"
  local replace="${3:-0}"
  local registry_status=1
  local registry_instance=""
  local registry_app=""
  local line=""
  local record=""
  local pid=""
  local instance_id=""
  local app_path=""
  local receipt_path=""
  local conflict_count=0
  local previous_differs=0
  local retired_instances=$'\n'

  if consumer_mac_test_read_registry; then
    registry_status=0
  else
    registry_status=$?
  fi
  if [[ "$registry_status" -eq 2 ]]; then
    return 1
  fi
  if [[ "$registry_status" -eq 0 ]]; then
    registry_instance="$CONSUMER_MAC_TEST_PREVIOUS_INSTANCE"
    registry_app="$CONSUMER_MAC_TEST_PREVIOUS_APP"
  fi
  if [[ "$registry_status" -eq 0 && ( "$registry_instance" != "$current_instance" || "$registry_app" != "$current_app" ) ]]; then
    previous_differs=1
    conflict_count=$((conflict_count + 1))
  fi

  while IFS= read -r receipt_path; do
    [[ -n "$receipt_path" ]] || continue
    if ! consumer_mac_test_read_registry "$receipt_path"; then
      return 1
    fi
    if [[ "$CONSUMER_MAC_TEST_PREVIOUS_INSTANCE" != "$current_instance" || "$CONSUMER_MAC_TEST_PREVIOUS_APP" != "$current_app" ]]; then
      conflict_count=$((conflict_count + 1))
    fi
  done < <(consumer_mac_test_parallel_receipt_files)

  while IFS= read -r line; do
    record="$(consumer_mac_test_app_record_from_line "$line" || true)"
    [[ -n "$record" ]] || continue
    conflict_count=$((conflict_count + 1))
  done < <(consumer_mac_test_list_process_lines)

  if [[ "$conflict_count" -gt 0 && "$replace" != "1" ]]; then
    echo "ERROR: another Jarvis macOS tester lane already owns the single tester slot." >&2
    echo "  Re-run with --replace to retire it before launching this lane." >&2
    echo "  Installed /Applications/Jarvis.app and ai.jarvis.gateway will be preserved." >&2
    return 1
  fi

  # Parallel receipts remain after their app exits, so a later normal launch
  # can still retire a gateway-only lane. This is the deterministic cleanup
  # boundary for agents that forget to tear down their isolated tester.
  while IFS= read -r receipt_path; do
    [[ -n "$receipt_path" ]] || continue
    if ! consumer_mac_test_read_registry "$receipt_path"; then
      return 1
    fi
    consumer_mac_test_terminate_app_path "$CONSUMER_MAC_TEST_PREVIOUS_APP"
    if [[ -n "$CONSUMER_MAC_TEST_PREVIOUS_INSTANCE" && "$CONSUMER_MAC_TEST_PREVIOUS_INSTANCE" != "$current_instance" && "$retired_instances" != *$'\n'"$CONSUMER_MAC_TEST_PREVIOUS_INSTANCE"$'\n'* ]]; then
      if ! consumer_mac_test_quarantine_gateway "$CONSUMER_MAC_TEST_PREVIOUS_INSTANCE"; then
        return 1
      fi
      retired_instances+="${CONSUMER_MAC_TEST_PREVIOUS_INSTANCE}"$'\n'
    fi
    # A same-instance handoff intentionally preserves its gateway. Keep that
    # lane's receipt until the singleton registry is durably published, or a
    # later write failure could leave the gateway with no cleanup identity.
    if [[ "$CONSUMER_MAC_TEST_PREVIOUS_INSTANCE" != "$current_instance" ]]; then
      /bin/rm -f "$receipt_path"
    fi
  done < <(consumer_mac_test_parallel_receipt_files)

  if [[ "$previous_differs" -eq 1 ]]; then
    consumer_mac_test_terminate_app_path "$registry_app"
    if [[ -n "$registry_instance" && "$registry_instance" != "$current_instance" && "$retired_instances" != *$'\n'"$registry_instance"$'\n'* ]]; then
      if ! consumer_mac_test_quarantine_gateway "$registry_instance"; then
        return 1
      fi
      retired_instances+="${registry_instance}"$'\n'
    fi
  fi

  while IFS= read -r line; do
    record="$(consumer_mac_test_app_record_from_line "$line" || true)"
    [[ -n "$record" ]] || continue
    IFS=$'\x1f' read -r pid instance_id app_path <<<"$record"

    echo "Retiring previous Jarvis tester app: pid=${pid} instance=${instance_id:-default-debug} path=${app_path}"
    consumer_mac_test_terminate_pid "$pid"

    # Replacing the same instance should preserve its already-running gateway.
    # A different named instance relinquishes both app and launchd ownership.
    if [[ -n "$instance_id" && "$instance_id" != "$current_instance" && "$retired_instances" != *$'\n'"$instance_id"$'\n'* ]]; then
      if ! consumer_mac_test_quarantine_gateway "$instance_id"; then
        return 1
      fi
      retired_instances+="${instance_id}"$'\n'
    fi
  done < <(consumer_mac_test_list_process_lines)
}

consumer_mac_test_prepare_parallel_launch() {
  local current_instance="$1"
  local current_app="$2"
  local replace="${3:-0}"
  local max_parallel="${OPENCLAW_CONSUMER_PARALLEL_TEST_MAX:-10}"
  local line=""
  local record=""
  local pid=""
  local instance_id=""
  local app_path=""
  local live_count=0
  local same_instance_count=0

  [[ -n "$current_instance" ]] || {
    echo "ERROR: --parallel requires a named isolated consumer instance." >&2
    return 1
  }
  [[ "$max_parallel" =~ ^[1-9][0-9]*$ && "$max_parallel" -le 50 ]] || {
    echo "ERROR: OPENCLAW_CONSUMER_PARALLEL_TEST_MAX must be between 1 and 50." >&2
    return 1
  }

  while IFS= read -r line; do
    record="$(consumer_mac_test_app_record_from_line "$line" || true)"
    [[ -n "$record" ]] || continue
    IFS=$'\x1f' read -r pid instance_id app_path <<<"$record"
    live_count=$((live_count + 1))

    # Parallel lanes may coexist only when their runtime identity is unique.
    # Two app bundles with one instance would still share a gateway/state dir.
    [[ "$instance_id" == "$current_instance" ]] || continue
    same_instance_count=$((same_instance_count + 1))
    if [[ "$replace" == "1" ]]; then
      echo "Retiring previous version of parallel tester instance=${instance_id} pid=${pid} path=${app_path}"
      consumer_mac_test_terminate_pid "$pid"
      live_count=$((live_count - 1))
    fi
  done < <(consumer_mac_test_list_process_lines)

  if [[ "$same_instance_count" -gt 0 && "$replace" != "1" ]]; then
    echo "ERROR: parallel tester instance '${current_instance}' is already running." >&2
    echo "  Use --replace to relaunch that instance, or choose a unique --instance." >&2
    return 1
  fi
  if [[ "$live_count" -ge "$max_parallel" ]]; then
    echo "ERROR: parallel Jarvis tester cap reached (${max_parallel})." >&2
    echo "  Finish/clean a lane, or use a normal --replace launch to collapse all testers back to one." >&2
    return 1
  fi
}

consumer_mac_test_record_launch() {
  local instance_id="${1:-}"
  local app_path="$2"
  local registry_path=""
  local registry_dir=""
  local pending_path=""
  local previous_umask=""

  consumer_mac_test_validate_launch_record "$instance_id" "$app_path" || return 1

  registry_path="$(consumer_mac_test_registry_path)"
  registry_dir="$(dirname "$registry_path")"
  pending_path="${registry_path}.pending.$$"
  if ! /bin/mkdir -p "$registry_dir"; then
    echo "ERROR: could not create Jarvis tester registry directory: $registry_dir" >&2
    return 1
  fi

  previous_umask="$(umask)"
  umask 077
  if ! {
    printf 'instance_id\t%s\n' "$instance_id"
    printf 'app_path\t%s\n' "$app_path"
  } >"$pending_path"; then
    umask "$previous_umask"
    /bin/rm -f "$pending_path"
    echo "ERROR: could not write Jarvis tester registry: $pending_path" >&2
    return 1
  fi
  if ! /bin/mv "$pending_path" "$registry_path"; then
    umask "$previous_umask"
    /bin/rm -f "$pending_path"
    echo "ERROR: could not publish Jarvis tester registry: $registry_path" >&2
    return 1
  fi
  umask "$previous_umask"
}

consumer_mac_test_record_parallel_launch() {
  local instance_id="$1"
  local app_path="$2"
  local registry_dir=""
  local registry_path=""
  local pending_path=""
  local previous_umask=""

  consumer_mac_test_validate_launch_record "$instance_id" "$app_path" || return 1
  [[ -n "$instance_id" ]] || return 1
  registry_dir="$(consumer_mac_test_parallel_registry_dir)"
  registry_path="${registry_dir}/${instance_id}.tsv"
  pending_path="${registry_path}.pending.$$"
  if ! /bin/mkdir -p "$registry_dir"; then
    echo "ERROR: could not create parallel tester registry: $registry_dir" >&2
    return 1
  fi

  previous_umask="$(umask)"
  umask 077
  if ! {
    printf 'instance_id\t%s\n' "$instance_id"
    printf 'app_path\t%s\n' "$app_path"
  } >"$pending_path"; then
    umask "$previous_umask"
    /bin/rm -f "$pending_path"
    return 1
  fi
  if ! /bin/mv "$pending_path" "$registry_path"; then
    umask "$previous_umask"
    /bin/rm -f "$pending_path"
    return 1
  fi
  umask "$previous_umask"
}

consumer_mac_test_remove_parallel_receipt() {
  local instance_id="$1"
  local receipt_path=""

  [[ -n "$instance_id" ]] || return 0
  receipt_path="$(consumer_mac_test_parallel_registry_dir)/${instance_id}.tsv"
  /bin/rm -f "$receipt_path"
}

consumer_mac_test_begin_launch() {
  local instance_id="${1:-}"
  local app_path="$2"
  local replace="${3:-0}"

  # Validate before acquiring or transferring the slot. A bad target must not
  # retire the previous tester and then fail while publishing its replacement.
  consumer_mac_test_validate_launch_record "$instance_id" "$app_path" || return 1
  consumer_mac_test_acquire_lock
  if ! consumer_mac_test_prepare_launch "$instance_id" "$app_path" "$replace"; then
    consumer_mac_test_release_lock
    return 1
  fi
  if ! consumer_mac_test_record_launch "$instance_id" "$app_path"; then
    consumer_mac_test_release_lock
    return 1
  fi
  if ! consumer_mac_test_remove_parallel_receipt "$instance_id"; then
    consumer_mac_test_release_lock
    return 1
  fi
}

consumer_mac_test_begin_parallel_launch() {
  local instance_id="${1:-}"
  local app_path="$2"
  local replace="${3:-0}"

  consumer_mac_test_validate_launch_record "$instance_id" "$app_path" || return 1
  consumer_mac_test_acquire_lock
  if ! consumer_mac_test_prepare_parallel_launch "$instance_id" "$app_path" "$replace"; then
    consumer_mac_test_release_lock
    return 1
  fi
  if ! consumer_mac_test_record_parallel_launch "$instance_id" "$app_path"; then
    consumer_mac_test_release_lock
    return 1
  fi
}
