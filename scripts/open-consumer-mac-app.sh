#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="${1:-$ROOT_DIR/dist/OpenClaw Consumer.app}"
INFO_PLIST="$APP_PATH/Contents/Info.plist"
EXPECTED_NAME="OpenClaw Consumer"
EXPECTED_BUNDLE_ID="ai.openclaw.consumer.mac.debug"
EXPECTED_VARIANT="consumer"

if [[ ! -f "$INFO_PLIST" ]]; then
  echo "ERROR: consumer app bundle not found: $APP_PATH" >&2
  echo "Run scripts/package-consumer-mac-app.sh first." >&2
  exit 1
fi

actual_name=$(/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" "$INFO_PLIST")
actual_bundle_id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$INFO_PLIST")
actual_variant=$(/usr/libexec/PlistBuddy -c "Print :OpenClawAppVariant" "$INFO_PLIST")

if [[ "$actual_name" != "$EXPECTED_NAME" || "$actual_bundle_id" != "$EXPECTED_BUNDLE_ID" || "$actual_variant" != "$EXPECTED_VARIANT" ]]; then
  echo "ERROR: refusing to open non-consumer bundle." >&2
  echo "  path=$APP_PATH" >&2
  echo "  display_name=$actual_name" >&2
  echo "  bundle_id=$actual_bundle_id" >&2
  echo "  variant=$actual_variant" >&2
  echo "Expected:" >&2
  echo "  display_name=$EXPECTED_NAME" >&2
  echo "  bundle_id=$EXPECTED_BUNDLE_ID" >&2
  echo "  variant=$EXPECTED_VARIANT" >&2
  exit 1
fi

pkill -f "$APP_PATH/Contents/MacOS/OpenClaw" || true
open -n "$APP_PATH"

echo "Opened consumer app:"
echo "  path=$APP_PATH"
echo "  display_name=$actual_name"
echo "  bundle_id=$actual_bundle_id"
echo "  variant=$actual_variant"
