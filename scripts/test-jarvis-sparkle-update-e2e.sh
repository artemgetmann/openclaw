#!/usr/bin/env bash
# Synthetic-only tests for jarvis-sparkle-update-e2e.sh. These tests prove
# fail-closed preflight and lane cleanup without invoking package, publish,
# notarize, launchd, /Applications, or Telegram operations.
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$ROOT_DIR/scripts/jarvis-sparkle-update-e2e.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-sparkle-e2e-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT HUP INT TERM

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }

make_fixture() {
  local root="$1"
  mkdir -p "$root"
  cat >"$root/old-app.env" <<'EOF'
VERSION=2026.07.14
BUILD=140
CODESIGN=strict-valid
GATEKEEPER=strict-valid
PACKAGE_COMMIT=old
EOF
  cat >"$root/new-app.env" <<'EOF'
VERSION=2026.07.15
BUILD=141
CODESIGN=strict-valid
GATEKEEPER=strict-valid
PACKAGE_COMMIT=expected-commit
EOF
  cat >"$root/installed-app.env" <<'EOF'
VERSION=2026.07.14
BUILD=140
EOF
  cat >"$root/managed-manifest.env" <<'EOF'
VERSION=2026.07.14
BUILD=140
PACKAGE_COMMIT=old
EOF
  cat >"$root/expected-managed-manifest.env" <<'EOF'
VERSION=2026.07.15
BUILD=141
PACKAGE_COMMIT=expected-commit
EOF
  cat >"$root/public-feed.env" <<'EOF'
VERSION=2026.07.15
BUILD=141
PACKAGE_COMMIT=expected-commit
EOF
  cat >"$root/gateway.env" <<'EOF'
LABEL=ai.jarvis.gateway
IDENTITY=ai.jarvis.gateway
EOF
  printf '10485760\n' >"$root/disk.available_bytes"
  : >"$root/canonical-release.lock"
}

run_expect_fail() {
  local label="$1"; shift
  local output status
  set +e
  output="$($HARNESS "$@" 2>&1)"
  status=$?
  set -e
  (( status != 0 )) || fail "$label unexpectedly passed"
  printf '%s\n' "$output" | grep -q 'preflight blocked:' || fail "$label lacked fail-closed reason"
  pass "$label"
}

fixture="$TEST_ROOT/valid"
make_fixture "$fixture"

bash -n "$HARNESS"
pass "harness parses with bash -n"

output="$($HARNESS --fixture "$fixture")"
printf '%s\n' "$output" | grep -q 'preflight=passed' || fail "read-only preflight did not pass"
[[ ! -e "$fixture/.sparkle-e2e-lane" ]] || fail "read-only preflight created lane state"
pass "default preflight is read-only"

locked="$TEST_ROOT/locked"
cp -R "$fixture" "$locked"
printf 'pid=99999\ncontext=other-owner\n' >"$locked/canonical-release.lock"
run_expect_fail "active canonical lock blocks before mutation" --apply --fixture "$locked"
[[ ! -e "$locked/.sparkle-e2e-lane" ]] || fail "lock failure created lane state"

debugged="$TEST_ROOT/debugged"
cp -R "$fixture" "$debugged"
: >"$debugged/debug-jarvis-processes"
run_expect_fail "debug Jarvis process blocks before mutation" --apply --fixture "$debugged"
[[ ! -e "$debugged/.sparkle-e2e-lane" ]] || fail "debug-process failure created lane state"

bad_manifest="$TEST_ROOT/bad-manifest"
cp -R "$fixture" "$bad_manifest"
printf 'VERSION=2026.07.15\nBUILD=999\nPACKAGE_COMMIT=expected-commit\n' >"$bad_manifest/managed-manifest.env"
run_expect_fail "newer managed manifest blocks before mutation" --apply --fixture "$bad_manifest"

bad_signature="$TEST_ROOT/bad-signature"
cp -R "$fixture" "$bad_signature"
sed -i.bak 's/CODESIGN=strict-valid/CODESIGN=invalid/' "$bad_signature/new-app.env"
rm -f "$bad_signature/new-app.env.bak"
run_expect_fail "strict codesign failure blocks before mutation" --apply --fixture "$bad_signature"

apply_fixture="$TEST_ROOT/apply"
cp -R "$fixture" "$apply_fixture"
apply_output="$($HARNESS --apply --fixture "$apply_fixture")"
printf '%s\n' "$apply_output" | grep -q 'PROOF_LAYER=sparkle_transition' || fail "apply did not prove Sparkle transition"
printf '%s\n' "$apply_output" | grep -q 'PROOF_LAYER=gateway_identity label=ai.jarvis.gateway restart=exact-synthetic' || fail "apply did not prove gateway identity"
[[ ! -e "$apply_fixture/.sparkle-e2e-lane" ]] || fail "apply cleanup left lane-owned state"
[[ -f "$apply_fixture/canonical-release.lock" ]] || fail "apply touched canonical lock"
pass "apply transitions synthetic app and cleans only lane-owned state"

nonce_fixture="$TEST_ROOT/nonce"
cp -R "$fixture" "$nonce_fixture"
printf 'nonce-123\n' >"$nonce_fixture/telegram-nonce.expected"
printf 'nonce-123\n' >"$nonce_fixture/telegram-nonce.observed"
nonce_output="$($HARNESS --fixture "$nonce_fixture")"
printf '%s\n' "$nonce_output" | grep -q 'telegram_nonce=verified' || fail "optional nonce was not verified"
pass "optional telegram-user nonce is opt-in and read-only"

printf 'All synthetic Jarvis Sparkle update E2E tests passed.\n'
