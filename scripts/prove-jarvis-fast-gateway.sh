#!/usr/bin/env bash
set -euo pipefail

# Fast, non-publishing proof for the packaged Jarvis app bundle.
#
# This script intentionally separates static package proof from live gateway
# ownership proof. The release Jarvis.app uses the default ai.openclaw.gateway
# service, so launching it from a feature worktree can repair/take over the
# protected shared runtime. When that safe hook is missing, fail only when the
# caller explicitly requires live proof; otherwise print the exact proof gap.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"
source "$ROOT_DIR/scripts/lib/gateway-launchagent-guard.sh"

APP_PATH="$ROOT_DIR/dist/Jarvis.app"
BUILD_TRUSTED_RING=0
REQUIRE_LIVE=0
RUN_STATUS=1
SINGLE_ARCH_SMOKE=0
LAUNCH_WRITE_DISABLED=0
LAUNCH_SETTLE_SECONDS="${JARVIS_FAST_GATEWAY_LAUNCH_SETTLE_SECONDS:-8}"

usage() {
  cat <<'EOF'
Usage: scripts/prove-jarvis-fast-gateway.sh [options]

Options:
  --app <path>       App bundle to inspect. Defaults to dist/Jarvis.app.
  --build            First run scripts/package-openclaw-mac-dist.sh --trusted-ring-fast.
                     This skips notarization, dSYM, publish, and public URL verification.
  --single-arch-smoke
                     With --build, package only the current Mac arch by default and
                     set ALLOW_SINGLE_ARCH_CONSUMER_SMOKE=1. Local smoke only:
                     this is not release/sendable proof.
  --require-live     Require an already-safe gateway LaunchAgent/RPC proof.
                     The script does not launch default Jarvis.app because that can
                     mutate ai.openclaw.gateway from a feature worktree.
  --launch-write-disabled
                     Launch the packaged app with the app state disable-launchagent
                     marker present, then prove the protected LaunchAgent plist did
                     not change. The marker is removed afterward if this script
                     created it.
  --no-status        Skip the read-only gateway status/RPC probe.
  -h, --help         Show this help.

This command never notarizes, publishes, verifies public release URLs, installs
/Applications/Jarvis.app, or bootouts/replaces ai.openclaw.gateway.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

plist_value() {
  local plist_path="$1"
  local key_path="$2"
  /usr/libexec/PlistBuddy -c "Print :${key_path}" "$plist_path" 2>/dev/null || true
}

real_path() {
  local path="$1"
  if [[ -e "$path" ]]; then
    (cd "$(dirname "$path")" && printf '%s/%s\n' "$(pwd -P)" "$(basename "$path")")
  else
    printf '%s\n' "$path"
  fi
}

launchagent_program_arg() {
  local plist_path="$1"
  local index="$2"
  plist_value "$plist_path" "ProgramArguments:${index}"
}

launchagent_entrypoint() {
  local plist_path="$1"
  local index=0
  local arg=""

  while true; do
    arg="$(launchagent_program_arg "$plist_path" "$index")"
    [[ -n "$arg" ]] || break
    case "$arg" in
      */dist/index.js|*/openclaw.mjs|*/bin/openclaw.js)
        printf '%s\n' "$arg"
        return 0
        ;;
    esac
    index=$((index + 1))
  done
}

path_is_under() {
  local child="$1"
  local parent="$2"
  [[ "$child" == "$parent" || "$child" == "$parent/"* ]]
}

file_sha256() {
  local path="$1"
  if [[ -f "$path" ]]; then
    /usr/bin/shasum -a 256 "$path" | /usr/bin/awk '{ print $1 }'
  else
    printf 'missing\n'
  fi
}

process_pids_for_binary() {
  local binary_path="$1"
  /bin/ps -axo pid=,command= |
    /usr/bin/awk -v target="$binary_path" 'index($0, target) > 0 { print $1 }' |
    /usr/bin/sort
}

