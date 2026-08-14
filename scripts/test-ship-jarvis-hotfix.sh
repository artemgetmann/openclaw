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
printf '%s|%s|%s\n' "${OPENCLAW_SHARED_RESOURCE_LOCK:-}" "${OPENCLAW_SHARED_RESOURCE_LOCK_FD:-}" "${OPENCLAW_SHARED_RESOURCE_LOCK_CAPABILITY:-}" >"${PACKAGE_MARKER}"
EOF
chmod +x "${PROBE_SCRIPT}" "${PACKAGE_SCRIPT_FIXTURE}"

if /bin/bash "${ROOT_DIR}/scripts/ship-jarvis-hotfix.sh" --help >/dev/null 2>&1; then
  fail "explicit bash launch bypassed the clean-entry sentinel"
fi
ENTRY_MARKER="${TMP_ROOT}/unsafe-source-ran"
if /usr/bin/env "BASH_FUNC_source%%=() { : >\"${ENTRY_MARKER}\"; builtin source \"\$@\"; }" \
    /bin/bash "${ROOT_DIR}/scripts/ship-jarvis-hotfix.sh" --help >/dev/null 2>&1; then
  fail "function-injected explicit bash launch bypassed the clean-entry sentinel"
fi
[[ ! -e "${ENTRY_MARKER}" ]] || fail "ambient source function ran before clean-entry rejection"
pass "clean-entry sentinel rejects explicit bash and imported functions"

GUARDED_FIXTURE="${TMP_ROOT}/guarded-entry"
GUARDED_CAPABILITIES="$(printf 'b%.0s' {1..64}),$(printf 'c%.0s' {1..64})"
mkdir -p "${GUARDED_FIXTURE}/scripts/lib"
cp "${ROOT_DIR}/scripts/lib/ship-jarvis-hotfix-guarded-entry.sh" \
  "${GUARDED_FIXTURE}/scripts/lib/ship-jarvis-hotfix-guarded-entry.sh"
cat >"${GUARDED_FIXTURE}/scripts/ship-jarvis-hotfix.sh" <<'EOF'
#!/usr/bin/env bash
root="$(cd "$(dirname "$0")/.." && pwd)"
printf '%s|%s|%s|%s|%s|%s\n' \
  "${OPENCLAW_HOTFIX_CLEAN_ENTRY:-missing}" \
  "${OPENCLAW_SHARED_RESOURCE_LOCK:-missing}" \
  "${OPENCLAW_SHARED_RESOURCE_LOCK_FD:-missing}" \
  "${OPENCLAW_SHARED_RESOURCE_LOCK_CAPABILITY:-missing}" \
  "${AMBIENT_POISON:-unset}" \
  "$*" >"${root}/guarded-entry.out"
EOF
chmod +x \
  "${GUARDED_FIXTURE}/scripts/lib/ship-jarvis-hotfix-guarded-entry.sh" \
  "${GUARDED_FIXTURE}/scripts/ship-jarvis-hotfix.sh"
AMBIENT_POISON=must-not-survive \
OPENCLAW_SHARED_RESOURCE_LOCK="gateway-main,release-jarvis" \
OPENCLAW_SHARED_RESOURCE_LOCK_FD="8,9" \
OPENCLAW_SHARED_RESOURCE_LOCK_CAPABILITY="${GUARDED_CAPABILITIES}" \
  "${GUARDED_FIXTURE}/scripts/lib/ship-jarvis-hotfix-guarded-entry.sh" \
    --pr 1 --main-policy current-green-main --approved-protected-pr 1443
[[ "$(<"${GUARDED_FIXTURE}/guarded-entry.out")" == \
  "1|gateway-main,release-jarvis|8,9|${GUARDED_CAPABILITIES}|unset|--pr 1 --main-policy current-green-main --approved-protected-pr 1443" ]] || \
  fail "guarded hotfix entry did not preserve resource proof and exact authority arguments"
pass "resource-lock re-entry preserves the exact delivery authority after a temporary refusal"

DIRTY_FIXTURE="${TMP_ROOT}/dirty-checkout"
DIRTY_MARKER="${TMP_ROOT}/dirty-helper-ran"
mkdir -p "${DIRTY_FIXTURE}/scripts/lib"
cp "${ROOT_DIR}/scripts/ship-jarvis-hotfix.sh" "${DIRTY_FIXTURE}/scripts/ship-jarvis-hotfix.sh"
cp "${ROOT_DIR}/scripts/lib/ship-jarvis-hotfix-guarded-entry.sh" \
  "${DIRTY_FIXTURE}/scripts/lib/ship-jarvis-hotfix-guarded-entry.sh"
