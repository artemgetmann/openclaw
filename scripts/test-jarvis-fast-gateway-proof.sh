#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/jarvis-fast-gateway-proof.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_pass() {
  local name="$1"
  shift
  "$@" || fail "$name"
}

expect_fail() {
  local name="$1"
  shift
  if "$@"; then
    fail "$name"
  fi
}

runtime_match_fixture() {
  jarvis_fast_gateway_launchagent_runtime_matches \
    "18789" \
    "$HOME/Library/Application Support/Jarvis" \
    "$HOME/Library/Application Support/Jarvis/.jarvis" \
    "$HOME/Library/Application Support/Jarvis/.jarvis/openclaw.json" \
    "$HOME/Library/Application Support/Jarvis/.jarvis/lib/openclaw-bundled/dist/index.js" \
    "$HOME/Library/Application Support/Jarvis/.jarvis/tools/node/bin" \
    "$HOME/Library/Application Support/Jarvis/.jarvis/openclaw.json" \
    "${1:-18789}" \
    "$HOME/Library/Application Support/Jarvis" \
    "$HOME/Library/Application Support/Jarvis/.jarvis" \
    "$HOME/Library/Application Support/Jarvis/.jarvis/openclaw.json" \
    "$HOME/Library/Application Support/Jarvis/.jarvis/lib/openclaw-bundled/dist/index.js" \
    "/usr/bin:$HOME/Library/Application Support/Jarvis/.jarvis/tools/node/bin:/bin" \
    "$HOME/Library/Application Support/Jarvis/.jarvis/openclaw.json"
}

# Stale distribution metadata must not erase the stronger fact that launchd is
# already pointing at the installed Jarvis runtime. The app can refresh these
# metadata fields later; the proof script should keep them diagnostic.
expect_pass "runtime ownership still matches with stale service metadata" \
  runtime_match_fixture
expect_fail "stale service metadata is reported separately" \
  jarvis_fast_gateway_launchagent_service_metadata_matches \
    "2026.3.16" \
    "2026031690" \
    "2026.6.23" \
    "2026062301"

gap="$(
  jarvis_fast_gateway_proof_gap \
    "1" \
    "1" \
    "0" \
    "1" \
    "1" \
    "ai.jarvis.gateway" \
    "1"
)"
[[ "$gap" == *"service metadata still needs an app-owned refresh"* ]] ||
  fail "stale service metadata must remain a live-proof gap"

gap="$(
  jarvis_fast_gateway_proof_gap \
    "1" \
    "1" \
    "1" \
    "1" \
    "1" \
    "ai.jarvis.gateway" \
    "0"
)"
[[ "$gap" == *"app-managed CLI does not expose expected GUI capabilities"* ]] ||
  fail "stale app-managed CLI capabilities must be a live-proof gap"

# A real runtime mismatch remains a proof gap. Port mismatch is enough to prove
# that the LaunchAgent is not the expected installed Jarvis runtime.
expect_fail "runtime port mismatch fails ownership proof" \
  runtime_match_fixture \
    "18790"

expect_pass "matching service metadata is accepted" \
  jarvis_fast_gateway_launchagent_service_metadata_matches \
    "2026.3.16" \
    "2026031690" \
    "2026.3.16" \
    "2026031690"

echo "jarvis_fast_gateway_proof_tests=true"
