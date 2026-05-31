#!/usr/bin/env bash
set -euo pipefail

# Stable side-by-side Jarvis Consumer RC packaging.
#
# This wrapper exists because local product validation and public distribution
# have different trust requirements. Both modes keep the same app identity and
# install path so TCC permissions, app state, and operator muscle memory do not
# churn between iterations.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/release-env.sh"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"

MODE=""
RC_INSTANCE_ID="jarvis-consumer-rc"
RC_APP_NAME="Jarvis Consumer"
RC_APP_BUNDLE_NAME="${RC_APP_NAME}.app"
RC_BUNDLE_ID="ai.openclaw.consumer.mac.consumer-rc"
RC_INSTALL_PATH="/Applications/${RC_APP_BUNDLE_NAME}"
RC_BUILT_APP_PATH="$ROOT_DIR/dist/${RC_APP_BUNDLE_NAME}"

usage() {
  cat <<'EOF'
Usage: scripts/package-jarvis-consumer-rc.sh --fast
       scripts/package-jarvis-consumer-rc.sh --notarize

Builds, signs, installs, and relaunches the stable Jarvis Consumer release
candidate app:

  app name:     Jarvis Consumer
  install path: /Applications/Jarvis Consumer.app
  bundle id:    ai.openclaw.consumer.mac.consumer-rc
  instance id:  jarvis-consumer-rc

Modes:
  --fast      Local RC loop. Skips Apple notarization, keeps the stable app
              identity/path, and relaunches only Jarvis Consumer.app.
  --notarize  Distribution RC loop. Uses the same identity/path, requires
              Developer ID + notary auth, notarizes/staples the app, then
              installs and relaunches Jarvis Consumer.app.

Safety:
  - Never touches /Applications/Jarvis.app.
  - Never bootouts or replaces the shared ai.openclaw.gateway service.
  - Uses the embedded jarvis-consumer-rc instance identity so the app runtime
    resolves isolated consumer state and gateway labels.
  - Refuses OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY=1 because that would collapse
    this RC lane onto the debug TCC identity.

Conservative env overrides:
  SKIP_PNPM_INSTALL=0|1
  SKIP_TSC=0|1
  SKIP_UI_BUILD=0|1
  BUILD_ARCHS="all|arm64|x86_64"
  SIGN_IDENTITY="Developer ID Application: ..."
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

notary_auth_configured() {
  if [[ -n "${NOTARYTOOL_KEY:-}" && -n "${NOTARYTOOL_KEY_ID:-}" && -n "${NOTARYTOOL_ISSUER:-}" ]]; then
    return 0
  fi
  if [[ -n "${NOTARYTOOL_PROFILE:-}" ]]; then
    return 0
  fi
  return 1
}

bundle_signing_authority() {
  local bundle_path="$1"
  /usr/bin/codesign -dv --verbose=4 "$bundle_path" 2>&1 \
    | /usr/bin/sed -n 's/^Authority=//p' \
    | /usr/bin/head -n 1
}

terminate_installed_rc_app() {
  local binary_path="$RC_INSTALL_PATH/Contents/MacOS/OpenClaw"
  local pids=()
  local pid=""

  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    pids+=("$pid")
  done < <(/bin/ps -axo pid=,command= | /usr/bin/awk -v target="$binary_path" 'index($0, target) > 0 { print $1 }')

  if [[ "${#pids[@]}" -gt 0 ]]; then
    /bin/kill "${pids[@]}" 2>/dev/null || true
  fi
}

assert_rc_inputs() {
  local env_instance="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
  local normalized_instance=""

  [[ "$RC_INSTALL_PATH" == "/Applications/Jarvis Consumer.app" ]] \
    || die "refusing unexpected install path: $RC_INSTALL_PATH"
  [[ "$RC_INSTALL_PATH" != "/Applications/Jarvis.app" ]] \
    || die "refusing to touch /Applications/Jarvis.app"
  [[ "$env_instance" == "" || "$env_instance" == "$RC_INSTANCE_ID" ]] \
    || die "OPENCLAW_CONSUMER_INSTANCE_ID must be unset or '$RC_INSTANCE_ID'"
  if truthy "${OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY:-}"; then
    die "OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY must be unset/false for the RC lane"
  fi

  normalized_instance="$(consumer_instance_normalize_id "$RC_INSTANCE_ID")"
  [[ "$normalized_instance" == "$RC_INSTANCE_ID" ]] \
    || die "RC instance id does not normalize cleanly: $RC_INSTANCE_ID -> $normalized_instance"
}

verify_rc_bundle() {
  local app_path="$1"
  APP_NAME="$RC_APP_NAME" \
  BUNDLE_ID="$RC_BUNDLE_ID" \
  OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY=0 \
    "$ROOT_DIR/scripts/verify-consumer-mac-app.sh" --instance "$RC_INSTANCE_ID" "$app_path"
}

package_rc_app_fast() {
  local default_skip_pnpm_install="${SKIP_PNPM_INSTALL:-1}"
  local default_skip_tsc="${SKIP_TSC:-1}"

  # First-run lanes still need real runtime output. Fast mode skips repeated
  # work only when the checkout already has the required artifacts.
  if [[ "${SKIP_PNPM_INSTALL+x}" != x && ! -d "$ROOT_DIR/node_modules" ]]; then
    default_skip_pnpm_install=0
    echo "node_modules missing; allowing pnpm install once for the RC package"
  fi
  if [[ "${SKIP_TSC+x}" != x && ! -f "$ROOT_DIR/dist/index.js" ]]; then
    default_skip_tsc=0
    echo "dist/index.js missing; forcing one JS build for the RC package"
  fi

  APP_NAME="$RC_APP_NAME" \
  APP_BUNDLE_NAME="$RC_APP_BUNDLE_NAME" \
  BUNDLE_ID="$RC_BUNDLE_ID" \
  APP_INSTANCE_ID="$RC_INSTANCE_ID" \
  OPENCLAW_CONSUMER_INSTANCE_ID="$RC_INSTANCE_ID" \
  OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY=0 \
  OPENCLAW_CONSUMER_FAST_PACKAGING=1 \
  SKIP_PNPM_INSTALL="$default_skip_pnpm_install" \
  SKIP_TSC="$default_skip_tsc" \
  SKIP_UI_BUILD="${SKIP_UI_BUILD:-1}" \
  SKIP_TEAM_ID_CHECK="${SKIP_TEAM_ID_CHECK:-1}" \
  BUILD_CONFIG="${BUILD_CONFIG:-release}" \
  BUILD_ARCHS="${BUILD_ARCHS:-all}" \
  CI="${CI:-true}" \
    "$ROOT_DIR/scripts/package-consumer-mac-app.sh" --instance "$RC_INSTANCE_ID"
}

package_rc_app_notarized() {
  APP_NAME="$RC_APP_NAME" \
  APP_BUNDLE_NAME="$RC_APP_BUNDLE_NAME" \
  BUNDLE_ID="$RC_BUNDLE_ID" \
  APP_INSTANCE_ID="$RC_INSTANCE_ID" \
  OPENCLAW_CONSUMER_INSTANCE_ID="$RC_INSTANCE_ID" \
  OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY=0 \
  BUILD_CONFIG="${BUILD_CONFIG:-release}" \
  BUILD_ARCHS="${BUILD_ARCHS:-all}" \
  CI="${CI:-true}" \
    "$ROOT_DIR/scripts/package-consumer-mac-app.sh" --instance "$RC_INSTANCE_ID"
}

notarize_rc_app() {
  local signing_authority=""
  local version=""
  local notary_zip=""

  signing_authority="$(bundle_signing_authority "$RC_BUILT_APP_PATH")"
  [[ "$signing_authority" == Developer\ ID\ Application:* ]] \
    || die "notarization requires Developer ID Application signing; current authority: ${signing_authority:-unknown}"
  notary_auth_configured \
    || die "notary auth missing; set NOTARYTOOL_KEY/NOTARYTOOL_KEY_ID/NOTARYTOOL_ISSUER or NOTARYTOOL_PROFILE"

  version="$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$RC_BUILT_APP_PATH/Contents/Info.plist")"
  notary_zip="$ROOT_DIR/dist/Jarvis-Consumer-RC-${version}.notary.zip"

  echo "Notarizing Jarvis Consumer RC app: $notary_zip"
  rm -f "$notary_zip"
  /usr/bin/ditto -c -k --sequesterRsrc --keepParent "$RC_BUILT_APP_PATH" "$notary_zip"
  STAPLE_APP_PATH="$RC_BUILT_APP_PATH" "$ROOT_DIR/scripts/notarize-mac-artifact.sh" "$notary_zip"
  rm -f "$notary_zip"
}