cp "${ROOT_DIR}/scripts/lib/heavy-local-slot.sh" "${DIRTY_FIXTURE}/scripts/lib/heavy-local-slot.sh"
cp "${ROOT_DIR}/scripts/lib/jarvis-release-lock.sh" "${DIRTY_FIXTURE}/scripts/lib/jarvis-release-lock.sh"
cp "${ROOT_DIR}/scripts/lib/jarvis-release-disk-preflight.sh" "${DIRTY_FIXTURE}/scripts/lib/jarvis-release-disk-preflight.sh"
printf ': >%q\n' "${DIRTY_MARKER}" >>"${DIRTY_FIXTURE}/scripts/lib/heavy-local-slot.sh"
chmod +x "${DIRTY_FIXTURE}/scripts/ship-jarvis-hotfix.sh"
if "${DIRTY_FIXTURE}/scripts/ship-jarvis-hotfix.sh" --pr 1 >/dev/null 2>&1; then
  fail "noncanonical dirty wrapper unexpectedly passed the source-free gate"
fi
[[ ! -e "${DIRTY_MARKER}" ]] || fail "dirty release helper executed before checkout rejection"
pass "source-free checkout gate rejects dirty helpers before loading them"

export OPENCLAW_SHIP_JARVIS_HOTFIX_LIB_ONLY=1
export OPENCLAW_SHIP_JARVIS_HOTFIX_TEST_MODE=1
export OPENCLAW_MAIN_REPO="${ROOT_DIR}"
export OPENCLAW_EXPECTED_MAIN_REPO="${ROOT_DIR}"
export OPENCLAW_HOTFIX_CLEAN_ENTRY=1
# shellcheck source=scripts/ship-jarvis-hotfix.sh
source "${ROOT_DIR}/scripts/ship-jarvis-hotfix.sh"
load_release_helpers

[[ "${SHIP_TEST_MODE}" == "1" ]] || fail "self-contained fixture did not enable test mode"

# Production re-enters through macOS /bin/bash 3.2. Under `set -u`, that shell
# rejects an unguarded expansion of an empty array even though newer Bash does
# not. Exercise the no-protected-receipt path in the exact production shell.
if ! OPENCLAW_SHIP_JARVIS_HOTFIX_LIB_ONLY=1 \
    OPENCLAW_SHIP_JARVIS_HOTFIX_TEST_MODE=1 \
    OPENCLAW_MAIN_REPO="${ROOT_DIR}" \
    OPENCLAW_EXPECTED_MAIN_REPO="${ROOT_DIR}" \
    OPENCLAW_HOTFIX_CLEAN_ENTRY=1 \
    /bin/bash -c '
      source "$1"
      parse_args --pr 42 --main-policy current-green-main
      if protected_pr_receipt_is_listed 999; then exit 1; fi
      assert_protected_receipts_consumed ""
    ' "${ROOT_DIR}/scripts/test-ship-jarvis-hotfix.sh" \
      "${ROOT_DIR}/scripts/ship-jarvis-hotfix.sh"; then
  fail "macOS Bash 3.2 rejected the empty protected-receipt path"
fi
pass "macOS Bash 3.2 accepts empty protected-receipt state under nounset"

# Protection runs with a deliberately restricted PATH, so the hotfix wrapper
# must forward the absolute lsof binary it already selected for production.
PROTECT_SCRIPT_FIXTURE="${TMP_ROOT}/protect.sh"
cat >"${PROTECT_SCRIPT_FIXTURE}" <<'EOF'
#!/usr/bin/env bash
printf '%s|%s|%s\n' "${PATH}" "${OPENCLAW_LSOF_BIN:-missing}" "$*"
EOF
chmod +x "${PROTECT_SCRIPT_FIXTURE}"
PROTECT_SCRIPT="${PROTECT_SCRIPT_FIXTURE}"
LSOF_BIN="/usr/sbin/lsof"

