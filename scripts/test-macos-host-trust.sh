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

# Exercise the release preflight entry point, not only the library. It must stop
# before querying identities or credentials when the trust view is restricted.
TEST_CONTROL_RESULT=fail
export TEST_CONTROL_RESULT
set +e
preflight_output="$(
  OPENCLAW_RELEASE_ENV_FILE=0 \
  OPENCLAW_MACOS_HOST_TRUST_CODESIGN_BIN="$codesign_stub" \
  OPENCLAW_MACOS_HOST_TRUST_CONTROL_PATH="$control_path" \
    /bin/bash "$ROOT_DIR/scripts/preflight-consumer-mac-release.sh" --host-context 2>&1
)"
preflight_status=$?
set -e
[[ "$preflight_status" -eq 2 ]] \
  || fail "release preflight returned $preflight_status instead of indeterminate exit 2"
[[ "$preflight_output" == *"INDETERMINATE:"* ]] \
  || fail "release preflight did not preserve the indeterminate trust state"
[[ "$preflight_output" != *"certificate is not available in the keychain"* ]] \
  || fail "release preflight converted restricted Keychain visibility into a missing identity"
pass "release preflight stops before sandboxed Keychain conclusions"

TEST_CONTROL_RESULT=pass
export TEST_CONTROL_RESULT
set +e
unasserted_output="$(
  OPENCLAW_RELEASE_ENV_FILE=0 \
  OPENCLAW_MACOS_HOST_TRUST_CODESIGN_BIN="$codesign_stub" \
  OPENCLAW_MACOS_HOST_TRUST_CONTROL_PATH="$control_path" \
    /bin/bash "$ROOT_DIR/scripts/preflight-consumer-mac-release.sh" 2>&1
)"
unasserted_status=$?
set -e
[[ "$unasserted_status" -eq 2 && "$unasserted_output" == *"Keychain visibility was not asserted"* ]] \
  || fail "preflight drew Keychain conclusions without explicit host context"
pass "Keychain conclusions require explicit host-context assertion"

# Gatekeeper can be blocked independently of codesign. Prove that its control
# failure remains indeterminate instead of becoming a candidate rejection.
gatekeeper_stub="$TMP_DIR/spctl"
/usr/bin/printf '%s\n' '#!/usr/bin/env bash
target="${@: -1}"
if [[ "$target" == "${TEST_GATEKEEPER_CONTROL_PATH:?}" ]]; then
  [[ "${TEST_GATEKEEPER_CONTROL_RESULT:-pass}" == "pass" ]] && exit 0
  echo "assessment service unavailable" >&2
  exit 1
fi
[[ "${TEST_GATEKEEPER_ARTIFACT_RESULT:-pass}" == "pass" ]]' >"$gatekeeper_stub"
chmod +x "$gatekeeper_stub"
gatekeeper_control="$TMP_DIR/Finder.app"
mkdir -p "$gatekeeper_control"
export TEST_GATEKEEPER_CONTROL_PATH="$gatekeeper_control"
export OPENCLAW_MACOS_GATEKEEPER_SPCTL_BIN="$gatekeeper_stub"
export OPENCLAW_MACOS_GATEKEEPER_CONTROL_PATH="$gatekeeper_control"
TEST_GATEKEEPER_CONTROL_RESULT=fail
export TEST_GATEKEEPER_CONTROL_RESULT
set +e
openclaw_macos_gatekeeper_require 2>"$TMP_DIR/gatekeeper.err"
gatekeeper_status=$?
set -e
[[ "$gatekeeper_status" -eq 2 && "$OPENCLAW_MACOS_GATEKEEPER_STATE" == "indeterminate" ]] \
  || fail "blocked Gatekeeper control was not indeterminate"
pass "Gatekeeper uses an independent control"

TEST_GATEKEEPER_CONTROL_RESULT=pass
TEST_GATEKEEPER_ARTIFACT_RESULT=fail
export TEST_GATEKEEPER_CONTROL_RESULT TEST_GATEKEEPER_ARTIFACT_RESULT
openclaw_macos_gatekeeper_require \
  || fail "trusted Gatekeeper control did not establish assessment context"
if "$gatekeeper_stub" -a -vv "$artifact_path" >/dev/null 2>&1; then
  fail "Gatekeeper candidate rejection passed after trusted control"
fi
pass "Gatekeeper candidate rejection remains fail-closed after its control"

# Checkpoint reuse is another release-verdict boundary. It must expose the
# distinct indeterminate reason so orchestration cannot rewrite it as a corrupt
# or rejected artifact.
source "$ROOT_DIR/scripts/lib/jarvis-release-checkpoint.sh"
export OPENCLAW_JARVIS_RELEASE_CHECKPOINT_CODESIGN_BIN="$codesign_stub"
TEST_CONTROL_RESULT=fail
export TEST_CONTROL_RESULT
set +e
openclaw_jarvis_release_checkpoint_verify_signature "$artifact_path" app \
  >/dev/null 2>"$TMP_DIR/checkpoint.err"
checkpoint_status=$?
set -e
[[ "$checkpoint_status" -eq 2 ]] \
  || fail "checkpoint trust control returned $checkpoint_status instead of 2"
[[ "$OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE" == "host-trust-indeterminate" ]] \
  || fail "checkpoint rewrote the indeterminate trust state"
pass "release checkpoint preserves indeterminate trust state"

TEST_CONTROL_RESULT=pass
TEST_ARTIFACT_RESULT=fail
export TEST_CONTROL_RESULT TEST_ARTIFACT_RESULT
set +e
openclaw_jarvis_release_checkpoint_verify_signature "$artifact_path" app \
  >/dev/null 2>"$TMP_DIR/checkpoint-artifact.err"
checkpoint_artifact_status=$?
set -e
[[ "$checkpoint_artifact_status" -eq 1 ]] \
  || fail "checkpoint artifact failure returned $checkpoint_artifact_status instead of 1"
[[ "$OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE" != "host-trust-indeterminate" ]] \
  || fail "checkpoint mislabeled a genuine artifact failure as indeterminate"
pass "release checkpoint fails closed after trusted host control"

echo "All macOS host trust guard tests passed."