runtime_manifest_value() {
  local manifest_path="$1"
  local key="$2"
  [[ -f "$manifest_path" ]] || return 0
  node -e '
    const fs = require("node:fs");
    const [manifestPath, key] = process.argv.slice(1);
    const value = JSON.parse(fs.readFileSync(manifestPath, "utf8"))?.[key];
    if (value !== undefined && value !== null) process.stdout.write(String(value));
  ' "$manifest_path" "$key"
}

run_gateway_status_probe() {
  local instance_id="$1"
  local label="$2"
  local port="$3"
  local state_dir="$4"
  local config_path="$5"
  local runtime_root="$6"
  local logs_path="$7"
  local profile="$8"

  echo "gateway_status_probe=running"
  OPENCLAW_CONSUMER_INSTANCE_ID="$instance_id" \
  OPENCLAW_LAUNCHD_LABEL="$label" \
  OPENCLAW_GATEWAY_PORT="$port" \
  OPENCLAW_GATEWAY_BIND="loopback" \
  OPENCLAW_STATE_DIR="$state_dir" \
  OPENCLAW_CONFIG_PATH="$config_path" \
  OPENCLAW_HOME="$runtime_root" \
  OPENCLAW_LOG_DIR="$logs_path" \
  OPENCLAW_PROFILE="$profile" \
    pnpm --dir "$ROOT_DIR" openclaw:local gateway status --deep --require-rpc --json
}

run_write_disabled_launch_probe() {
  local marker_path="$1"
  local plist_path="$2"
  local app_path="$3"
  local app_binary="$4"
  local marker_created=0
  local marker_preexisting=0
  local before_hash
  local after_hash
  local before_pids
  local after_pids
  local new_pids

  before_pids="$(mktemp "${TMPDIR:-/tmp}/jarvis-fast-gateway-before.XXXXXX")"
  after_pids="$(mktemp "${TMPDIR:-/tmp}/jarvis-fast-gateway-after.XXXXXX")"

  cleanup_write_disabled_launch_probe() {
    if [[ -s "$after_pids" ]]; then
      local pids
      pids="$(/usr/bin/comm -13 "$before_pids" "$after_pids" | /usr/bin/tr '\n' ' ')"
      if [[ -n "$pids" ]]; then
        # Only terminate app processes that this proof launched from the inspected bundle.
        /bin/kill $pids >/dev/null 2>&1 || true
      fi
    fi
    if [[ "$marker_created" == "1" ]]; then
      /bin/rm -f "$marker_path"
    fi
    /bin/rm -f "$before_pids" "$after_pids"
  }

  echo "write_disabled_launch=running"
  echo "  launchagent_disable_marker=$marker_path"

  if [[ -e "$marker_path" ]]; then
    marker_preexisting=1
  else
    if ! /bin/mkdir -p "$(dirname "$marker_path")"; then
      cleanup_write_disabled_launch_probe
      return 1
    fi
    if ! /bin/cat >"$marker_path" <<EOF
{
  "version": 1,
  "source": "scripts/prove-jarvis-fast-gateway.sh",
  "reason": "write-disabled launch proof",
  "createdBy": "jarvis-fast-gateway"
}
EOF
    then
      cleanup_write_disabled_launch_probe
      return 1
    fi
    marker_created=1
  fi

  echo "  launchagent_disable_marker_preexisting=$([[ "$marker_preexisting" == "1" ]] && printf true || printf false)"
  before_hash="$(file_sha256 "$plist_path")"
  echo "  launchagent_plist_hash_before=$before_hash"
  process_pids_for_binary "$app_binary" >"$before_pids"

  if ! /usr/bin/open -n -g "$app_path"; then
    cleanup_write_disabled_launch_probe
    return 1
  fi

  new_pids=""
  for _ in {1..30}; do
    process_pids_for_binary "$app_binary" >"$after_pids"
    new_pids="$(/usr/bin/comm -13 "$before_pids" "$after_pids" | /usr/bin/tr '\n' ' ')"
    if [[ -n "$new_pids" ]]; then
      break
    fi
    /bin/sleep 0.5
  done

  echo "  launched_app_pids=${new_pids:-none}"
  if [[ -z "$new_pids" ]]; then
    cleanup_write_disabled_launch_probe
    return 1
  fi

  /bin/sleep "$LAUNCH_SETTLE_SECONDS"
  after_hash="$(file_sha256 "$plist_path")"
  echo "  launchagent_plist_hash_after=$after_hash"

  cleanup_write_disabled_launch_probe

  if [[ "$before_hash" != "$after_hash" ]]; then
    echo "  launchagent_plist_unchanged=false"
    return 1
  fi

  echo "  launchagent_plist_unchanged=true"
  echo "write_disabled_launch=true"
  return 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      [[ $# -ge 2 ]] || die "--app requires a path"
      APP_PATH="$2"
      shift 2
      ;;
    --build)
      BUILD_TRUSTED_RING=1
      shift
      ;;
    --single-arch-smoke)
      SINGLE_ARCH_SMOKE=1
      shift
      ;;
    --require-live)
      REQUIRE_LIVE=1
      shift
      ;;
    --launch-write-disabled)
      LAUNCH_WRITE_DISABLED=1
      shift
      ;;
    --no-status)
      RUN_STATUS=0
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