offline_protection_output="$(run_offline_seeded_protection deadbeef verify)"
[[ "${offline_protection_output}" == \
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin|/usr/sbin/lsof|--expected-live-commit deadbeef --offline-seeded-fallback --verify" ]] || \
  fail "offline protection did not receive pinned lsof under the restricted PATH: ${offline_protection_output}"

DRY_RUN=0
runtime_protection_output="$(protect_runtime deadbeef)"
[[ "$(printf '%s\n' "${runtime_protection_output}" | /usr/bin/wc -l | /usr/bin/tr -d ' ')" == "2" ]] || \
  fail "runtime protection fixture did not observe dry-run and apply invocations"
while IFS= read -r protection_line; do
  [[ "${protection_line}" == \
    /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin\|/usr/sbin/lsof\|--expected-live-commit\ deadbeef* ]] || \
    fail "runtime protection did not receive pinned lsof under the restricted PATH: ${protection_line}"
done <<<"${runtime_protection_output}"
pass "sanitized recovery and runtime protection receive the pinned lsof path"

production_probe="$(
  OPENCLAW_SHIP_JARVIS_HOTFIX_LIB_ONLY=1 \
    OPENCLAW_SHIP_JARVIS_HOTFIX_TEST_MODE=1 \
    OPENCLAW_MAIN_REPO=/Users/user/Programming_Projects/openclaw \
    OPENCLAW_EXPECTED_MAIN_REPO="${ROOT_DIR}" \
    OPENCLAW_JARVIS_HOME=/tmp/redirected-jarvis \
    OPENCLAW_PLISTBUDDY_BIN=/tmp/fake-plistbuddy \
    JARVIS_RELEASE_DISK_POST_WRITE_FLOOR_KIB=1 \
    JARVIS_RELEASE_DISK_EXPECTED_WRITE_RESERVE_KIB=0 \
    JARVIS_RELEASE_DISK_PROBE_COMMAND=/tmp/fake-probe \
    OPENCLAW_HOTFIX_CLEAN_ENTRY=1 \
    /bin/bash -c '
      source "$0"
      printf "%s|%s|%s" "$SHIP_TEST_MODE" "$JARVIS_HOME" "$PLISTBUDDY_BIN"
      jarvis_release_disk_post_write_floor_kib() { printf "36700160\n"; }
      jarvis_release_disk_cold_package_reserve_kib() { printf "9437184\n"; }
      jarvis_release_disk_preflight_operation() {
        printf "|%s|%s|%s|%s\n" "$1" "$2" "$3" "${JARVIS_RELEASE_DISK_PROBE_COMMAND:-unset}"
      }
      require_hotfix_disk_preflight
    ' \
    "${ROOT_DIR}/scripts/ship-jarvis-hotfix.sh"
)"
[[ "${production_probe}" == "0|/Users/user/Library/Application Support/Jarvis|/usr/libexec/PlistBuddy|main-jarvis-cold-package|36700160|9437184|unset" ]] || \
  fail "production authority accepted ambient test/runtime overrides: ${production_probe}"

PR_NUMBER=42
if (assert_pr_can_ship '{"baseRefName":"main","state":"OPEN"}') >/dev/null 2>&1; then
  fail "OPEN PR unexpectedly passed the source-merge boundary"
fi
pass "production target and prior-source-merge boundaries fail closed"

PR_NUMBER=""
MAIN_POLICY=""
DRY_RUN=0
parse_args --pr 42 --main-policy exact-pr --dry-run
[[ "${PR_NUMBER}" == "42" && "${MAIN_POLICY}" == "exact-pr" && "${DRY_RUN}" == "1" ]] || \
  fail "exact-pr authority was not persisted by argument parsing"
PR_NUMBER=""
MAIN_POLICY=""
DRY_RUN=0
parse_args --pr 42 --main-policy current-green-main
[[ "${MAIN_POLICY}" == "current-green-main" ]] || \
  fail "moving green-main authority was not persisted by argument parsing"
PR_NUMBER=""
MAIN_POLICY=""
APPROVED_PROTECTED_PRS=()
DRY_RUN=0
parse_args --pr 42 --main-policy current-green-main \
  --approved-protected-pr 1443 --approved-protected-pr 1448
[[ "${APPROVED_PROTECTED_PRS[*]}" == "1443 1448" ]] || \
  fail "exact protected-drift approvals were not persisted by argument parsing"
if (PR_NUMBER=""; MAIN_POLICY=""; APPROVED_PROTECTED_PRS=(); DRY_RUN=0; \
  parse_args --pr 42 --main-policy exact-pr --approved-protected-pr 1443) >/dev/null 2>&1; then
  fail "exact-pr authority silently widened through a protected-drift receipt"
fi
if (PR_NUMBER=""; MAIN_POLICY=""; DRY_RUN=0; parse_args --pr 42) >/dev/null 2>&1; then
  fail "missing task-start delivery authority unexpectedly passed"
fi
pass "moving-main policy and exact protected-drift receipts are explicit release arguments"

MAIN_POLICY=exact-pr
assert_main_policy_target \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
if (assert_main_policy_target \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) >/dev/null 2>&1; then
  fail "exact-pr authority accepted advanced main"
fi
MAIN_POLICY=current-green-main
assert_main_policy_target \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
pass "exact-pr rejects drift while current-green-main reaches fenced drift proof"

export JARVIS_RELEASE_DISK_PROBE_COMMAND="${PROBE_SCRIPT}"
export JARVIS_RELEASE_DISK_POST_WRITE_FLOOR_KIB=60
export JARVIS_RELEASE_DISK_EXPECTED_WRITE_RESERVE_KIB=40
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
grep -Fq \
  'next_operator_action=invoke_reclaim_coding_disk_then_rerun_preflight_once' \
  "${TMP_ROOT}/low.out" || fail "low disk omitted autonomous recovery action"
grep -Fq \
  "recovery_skill=${HOME}/.agents/skills/reclaim-coding-disk/SKILL.md" \
  "${TMP_ROOT}/low.out" || fail "low disk omitted canonical recovery skill"
pass "low disk stops before package invocation"

export TEST_FREE_KIB=100
export OPENCLAW_SHARED_RESOURCE_LOCK="gateway-main,release-jarvis"
export OPENCLAW_SHARED_RESOURCE_LOCK_FD="8,9"
export OPENCLAW_SHARED_RESOURCE_LOCK_CAPABILITY="$(printf 'a%.0s' {1..64}),$(printf 'b%.0s' {1..64})"
preflight_and_package_hotfix 1 2026.7.16 arm64 >"${TMP_ROOT}/enough.out" 2>&1
[[ -e "${PACKAGE_MARKER}" ]] || fail "sufficient disk did not invoke package helper"
[[ "$(<"${PACKAGE_MARKER}")" == "${OPENCLAW_SHARED_RESOURCE_LOCK}|${OPENCLAW_SHARED_RESOURCE_LOCK_FD}|${OPENCLAW_SHARED_RESOURCE_LOCK_CAPABILITY}" ]] || \
  fail "package helper did not inherit the hotfix resource locks"
grep -q '^status=pass$' "${TMP_ROOT}/enough.out" || fail "sufficient disk omitted pass receipt"
pass "sufficient disk proceeds under the hotfix resource locks"

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

gh_fixture() {
  if [[ "$1 $2 $3" == "pr view 42" && "$4" == "--json" && "$5" == "number,state,baseRefName,mergeCommit" ]]; then
    printf '%s\n' '{"number":42,"state":"MERGED","baseRefName":"main","mergeCommit":{"oid":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}'
    return
  fi
  if [[ "$1 $2 $3" == "pr view 42" && "$4" == "--json" && "$5" == "files" ]]; then
    printf '%s\n' '{"files":[{"path":"src/agents/pi-tools.ts"}]}'
    return
  fi
  return 1
}

GH_BIN=gh_fixture
JQ_BIN=jq
pr_proves_normal_merge 42 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ||
  fail "normal merged-main PR proof was rejected"
if pr_proves_normal_merge 42 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; then
  fail "mismatched merge commit passed normal merged-main proof"
fi
pr_paths_are_routine 42 || fail "routine merged PR path was rejected"
pass "hotfix source proof uses exact GitHub merge identity and changed paths"

compare_with_merged_side_branch='{
  "commits": [
    {"sha":"side","parents":[{"sha":"base"}]},
    {"sha":"merge","parents":[{"sha":"base"},{"sha":"side"}]},
    {"sha":"head","parents":[{"sha":"merge"}]}
  ]
}'
mainline="$(first_parent_main_commits "${compare_with_merged_side_branch}" base head)"
[[ "${mainline}" == $'head\nmerge' ]] || \
  fail "first-parent proof included a merged side-branch commit: ${mainline}"
