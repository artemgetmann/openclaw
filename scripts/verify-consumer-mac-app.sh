#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"

INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
APP_PATH=""

usage() {
  cat <<'EOF'
Usage: scripts/verify-consumer-mac-app.sh [--instance <id>] [app_path]
Set OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY=1 when verifying an isolated runtime
lane that was packaged with the stable consumer debug app identity.
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
    --help|-h)
      usage
      exit 0
      ;;
    *)
      if [[ -n "$APP_PATH" ]]; then
        echo "ERROR: unexpected extra argument: $1" >&2
        usage >&2
        exit 1
      fi
      APP_PATH="$1"
      shift
      ;;
  esac
done

NORMALIZED_INSTANCE_ID="$(consumer_instance_normalize_id "$INSTANCE_ID")"
EXPECTED_NAME="$(consumer_instance_display_name "$NORMALIZED_INSTANCE_ID")"
# Allow release/distribution callers to override the debug bundle id while still
# reusing the same consumer-identity verifier.
EXPECTED_BUNDLE_ID="${BUNDLE_ID:-$(consumer_instance_bundle_id "$NORMALIZED_INSTANCE_ID")}"
EXPECTED_VARIANT="consumer"
EXPECTED_URL_SCHEME="openclaw-consumer"
EXPECTED_GATEWAY_PORT="$(consumer_instance_gateway_port "$NORMALIZED_INSTANCE_ID")"
APP_PATH="${APP_PATH:-$(consumer_instance_app_path "$ROOT_DIR" "$NORMALIZED_INSTANCE_ID")}"
INFO_PLIST="$APP_PATH/Contents/Info.plist"

if [[ ! -f "$INFO_PLIST" ]]; then
  echo "ERROR: consumer app bundle not found: $APP_PATH" >&2
  exit 1
fi

plist_print() {
  local key="$1"
  /usr/libexec/PlistBuddy -c "Print :$key" "$INFO_PLIST"
}

actual_name="$(plist_print CFBundleDisplayName)"
actual_bundle_id="$(plist_print CFBundleIdentifier)"
actual_variant="$(plist_print OpenClawAppVariant)"
actual_instance_id="$(/usr/libexec/PlistBuddy -c "Print :OpenClawConsumerInstanceID" "$INFO_PLIST" 2>/dev/null || true)"
actual_url_scheme="$(/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0" "$INFO_PLIST" 2>/dev/null || true)"
actual_version="$(plist_print CFBundleShortVersionString)"
actual_build="$(plist_print CFBundleVersion)"
actual_commit="$(/usr/libexec/PlistBuddy -c "Print :OpenClawGitCommit" "$INFO_PLIST" 2>/dev/null || echo "unknown")"
actual_build_ts="$(/usr/libexec/PlistBuddy -c "Print :OpenClawBuildTimestamp" "$INFO_PLIST" 2>/dev/null || echo "unknown")"

if [[ "$actual_name" != "$EXPECTED_NAME" ]]; then
  echo "ERROR: expected consumer display name '$EXPECTED_NAME', got '$actual_name'" >&2
  exit 1
fi

if [[ "$actual_bundle_id" != "$EXPECTED_BUNDLE_ID" ]]; then
  echo "ERROR: expected consumer bundle id '$EXPECTED_BUNDLE_ID', got '$actual_bundle_id'" >&2
  exit 1
fi

if [[ "$actual_variant" != "$EXPECTED_VARIANT" ]]; then
  echo "ERROR: expected consumer variant '$EXPECTED_VARIANT', got '$actual_variant'" >&2
  exit 1
fi

if [[ "$actual_instance_id" != "${NORMALIZED_INSTANCE_ID}" ]]; then
  echo "ERROR: expected consumer instance id '${NORMALIZED_INSTANCE_ID}', got '${actual_instance_id}'" >&2
  exit 1
fi

if [[ "$actual_url_scheme" != "$EXPECTED_URL_SCHEME" ]]; then
  echo "ERROR: expected URL scheme '$EXPECTED_URL_SCHEME', got '$actual_url_scheme'" >&2
  exit 1
fi

codesign --verify --deep --strict "$APP_PATH" >/dev/null

codesign_details="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1)"
signing_authority="$(printf '%s\n' "$codesign_details" | sed -n 's/^Authority=//p' | head -n 1)"
team_identifier="$(printf '%s\n' "$codesign_details" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
format_line="$(printf '%s\n' "$codesign_details" | sed -n 's/^Format=//p' | head -n 1)"

# Gatekeeper verdict is useful demo-distribution signal, but a local Apple
# Development build should still count as a valid bundle assembly result.
set +e
spctl_output="$(
  /usr/sbin/spctl -a -vv "$APP_PATH" 2>&1
)"
spctl_status=$?
set -e
gatekeeper_status="accepted"
gatekeeper_note="Gatekeeper accepted this app."
if [[ $spctl_status -ne 0 ]]; then
  gatekeeper_status="rejected"
  gatekeeper_note="Gatekeeper rejected this app."
  if printf '%s\n' "$spctl_output" | grep -q "origin=Apple Development:"; then
    gatekeeper_note="Gatekeeper rejected this app because it is Apple Development signed. Local/manual-trust demos are still possible; broader distribution needs Developer ID + notarization."
  fi
fi

runtime_root="$(consumer_instance_runtime_root "$HOME" "$NORMALIZED_INSTANCE_ID")"
state_dir="$(consumer_instance_state_dir "$HOME" "$NORMALIZED_INSTANCE_ID")"
config_path="$(consumer_instance_config_path "$HOME" "$NORMALIZED_INSTANCE_ID")"
workspace_path="$(consumer_instance_workspace_path "$HOME" "$NORMALIZED_INSTANCE_ID")"
logs_path="$(consumer_instance_logs_path "$HOME" "$NORMALIZED_INSTANCE_ID")"
app_launchd_label="$(consumer_instance_launchd_label "$NORMALIZED_INSTANCE_ID")"
gateway_launchd_label="$(consumer_instance_gateway_launchd_label "$NORMALIZED_INSTANCE_ID")"

echo "Consumer app verification passed:"
echo "  path=$APP_PATH"
echo "  display_name=$actual_name"
echo "  bundle_id=$actual_bundle_id"
echo "  variant=$actual_variant"
echo "  instance_id=${NORMALIZED_INSTANCE_ID:-default}"
echo "  url_scheme=$actual_url_scheme"
echo "  version=$actual_version"
echo "  build=$actual_build"
echo "  git_commit=$actual_commit"
echo "  build_timestamp=$actual_build_ts"
echo "  signing_authority=${signing_authority:-unknown}"
echo "  team_id=${team_identifier:-unknown}"
echo "  code_format=${format_line:-unknown}"
echo "  gatekeeper=$gatekeeper_status"
echo "  gatekeeper_note=$gatekeeper_note"
echo "  gatekeeper_raw=${spctl_output//$'\n'/ | }"
echo "  gateway_port=$EXPECTED_GATEWAY_PORT"
echo "  runtime_root=$runtime_root"
echo "  state_dir=$state_dir"
echo "  config_path=$config_path"
echo "  workspace_path=$workspace_path"
echo "  logs_path=$logs_path"
echo "  app_launchd_label=$app_launchd_label"
echo "  gateway_launchd_label=$gateway_launchd_label"
