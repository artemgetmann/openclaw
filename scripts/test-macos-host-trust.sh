#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/macos-host-trust.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

write_codesign_stub() {
  local path="$1"
  # The fixture separates the trusted Apple control from the candidate. That
  # distinction is the contract under test, not a particular CSSM error string.
  /usr/bin/printf '%s\n' '#!/usr/bin/env bash
target="${@: -1}"
if [[ "$target" == "${TEST_CONTROL_PATH:?}" ]]; then
  if [[ "${TEST_CONTROL_RESULT:-pass}" == "pass" ]]; then
    exit 0
  fi
  echo "CSSMERR_TP_NOT_TRUSTED" >&2
  exit 1
fi
if [[ "${TEST_ARTIFACT_RESULT:-pass}" == "pass" ]]; then
  exit 0
fi
echo "invalid signature" >&2
exit 1' >"$path"
  chmod +x "$path"
}

codesign_stub="$TMP_DIR/codesign"
control_path="$TMP_DIR/apple-control"
artifact_path="$TMP_DIR/Jarvis.app"
touch "$control_path" "$artifact_path"
write_codesign_stub "$codesign_stub"

export TEST_CONTROL_PATH="$control_path"
export OPENCLAW_MACOS_HOST_TRUST_CODESIGN_BIN="$codesign_stub"
export OPENCLAW_MACOS_HOST_TRUST_CONTROL_PATH="$control_path"

TEST_CONTROL_RESULT=fail
export TEST_CONTROL_RESULT
indeterminate_log="$TMP_DIR/indeterminate.log"
set +e
openclaw_macos_host_trust_require 2>"$indeterminate_log"
indeterminate_status=$?
set -e
indeterminate_output="$(cat "$indeterminate_log")"
[[ "$indeterminate_status" -eq 2 ]] \
  || fail "restricted control failure returned $indeterminate_status instead of 2"
[[ "$OPENCLAW_MACOS_HOST_TRUST_STATE" == "indeterminate" ]] \
  || fail "restricted control failure was not classified indeterminate"
[[ "$indeterminate_output" == *"Rerun outside any Codex/container/process sandbox"* ]] \
  || fail "indeterminate result omitted the exact host rerun instruction"
[[ "$indeterminate_output" == *"does not justify artifact rejection"* ]] \
  || fail "indeterminate result omitted the no-remediation boundary"
pass "restricted codesign false negative is indeterminate"

TEST_CONTROL_RESULT=pass
TEST_ARTIFACT_RESULT=fail
export TEST_CONTROL_RESULT TEST_ARTIFACT_RESULT
openclaw_macos_host_trust_require \
  || fail "trusted Apple control did not establish host verification context"
if "$codesign_stub" --verify --strict "$artifact_path" >/dev/null 2>&1; then
  fail "genuine artifact signature failure passed after trusted control"
fi
pass "artifact failure still fails closed after trusted host control"

TEST_ARTIFACT_RESULT=pass
export TEST_ARTIFACT_RESULT
"$codesign_stub" --verify --strict "$artifact_path" \
  || fail "valid artifact failed after trusted control"
pass "valid artifact passes after trusted host control"

echo "All macOS host trust guard tests passed."
