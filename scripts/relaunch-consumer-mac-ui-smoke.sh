#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"

INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
OPEN_APP=1
BUILD_APP=1
CLEAN_ONLY=0
BUILD_CONFIG="${BUILD_CONFIG:-debug}"
BUILD_PATH="$ROOT_DIR/apps/macos/.build-ui-smoke"
STARTED_AT="$SECONDS"

usage() {
  cat <<'EOF'
Usage: scripts/relaunch-consumer-mac-ui-smoke.sh [--instance <id>] [--no-open|--build-only] [--no-build] [--clean]

Fast native Jarvis UI smoke:
  - builds apps/macos with SwiftPM only unless --no-build is passed
  - launches the current worktree's debug binary through a tiny debug .app wrapper
  - uses an isolated consumer instance/config/state
  - skips /Applications installs, release packaging, DMGs, zips, npm tarballs,
    bundled Node, node_modules packaging, and default gateway restarts

Cleanup:
  --clean removes generated UI-smoke build output and stopped debug .app wrappers.
          Running UI-smoke apps are left in place for inspection.
EOF
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

cleanup_ui_smoke_artifacts() {
  local app_dir="$ROOT_DIR/dist-ui-smoke"
  local app_path=""
  local binary_path=""
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
    return
  fi

  shopt -s nullglob
  for app_path in "$app_dir"/*.app; do
    binary_path="$app_path/Contents/MacOS/OpenClaw"
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

  # Remove the container only when every wrapper was safely removed.
  /bin/rmdir "$app_dir" 2>/dev/null || true
  echo "UI-smoke cleanup complete: removed_app_wrappers=$removed_apps skipped_running_app_wrappers=$skipped_apps"
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

print_proof() {
  local binary_path="$1"
  local app_path="$2"
  local normalized="$3"
  local state_dir="$4"
  local config_path="$5"
  local logs_dir="$6"
  local log_path="$7"
  local elapsed="$8"

  echo "Jarvis macOS UI smoke proof:"
  echo "  binary_path=$binary_path"
  echo "  debug_app_path=$app_path"
  echo "  instance_id=$normalized"
  echo "  state_dir=$state_dir"
  echo "  config_path=$config_path"
  echo "  logs_dir=$logs_dir"
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

/bin/mkdir -p "$STATE_DIR" "$LOGS_DIR"

if [[ "$BUILD_APP" == "1" ]]; then
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

write_debug_app_wrapper "$BINARY_PATH" "$APP_PATH" "$NORMALIZED_INSTANCE_ID" "$STATE_DIR" "$CONFIG_PATH" "$LOGS_DIR"

if [[ "$OPEN_APP" == "0" ]]; then
  print_proof "$BINARY_PATH" "$APP_PATH" "$NORMALIZED_INSTANCE_ID" "$STATE_DIR" "$CONFIG_PATH" "$LOGS_DIR" "$LOG_PATH" "$((SECONDS - STARTED_AT))"
  echo "launch_skipped=true"
  exit 0
fi

terminate_matching_app_binary "$APP_PATH/Contents/MacOS/OpenClaw"

# --no-launchd writes the disable marker inside this isolated state dir and
# prevents the GUI from installing/restarting any gateway job. The exported
# runtime env is the same consumer identity contract used by packaged builds,
# minus every packaging step.
export OPENCLAW_APP_VARIANT=consumer
export OPENCLAW_CONSUMER_INSTANCE_ID="$NORMALIZED_INSTANCE_ID"
consumer_instance_export_runtime_env "$NORMALIZED_INSTANCE_ID"
export OPENCLAW_FORK_ROOT="$ROOT_DIR"

# Use LaunchServices for the real launch so the GUI belongs to macOS, not this
# short-lived shell. Direct exec can pass the immediate check and still vanish
# after bash exits, which makes the smoke useless for visual inspection.
/usr/bin/open \
  -n \
  -F \
  --stdout "$LOG_PATH" \
  --stderr "$LOG_PATH" \
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
  "$APP_PATH" \
  --args --no-launchd

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
print_proof "$BINARY_PATH" "$APP_PATH" "$NORMALIZED_INSTANCE_ID" "$STATE_DIR" "$CONFIG_PATH" "$LOGS_DIR" "$LOG_PATH" "$((SECONDS - STARTED_AT))"
echo "pid=$APP_PID"
echo "process_running=true"
