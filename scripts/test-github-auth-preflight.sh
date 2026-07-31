#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/github-auth-preflight-test.XXXXXX")"
trap 'rm -rf "${TMP_ROOT}"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$*"
}

GH_STUB="${TMP_ROOT}/gh"
cat >"${GH_STUB}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${TEST_GH_CALLS}"

if [[ "${1:-}" == "api" && "${2:-}" == "user" ]]; then
  if [[ "${TEST_API_RESULT:-success}" == "success" ]]; then
    printf '%s\n' "artemgetmann"
    exit 0
  fi
  printf '%s\n' 'authentication failed with ghp_fixture_secret and bearer fixture-secret' >&2
  exit 1
fi

if [[ "${1:-}" == "pr" && "${2:-}" == "view" ]]; then
  printf '%s\t%s\t%s\t%s\n' \
    "${TEST_PR_STATE:-OPEN}" \
    "${TEST_PR_HEAD:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" \
    "${TEST_MERGE_COMMIT:-}" \
    "${TEST_AUTO_MERGE:-false}"
  exit "${TEST_PR_VIEW_EXIT:-0}"
fi

if [[ "${1:-}" == "pr" && "${2:-}" == "merge" ]]; then
  printf 'mutation\n' >>"${TEST_MUTATIONS}"
  printf '%s\n' 'mutation failed with ghp_fixture_secret' >&2
  exit "${TEST_MUTATION_EXIT:-0}"
fi

exit 2
EOF
chmod +x "${GH_STUB}"

export OPENCLAW_GITHUB_GH_BIN="${GH_STUB}"
export TEST_GH_CALLS="${TMP_ROOT}/gh.calls"
export TEST_MUTATIONS="${TMP_ROOT}/mutations"
: >"${TEST_GH_CALLS}"
: >"${TEST_MUTATIONS}"

# shellcheck source=scripts/lib/github-auth-preflight.sh
source "${ROOT_DIR}/scripts/lib/github-auth-preflight.sh"

export TEST_API_RESULT=failure
restricted_output=""
restricted_status=0
restricted_output="$(openclaw_github_preflight restricted host-gh 2>&1)" || restricted_status=$?
[[ "${restricted_status}" -eq 75 ]] || fail "restricted failure returned ${restricted_status}"
[[ "${restricted_output}" == *"status=indeterminate"* ]] || fail "restricted failure was not indeterminate"
[[ "${restricted_output}" != *"fixture_secret"* ]] || fail "restricted output leaked a secret"

export TEST_API_RESULT=success
host_output="$(openclaw_github_preflight host host-gh)"
[[ "${host_output}" == *"status=ready context=host"* ]] || fail "host success was not ready"
pass "restricted false negative can be resolved by a separate host read-only probe"

export TEST_API_RESULT=failure
host_failure_output=""
host_failure_status=0
host_failure_output="$(openclaw_github_preflight host host-gh 2>&1)" || host_failure_status=$?
[[ "${host_failure_status}" -eq 1 ]] || fail "genuine host failure returned ${host_failure_status}"
[[ "${host_failure_output}" == *"status=blocked context=host"* ]] || fail "host failure was not blocked"
[[ "${host_failure_output}" != *"fixture_secret"* ]] || fail "host output leaked a secret"
pass "genuine host auth or API failure blocks without secret leakage"

export TEST_PR_HEAD=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
head_status=0
openclaw_github_pr_mutation_once 42 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  "${GH_STUB}" pr merge 42 >/dev/null 2>&1 || head_status=$?
[[ "${head_status}" -eq 3 ]] || fail "expected-head mismatch returned ${head_status}"
[[ ! -s "${TEST_MUTATIONS}" ]] || fail "expected-head mismatch attempted a mutation"
pass "expected-head drift blocks before mutation"

export TEST_PR_HEAD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export TEST_MUTATION_EXIT=1
mutation_output=""
mutation_status=0
mutation_output="$(openclaw_github_pr_mutation_once 42 "${TEST_PR_HEAD}" \
  "${GH_STUB}" pr merge 42 2>&1)" || mutation_status=$?
[[ "${mutation_status}" -eq 75 ]] || fail "ambiguous mutation returned ${mutation_status}"
[[ "$(wc -l <"${TEST_MUTATIONS}" | tr -d ' ')" -eq 1 ]] || fail "ambiguous mutation was retried"
[[ "${mutation_output}" == *"status=indeterminate"* ]] || fail "ambiguous mutation lacked receipt"
[[ "${mutation_output}" != *"fixture_secret"* ]] || fail "ambiguous mutation leaked a secret"
pass "ambiguous mutation reconciles read-only and stops after one attempt"

unset OPENCLAW_GITHUB_SELECTED_TRANSPORT
connector_status=0
openclaw_github_select_mutation_transport connector >/dev/null 2>&1 || connector_status=$?
[[ "${connector_status}" -eq 75 ]] || fail "connector selection did not disable shell mutation"
host_after_connector_status=0
openclaw_github_select_mutation_transport host-gh >/dev/null 2>&1 || host_after_connector_status=$?
[[ "${host_after_connector_status}" -eq 2 ]] || fail "transport switch was not rejected"
[[ "$(wc -l <"${TEST_MUTATIONS}" | tr -d ' ')" -eq 1 ]] || fail "transport selection added a mutation"
pass "one process cannot switch from connector to host gh mutation"

unset OPENCLAW_GITHUB_SELECTED_TRANSPORT
openclaw_github_select_mutation_transport host-gh
connector_after_host_status=0
openclaw_github_select_mutation_transport connector >/dev/null 2>&1 || connector_after_host_status=$?
[[ "${connector_after_host_status}" -eq 2 ]] || fail "host-to-connector transport switch was not rejected"
pass "one process cannot switch from host gh to connector mutation"

printf 'All GitHub auth preflight tests passed.\n'
