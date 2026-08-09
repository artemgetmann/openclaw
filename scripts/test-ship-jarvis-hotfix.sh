#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ship-jarvis-hotfix-test.XXXXXX")"
trap 'rm -rf "${TMP_ROOT}"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$*"
}

PROBE_SCRIPT="${TMP_ROOT}/probe.sh"
PACKAGE_SCRIPT_FIXTURE="${TMP_ROOT}/package.sh"
PACKAGE_MARKER="${TMP_ROOT}/package-called"
cat >"${PROBE_SCRIPT}" <<'EOF'
#!/usr/bin/env bash
printf 'fixture-fs\t/fixture\t%s\t%s\n' "${TEST_FREE_KIB}" "$1"
EOF
cat >"${PACKAGE_SCRIPT_FIXTURE}" <<'EOF'
#!/usr/bin/env bash
: >"${PACKAGE_MARKER}"
EOF
chmod +x "${PROBE_SCRIPT}" "${PACKAGE_SCRIPT_FIXTURE}"

export OPENCLAW_SHIP_JARVIS_HOTFIX_LIB_ONLY=1
# shellcheck source=scripts/ship-jarvis-hotfix.sh
source "${ROOT_DIR}/scripts/ship-jarvis-hotfix.sh"

[[ "${SHIP_TEST_MODE}" == "0" ]] || fail "ordinary worktree load unexpectedly enabled test mode"
[[ "${PLISTBUDDY_BIN}" == "/usr/libexec/PlistBuddy" ]] || fail "production PlistBuddy was redirected"
[[ "${JARVIS_HOME}" == "/Users/user/Library/Application Support/Jarvis" ]] || \
  fail "production Jarvis home was redirected"

PR_NUMBER=42
if (assert_pr_can_ship '{"baseRefName":"main","state":"OPEN"}') >/dev/null 2>&1; then
  fail "OPEN PR unexpectedly passed the fenced source-merge boundary"
fi
pass "production target and prior-source-merge boundaries fail closed"

export JARVIS_RELEASE_DISK_PROBE_COMMAND="${PROBE_SCRIPT}"
export JARVIS_RELEASE_DISK_REQUIRED_KIB=100
export PACKAGE_MARKER
PACKAGE_SCRIPT="${PACKAGE_SCRIPT_FIXTURE}"
MAIN_REPO="${TMP_ROOT}"
JARVIS_APP_PATH="${TMP_ROOT}/dist/Jarvis.app"

export TEST_FREE_KIB=99
DRY_RUN=0
if preflight_and_package_hotfix 1 2026.7.16 arm64 >"${TMP_ROOT}/low.out" 2>&1; then
  fail "low disk unexpectedly reached packaging"
fi
[[ ! -e "${PACKAGE_MARKER}" ]] || fail "low disk invoked package helper"
grep -q '^status=fail$' "${TMP_ROOT}/low.out" || fail "low disk omitted fail receipt"
pass "low disk stops before package invocation"

export TEST_FREE_KIB=100
preflight_and_package_hotfix 1 2026.7.16 arm64 >"${TMP_ROOT}/enough.out" 2>&1
[[ -e "${PACKAGE_MARKER}" ]] || fail "sufficient disk did not invoke package helper"
grep -q '^status=pass$' "${TMP_ROOT}/enough.out" || fail "sufficient disk omitted pass receipt"
pass "sufficient disk proceeds to package invocation"

rm -f "${PACKAGE_MARKER}"
(
  bash() { return 97; }
  env() { return 98; }
  export -f bash env
  preflight_and_package_hotfix 1 2026.7.16 arm64 >"${TMP_ROOT}/shadow.out" 2>&1
)
[[ -e "${PACKAGE_MARKER}" ]] || fail "ambient function shadow intercepted package authority"
pass "absolute production interpreters resist ambient function shadowing"

