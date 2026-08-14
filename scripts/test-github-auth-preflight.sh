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
    "${TEST_MERGE_COMMIT:-none}" \
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

GIT_STUB="${TMP_ROOT}/git"
cat >"${GIT_STUB}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${TEST_GIT_CALLS}"

if [[ "${1:-}" == "remote" && "${2:-}" == "get-url" ]]; then
  if [[ "${3:-}" == "--push" ]]; then
    printf '%s\n' "${TEST_PUSH_URL:-git@github.com:artemgetmann/openclaw.git}"
  else
    printf '%s\n' "${TEST_REMOTE_URL:-git@github.com:artemgetmann/openclaw.git}"
  fi
  exit "${TEST_REMOTE_URL_EXIT:-0}"
fi

if [[ " $* " == *" push --dry-run "* ]]; then
  [[ "${TEST_PUSH_RESULT:-success}" == "success" ]]
  exit $?
fi

if [[ "${1:-}" == "ls-remote" ]]; then
  if [[ "${TEST_LS_REMOTE_RESULT:-success}" == "failure" ]]; then
    exit 1
  fi
  printf '%s\t%s\n' \
    "${TEST_REMOTE_SHA:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" \
    "${TEST_REMOTE_REF:-HEAD}"
  exit 0
fi

exit 2
EOF
chmod +x "${GIT_STUB}"

export OPENCLAW_GITHUB_GH_BIN="${GH_STUB}"
export OPENCLAW_GITHUB_GIT_BIN="${GIT_STUB}"
export TEST_GH_CALLS="${TMP_ROOT}/gh.calls"
export TEST_GIT_CALLS="${TMP_ROOT}/git.calls"
export TEST_MUTATIONS="${TMP_ROOT}/mutations"
: >"${TEST_GH_CALLS}"
: >"${TEST_GIT_CALLS}"
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

report_output=""
report_status=0
report_output="$(openclaw_github_transport_report host origin 2>&1)" || report_status=$?
[[ "${report_status}" -eq 1 ]] || fail "three-state report returned ${report_status}"
[[ "${report_output}" == *"transport=connector capability=unknown"* ]] || fail "report omitted connector capability state"
[[ "${report_output}" == *"transport=host-gh reason=api-probe-failed"* ]] || fail "report omitted host gh API state"
[[ "${report_output}" == *"GIT_TRANSPORT status=ready context=host remote=origin fetch_protocol=ssh push_protocol=ssh fetch=ready push=ready"* ]] || fail "report omitted SSH fetch/push state"
[[ "${report_output}" == *"api=unavailable-or-unproven git=ready"* ]] || fail "report conflated host gh failure with Git transport failure"
pass "transport report keeps connector API, host gh API, and Git transport independent"

export TEST_API_RESULT=success
export TEST_PUSH_RESULT=failure
push_report_status=0
push_report_output="$(openclaw_github_transport_report host origin 2>&1)" || push_report_status=$?
[[ "${push_report_status}" -eq 1 ]] || fail "failed push probe returned ${push_report_status}"
[[ "${push_report_output}" == *"reason=fetch-or-push-probe-failed"* ]] || fail "failed push probe was reported ready"
[[ "${push_report_output}" == *"api=available git=unavailable"* ]] || fail "report conflated API health with failed push transport"
unset TEST_PUSH_RESULT
pass "fetch success cannot mask failed push transport"

export TEST_REMOTE_SHA=cccccccccccccccccccccccccccccccccccccccc
push_reconcile_output="$(openclaw_reconcile_failed_git_push prhead refs/heads/fix/example "${TEST_REMOTE_SHA}" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)"
[[ "${push_reconcile_output}" == *"status=accepted-after-reconciliation"* ]] || fail "completed ambiguous push was not reconciled"
[[ "${push_reconcile_output}" == *"retry=false"* ]] || fail "completed ambiguous push authorized a retry"
pass "failed push response reconciles an already-updated remote without retry"

export TEST_REMOTE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
push_unchanged_status=0
openclaw_reconcile_failed_git_push prhead refs/heads/fix/example cccccccccccccccccccccccccccccccccccccccc "${TEST_REMOTE_SHA}" >/dev/null 2>&1 || push_unchanged_status=$?
[[ "${push_unchanged_status}" -eq 75 ]] || fail "unchanged ambiguous push returned ${push_unchanged_status}"
pass "failed push response stops when reconciliation proves no update"

export TEST_REMOTE_SHA=dddddddddddddddddddddddddddddddddddddddd
push_drift_status=0
openclaw_reconcile_failed_git_push prhead refs/heads/fix/example cccccccccccccccccccccccccccccccccccccccc aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >/dev/null 2>&1 || push_drift_status=$?
[[ "${push_drift_status}" -eq 3 ]] || fail "remote drift returned ${push_drift_status}"
pass "failed push response blocks on remote drift"

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
[[ "${mutation_output}" == *"merge_commit=none auto_merge=false"* ]] || fail "ambiguous mutation receipt shifted empty fields"
[[ "${mutation_output}" != *"fixture_secret"* ]] || fail "ambiguous mutation leaked a secret"
pass "ambiguous mutation reconciles read-only and stops after one attempt"

: >"${TEST_MUTATIONS}"
export TEST_AUTO_MERGE=true
auto_merge_output=""
auto_merge_status=0
auto_merge_output="$(openclaw_github_pr_mutation_once 42 "${TEST_PR_HEAD}" \
  "${GH_STUB}" pr merge 42 2>&1)" || auto_merge_status=$?
[[ "${auto_merge_status}" -eq 75 ]] || fail "auto-merge reconciliation returned ${auto_merge_status}"
[[ "${auto_merge_output}" == *"merge_commit=none auto_merge=true"* ]] || fail "auto-merge reconciliation shifted empty fields"
[[ "$(wc -l <"${TEST_MUTATIONS}" | tr -d ' ')" -eq 1 ]] || fail "auto-merge ambiguity was retried"
pass "ambiguous auto-merge receipt preserves the empty merge commit field"

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

if rg -q 'resolve_head_push_url_https|graphql_push_to_fork|createCommitOnBranch' "${ROOT_DIR}/scripts/pr"; then
  fail "scripts/pr still contains an HTTPS or API Git-object fallback"
fi
rg -q 'openclaw_reconcile_failed_git_push' "${ROOT_DIR}/scripts/pr" || fail "scripts/pr does not reconcile failed push responses"
pass "PR preparation keeps Git objects on SSH and removes API recreation fallback"

printf 'All GitHub auth preflight tests passed.\n'
