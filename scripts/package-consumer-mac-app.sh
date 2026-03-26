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
if [[ -z "$NORMALIZED_INSTANCE_ID" ]]; then
  CURRENT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  CANONICAL_CONSUMER_CHECKOUT="/Users/user/Programming_Projects/openclaw-consumer-openclaw-project"
  if [[ "$CURRENT_ROOT" != "$CANONICAL_CONSUMER_CHECKOUT" ]]; then
    echo "ERROR: default consumer packaging is reserved for the main consumer checkout." >&2
    echo "Use --instance <id> from worktrees so you do not collide with the shared consumer runtime." >&2
    echo "Expected checkout: $CANONICAL_CONSUMER_CHECKOUT" >&2
    echo "Current checkout: ${CURRENT_ROOT:-unknown}" >&2
    exit 1
  fi
fi
APP_NAME="${APP_NAME:-$(consumer_instance_app_name "$NORMALIZED_INSTANCE_ID")}"
APP_BUNDLE_NAME="${APP_BUNDLE_NAME:-${APP_NAME}.app}"
APP_PATH="${ROOT_DIR}/dist/${APP_BUNDLE_NAME}"
INFO_PLIST="${APP_PATH}/Contents/Info.plist"
EXPECTED_BUNDLE_ID="${BUNDLE_ID:-$(consumer_instance_bundle_id "$NORMALIZED_INSTANCE_ID")}"
EXPECTED_VARIANT="consumer"
VERIFY_ARGS=()

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

if [[ -n "$NORMALIZED_INSTANCE_ID" ]]; then
  VERIFY_ARGS+=(--instance "$NORMALIZED_INSTANCE_ID")
fi

# Keep verifier expectations aligned when the caller overrides the bundle id for
# release/distribution packaging instead of the default debug identity.
BUNDLE_ID="$EXPECTED_BUNDLE_ID" \
  "$ROOT_DIR/scripts/verify-consumer-mac-app.sh" "${VERIFY_ARGS[@]}" "$APP_PATH"

echo "Consumer packaging note:"
echo "  If the verifier passed, treat unrelated pnpm/TypeScript diagnostics separately from bundle assembly."
echo "  Known current repo noise: skipWaitForIdle diagnostics from src/agents/pi-embedded-runner/run/attempt.ts can appear during packaging without breaking the consumer app bundle."