if [[ "$BUILD_TRUSTED_RING" == "1" ]]; then
  echo "build_trusted_ring_fast=running"
  if [[ "$SINGLE_ARCH_SMOKE" == "1" ]]; then
    echo "single_arch_smoke=true"
    ALLOW_SINGLE_ARCH_CONSUMER_SMOKE=1 \
    BUILD_ARCHS="${BUILD_ARCHS:-$(uname -m)}" \
      "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" --trusted-ring-fast
  else
    "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" --trusted-ring-fast
  fi
fi

APP_REAL_PATH="$(real_path "$APP_PATH")"
ROOT_REAL_PATH="$(real_path "$ROOT_DIR")"
CANONICAL_MAIN_ROOT="$(real_path "${OPENCLAW_CANONICAL_MAIN_ROOT:-$HOME/Programming_Projects/openclaw}")"
ROOT_IS_CANONICAL_MAIN=0
if [[ "$ROOT_REAL_PATH" == "$CANONICAL_MAIN_ROOT" ]]; then
  ROOT_IS_CANONICAL_MAIN=1
fi

if [[ "$APP_REAL_PATH" == "/Applications/Jarvis.app" ]]; then
  die "refusing to inspect /Applications/Jarvis.app in this lane; use dist/Jarvis.app or another local packaged bundle"
fi

INFO_PLIST="$APP_PATH/Contents/Info.plist"
[[ -f "$INFO_PLIST" ]] || die "app bundle not found: $APP_PATH"

DISPLAY_NAME="$(plist_value "$INFO_PLIST" "CFBundleDisplayName")"
BUNDLE_ID="$(plist_value "$INFO_PLIST" "CFBundleIdentifier")"
VARIANT="$(plist_value "$INFO_PLIST" "OpenClawAppVariant")"
INSTANCE_ID="$(plist_value "$INFO_PLIST" "OpenClawConsumerInstanceID")"
VERSION="$(plist_value "$INFO_PLIST" "CFBundleShortVersionString")"
BUILD="$(plist_value "$INFO_PLIST" "CFBundleVersion")"
COMMIT="$(plist_value "$INFO_PLIST" "OpenClawGitCommit")"
SPARKLE_FEED_URL="$(plist_value "$INFO_PLIST" "SUFeedURL")"
SPARKLE_AUTO_CHECKS="$(plist_value "$INFO_PLIST" "SUEnableAutomaticChecks")"
NORMALIZED_INSTANCE_ID="$(consumer_instance_normalize_id "$INSTANCE_ID")"

[[ "$VARIANT" == "consumer" ]] || die "expected consumer app variant, got '${VARIANT:-missing}'"
[[ "$INSTANCE_ID" == "$NORMALIZED_INSTANCE_ID" ]] || die "instance id is not normalized: '$INSTANCE_ID' -> '$NORMALIZED_INSTANCE_ID'"

VERIFY_ARGS=()
if [[ -n "$NORMALIZED_INSTANCE_ID" ]]; then
  VERIFY_ARGS+=(--instance "$NORMALIZED_INSTANCE_ID")
