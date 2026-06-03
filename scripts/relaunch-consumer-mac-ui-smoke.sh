#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"
source "$ROOT_DIR/scripts/lib/gateway-launchagent-guard.sh"
source "$ROOT_DIR/scripts/lib/validated-node.sh"
openclaw_use_validated_node "$ROOT_DIR" >/dev/null

INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
OPEN_APP=1
BUILD_APP=1
CLEAN_ONLY=0
WITH_RUNTIME=0
CONSUMER_STEP="${OPENCLAW_CONSUMER_SETUP_DEBUG_STEP:-}"
BACKEND_API_TOKEN="${JARVIS_BACKEND_ACCESS_TOKEN:-${JARVIS_BACKEND_API_TOKEN:-}}"
BACKEND_BASE_URL="${JARVIS_BACKEND_BASE_URL:-https://jarvis-backend-klvq.onrender.com}"
BUILD_CONFIG="${BUILD_CONFIG:-debug}"
BUILD_PATH="$ROOT_DIR/apps/macos/.build-ui-smoke"
GATEWAY_ENTRY="$ROOT_DIR/dist/index.js"
STARTED_AT="$SECONDS"

usage() {
  cat <<'EOF'
Usage: scripts/relaunch-consumer-mac-ui-smoke.sh [--instance <id>] [--consumer-step <step>] [--no-open|--build-only] [--no-build] [--clean]

Fast native Jarvis UI smoke:
  - builds apps/macos with SwiftPM only unless --no-build is passed
  - launches the current worktree's debug binary through a tiny debug .app wrapper
  - uses an isolated consumer instance/config/state
  - defaults to visual-only mode with --no-launchd so the gateway is not touched
  - --with-runtime keeps the app attach-only, then refreshes this instance's
    gateway LaunchAgent env/port/label from the current worktree for Telegram first-task proof
  - skips /Applications installs, release packaging, DMGs, zips, npm tarballs,
    bundled Node, node_modules packaging, and default gateway restarts

Cleanup:
  --clean removes generated UI-smoke build output, stopped debug .app wrappers,
          and stale UI-smoke app/gateway LaunchAgents.
          Running UI-smoke apps are left in place for inspection.
EOF
}

ensure_cli_build_output() {
  local entry_js="$ROOT_DIR/dist/entry.js"
  local entry_mjs="$ROOT_DIR/dist/entry.mjs"

  if [[ -f "$entry_js" || -f "$entry_mjs" ]]; then
    return
  fi

  echo "Building OpenClaw CLI runtime for browser readiness checks..."
  (
    cd "$ROOT_DIR"
    pnpm build
  )
}

app_binary_has_matching_pids() {
  local binary_path="$1"
  local pid=""

  # Deleting a live debug wrapper can break the app being inspected. Treat any
  # process whose command contains this exact wrapper binary as live, regardless
  # of parent process, so cleanup stays conservative.
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    return 0
  done < <(/bin/ps -axo pid=,command= | /usr/bin/awk -v target="$binary_path" 'index($0, target) > 0 { print $1 }')

  return 1
}

resolve_backend_api_token() {
  if [[ -n "$BACKEND_API_TOKEN" ]]; then
    return
  fi
  if ! command -v security >/dev/null 2>&1; then
    return
  fi
  # Read the protected Render backend token for the debug wrapper only. Never
  # print the value; the smoke proof reports only paths and non-secret state.
  BACKEND_API_TOKEN="$(security find-generic-password \
    -s "Jarvis Render Backend" \
    -a "JARVIS_BACKEND_API_TOKEN" \
    -w 2>/dev/null || true)"
}

