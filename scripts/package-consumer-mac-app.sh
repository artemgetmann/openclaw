#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="$ROOT_DIR/dist/OpenClaw Consumer.app"
INFO_PLIST="$APP_PATH/Contents/Info.plist"
EXPECTED_NAME="OpenClaw Consumer"
EXPECTED_BUNDLE_ID="ai.openclaw.consumer.mac.debug"
EXPECTED_VARIANT="consumer"

APP_NAME="${APP_NAME:-$EXPECTED_NAME}" \
APP_BUNDLE_NAME="${APP_BUNDLE_NAME:-${EXPECTED_NAME}.app}" \
BUNDLE_ID="${BUNDLE_ID:-$EXPECTED_BUNDLE_ID}" \
APP_VARIANT="${APP_VARIANT:-$EXPECTED_VARIANT}" \
URL_SCHEME="${URL_SCHEME:-openclaw-consumer}" \
"$ROOT_DIR/scripts/package-mac-app.sh"

if [[ ! -f "$INFO_PLIST" ]]; then
  echo "ERROR: consumer app bundle missing after packaging: $APP_PATH" >&2
  exit 1
fi

actual_name=$(/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" "$INFO_PLIST")
actual_bundle_id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$INFO_PLIST")
actual_variant=$(/usr/libexec/PlistBuddy -c "Print :OpenClawAppVariant" "$INFO_PLIST")

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

echo "Consumer app ready:"
echo "  path=$APP_PATH"
echo "  display_name=$actual_name"
echo "  bundle_id=$actual_bundle_id"
echo "  variant=$actual_variant"
