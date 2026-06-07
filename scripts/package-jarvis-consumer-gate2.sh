#!/usr/bin/env bash
set -euo pipefail

# Build and stage the one-off Gate2 clean-user RC proof app.
# This deliberately does not install into /Applications and does not launch the
# app, so the coordinator can prove port ownership before the clean user opens it.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"

GATE2_INSTANCE_ID="jarvis-consumer-gate2"
GATE2_APP_NAME="Jarvis Consumer Gate2"
GATE2_APP_BUNDLE_NAME="${GATE2_APP_NAME}.app"
GATE2_BUNDLE_ID="ai.openclaw.consumer.mac.gate2"
GATE2_EXPECTED_PORT="25229"
GATE2_EXPECTED_LABEL="ai.openclaw.consumer.jarvis-consumer-gate2.gateway"
GATE2_USER="${JARVIS_GATE2_USER:-jarvistest}"
GATE2_SHARED_DIR="${JARVIS_GATE2_SHARED_DIR:-/Users/Shared/JarvisConsumerGate2}"
GATE2_BUILT_APP_PATH="$ROOT_DIR/dist/$GATE2_APP_BUNDLE_NAME"

usage() {
  cat <<'EOF'
Usage: scripts/package-jarvis-consumer-gate2.sh --fast [--reuse-runtime]

Builds a one-off Jarvis Consumer Gate2 app for true clean-user proof:

  app name:     Jarvis Consumer Gate2
  bundle id:    ai.openclaw.consumer.mac.gate2
  instance id:  jarvis-consumer-gate2
  port:         25229
  label:        ai.openclaw.consumer.jarvis-consumer-gate2.gateway

The script stages the app under /Users/jarvistest/Desktop by default and copies
a read-only proof collector to /Users/Shared/JarvisConsumerGate2. It does not
install into /Applications and does not launch the app.

Env overrides:
  JARVIS_GATE2_USER=<macOS user>      default: jarvistest
  JARVIS_GATE2_SHARED_DIR=<path>      default: /Users/Shared/JarvisConsumerGate2
  SKIP_PNPM_INSTALL=0|1
  SKIP_TSC=0|1
  SKIP_UI_BUILD=0|1
  BUILD_ARCHS="all|arm64|x86_64"
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

assert_expected_identity() {
  local normalized
  local port
  local label

  normalized="$(consumer_instance_normalize_id "$GATE2_INSTANCE_ID")"
  [[ "$normalized" == "$GATE2_INSTANCE_ID" ]] \
    || die "Gate2 instance id does not normalize cleanly: $GATE2_INSTANCE_ID -> $normalized"

  port="$(consumer_instance_gateway_port "$GATE2_INSTANCE_ID")"
  label="$(consumer_instance_gateway_launchd_label "$GATE2_INSTANCE_ID")"

  [[ "$port" == "$GATE2_EXPECTED_PORT" ]] \
    || die "expected Gate2 port $GATE2_EXPECTED_PORT, got $port"
  [[ "$label" == "$GATE2_EXPECTED_LABEL" ]] \
    || die "expected Gate2 label $GATE2_EXPECTED_LABEL, got $label"
}

assert_port_free() {
  if lsof -nP -iTCP:"$GATE2_EXPECTED_PORT" -sTCP:LISTEN >/tmp/jarvis-gate2-port-owner.txt 2>&1; then
    cat /tmp/jarvis-gate2-port-owner.txt >&2
    die "port $GATE2_EXPECTED_PORT is already owned; stop before staging Gate2"
  fi
}

target_home() {
  local home
  home="$(dscl . -read "/Users/${GATE2_USER}" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"
  [[ -n "$home" ]] || home="/Users/${GATE2_USER}"
  printf '%s\n' "$home"
}

stage_gate2_app() {
  local home
  local desktop
  local staged_app

  home="$(target_home)"
  desktop="$home/Desktop"
  staged_app="$desktop/$GATE2_APP_BUNDLE_NAME"

  [[ -d "$desktop" ]] \
    || die "target Desktop is missing: $desktop"
  [[ -w "$desktop" ]] \
    || die "target Desktop is not writable: $desktop"
  [[ -d "$GATE2_BUILT_APP_PATH" ]] \
    || die "built Gate2 app missing: $GATE2_BUILT_APP_PATH"

  rm -rf "$staged_app"
  /usr/bin/ditto "$GATE2_BUILT_APP_PATH" "$staged_app"

  echo "Staged Gate2 app:"
  echo "  app=$staged_app"
}

assert_stage_target_ready() {
  local home
  local desktop

  home="$(target_home)"
  desktop="$home/Desktop"

  [[ -d "$desktop" ]] \
    || die "target Desktop is missing: $desktop"
  [[ -w "$desktop" ]] \
    || die "target Desktop is not writable from $(whoami): $desktop"
}

stage_collector() {
  mkdir -p "$GATE2_SHARED_DIR"
  /usr/bin/ditto \
    "$ROOT_DIR/scripts/collect-jarvis-consumer-gate2-logs.sh" \
    "$GATE2_SHARED_DIR/collect-jarvis-consumer-gate2-logs.sh"
  chmod +x "$GATE2_SHARED_DIR/collect-jarvis-consumer-gate2-logs.sh"

  echo "Staged Gate2 collector:"
  echo "  collector=$GATE2_SHARED_DIR/collect-jarvis-consumer-gate2-logs.sh"
}

verify_info_plist() {
  local info="$GATE2_BUILT_APP_PATH/Contents/Info.plist"
  local display_name
  local bundle_id
  local instance_id
  local commit

  [[ -f "$info" ]] || die "Info.plist missing: $info"

  display_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$info")"
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info")"
  instance_id="$(/usr/libexec/PlistBuddy -c 'Print :OpenClawConsumerInstanceID' "$info")"
  commit="$(/usr/libexec/PlistBuddy -c 'Print :OpenClawGitCommit' "$info" 2>/dev/null || true)"

  [[ "$display_name" == "$GATE2_APP_NAME" ]] \
    || die "expected display name '$GATE2_APP_NAME', got '$display_name'"
  [[ "$bundle_id" == "$GATE2_BUNDLE_ID" ]] \
    || die "expected bundle id '$GATE2_BUNDLE_ID', got '$bundle_id'"
  [[ "$instance_id" == "$GATE2_INSTANCE_ID" ]] \
    || die "expected instance id '$GATE2_INSTANCE_ID', got '$instance_id'"
  [[ -n "$commit" ]] \
    || die "embedded commit missing"

  echo "Verified Gate2 Info.plist:"
  echo "  display_name=$display_name"
  echo "  bundle_id=$bundle_id"
  echo "  instance_id=$instance_id"
  echo "  embedded_commit=$commit"
}

runtime_js_ready() {
  # Gate2 is a clean-user proof lane, so a shell-only app bundle is worse than
  # no bundle: it reaches onboarding and then cannot boot the gateway.
  [[ -f "$ROOT_DIR/dist/index.js" || -f "$ROOT_DIR/dist/index.mjs" ]] || return 1
  [[ -f "$ROOT_DIR/dist/entry.js" || -f "$ROOT_DIR/dist/entry.mjs" ]] || return 1
}

gate2_default_skip_tsc() {
  local requested="${SKIP_TSC:-1}"

  if [[ "${REUSE_RUNTIME:-0}" == "1" ]]; then
    runtime_js_ready || die "runtime JS missing; --reuse-runtime is unsafe. Rerun --fast once to rebuild runtime JS."
    printf '%s\n' "$requested"
    return 0
  fi

  if ! runtime_js_ready; then
    echo "runtime JS missing; forcing one JS build for the Gate2 package" >&2
    printf '0\n'
    return 0
  fi

  printf '%s\n' "$requested"
}

package_gate2_app_fast() {
  local package_args=(--instance "$GATE2_INSTANCE_ID")
  local default_skip_tsc=""

  if [[ "${REUSE_RUNTIME:-0}" == "1" ]]; then
    package_args+=(--reuse-runtime)
  fi
  default_skip_tsc="$(gate2_default_skip_tsc)"

  APP_NAME="$GATE2_APP_NAME" \
  APP_BUNDLE_NAME="$GATE2_APP_BUNDLE_NAME" \
  BUNDLE_ID="$GATE2_BUNDLE_ID" \
  APP_INSTANCE_ID="$GATE2_INSTANCE_ID" \
  OPENCLAW_CONSUMER_INSTANCE_ID="$GATE2_INSTANCE_ID" \
  OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY=0 \
  OPENCLAW_CONSUMER_FAST_PACKAGING=1 \
  SKIP_PNPM_INSTALL="${SKIP_PNPM_INSTALL:-1}" \
  SKIP_TSC="$default_skip_tsc" \
  SKIP_UI_BUILD="${SKIP_UI_BUILD:-1}" \
  BUILD_CONFIG="${BUILD_CONFIG:-release}" \
  BUILD_ARCHS="${BUILD_ARCHS:-all}" \
  CI="${CI:-true}" \
    "$ROOT_DIR/scripts/package-consumer-mac-app-fast.sh" "${package_args[@]}"
}

print_summary() {
  local home
  home="$(target_home)"

  echo "Jarvis Consumer Gate2 package staged:"
  echo "  user=$GATE2_USER"
  echo "  app=$home/Desktop/$GATE2_APP_BUNDLE_NAME"
  echo "  bundle_id=$GATE2_BUNDLE_ID"
  echo "  instance_id=$GATE2_INSTANCE_ID"
  echo "  isolated_gateway_label=$GATE2_EXPECTED_LABEL"
  echo "  isolated_gateway_port=$GATE2_EXPECTED_PORT"
  echo "  expected_state_dir=$home/Library/Application Support/OpenClaw/instances/$GATE2_INSTANCE_ID"
  echo "  collector=$GATE2_SHARED_DIR/collect-jarvis-consumer-gate2-logs.sh"
  echo "  shared_gateway=untouched; this script did not launch the app or mutate ai.openclaw.gateway"
}

MODE=""
REUSE_RUNTIME=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast)
      [[ -z "$MODE" ]] || die "choose exactly one mode"
      MODE="fast"
      shift
      ;;
    --reuse-runtime|--shell-only-fast)
      REUSE_RUNTIME=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$MODE" == "fast" ]] || {
  usage >&2
  exit 2
}

assert_expected_identity
assert_port_free
assert_stage_target_ready
package_gate2_app_fast
verify_info_plist
stage_gate2_app
stage_collector
print_summary
