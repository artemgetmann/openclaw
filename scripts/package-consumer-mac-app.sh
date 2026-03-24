#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"

INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"

usage() {
  cat <<'EOF'
Usage: scripts/package-consumer-mac-app.sh [--instance <id>]
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
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$INSTANCE_ID" ]]; then
  # Linked git worktrees should not silently share the default consumer runtime.
  # Derive a stable per-worktree instance id so parallel app lanes get their own
  # bundle id, launchd label, state dir, and gateway port by default.
  INSTANCE_ID="$(consumer_instance_default_id_for_checkout "$ROOT_DIR")"
fi

NORMALIZED_INSTANCE_ID="$(consumer_instance_normalize_id "$INSTANCE_ID")"
APP_NAME="${APP_NAME:-$(consumer_instance_app_name "$NORMALIZED_INSTANCE_ID")}"
APP_BUNDLE_NAME="${APP_BUNDLE_NAME:-${APP_NAME}.app}"
APP_PATH="${ROOT_DIR}/dist/${APP_BUNDLE_NAME}"
INFO_PLIST="${APP_PATH}/Contents/Info.plist"
EXPECTED_BUNDLE_ID="${BUNDLE_ID:-$(consumer_instance_bundle_id "$NORMALIZED_INSTANCE_ID")}"
EXPECTED_VARIANT="consumer"

APP_NAME="$APP_NAME" \
APP_BUNDLE_NAME="$APP_BUNDLE_NAME" \
BUNDLE_ID="$EXPECTED_BUNDLE_ID" \
APP_VARIANT="${APP_VARIANT:-$EXPECTED_VARIANT}" \
APP_INSTANCE_ID="$NORMALIZED_INSTANCE_ID" \
URL_SCHEME="${URL_SCHEME:-openclaw-consumer}" \
"$ROOT_DIR/scripts/package-mac-app.sh"

if [[ ! -f "$INFO_PLIST" ]]; then
  echo "ERROR: consumer app bundle missing after packaging: $APP_PATH" >&2
  exit 1
fi

actual_name=$(/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" "$INFO_PLIST")
actual_bundle_id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$INFO_PLIST")
actual_variant=$(/usr/libexec/PlistBuddy -c "Print :OpenClawAppVariant" "$INFO_PLIST")
actual_instance_id=$(/usr/libexec/PlistBuddy -c "Print :OpenClawConsumerInstanceID" "$INFO_PLIST" 2>/dev/null || true)

if [[ "$actual_name" != "$APP_NAME" ]]; then
  echo "ERROR: expected consumer display name '$APP_NAME', got '$actual_name'" >&2
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

echo "Consumer app ready:"
echo "  path=$APP_PATH"
echo "  display_name=$actual_name"
echo "  bundle_id=$actual_bundle_id"
echo "  variant=$actual_variant"
echo "  instance_id=${NORMALIZED_INSTANCE_ID:-default}"
echo "  gateway_port=$(consumer_instance_gateway_port "$NORMALIZED_INSTANCE_ID")"