install_rc_app() {
  [[ -d "$RC_BUILT_APP_PATH" ]] || die "built RC app missing: $RC_BUILT_APP_PATH"
  [[ "$RC_INSTALL_PATH" == "/Applications/Jarvis Consumer.app" ]] \
    || die "refusing unexpected install path: $RC_INSTALL_PATH"

  terminate_installed_rc_app
  rm -rf "$RC_INSTALL_PATH"
  /usr/bin/ditto "$RC_BUILT_APP_PATH" "$RC_INSTALL_PATH"
}

relaunch_rc_app() {
  env -i \
    HOME="${HOME}" \
    USER="${USER:-$(id -un)}" \
    LOGNAME="${LOGNAME:-$(id -un)}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    LANG="${LANG:-en_US.UTF-8}" \
    GOOGLE_PLACES_API_KEY="${GOOGLE_PLACES_API_KEY:-}" \
    HIMALAYA_CONFIG="${HIMALAYA_CONFIG:-}" \
    OPENCLAW_CONSUMER_INSTANCE_ID="$RC_INSTANCE_ID" \
    /usr/bin/open -n "$RC_INSTALL_PATH"

  /usr/bin/osascript <<EOF >/dev/null 2>&1 || true
tell application id "$RC_BUNDLE_ID"
  reopen
  activate
end tell
EOF
}

