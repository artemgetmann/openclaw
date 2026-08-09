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
DRY_RUN=1
preflight_and_package_hotfix 1 2026.7.16 arm64 >"${TMP_ROOT}/dry-run.out" 2>&1
[[ ! -e "${PACKAGE_MARKER}" ]] || fail "dry run invoked package helper"
pass_line="$(grep -n '^status=pass$' "${TMP_ROOT}/dry-run.out" | head -n 1 | cut -d: -f1)"
package_line="$(grep -n 'package.sh' "${TMP_ROOT}/dry-run.out" | head -n 1 | cut -d: -f1)"
[[ -n "${pass_line}" && -n "${package_line}" && "${pass_line}" -lt "${package_line}" ]] || \
  fail "dry-run package plan appeared before disk pass receipt"
pass "dry run proves disk before printing package plan"

approved_json='{"reviewDecision":"APPROVED","body":""}'
review_receipt_json='{"reviewDecision":"","body":"- Independent reviewer: PASS with no findings\n- Independent tester: PASS on exact head"}'
missing_tester_json='{"reviewDecision":"","body":"- Independent reviewer: PASS with no findings"}'
reviewed_pr_receipt_valid "${approved_json}" || fail "GitHub approval was not accepted"
reviewed_pr_receipt_valid "${review_receipt_json}" || fail "canonical review receipts were not accepted"
if reviewed_pr_receipt_valid "${missing_tester_json}"; then
  fail "reviewer-only receipt unexpectedly passed"
fi
pass "reviewed-main gate accepts approval or complete canonical receipts only"

printf 'All ship-jarvis-hotfix disk preflight tests passed.\n'