if first_parent_main_commits '{"commits":[{"sha":"head","parents":[{"sha":"missing"}]}]}' base head \
    >/dev/null 2>&1; then
  fail "incomplete first-parent history unexpectedly passed"
fi
pass "hotfix source proof excludes merged side-branch commits from mainline review"

# Model the real approval loop without GitHub or runtime mutation. The original
# PR stays the delivery anchor while main gains routine and protected PRs over
# multiple delayed attempts. Only exact protected PR receipts may cross that
# second authority boundary.
BASE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SAFE_ONE_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
PROTECTED_ONE_SHA="cccccccccccccccccccccccccccccccccccccccc"
SAFE_TWO_SHA="dddddddddddddddddddddddddddddddddddddddd"
PROTECTED_TWO_SHA="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
FIXTURE_HEAD_SHA="${SAFE_ONE_SHA}"
FIXTURE_FAIL_REQUIRED_PR=""
REQUIRED_CALLS_FILE="${TMP_ROOT}/required-calls"
: >"${REQUIRED_CALLS_FILE}"

authority_gh_fixture() {
  local api_path="${!#}"
  local pr=""
  if [[ "$1 $2" == "repo view" ]]; then
    printf '%s\n' 'artemgetmann/openclaw'
    return
  fi
  if [[ "$1 $2" == "api repos/artemgetmann/openclaw/commits/main" ]]; then
    printf '%s\n' "${FIXTURE_HEAD_SHA}"
    return
  fi
  if [[ "$1" == "api" && "$2" == repos/artemgetmann/openclaw/compare/* ]]; then
    case "${FIXTURE_HEAD_SHA}" in
      "${SAFE_ONE_SHA}")
        jq -n --arg base "${BASE_SHA}" --arg safe1 "${SAFE_ONE_SHA}" \
          '{status:"ahead",total_commits:1,commits:[{sha:$safe1,parents:[{sha:$base}]}]}'
        ;;
      "${PROTECTED_ONE_SHA}")
        jq -n --arg base "${BASE_SHA}" --arg safe1 "${SAFE_ONE_SHA}" --arg protected1 "${PROTECTED_ONE_SHA}" \
          '{status:"ahead",total_commits:2,commits:[{sha:$safe1,parents:[{sha:$base}]},{sha:$protected1,parents:[{sha:$safe1}]}]}'
        ;;
      "${SAFE_TWO_SHA}")
        jq -n --arg base "${BASE_SHA}" --arg safe1 "${SAFE_ONE_SHA}" --arg protected1 "${PROTECTED_ONE_SHA}" --arg safe2 "${SAFE_TWO_SHA}" \
          '{status:"ahead",total_commits:3,commits:[{sha:$safe1,parents:[{sha:$base}]},{sha:$protected1,parents:[{sha:$safe1}]},{sha:$safe2,parents:[{sha:$protected1}]}]}'
        ;;
      "${PROTECTED_TWO_SHA}")
        jq -n --arg base "${BASE_SHA}" --arg safe1 "${SAFE_ONE_SHA}" --arg protected1 "${PROTECTED_ONE_SHA}" --arg safe2 "${SAFE_TWO_SHA}" --arg protected2 "${PROTECTED_TWO_SHA}" \
          '{status:"ahead",total_commits:4,commits:[{sha:$safe1,parents:[{sha:$base}]},{sha:$protected1,parents:[{sha:$safe1}]},{sha:$safe2,parents:[{sha:$protected1}]},{sha:$protected2,parents:[{sha:$safe2}]}]}'
        ;;
      *) return 1 ;;
    esac
    return
  fi
  if [[ "$1" == "api" && "${api_path}" == repos/artemgetmann/openclaw/commits/*/pulls ]]; then
    case "${api_path}" in
      *"${SAFE_ONE_SHA}"*) pr=101 ;;
      *"${PROTECTED_ONE_SHA}"*) pr=201 ;;
      *"${SAFE_TWO_SHA}"*) pr=102 ;;
      *"${PROTECTED_TWO_SHA}"*) pr=202 ;;
      *) return 1 ;;
    esac
    jq -n --argjson pr "${pr}" --arg sha "${api_path#repos/artemgetmann/openclaw/commits/}" \
      '[{number:$pr,merged_at:"2026-08-14T00:00:00Z",base:{ref:"main"},merge_commit_sha:($sha | sub("/pulls$";""))}]'
    return
  fi
  if [[ "$1 $2" == "pr view" ]]; then
    pr="$3"
    local sha=""
    case "${pr}" in
      42) sha="${BASE_SHA}" ;;
      101) sha="${SAFE_ONE_SHA}" ;;
      201) sha="${PROTECTED_ONE_SHA}" ;;
      102) sha="${SAFE_TWO_SHA}" ;;
      202) sha="${PROTECTED_TWO_SHA}" ;;
      *) return 1 ;;
    esac
    if [[ "$4 $5" == "--json number,state,baseRefName,mergeCommit" ]]; then
      jq -n --argjson pr "${pr}" --arg sha "${sha}" \
        '{number:$pr,state:"MERGED",baseRefName:"main",mergeCommit:{oid:$sha}}'
      return
    fi
    if [[ "$4 $5" == "--json files" ]]; then
      case "${pr}" in
        201) printf '%s\n' '{"files":[{"path":"src/gateway/auth-handler.ts"}]}' ;;
        202) printf '%s\n' '{"files":[{"path":"scripts/release-helper.sh"}]}' ;;
        *) printf '%s\n' '{"files":[{"path":"src/agents/pi-tools.ts"}]}' ;;
      esac
      return
    fi
  fi
  return 1
}

