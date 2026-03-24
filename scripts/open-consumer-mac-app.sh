#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"

INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
APP_PATH=""
REPLACE=0

usage() {
  cat <<'EOF'
Usage: scripts/open-consumer-mac-app.sh [--instance <id>] [--replace] [app_path]
EOF
}

terminate_matching_app_binary() {
  local binary_path="$1"
  local pids=()
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    pids+=("$pid")
  done < <(/bin/ps -axo pid=,command= | /usr/bin/awk -v target="$binary_path" 'index($0, target) > 0 { print $1 }')

  if [[ "${#pids[@]}" -eq 0 ]]; then
    return
  fi

  /bin/kill "${pids[@]}" 2>/dev/null || true
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
    --replace)
      REPLACE=1
      shift
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
EXPECTED_NAME="$(consumer_instance_app_name "$NORMALIZED_INSTANCE_ID")"
EXPECTED_BUNDLE_ID="$(consumer_instance_bundle_id "$NORMALIZED_INSTANCE_ID")"
EXPECTED_VARIANT="consumer"

if [[ -z "$APP_PATH" ]]; then
  APP_PATH="$(consumer_instance_app_path "$ROOT_DIR" "$NORMALIZED_INSTANCE_ID")"
fi

INFO_PLIST="$APP_PATH/Contents/Info.plist"
if [[ ! -f "$INFO_PLIST" ]]; then
  echo "ERROR: consumer app bundle not found: $APP_PATH" >&2
  echo "Run scripts/package-consumer-mac-app.sh${NORMALIZED_INSTANCE_ID:+ --instance ${NORMALIZED_INSTANCE_ID}} first." >&2
  exit 1
fi

actual_name=$(/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" "$INFO_PLIST")
actual_bundle_id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$INFO_PLIST")
actual_variant=$(/usr/libexec/PlistBuddy -c "Print :OpenClawAppVariant" "$INFO_PLIST")
actual_instance_id=$(/usr/libexec/PlistBuddy -c "Print :OpenClawConsumerInstanceID" "$INFO_PLIST" 2>/dev/null || true)

if [[ "$actual_name" != "$EXPECTED_NAME" || "$actual_bundle_id" != "$EXPECTED_BUNDLE_ID" || "$actual_variant" != "$EXPECTED_VARIANT" || "$actual_instance_id" != "${NORMALIZED_INSTANCE_ID}" ]]; then
  echo "ERROR: refusing to open unexpected consumer bundle." >&2
  echo "  path=$APP_PATH" >&2
  echo "  display_name=$actual_name" >&2
  echo "  bundle_id=$actual_bundle_id" >&2
  echo "  variant=$actual_variant" >&2
  echo "  instance_id=$actual_instance_id" >&2
  echo "Expected:" >&2
  echo "  display_name=$EXPECTED_NAME" >&2
  echo "  bundle_id=$EXPECTED_BUNDLE_ID" >&2
  echo "  variant=$EXPECTED_VARIANT" >&2
  echo "  instance_id=${NORMALIZED_INSTANCE_ID:-}" >&2
  exit 1
fi

if [[ "$REPLACE" == "1" ]]; then
  terminate_matching_app_binary "$APP_PATH/Contents/MacOS/OpenClaw"
fi

if [[ -n "$NORMALIZED_INSTANCE_ID" ]]; then
  env -i \
    HOME="${HOME}" \
    USER="${USER:-$(id -un)}" \
    LOGNAME="${LOGNAME:-$(id -un)}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    LANG="${LANG:-en_US.UTF-8}" \
    OPENCLAW_CONSUMER_INSTANCE_ID="$NORMALIZED_INSTANCE_ID" \
    /usr/bin/open -n "$APP_PATH"
else
  env -i \
    HOME="${HOME}" \
    USER="${USER:-$(id -un)}" \
    LOGNAME="${LOGNAME:-$(id -un)}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    LANG="${LANG:-en_US.UTF-8}" \
    /usr/bin/open -n "$APP_PATH"
fi

echo "Opened consumer app:"
echo "  path=$APP_PATH"
echo "  display_name=$actual_name"
echo "  bundle_id=$actual_bundle_id"
echo "  variant=$actual_variant"
echo "  instance_id=${NORMALIZED_INSTANCE_ID:-default}"