fi

echo "jarvis_fast_gateway_static=verifying"
APP_NAME="$DISPLAY_NAME" \
BUNDLE_ID="$BUNDLE_ID" \
  "$ROOT_DIR/scripts/verify-consumer-mac-app.sh" "${VERIFY_ARGS[@]}" "$APP_PATH"

RUNTIME_RESOURCE_ROOT="$APP_PATH/Contents/Resources/OpenClawRuntime"
RUNTIME_PROJECT_ROOT="$RUNTIME_RESOURCE_ROOT/openclaw"
RUNTIME_ENTRYPOINT="$RUNTIME_PROJECT_ROOT/dist/index.js"
RUNTIME_MANIFEST="$RUNTIME_RESOURCE_ROOT/manifest.json"
APP_BINARY="$APP_PATH/Contents/MacOS/OpenClaw"
[[ -d "$RUNTIME_RESOURCE_ROOT" ]] || die "bundled runtime resource missing: $RUNTIME_RESOURCE_ROOT"
[[ -r "$RUNTIME_ENTRYPOINT" ]] || die "bundled runtime entrypoint missing: $RUNTIME_ENTRYPOINT"
[[ -x "$APP_BINARY" ]] || die "app executable missing: $APP_BINARY"

SIGNATURE_STATUS="invalid"
if /usr/bin/codesign --verify --deep --strict "$APP_PATH" >/dev/null 2>&1; then
  SIGNATURE_STATUS="valid"
fi

EXPECTED_LABEL="$(consumer_instance_gateway_launchd_label "$NORMALIZED_INSTANCE_ID")"
EXPECTED_PORT="$(consumer_instance_gateway_port "$NORMALIZED_INSTANCE_ID")"
EXPECTED_RUNTIME_ROOT="$(consumer_instance_runtime_root "$NORMALIZED_INSTANCE_ID")"
EXPECTED_STATE_DIR="$(consumer_instance_state_dir "$NORMALIZED_INSTANCE_ID")"
EXPECTED_CONFIG_PATH="$(consumer_instance_config_path "$NORMALIZED_INSTANCE_ID")"
EXPECTED_LOGS_PATH="$(consumer_instance_logs_path "$NORMALIZED_INSTANCE_ID")"
EXPECTED_PROFILE="$(consumer_instance_profile "$NORMALIZED_INSTANCE_ID")"
EXPECTED_INSTALLED_ENTRYPOINT="$EXPECTED_RUNTIME_ROOT/lib/openclaw-bundled/dist/index.js"
EXPECTED_NODE_PATH_ENTRY="$EXPECTED_STATE_DIR/tools/node/bin"
EXPECTED_CANONICAL_CONFIG=""
if [[ "$EXPECTED_LABEL" == "ai.openclaw.gateway" ]]; then
  EXPECTED_CANONICAL_CONFIG="$EXPECTED_CONFIG_PATH"
fi

LAUNCHAGENT_PLIST="$HOME/Library/LaunchAgents/${EXPECTED_LABEL}.plist"
LAUNCHAGENT_PRESENT=0
LAUNCHAGENT_MATCHES_EXPECTED=0
PROTECTED_DRIFT=0
STATUS_PROBE_OK=0
WRITE_DISABLED_LAUNCH_OK=0
PROOF_GAP=""

echo "Jarvis fast gateway package facts:"
echo "  app_path=$APP_PATH"
echo "  display_name=$DISPLAY_NAME"
echo "  bundle_id=$BUNDLE_ID"
echo "  variant=$VARIANT"
echo "  instance_id=${NORMALIZED_INSTANCE_ID:-default}"
echo "  version=$VERSION"
echo "  build=$BUILD"
echo "  git_commit=${COMMIT:-unknown}"
echo "  sparkle_feed_url=${SPARKLE_FEED_URL:-<blank>}"
echo "  sparkle_auto_checks=${SPARKLE_AUTO_CHECKS:-<missing>}"
echo "  signature=$SIGNATURE_STATUS"
echo "  bundled_runtime_entrypoint=$RUNTIME_ENTRYPOINT"
echo "  bundled_runtime_manifest=$RUNTIME_MANIFEST"
echo "  bundled_runtime_manifest_version=$(runtime_manifest_value "$RUNTIME_MANIFEST" bundleVersion)"
echo "  expected_gateway_label=$EXPECTED_LABEL"
echo "  expected_gateway_port=$EXPECTED_PORT"
echo "  expected_state_dir=$EXPECTED_STATE_DIR"
echo "  expected_config_path=$EXPECTED_CONFIG_PATH"
echo "  expected_installed_entrypoint=$EXPECTED_INSTALLED_ENTRYPOINT"

