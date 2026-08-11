#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/consumer-mcporter-runtime.sh"

fixture="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-mcporter-receipt-test.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT

mkdir -p \
  "$fixture/node_modules/mcporter/dist" \
  "$fixture/node_modules/@rolldown/binding-darwin-arm64" \
  "$fixture/node_modules/@rolldown/binding-darwin-x64"

cat >"$fixture/package.json" <<JSON
{"private":true,"dependencies":{"mcporter":"$OPENCLAW_CONSUMER_MCPORTER_VERSION","@rolldown/binding-darwin-arm64":"$OPENCLAW_CONSUMER_ROLLDOWN_BINDING_VERSION","@rolldown/binding-darwin-x64":"$OPENCLAW_CONSUMER_ROLLDOWN_BINDING_VERSION"}}
JSON
cat >"$fixture/package-lock.json" <<JSON
{"lockfileVersion":3,"packages":{"node_modules/mcporter":{"version":"$OPENCLAW_CONSUMER_MCPORTER_VERSION","integrity":"$OPENCLAW_CONSUMER_MCPORTER_INTEGRITY"},"node_modules/@rolldown/binding-darwin-arm64":{"version":"$OPENCLAW_CONSUMER_ROLLDOWN_BINDING_VERSION","integrity":"$OPENCLAW_CONSUMER_ROLLDOWN_ARM64_INTEGRITY"},"node_modules/@rolldown/binding-darwin-x64":{"version":"$OPENCLAW_CONSUMER_ROLLDOWN_BINDING_VERSION","integrity":"$OPENCLAW_CONSUMER_ROLLDOWN_X64_INTEGRITY"}}}
JSON
cat >"$fixture/node_modules/mcporter/package.json" <<JSON
{"version":"$OPENCLAW_CONSUMER_MCPORTER_VERSION","license":"$OPENCLAW_CONSUMER_MCPORTER_LICENSE","bin":{"mcporter":"$OPENCLAW_CONSUMER_MCPORTER_BIN"}}
JSON
printf 'cli\n' >"$fixture/node_modules/mcporter/dist/cli.js"
printf 'MIT\n' >"$fixture/node_modules/mcporter/LICENSE"

for arch in arm64 x64; do
  cat >"$fixture/node_modules/@rolldown/binding-darwin-$arch/package.json" <<JSON
{"version":"$OPENCLAW_CONSUMER_ROLLDOWN_BINDING_VERSION"}
JSON
  printf 'unsigned-%s\n' "$arch" >"$fixture/node_modules/@rolldown/binding-darwin-$arch/binding.node"
done

openclaw_verify_consumer_mcporter_runtime node "$fixture" write
openclaw_verify_consumer_mcporter_runtime node "$fixture"

# Model codesign changing a Mach-O payload. The stale receipt must fail, then a
# post-sign refresh must make the exact signed bytes verifiable.
printf 'signed-arm64\n' >"$fixture/node_modules/@rolldown/binding-darwin-arm64/binding.node"
if openclaw_verify_consumer_mcporter_runtime node "$fixture" >/dev/null 2>&1; then
  echo "ERROR: stale mcporter receipt accepted changed native bytes" >&2
  exit 1
fi
openclaw_verify_consumer_mcporter_runtime node "$fixture" write
openclaw_verify_consumer_mcporter_runtime node "$fixture"

codesign_script="$ROOT_DIR/scripts/codesign-mac-app.sh"
payload_sign_line="$(grep -n 'phase_log_elapsed.*Sign runtime payloads' "$codesign_script" | cut -d: -f1)"
receipt_refresh_line="$(grep -n 'openclaw_verify_consumer_mcporter_runtime' "$codesign_script" | tail -1 | cut -d: -f1)"
outer_sign_line="$(grep -n 'sign_item.*APP_BUNDLE.*APP_ENTITLEMENTS' "$codesign_script" | tail -1 | cut -d: -f1)"
if ! ((payload_sign_line < receipt_refresh_line && receipt_refresh_line < outer_sign_line)); then
  echo "ERROR: mcporter receipt refresh must remain between payload and outer-bundle signing" >&2
  exit 1
fi

echo "consumer_mcporter_receipt_test=pass"
