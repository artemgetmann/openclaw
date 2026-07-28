#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/heavy-local-slot.sh
source "$ROOT_DIR/scripts/lib/heavy-local-slot.sh"
ORIGINAL_ARGS=("$@")

# A direct invocation owns both the Swift build and the app replacement. When
# called below another guarded campaign, the verified ancestor lease is reused.
openclaw_heavy_local_slot_require_or_reexec \
  "build-and-run-mac" \
  "$ROOT_DIR" \
  "$ROOT_DIR/scripts/build-and-run-mac.sh" \
  "${ORIGINAL_ARGS[@]}"

cd "$ROOT_DIR/apps/macos"

BUILD_PATH=".build-local"
PRODUCT="OpenClaw"
BIN="$BUILD_PATH/debug/$PRODUCT"

printf "\n▶️  Building $PRODUCT (debug, build path: $BUILD_PATH)\n"
swift build -c debug --product "$PRODUCT" --build-path "$BUILD_PATH"

printf "\n⏹  Stopping existing $PRODUCT...\n"
killall -q "$PRODUCT" 2>/dev/null || true

printf "\n🚀 Launching $BIN ...\n"
nohup "$BIN" >/tmp/openclaw.log 2>&1 &
PID=$!
printf "Started $PRODUCT (PID $PID). Logs: /tmp/openclaw.log\n"