rm -f "${PACKAGE_MARKER}"
DRY_RUN=1
preflight_and_package_hotfix 1 2026.7.16 arm64 >"${TMP_ROOT}/dry-run.out" 2>&1
[[ ! -e "${PACKAGE_MARKER}" ]] || fail "dry run invoked package helper"
pass_line="$(grep -n '^status=pass$' "${TMP_ROOT}/dry-run.out" | head -n 1 | cut -d: -f1)"
package_line="$(grep -n 'package.sh' "${TMP_ROOT}/dry-run.out" | head -n 1 | cut -d: -f1)"
[[ -n "${pass_line}" && -n "${package_line}" && "${pass_line}" -lt "${package_line}" ]] || \
  fail "dry-run package plan appeared before disk pass receipt"
pass "dry run proves disk before printing package plan"

moving_main_path_requires_new_approval "scripts/ship-jarvis-hotfix.sh" || \
  fail "release tooling was not classified as protected"
moving_main_path_requires_new_approval "src/gateway/auth-handler.ts" || \
  fail "security-owned auth path was not classified as protected"
moving_main_path_requires_new_approval "scripts/lib/validated-node.sh" || \
  fail "post-pull helper was not classified as protected"
moving_main_path_requires_new_approval "src/gateway/security-path-policy.ts" || \
  fail "security-path policy was not classified as protected"
moving_main_path_requires_new_approval "CODEOWNERS" || fail "root CODEOWNERS was not protected"
moving_main_path_requires_new_approval "docs/CODEOWNERS" || fail "docs CODEOWNERS was not protected"
if moving_main_path_requires_new_approval "src/agents/pi-tools.ts"; then
  fail "ordinary source path was classified as protected"
fi
pass "moving-main path gate separates routine from security/release scope"

QUEUE_ITEM_FIXTURE='{"state":"closed","candidate":{"pr":42,"url":"https://github.com/artemgetmann/openclaw/pull/42","title":"fixture","prContract":"fixture-contract","baseBranch":"main","testedBaseSha":"dddddddddddddddddddddddddddddddddddddddd","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","diffFingerprint":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","changedPaths":["src/agents/pi-tools.ts"]},"builder":{"threadId":"builder","hostId":"host","wakeRoute":{"threadId":"builder","hostId":"host"}},"reviewReceipt":{"schemaVersion":1,"role":"code-reviewer","status":"PASS","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","diffFingerprint":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","owner":{"threadId":"reviewer","hostId":"host"},"unresolvedFindings":[]},"testerReceipt":{"status":"PASS","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","diffFingerprint":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","closure":"terminal-receipt","contractId":"contract","owner":{"threadId":"tester","hostId":"host"}},"authority":{"schemaVersion":1,"source":"builder-handoff","scope":"PR #42 source merge only","allowedActions":["normal-merge"],"constraints":["no admin or bypass","no credentials or OTP","no irreversible or public release","no new scope"]},"lifecycle":{"contractId":"release-contract","stateDirectory":"/tmp/state"},"capabilityPolicy":{"routine":"routine-release","escalation":"reasoning-escalation"},"ownershipReceipt":{"mode":"queue-lease","owner":{"threadId":"release","hostId":"host"},"builder":{"threadId":"builder","hostId":"host","wakeRoute":{"threadId":"builder","hostId":"host"}},"builderSuspended":true,"leaseId":"lease","fence":1},"ownerHistory":[{"leaseId":"lease","fence":1,"claimedPr":42,"owner":{"threadId":"release","hostId":"host"}}],"terminalReceipts":[{"schemaVersion":1,"kind":"source-merge","pr":42,"reviewedHeadSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","diffFingerprint":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","mergeSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","normalNonAdmin":true,"expectedHeadProtected":true,"landedTreeMatchesReviewed":true,"targetAncestryProven":true}]}'
release_queue_item_json() {
  printf '%s\n' "${QUEUE_ITEM_FIXTURE}"
}
release_queue_proves_reviewed_merge 42 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb || \
  fail "complete exact-head queue receipt was rejected"
