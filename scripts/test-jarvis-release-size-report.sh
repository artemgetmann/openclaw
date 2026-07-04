#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

assert_contains() {
  local name="$1"
  local file="$2"
  local pattern="$3"

  if ! grep -q -- "$pattern" "$file"; then
    cat "$file" >&2
    fail "$name missing pattern: $pattern"
  fi

  pass "$name"
}

APP_PATH="$TMP_DIR/Jarvis.app"
RUNTIME_DIR="$APP_PATH/Contents/Resources/OpenClawRuntime"
OPENCLAW_DIR="$RUNTIME_DIR/openclaw"
REPORT_PATH="$TMP_DIR/report.env"
TOP_PATH="$TMP_DIR/top.txt"
DETAIL_PATH="$TMP_DIR/details.txt"

mkdir -p \
  "$OPENCLAW_DIR/dist/assets" \
  "$OPENCLAW_DIR/dist/plugin-sdk/assets" \
  "$OPENCLAW_DIR/extensions/voice-call" \
  "$OPENCLAW_DIR/node_modules/.pnpm/native@1.0.0/node_modules/native/prebuilds" \
  "$OPENCLAW_DIR/node_modules/.pnpm/docs-heavy@1.0.0/node_modules/docs-heavy/docs" \
  "$RUNTIME_DIR/node/darwin-arm64/bin" \
  "$RUNTIME_DIR/uv/darwin-arm64"

dd if=/dev/zero of="$OPENCLAW_DIR/dist/assets/image.bin" bs=1024 count=3 >/dev/null 2>&1
dd if=/dev/zero of="$OPENCLAW_DIR/dist/plugin-sdk/assets/image.bin" bs=1024 count=2 >/dev/null 2>&1
dd if=/dev/zero of="$OPENCLAW_DIR/node_modules/.pnpm/native@1.0.0/node_modules/native/prebuilds/native.node" bs=1024 count=4 >/dev/null 2>&1
dd if=/dev/zero of="$OPENCLAW_DIR/extensions/voice-call/payload.bin" bs=1024 count=1 >/dev/null 2>&1

bash "$ROOT_DIR/scripts/report-jarvis-release-size.sh" \
  --app "$APP_PATH" \
  --output "$REPORT_PATH" \
  --top-output "$TOP_PATH" \
  --detail-output "$DETAIL_PATH" \
  >"$TMP_DIR/stdout.txt"

assert_contains "env report records detail path" "$REPORT_PATH" "JARVIS_RELEASE_SIZE_DETAILS="
assert_contains "env report records dist assets" "$REPORT_PATH" "JARVIS_RELEASE_SIZE_RUNTIME_DIST_ASSETS_BYTES="
assert_contains "env report records plugin sdk assets" "$REPORT_PATH" "JARVIS_RELEASE_SIZE_RUNTIME_DIST_PLUGIN_SDK_ASSETS_BYTES="
assert_contains "env report records duplicate candidate" "$REPORT_PATH" "JARVIS_RELEASE_SIZE_DUPLICATE_DIST_ASSETS_CANDIDATE_BYTES="

assert_contains "detail has pnpm package section" "$DETAIL_PATH" "Top pnpm package store entries"
assert_contains "detail has extension section" "$DETAIL_PATH" "Top bundled extensions"
assert_contains "detail has asset bucket section" "$DETAIL_PATH" "Runtime dist asset buckets"
assert_contains "detail has native binary section" "$DETAIL_PATH" "Top native binary files under node_modules"
assert_contains "detail has dev payload section" "$DETAIL_PATH" "Likely dev/docs/test payload directories"
assert_contains "detail includes native file" "$DETAIL_PATH" "native.node"
assert_contains "detail includes extension" "$DETAIL_PATH" "voice-call"

assert_contains "top report exists" "$TOP_PATH" "Largest Jarvis runtime entries"
assert_contains "stdout points at details" "$TMP_DIR/stdout.txt" "details=$DETAIL_PATH"