if [[ -f "$LAUNCHAGENT_PLIST" ]]; then
  LAUNCHAGENT_PRESENT=1
  ACTUAL_PORT="$(openclaw_gateway_plist_port "$LAUNCHAGENT_PLIST" || true)"
  ACTUAL_ENTRYPOINT="$(launchagent_entrypoint "$LAUNCHAGENT_PLIST")"
  ACTUAL_HOME="$(openclaw_gateway_plist_value "$LAUNCHAGENT_PLIST" "EnvironmentVariables:OPENCLAW_HOME")"
  ACTUAL_STATE_DIR="$(openclaw_gateway_plist_value "$LAUNCHAGENT_PLIST" "EnvironmentVariables:OPENCLAW_STATE_DIR")"
  ACTUAL_CONFIG_PATH="$(openclaw_gateway_plist_value "$LAUNCHAGENT_PLIST" "EnvironmentVariables:OPENCLAW_CONFIG_PATH")"
  ACTUAL_CANONICAL_CONFIG="$(openclaw_gateway_plist_value "$LAUNCHAGENT_PLIST" "EnvironmentVariables:OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH")"
  ACTUAL_SERVICE_VERSION="$(openclaw_gateway_plist_value "$LAUNCHAGENT_PLIST" "EnvironmentVariables:OPENCLAW_SERVICE_VERSION")"
  ACTUAL_SERVICE_BUILD="$(openclaw_gateway_plist_value "$LAUNCHAGENT_PLIST" "EnvironmentVariables:OPENCLAW_SERVICE_BUILD")"
  ACTUAL_PATH="$(openclaw_gateway_plist_value "$LAUNCHAGENT_PLIST" "EnvironmentVariables:PATH")"

  echo "Jarvis fast gateway LaunchAgent facts:"
  echo "  launchagent_plist=$LAUNCHAGENT_PLIST"
  echo "  actual_port=${ACTUAL_PORT:-missing}"
  echo "  actual_entrypoint=${ACTUAL_ENTRYPOINT:-missing}"
  echo "  actual_home=${ACTUAL_HOME:-missing}"
  echo "  actual_state_dir=${ACTUAL_STATE_DIR:-missing}"
  echo "  actual_config_path=${ACTUAL_CONFIG_PATH:-missing}"
  echo "  actual_canonical_config=${ACTUAL_CANONICAL_CONFIG:-missing}"
  echo "  actual_service_version=${ACTUAL_SERVICE_VERSION:-missing}"
  echo "  actual_service_build=${ACTUAL_SERVICE_BUILD:-missing}"

  if [[ "$EXPECTED_LABEL" == "ai.openclaw.gateway" ]] &&
    [[ -n "$ACTUAL_ENTRYPOINT" ]] &&
    { [[ "$ACTUAL_ENTRYPOINT" == *"/.worktrees/"* ]] ||
      { path_is_under "$ACTUAL_ENTRYPOINT" "$ROOT_REAL_PATH" && [[ "$ROOT_IS_CANONICAL_MAIN" != "1" ]]; }; }; then
    PROTECTED_DRIFT=1
  fi

  if [[ "$ACTUAL_PORT" == "$EXPECTED_PORT" &&
    "$ACTUAL_HOME" == "$EXPECTED_RUNTIME_ROOT" &&
    "$ACTUAL_STATE_DIR" == "$EXPECTED_STATE_DIR" &&
    "$ACTUAL_CONFIG_PATH" == "$EXPECTED_CONFIG_PATH" &&
    "$ACTUAL_ENTRYPOINT" == "$EXPECTED_INSTALLED_ENTRYPOINT" &&
    "$ACTUAL_SERVICE_VERSION" == "$VERSION" &&
    "$ACTUAL_SERVICE_BUILD" == "$BUILD" &&
    "$ACTUAL_PATH" == *"$EXPECTED_NODE_PATH_ENTRY"* ]]; then
    if [[ -z "$EXPECTED_CANONICAL_CONFIG" || "$ACTUAL_CANONICAL_CONFIG" == "$EXPECTED_CANONICAL_CONFIG" ]]; then
      LAUNCHAGENT_MATCHES_EXPECTED=1
    fi
  fi