PR_NUMBER=42
require_requested_pr_fenced_merge bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
VALID_QUEUE_ITEM_FIXTURE="${QUEUE_ITEM_FIXTURE}"
QUEUE_ITEM_FIXTURE=''
if (require_requested_pr_fenced_merge bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) >/dev/null 2>&1; then
  fail "requested merged PR passed without its fenced queue receipt"
fi
QUEUE_ITEM_FIXTURE="${VALID_QUEUE_ITEM_FIXTURE}"
QUEUE_ITEM_FIXTURE="$(printf '%s\n' "${QUEUE_ITEM_FIXTURE}" | jq '.reviewReceipt.unresolvedFindings = [{"severity":"high"}]')"
if release_queue_proves_reviewed_merge 42 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; then
  fail "high review finding unexpectedly passed"
fi
QUEUE_ITEM_FIXTURE="$(printf '%s\n' "${VALID_QUEUE_ITEM_FIXTURE}" | jq 'del(.builder)')"
if release_queue_proves_reviewed_merge 42 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; then
  fail "missing builder unexpectedly passed"
fi
QUEUE_ITEM_FIXTURE="$(printf '%s\n' "${VALID_QUEUE_ITEM_FIXTURE}" | jq '.candidate.changedPaths = ["   "]')"
if release_queue_proves_reviewed_merge 42 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; then
  fail "whitespace-only changed path unexpectedly passed"
fi
QUEUE_ITEM_FIXTURE="$(printf '%s\n' "${VALID_QUEUE_ITEM_FIXTURE}" | jq '.testerReceipt.owner = {"threadId":"reviewer","hostId":"host","extra":"different-object"}')"
if release_queue_proves_reviewed_merge 42 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; then
  fail "same reviewer/tester identity unexpectedly passed"
fi
QUEUE_ITEM_FIXTURE="$(printf '%s\n' "${VALID_QUEUE_ITEM_FIXTURE}" | jq 'del(.authority)')"
if release_queue_proves_reviewed_merge 42 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; then
  fail "missing release authority unexpectedly passed"
fi
QUEUE_ITEM_FIXTURE="$(printf '%s\n' "${VALID_QUEUE_ITEM_FIXTURE}" | jq '.terminalReceipts = .terminalReceipts[0]')"
if release_queue_proves_reviewed_merge 42 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; then
  fail "object-shaped terminal receipts unexpectedly passed"
fi
for mutation in \
  'del(.ownershipReceipt)' \
  '.ownershipReceipt.builderSuspended = false' \
  '.ownershipReceipt.owner = .builder' \
  '.ownershipReceipt.leaseId = "wrong"' \
  '.ownershipReceipt.fence = 99' \
  '.terminalReceipts += [.terminalReceipts[0] | .mergeSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"]' \
  '.candidate.changedPaths = [" scripts/ship-jarvis-hotfix.sh"]'; do
  QUEUE_ITEM_FIXTURE="$(printf '%s\n' "${VALID_QUEUE_ITEM_FIXTURE}" | jq "${mutation}")"
  if release_queue_proves_reviewed_merge 42 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; then
    fail "contradictory queue authority unexpectedly passed: ${mutation}"
  fi
done
for mutation in \
  '.capabilityPolicy.routine = "arbitrary"' \
  '.lifecycle.stateDirectory = "relative/state"' \
  '.authority.allowedActions += ["admin-bypass"]' \
  '.authority.constraints = [null]' \
  '.reviewReceipt.owner.threadId = "builder "' \
  '.ownerHistory[0].owner = .builder'; do
  QUEUE_ITEM_FIXTURE="$(printf '%s\n' "${VALID_QUEUE_ITEM_FIXTURE}" | jq "${mutation}")"
  if release_queue_proves_reviewed_merge 42 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; then
    fail "malformed fenced authority unexpectedly passed: ${mutation}"
  fi
done
pass "moving-main review gate requires exact-head fenced PASS receipts"

printf 'All ship-jarvis-hotfix disk preflight tests passed.\n'