seed_jarvis_backend_config() {
  local config_path="$1"
  local tmp_path

  if [[ -z "$BACKEND_API_TOKEN" ]]; then
    if [[ "$CONSUMER_STEP" == "accountActivation" || "$CONSUMER_STEP" == "telegram" || "$CONSUMER_STEP" == "telegramGroup" ]]; then
      echo "ERROR: --consumer-step $CONSUMER_STEP requires Jarvis backend credentials." >&2
      echo "Set JARVIS_BACKEND_ACCESS_TOKEN or JARVIS_BACKEND_API_TOKEN, or store the API token in Keychain account JARVIS_BACKEND_API_TOKEN for service 'Jarvis Render Backend'." >&2
      return 1
    fi
    return 0
  fi

  /bin/mkdir -p "$(/usr/bin/dirname "$config_path")"
  tmp_path="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/openclaw-ui-smoke-backend-config.XXXXXX")"

  # Match the packaged consumer seeded-defaults shape, but write it into the
  # isolated smoke config because the debug wrapper has no Resources bundle.
  # Preserve unrelated config and overwrite only build-owned backend auth so a
  # stale empty/invalid activation seed cannot make the app look disabled.
  if [[ -f "$config_path" ]]; then
    /usr/bin/jq \
      --arg baseUrl "$BACKEND_BASE_URL" \
      --arg accessToken "$BACKEND_API_TOKEN" \
      '
      def object_or_empty: if type == "object" then . else {} end;
      object_or_empty
      | .jarvis = (
          (.jarvis // {} | object_or_empty)
          | .backend = (
              (.backend // {} | object_or_empty)
              | .baseUrl = $baseUrl
              | .accessToken = $accessToken
            )
          | .managedServices = (
              (.managedServices // {} | object_or_empty)
              | .mode = "managed"
            )
        )
      ' "$config_path" >"$tmp_path"
  else
    /usr/bin/jq \
      --null-input \
      --arg baseUrl "$BACKEND_BASE_URL" \
      --arg accessToken "$BACKEND_API_TOKEN" \
      '{
        jarvis: {
          backend: {
            baseUrl: $baseUrl,
            accessToken: $accessToken
          },
          managedServices: {
            mode: "managed"
          }
        }
      }' >"$tmp_path"
  fi

  /bin/chmod 600 "$tmp_path"
  /bin/mv "$tmp_path" "$config_path"
  echo "backend_config_seeded=true"
}

cleanup_ui_smoke_artifacts() {
  local app_dir="$ROOT_DIR/dist-ui-smoke"
  local app_path=""
  local binary_path=""
  local info_plist=""
  local bundle_id=""
  local instance_id=""
  local gateway_label=""
  local quarantine_dir="$HOME/Library/LaunchAgents/openclaw-test-disabled-$(date +%Y%m%d-%H%M%S)"
  local removed_apps=0
  local skipped_apps=0

  if [[ -d "$BUILD_PATH" ]]; then
    echo "Removing UI-smoke SwiftPM build output: $BUILD_PATH"
    /bin/rm -rf "$BUILD_PATH"
  else
    echo "UI-smoke SwiftPM build output already clean: $BUILD_PATH"
  fi

  if [[ ! -d "$app_dir" ]]; then
    echo "UI-smoke debug app wrappers already clean: $app_dir"
    cleanup_stale_ui_smoke_launchagents "$quarantine_dir"
    return
  fi

  shopt -s nullglob
  for app_path in "$app_dir"/*.app; do
    binary_path="$app_path/Contents/MacOS/OpenClaw"
    info_plist="$app_path/Contents/Info.plist"
    bundle_id=""
    instance_id=""
    gateway_label=""

    if [[ -f "$info_plist" ]]; then
      bundle_id="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$info_plist" 2>/dev/null || true)"
      instance_id="$(/usr/libexec/PlistBuddy -c "Print :OpenClawConsumerInstanceID" "$info_plist" 2>/dev/null || true)"
    fi

    if [[ -n "$bundle_id" ]]; then
      quarantine_launchagent "$bundle_id" "$quarantine_dir"
    fi
    if [[ -n "$instance_id" ]]; then
      gateway_label="$(consumer_instance_gateway_launchd_label "$(consumer_instance_normalize_id "$instance_id")")"
      quarantine_launchagent "$gateway_label" "$quarantine_dir"
    fi

    if [[ -x "$binary_path" ]] && app_binary_has_matching_pids "$binary_path"; then
      echo "Keeping running UI-smoke app wrapper: $app_path"
      skipped_apps=$((skipped_apps + 1))
      continue
    fi

    echo "Removing stopped UI-smoke app wrapper: $app_path"
    /bin/rm -rf "$app_path"
    removed_apps=$((removed_apps + 1))
  done
  shopt -u nullglob

  cleanup_stale_ui_smoke_launchagents "$quarantine_dir"

  # Remove the container only when every wrapper was safely removed.
  /bin/rmdir "$app_dir" 2>/dev/null || true
  echo "UI-smoke cleanup complete: removed_app_wrappers=$removed_apps skipped_running_app_wrappers=$skipped_apps"
}

quarantine_launchagent() {
  local label="$1"
  local quarantine_dir="$2"
  local plist_path="$HOME/Library/LaunchAgents/${label}.plist"

  [[ -n "$label" ]] || return 0
  case "$label" in
    ai.openclaw.gateway|ai.openclaw.gateway-watchdog|ai.openclaw.consumer.mac)
      echo "Preserving LaunchAgent: $label"
      return 0
      ;;
  esac
  [[ -f "$plist_path" ]] || return 0

  echo "Quarantining stale UI-smoke LaunchAgent: $label"
  /bin/launchctl bootout "gui/$(id -u)/${label}" >/dev/null 2>&1 || true
  /bin/mkdir -p "$quarantine_dir"
  /bin/mv "$plist_path" "$quarantine_dir/"
}

cleanup_stale_ui_smoke_launchagents() {
  local quarantine_dir="$1"
  local plist_path=""
  local label=""

  shopt -s nullglob
  for plist_path in "$HOME"/Library/LaunchAgents/ai.openclaw.consumer.mac.debug.ui-smoke.*.plist \
    "$HOME"/Library/LaunchAgents/ai.openclaw.consumer.*.gateway.plist; do
    label="$(/usr/libexec/PlistBuddy -c "Print :Label" "$plist_path" 2>/dev/null || /usr/bin/basename "$plist_path" .plist)"
    quarantine_launchagent "$label" "$quarantine_dir"
  done
  shopt -u nullglob
}

terminate_matching_app_binary() {
  local binary_path="$1"
  local pids=()

  # Keep replacement scoped to this exact SwiftPM binary so other packaged or
  # shared-runtime app instances keep running untouched.
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    pids+=("$pid")
  done < <(/bin/ps -axo pid=,command= | /usr/bin/awk -v target="$binary_path" 'index($0, target) > 0 { print $1 }')

  if [[ "${#pids[@]}" -eq 0 ]]; then
    return
  fi

  /bin/kill "${pids[@]}" 2>/dev/null || true
  # Give the exact old smoke process a short grace period to exit so the final
  # proof reports the fresh LaunchServices-owned instance, not a dying PID.
  for _ in {1..20}; do
    local any_alive=0
    local pid
    for pid in "${pids[@]}"; do
      if /bin/ps -p "$pid" >/dev/null 2>&1; then
        any_alive=1
        break
      fi
    done
    [[ "$any_alive" == "0" ]] && return
    /bin/sleep 0.1
  done
}

find_launchd_owned_app_binary_pids() {
  local binary_path="$1"

  /bin/ps -axo pid=,ppid=,command= | /usr/bin/awk -v target="$binary_path" 'index($0, target) > 0 && $2 == 1 { print $1 }'
}

bootout_conflicting_gateway_label() {
  # This does not manage the default gateway. It only unloads stale labels when
  # their saved env already points at this isolated consumer lane, and the
  # shared guard refuses default-gateway bootout for named smoke targets.
  openclaw_bootout_conflicting_gateway_label "$@"
}

gateway_plist_port() {
  local plist_path="$1"
  local index=0
  local arg=""

  while true; do
    arg="$(plist_value "$plist_path" "ProgramArguments:${index}")"
    [[ -n "$arg" ]] || break
    if [[ "$arg" == "--port" ]]; then
      plist_value "$plist_path" "ProgramArguments:$((index + 1))"
      return 0
    fi
    if [[ "$arg" == --port=* ]]; then
      printf '%s\n' "${arg#--port=}"
      return 0
    fi
    index=$((index + 1))
  done

  return 1
}

verify_gateway_plist_matches_instance() {
  local normalized="$1"
  local state_dir="$2"
  local config_path="$3"
  local gateway_port="$4"
  local profile="$5"
  local launchd_label="$6"
  local plist_path="$HOME/Library/LaunchAgents/${launchd_label}.plist"
  local actual_label=""
  local actual_entry=""
  local actual_port=""
  local actual_state_dir=""
  local actual_config_path=""
  local actual_profile=""
  local actual_launchd_label=""
  local actual_consumer_instance=""
  local actual_gateway_port=""

  if [[ ! -f "$plist_path" ]]; then
    echo "ERROR: isolated gateway plist was not created: $plist_path" >&2
    return 1
  fi

  actual_label="$(plist_value "$plist_path" 'Label')"
  actual_entry="$(plist_value "$plist_path" 'ProgramArguments:1')"
  actual_port="$(gateway_plist_port "$plist_path")"
  actual_state_dir="$(plist_value "$plist_path" 'EnvironmentVariables:OPENCLAW_STATE_DIR')"
  actual_config_path="$(plist_value "$plist_path" 'EnvironmentVariables:OPENCLAW_CONFIG_PATH')"
  actual_profile="$(plist_value "$plist_path" 'EnvironmentVariables:OPENCLAW_PROFILE')"
  actual_launchd_label="$(plist_value "$plist_path" 'EnvironmentVariables:OPENCLAW_LAUNCHD_LABEL')"
  actual_consumer_instance="$(plist_value "$plist_path" 'EnvironmentVariables:OPENCLAW_CONSUMER_INSTANCE_ID')"
  actual_gateway_port="$(plist_value "$plist_path" 'EnvironmentVariables:OPENCLAW_GATEWAY_PORT')"

  if [[ "$actual_label" != "$launchd_label" ]]; then
    echo "ERROR: isolated gateway plist label mismatch: expected=$launchd_label actual=${actual_label:-missing}" >&2
    return 1
  fi
  if [[ "$actual_entry" != "$GATEWAY_ENTRY" ]]; then
    echo "ERROR: isolated gateway plist entrypoint mismatch: expected=$GATEWAY_ENTRY actual=${actual_entry:-missing}" >&2
    return 1
  fi
  if [[ "$actual_port" != "$gateway_port" || "$actual_gateway_port" != "$gateway_port" ]]; then
    echo "ERROR: isolated gateway plist port mismatch: expected=$gateway_port args=${actual_port:-missing} env=${actual_gateway_port:-missing}" >&2
    return 1
  fi
  if [[ "$actual_state_dir" != "$state_dir" ]]; then
    echo "ERROR: isolated gateway plist state dir mismatch: expected=$state_dir actual=${actual_state_dir:-missing}" >&2
    return 1
  fi
  if [[ "$actual_config_path" != "$config_path" ]]; then
    echo "ERROR: isolated gateway plist config path mismatch: expected=$config_path actual=${actual_config_path:-missing}" >&2
    return 1
  fi
  if [[ "$actual_profile" != "$profile" ]]; then
    echo "ERROR: isolated gateway plist profile mismatch: expected=$profile actual=${actual_profile:-missing}" >&2
    return 1
  fi
  if [[ "$actual_launchd_label" != "$launchd_label" ]]; then
    echo "ERROR: isolated gateway plist env label mismatch: expected=$launchd_label actual=${actual_launchd_label:-missing}" >&2
    return 1
  fi
  if [[ "$actual_consumer_instance" != "$normalized" ]]; then
    echo "ERROR: isolated gateway plist instance mismatch: expected=$normalized actual=${actual_consumer_instance:-missing}" >&2
    return 1
  fi
}

wait_for_gateway_health() {
  local gateway_port="$1"
  local deadline=$((SECONDS + 180))

  # Runtime-backed Telegram proof needs a real local listener. A matching plist
  # only proves ownership; the first-task verifier still fails if the websocket
  # never becomes reachable.
  while (( SECONDS < deadline )); do
    if /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${gateway_port}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    /bin/sleep 2
  done

  echo "ERROR: isolated gateway did not become healthy on 127.0.0.1:${gateway_port}" >&2
  return 1
}

scope_runtime_backed_smoke_plugins() {
  local config_path="$1"
  local tmp_path

  tmp_path="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/openclaw-ui-smoke-config.XXXXXX")"
  # First-task proof needs Telegram plus the small provider set that can answer
  # a basic DM. Keep heavyweight unrelated plugins out of the isolated smoke
  # runtime so plugin bootstrap does not scan/import the whole worktree.
  /usr/bin/jq '
    .plugins = ((.plugins // {}) + {
      enabled: true,
      allow: ["telegram", "anthropic", "openai"],
      deny: ["acpx", "diffs"],
      slots: ((.plugins.slots // {}) + { memory: "none" }),
      entries: ((.plugins.entries // {}) + {
        telegram: (((.plugins.entries.telegram // {}) + { enabled: true }))
      })
    })
  ' "$config_path" >"$tmp_path"
  /bin/mv "$tmp_path" "$config_path"
}

approve_latest_device_pairing_if_pending() {
  local normalized="$1"
  local state_dir="$2"
  local config_path="$3"
  local gateway_port="$4"
  local profile="$5"
  local launchd_label="$6"
  local pending_path="$state_dir/devices/pending.json"
  local attempt

  # Runtime-backed smoke launches an isolated GUI against an isolated gateway.
  # The first UI connection can legitimately create an operator pairing repair
  # request; approve only that instance-local request so first-task proof talks
  # to the same runtime without involving the shared gateway or another app.
  for attempt in {1..30}; do
    if [[ -f "$pending_path" ]] && /usr/bin/jq -e '
      [ .[]?
        | select((.clientId // "") == "openclaw-macos")
        | select((.role // "") == "operator" or ((.roles // []) | index("operator")))
      ] | length > 0
    ' "$pending_path" >/dev/null 2>&1; then
      OPENCLAW_STATE_DIR="$state_dir" \
        OPENCLAW_CONFIG_PATH="$config_path" \
        OPENCLAW_PROFILE="$profile" \
        OPENCLAW_LAUNCHD_LABEL="$launchd_label" \
        OPENCLAW_CONSUMER_INSTANCE_ID="$normalized" \
        OPENCLAW_GATEWAY_PORT="$gateway_port" \
        OPENCLAW_FORK_ROOT="$ROOT_DIR" \
        "$OPENCLAW_NODE_BIN" "$GATEWAY_ENTRY" devices approve --latest >/dev/null 2>&1 || true
      return 0
    fi
    /bin/sleep 0.25
  done
}

bootstrap_isolated_gateway_plist() {
  local launchd_label="$1"
  local plist_path="$HOME/Library/LaunchAgents/${launchd_label}.plist"

  # The CLI writes the correct plist for this isolated lane, but launchctl can
  # report the job as not loaded after a force install. Bootstrap the exact
  # verified plist so runtime-backed smoke proves a real listener, not just a
  # file on disk.
  /bin/launchctl bootstrap "gui/$(id -u)" "$plist_path" >/dev/null 2>&1 || true
  /bin/launchctl kickstart -k "gui/$(id -u)/${launchd_label}" >/dev/null 2>&1 || true
}

refresh_gateway_service_env() {
  local normalized="$1"
  local state_dir="$2"
  local config_path="$3"
  local gateway_port
  local profile
  local launchd_label

  gateway_port="$(consumer_instance_gateway_port "$normalized")"
  profile="$(consumer_instance_profile "$normalized")"
  launchd_label="$(consumer_instance_gateway_launchd_label "$normalized")"

  # LaunchServices does not reliably carry every shell env var into the app or
  # the supervised gateway. Reinstall the isolated gateway job from this shell
  # after bootstrap has written config so Telegram proof uses the right port,
  # profile, state dir, and label.
  local attempt
  for attempt in {1..20}; do
    if [[ -f "$config_path" ]]; then
      scope_runtime_backed_smoke_plugins "$config_path"
      bootout_conflicting_gateway_label "ai.openclaw.gateway" "$launchd_label" "$state_dir" "$config_path" "$gateway_port"
      bootout_conflicting_gateway_label "ai.openclaw.consumer.gateway" "$launchd_label" "$state_dir" "$config_path" "$gateway_port"
      "${OPENCLAW_LAUNCHCTL_BIN}" bootout "gui/$(id -u)/${launchd_label}" >/dev/null 2>&1 || true
      OPENCLAW_STATE_DIR="$state_dir" \
        OPENCLAW_CONFIG_PATH="$config_path" \
        OPENCLAW_PROFILE="$profile" \
        OPENCLAW_LAUNCHD_LABEL="$launchd_label" \
        OPENCLAW_CONSUMER_INSTANCE_ID="$normalized" \
      OPENCLAW_FORK_ROOT="$ROOT_DIR" \
        "$OPENCLAW_NODE_BIN" "$GATEWAY_ENTRY" gateway install \
          --force \
          --allow-shared-service-takeover \
          --port "$gateway_port" \
          --runtime node >/dev/null
      verify_gateway_plist_matches_instance "$normalized" "$state_dir" "$config_path" "$gateway_port" "$profile" "$launchd_label"
      bootstrap_isolated_gateway_plist "$launchd_label"
      wait_for_gateway_health "$gateway_port"
      return 0
    fi
    /bin/sleep 0.25
  done

  echo "ERROR: isolated runtime config was not created in time: $config_path" >&2
  return 1
}

launch_smoke_app() {
  local app_path="$1"
  local log_path="$2"
  shift 2

  # Use LaunchServices for the real launch so the GUI belongs to macOS, not this
  # short-lived shell. Direct exec can pass the immediate check and still vanish
  # after bash exits, which makes the smoke useless for visual inspection.
  /usr/bin/open \
    -n \
    -F \
    --stdout "$log_path" \
    --stderr "$log_path" \
    --env "OPENCLAW_APP_VARIANT=$OPENCLAW_APP_VARIANT" \
    --env "OPENCLAW_CONFIG_PATH=$OPENCLAW_CONFIG_PATH" \
    --env "OPENCLAW_CONSUMER_INSTANCE_ID=$OPENCLAW_CONSUMER_INSTANCE_ID" \
    --env "OPENCLAW_FORK_ROOT=$OPENCLAW_FORK_ROOT" \
    --env "OPENCLAW_GATEWAY_BIND=$OPENCLAW_GATEWAY_BIND" \
    --env "OPENCLAW_GATEWAY_PORT=$OPENCLAW_GATEWAY_PORT" \
    --env "OPENCLAW_HOME=$OPENCLAW_HOME" \
    --env "OPENCLAW_LAUNCHD_LABEL=$OPENCLAW_LAUNCHD_LABEL" \
    --env "OPENCLAW_LOG_DIR=$OPENCLAW_LOG_DIR" \
    --env "OPENCLAW_PROFILE=$OPENCLAW_PROFILE" \
    --env "OPENCLAW_STATE_DIR=$OPENCLAW_STATE_DIR" \
    "$@" \
    "$app_path" \
    --args "${APP_ARGS[@]}"
}

print_proof() {
  local binary_path="$1"
  local app_path="$2"
  local normalized="$3"
  local state_dir="$4"
  local config_path="$5"
  local logs_dir="$6"
  local log_path="$7"
  local elapsed="$8"
  local runtime_mode="$9"
  local launchd_label="${10}"
  local gateway_port="${11}"
  local disable_marker="${12}"

  echo "Jarvis macOS UI smoke proof:"
  echo "  binary_path=$binary_path"
  echo "  debug_app_path=$app_path"
  echo "  instance_id=$normalized"
  echo "  runtime_mode=$runtime_mode"
  echo "  state_dir=$state_dir"
  echo "  config_path=$config_path"
  echo "  logs_dir=$logs_dir"
  echo "  gateway_launchd_label=$launchd_label"
  echo "  gateway_port=$gateway_port"
  echo "  launchagent_disable_marker=$disable_marker"
  echo "  launch_log=$log_path"
  echo "  display_identity=Jarvis (OPENCLAW_APP_VARIANT=consumer)"
  echo "  bundle_identity=minimal debug .app wrapper; current worktree SwiftPM binary"
  echo "  no_applications_install=true"
  echo "  no_release_packaging=true"
  echo "  no_default_gateway_restart=true"
  echo "  elapsed_seconds=$elapsed"
}

write_debug_app_wrapper() {
  local binary_path="$1"
  local app_path="$2"
  local normalized="$3"
  local state_dir="$4"
  local config_path="$5"
  local logs_dir="$6"
  local consumer_step="$7"

  local contents_dir="$app_path/Contents"
  local macos_dir="$contents_dir/MacOS"
  local frameworks_dir="$contents_dir/Frameworks"
  local info_plist="$contents_dir/Info.plist"
  local bundle_id="ai.openclaw.consumer.mac.debug.ui-smoke.${normalized}"
  local display_name="Jarvis UI Smoke (${normalized})"
  local sparkle_framework="$BUILD_PATH/${BUILD_CONFIG}/Sparkle.framework"
  local swift_compat_lib="$(xcode-select -p)/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-6.2/macosx/libswiftCompatibilitySpan.dylib"

  /bin/rm -rf "$app_path"
  /bin/mkdir -p "$macos_dir" "$frameworks_dir"
  /bin/cp "$binary_path" "$macos_dir/OpenClaw"
  /bin/chmod +x "$macos_dir/OpenClaw"

  # Keep this wrapper tiny, but still app-shaped enough for SwiftUI,
  # UserNotifications, and Sparkle to resolve bundle/rpath state correctly.
  if [[ -d "$sparkle_framework" ]]; then
    /bin/cp -R "$sparkle_framework" "$frameworks_dir/"
    /bin/chmod -R a+rX "$frameworks_dir/Sparkle.framework"
  fi
  if [[ -f "$swift_compat_lib" ]]; then
    /bin/cp "$swift_compat_lib" "$frameworks_dir/"
    /bin/chmod +x "$frameworks_dir/libswiftCompatibilitySpan.dylib"
  fi

  cat >"$info_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${display_name}</string>
  <key>CFBundleExecutable</key>
  <string>OpenClaw</string>
  <key>CFBundleIdentifier</key>
  <string>${bundle_id}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${display_name}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.0.0-ui-smoke</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSEnvironment</key>
  <dict>
    <key>OPENCLAW_APP_VARIANT</key>
    <string>consumer</string>
    <key>OPENCLAW_CONFIG_PATH</key>
    <string>${config_path}</string>
    <key>OPENCLAW_CONSUMER_INSTANCE_ID</key>
    <string>${normalized}</string>
    <key>OPENCLAW_FORK_ROOT</key>
    <string>${ROOT_DIR}</string>
    <key>OPENCLAW_HOME</key>
    <string>$(consumer_instance_runtime_root "$normalized")</string>
    <key>OPENCLAW_LOG_DIR</key>
    <string>${logs_dir}</string>
    <key>OPENCLAW_CONSUMER_SETUP_DEBUG_STEP</key>
    <string>${consumer_step}</string>
    <key>OPENCLAW_PROFILE</key>
    <string>$(consumer_instance_profile "$normalized")</string>
    <key>OPENCLAW_STATE_DIR</key>
    <string>${state_dir}</string>
  </dict>
  <key>OpenClawAppVariant</key>
  <string>consumer</string>
  <key>OpenClawConsumerInstanceID</key>
  <string>${normalized}</string>
</dict>
</plist>
EOF
}

select_ui_smoke_signing_identity() {
  if [[ -n "${OPENCLAW_UI_SMOKE_SIGN_IDENTITY:-}" ]]; then
    echo "$OPENCLAW_UI_SMOKE_SIGN_IDENTITY"
    return 0
  fi

  local identity=""
  identity="$(security find-identity -p codesigning -v 2>/dev/null \
    | awk -F '"' '/Apple Development:/ { print $2; exit }')"
  if [[ -n "$identity" ]]; then
    echo "$identity"
    return 0
  fi

  identity="$(security find-identity -p codesigning -v 2>/dev/null \
    | awk -F '"' '/Developer ID Application:/ { print $2; exit }')"
  if [[ -n "$identity" ]]; then
    echo "$identity"
    return 0
  fi

  return 1
}

sign_debug_app_wrapper() {
  local app_path="$1"
  local signing_identity=""

  if ! signing_identity="$(select_ui_smoke_signing_identity)"; then
    echo "warning: no codesigning identity found; UI smoke permissions may reset after rebuilds" >&2
    return 0
  fi

  # TCC tracks Accessibility and Screen Recording against the app's code
  # requirement. SwiftPM outputs are ad-hoc signed, so every rebuild otherwise
  # looks like a new app to macOS even when the bundle id is stable.
  /usr/bin/codesign \
    --force \
    --deep \
    --sign "$signing_identity" \
    --timestamp=none \
    "$app_path"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --instance requires a value" >&2
        exit 1
      fi
      INSTANCE_ID="$2"
      shift 2
      ;;
    --consumer-step)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --consumer-step requires a value" >&2
        exit 1
      fi
      CONSUMER_STEP="$2"
      shift 2
      ;;
    --no-open|--build-only)
      OPEN_APP=0
      shift
      ;;
    --no-build)
      BUILD_APP=0
      shift
      ;;
    --clean)
      CLEAN_ONLY=1
      OPEN_APP=0
      BUILD_APP=0
      shift
      ;;
    --with-runtime)
      WITH_RUNTIME=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$CLEAN_ONLY" == "1" ]]; then
  cleanup_ui_smoke_artifacts
  exit 0
fi

if [[ -z "$INSTANCE_ID" ]]; then
  INSTANCE_ID="$(consumer_instance_default_id_for_checkout "$ROOT_DIR")"
fi

NORMALIZED_INSTANCE_ID="$(consumer_instance_normalize_id "$INSTANCE_ID")"
if [[ -z "$NORMALIZED_INSTANCE_ID" ]]; then
  echo "ERROR: could not derive a non-default consumer instance id." >&2
  echo "Use --instance <id> so this smoke cannot collide with the shared runtime." >&2
  exit 1
fi

STATE_DIR="$(consumer_instance_state_dir "$NORMALIZED_INSTANCE_ID")"
CONFIG_PATH="$(consumer_instance_config_path "$NORMALIZED_INSTANCE_ID")"
LOGS_DIR="$(consumer_instance_logs_path "$NORMALIZED_INSTANCE_ID")"
LOG_PATH="$LOGS_DIR/mac-ui-smoke.log"
BINARY_PATH="$BUILD_PATH/${BUILD_CONFIG}/OpenClaw"
APP_PATH="$ROOT_DIR/dist-ui-smoke/Jarvis UI Smoke (${NORMALIZED_INSTANCE_ID}).app"
GATEWAY_LAUNCHD_LABEL="$(consumer_instance_gateway_launchd_label "$NORMALIZED_INSTANCE_ID")"
GATEWAY_PORT="$(consumer_instance_gateway_port "$NORMALIZED_INSTANCE_ID")"
LAUNCHAGENT_DISABLE_MARKER="$STATE_DIR/disable-launchagent"
RUNTIME_MODE="visual-only"
if [[ "$WITH_RUNTIME" == "1" ]]; then
  RUNTIME_MODE="isolated-runtime-backed"
fi

/bin/mkdir -p "$STATE_DIR" "$LOGS_DIR"
resolve_backend_api_token
seed_jarvis_backend_config "$CONFIG_PATH"

if [[ "$BUILD_APP" == "1" ]]; then
  ensure_cli_build_output

  echo "Building Jarvis macOS UI smoke from source..."
  swift build \
    --package-path "$ROOT_DIR/apps/macos" \
    --product OpenClaw \
    --build-path "$BUILD_PATH" \
    --configuration "$BUILD_CONFIG" \
    -Xlinker -rpath \
    -Xlinker @executable_path/../Frameworks
else
  echo "Skipping SwiftPM build (--no-build)."
fi

if [[ ! -x "$BINARY_PATH" ]]; then
  echo "ERROR: expected SwiftPM binary not found: $BINARY_PATH" >&2
  exit 1
fi

write_debug_app_wrapper "$BINARY_PATH" "$APP_PATH" "$NORMALIZED_INSTANCE_ID" "$STATE_DIR" "$CONFIG_PATH" "$LOGS_DIR" "$CONSUMER_STEP"
sign_debug_app_wrapper "$APP_PATH"

if [[ "$OPEN_APP" == "0" ]]; then
  print_proof "$BINARY_PATH" "$APP_PATH" "$NORMALIZED_INSTANCE_ID" "$STATE_DIR" "$CONFIG_PATH" "$LOGS_DIR" "$LOG_PATH" "$((SECONDS - STARTED_AT))" "$RUNTIME_MODE" "$GATEWAY_LAUNCHD_LABEL" "$GATEWAY_PORT" "$LAUNCHAGENT_DISABLE_MARKER"
  echo "launch_skipped=true"
  exit 0
fi

terminate_matching_app_binary "$APP_PATH/Contents/MacOS/OpenClaw"

export OPENCLAW_APP_VARIANT=consumer
export OPENCLAW_CONSUMER_INSTANCE_ID="$NORMALIZED_INSTANCE_ID"
consumer_instance_export_runtime_env "$NORMALIZED_INSTANCE_ID"
export OPENCLAW_FORK_ROOT="$ROOT_DIR"

APP_ARGS=(--no-launchd --no-login-item)
# Runtime-backed smoke lets this script own the isolated LaunchAgent and lets
# the app attach to it. If the GUI also manages launchd, it can tear down the
# freshly verified gateway during relaunch and leave first-task proof racing a
# new bootstrap.

OPEN_ENV_ARGS=()
if [[ -n "$BACKEND_API_TOKEN" ]]; then
  # Keep the protected token out of the generated Info.plist. It is only
  # injected into the launched smoke process and is never printed in proof logs.
  OPEN_ENV_ARGS+=(--env "JARVIS_BACKEND_API_TOKEN=$BACKEND_API_TOKEN")
fi

if [[ "$WITH_RUNTIME" == "1" ]]; then
  # First launch is only a bootstrap pass: the app creates the isolated config
  # and the durable visual process is relaunched after this shell has installed
  # and verified the exact gateway plist the GUI should observe on startup.
  launch_smoke_app "$APP_PATH" "$LOG_PATH" "${OPEN_ENV_ARGS[@]}"
  approve_latest_device_pairing_if_pending "$NORMALIZED_INSTANCE_ID" "$STATE_DIR" "$CONFIG_PATH" "$GATEWAY_PORT" "$OPENCLAW_PROFILE" "$OPENCLAW_LAUNCHD_LABEL"
  refresh_gateway_service_env "$NORMALIZED_INSTANCE_ID" "$STATE_DIR" "$CONFIG_PATH"
  terminate_matching_app_binary "$APP_PATH/Contents/MacOS/OpenClaw"
fi

launch_smoke_app "$APP_PATH" "$LOG_PATH" "${OPEN_ENV_ARGS[@]}"
if [[ "$WITH_RUNTIME" == "1" ]]; then
  approve_latest_device_pairing_if_pending "$NORMALIZED_INSTANCE_ID" "$STATE_DIR" "$CONFIG_PATH" "$GATEWAY_PORT" "$OPENCLAW_PROFILE" "$OPENCLAW_LAUNCHD_LABEL"
fi

/bin/sleep 4
APP_PIDS=()
while IFS= read -r pid; do
  [[ -n "$pid" ]] || continue
  APP_PIDS+=("$pid")
done < <(find_launchd_owned_app_binary_pids "$APP_PATH/Contents/MacOS/OpenClaw")

/bin/sleep 1
APP_PIDS=()
while IFS= read -r pid; do
  [[ -n "$pid" ]] || continue
  APP_PIDS+=("$pid")
done < <(find_launchd_owned_app_binary_pids "$APP_PATH/Contents/MacOS/OpenClaw")

if [[ "${#APP_PIDS[@]}" -eq 0 ]]; then
  echo "ERROR: Jarvis UI smoke process exited after launch." >&2
  echo "Debug app: $APP_PATH" >&2
  echo "Launch log: $LOG_PATH" >&2
  exit 1
fi

# LaunchServices can leave a short-lived handoff process in the first scan.
# Re-scan after a small hold so the reported PID is the durable GUI process.
/bin/sleep 6
APP_PIDS=()
while IFS= read -r pid; do
  [[ -n "$pid" ]] || continue
  APP_PIDS+=("$pid")
done < <(find_launchd_owned_app_binary_pids "$APP_PATH/Contents/MacOS/OpenClaw")

if [[ "${#APP_PIDS[@]}" -eq 0 ]]; then
  echo "ERROR: Jarvis UI smoke process did not stay alive long enough for inspection." >&2
  echo "Debug app: $APP_PATH" >&2
  echo "Launch log: $LOG_PATH" >&2
  exit 1
fi

APP_PID="${APP_PIDS[0]}"
print_proof "$BINARY_PATH" "$APP_PATH" "$NORMALIZED_INSTANCE_ID" "$STATE_DIR" "$CONFIG_PATH" "$LOGS_DIR" "$LOG_PATH" "$((SECONDS - STARTED_AT))" "$RUNTIME_MODE" "$GATEWAY_LAUNCHD_LABEL" "$GATEWAY_PORT" "$LAUNCHAGENT_DISABLE_MARKER"
echo "pid=$APP_PID"
echo "process_running=true"