print_summary() {
  local mode_label="$1"
  local gateway_label=""
  local gateway_port=""
  local state_dir=""

  gateway_label="$(consumer_instance_gateway_launchd_label "$RC_INSTANCE_ID")"
  gateway_port="$(consumer_instance_gateway_port "$RC_INSTANCE_ID")"
  state_dir="$(consumer_instance_state_dir "$RC_INSTANCE_ID")"

  echo "Jarvis Consumer RC package ready:"
  echo "  mode=$mode_label"
  echo "  app=$RC_INSTALL_PATH"
  echo "  bundle_id=$RC_BUNDLE_ID"
  echo "  instance_id=$RC_INSTANCE_ID"
  echo "  isolated_gateway_label=$gateway_label"
  echo "  isolated_gateway_port=$gateway_port"
  echo "  state_dir=$state_dir"
  echo "  shared_gateway=untouched (ai.openclaw.gateway was not booted out or replaced)"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast)
      [[ -z "$MODE" ]] || die "choose exactly one mode"
      MODE="fast"
      shift
      ;;
    --notarize)
      [[ -z "$MODE" ]] || die "choose exactly one mode"
      MODE="notarize"
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

if [[ -z "$MODE" ]]; then
  usage >&2
  exit 2
fi

assert_rc_inputs

case "$MODE" in
  fast)
    package_rc_app_fast
    verify_rc_bundle "$RC_BUILT_APP_PATH"
    install_rc_app
    verify_rc_bundle "$RC_INSTALL_PATH"
    relaunch_rc_app
    print_summary "fast"
    ;;
  notarize)
    package_rc_app_notarized
    verify_rc_bundle "$RC_BUILT_APP_PATH"
    notarize_rc_app
    verify_rc_bundle "$RC_BUILT_APP_PATH"
    install_rc_app
    verify_rc_bundle "$RC_INSTALL_PATH"
    relaunch_rc_app
    print_summary "notarize"
    ;;
esac