run_pr_required() {
  local pr=""
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == "--pr" ]]; then
      pr="$2"
      shift 2
      continue
    fi
    shift
  done
  printf '%s\n' "${pr}" >>"${REQUIRED_CALLS_FILE}"
  [[ "${pr}" != "${FIXTURE_FAIL_REQUIRED_PR}" ]]
}

GH_BIN=authority_gh_fixture
PR_NUMBER=42
MAIN_POLICY=current-green-main
APPROVED_PROTECTED_PRS=()

[[ "$(dry_run_reviewed_remote_main "${BASE_SHA}")" == "${SAFE_ONE_SHA}" ]] || \
  fail "first routine main drift did not preserve moving-main authority"
[[ "$(dry_run_reviewed_remote_main "${BASE_SHA}")" == "${SAFE_ONE_SHA}" ]] || \
  fail "repeated routine main drift asked for new authority"

FIXTURE_HEAD_SHA="${PROTECTED_ONE_SHA}"
if (dry_run_reviewed_remote_main "${BASE_SHA}") >"${TMP_ROOT}/protected-one.out" 2>&1; then
  fail "unapproved protected drift unexpectedly passed"
fi
grep -Fq "PR #201" "${TMP_ROOT}/protected-one.out" || \
  fail "protected drift blocker omitted the exact PR delta"