else
  echo "Jarvis fast gateway LaunchAgent facts:"
  echo "  launchagent_plist=$LAUNCHAGENT_PLIST"
  echo "  launchagent_present=false"
fi

if [[ "$PROTECTED_DRIFT" == "1" ]]; then
  die "protected shared gateway appears pinned to this feature worktree: $ACTUAL_ENTRYPOINT"
fi

if [[ "$LAUNCHAGENT_MATCHES_EXPECTED" == "1" && "$RUN_STATUS" == "1" ]]; then
  if run_gateway_status_probe \
    "$NORMALIZED_INSTANCE_ID" \
    "$EXPECTED_LABEL" \
    "$EXPECTED_PORT" \
    "$EXPECTED_STATE_DIR" \
    "$EXPECTED_CONFIG_PATH" \
    "$EXPECTED_RUNTIME_ROOT" \
    "$EXPECTED_LOGS_PATH" \
    "$EXPECTED_PROFILE"; then
    STATUS_PROBE_OK=1
  fi
fi

if [[ "$LAUNCH_WRITE_DISABLED" == "1" ]]; then
  if run_write_disabled_launch_probe \
    "$EXPECTED_STATE_DIR/disable-launchagent" \
    "$LAUNCHAGENT_PLIST" \
    "$APP_PATH" \
    "$APP_BINARY"; then
    WRITE_DISABLED_LAUNCH_OK=1
  else
    die "write-disabled packaged app launch mutated the LaunchAgent or failed to launch"
  fi
fi

if [[ "$LAUNCHAGENT_PRESENT" == "0" ]]; then
  PROOF_GAP="gateway LaunchAgent is not present for $EXPECTED_LABEL"
elif [[ "$LAUNCHAGENT_MATCHES_EXPECTED" != "1" ]]; then
  PROOF_GAP="gateway LaunchAgent does not yet point at the packaged Jarvis installed runtime"
elif [[ "$RUN_STATUS" == "1" && "$STATUS_PROBE_OK" != "1" ]]; then
  PROOF_GAP="gateway LaunchAgent matches packaged runtime, but RPC status did not pass"
fi

if [[ -n "$PROOF_GAP" ]]; then
  echo "jarvis_fast_gateway_static=true"
  echo "jarvis_fast_gateway_live=false"
  echo "proof_gap=$PROOF_GAP"
  if [[ "$EXPECTED_LABEL" == "ai.openclaw.gateway" ]]; then
    if [[ "$WRITE_DISABLED_LAUNCH_OK" == "1" ]]; then
      echo "safe_live_hook=write-disabled packaged app launch preserved ai.openclaw.gateway"
    else
      echo "safe_live_hook_needed=release Jarvis.app needs a non-default isolated launch/proof mode, or an app-level write-disabled dry-run that reports GatewayLaunchAgentManager's desired install without modifying ai.openclaw.gateway"
    fi
  fi
  if [[ "$REQUIRE_LIVE" == "1" ]]; then
    die "live packaged gateway proof required but unsafe or incomplete: $PROOF_GAP"
  fi
else
  echo "jarvis_fast_gateway_static=true"
  echo "jarvis_fast_gateway_live=true"
  echo "proof_gap=none"
fi

echo "protected_surfaces=preserved"
echo "applications_jarvis_app=untouched"
echo "notarization=skipped"
echo "publish=skipped"