grep -Fq "src/gateway/auth-handler.ts" "${TMP_ROOT}/protected-one.out" || \
  fail "protected drift blocker omitted the exact protected path"

APPROVED_PROTECTED_PRS=(201)
[[ "$(dry_run_reviewed_remote_main "${BASE_SHA}")" == "${PROTECTED_ONE_SHA}" ]] || \
  fail "explicit protected PR approval did not pass"
[[ "$(dry_run_reviewed_remote_main "${BASE_SHA}")" == "${PROTECTED_ONE_SHA}" ]] || \
  fail "identical already-approved protected drift prompted again"

FIXTURE_HEAD_SHA="${SAFE_TWO_SHA}"
[[ "$(dry_run_reviewed_remote_main "${BASE_SHA}")" == "${SAFE_TWO_SHA}" ]] || \
  fail "safe drift after an approved protected delta prompted again"

FIXTURE_HEAD_SHA="${PROTECTED_TWO_SHA}"
if (dry_run_reviewed_remote_main "${BASE_SHA}") >"${TMP_ROOT}/protected-two.out" 2>&1; then
  fail "materially changed protected set reused stale approval"
fi
grep -Fq "PR #202" "${TMP_ROOT}/protected-two.out" || \
  fail "changed protected-set blocker omitted the new PR"
APPROVED_PROTECTED_PRS=(201 202)
[[ "$(dry_run_reviewed_remote_main "${BASE_SHA}")" == "${PROTECTED_TWO_SHA}" ]] || \
  fail "second exact protected approval did not pass the changed set"

FIXTURE_HEAD_SHA="${SAFE_ONE_SHA}"
APPROVED_PROTECTED_PRS=(201)
if (dry_run_reviewed_remote_main "${BASE_SHA}") >"${TMP_ROOT}/unused-approval.out" 2>&1; then
  fail "unused protected approval silently widened future delivery authority"
fi

APPROVED_PROTECTED_PRS=()
FIXTURE_FAIL_REQUIRED_PR=101
if (dry_run_reviewed_remote_main "${BASE_SHA}") >"${TMP_ROOT}/failed-ci.out" 2>&1; then
  fail "failed required checks were accepted as green main"
fi
FIXTURE_FAIL_REQUIRED_PR=""
pass "authority receipt survives safe drift and delay while changed protected drift and failed CI stop"

printf 'All ship-jarvis-hotfix disk preflight tests passed.\n'
