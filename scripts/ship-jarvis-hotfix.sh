#!/usr/bin/env -S -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin HOME=/Users/user OPENCLAW_HOTFIX_CLEAN_ENTRY=1 /bin/bash

# This sentinel exists only in the env-clean shebang. Check it using builtins
# before any source, command substitution, or path resolution so `bash script`
# cannot import functions and reach wrapper authority.
if [[ "${OPENCLAW_HOTFIX_CLEAN_ENTRY:-}" != "1" ]]; then
  builtin printf '[ship-jarvis-hotfix] ERROR: unsafe shell entry; execute scripts/ship-jarvis-hotfix.sh directly\n' >&2
  builtin exit 126
fi
builtin unset OPENCLAW_HOTFIX_CLEAN_ENTRY
set -euo pipefail

SCRIPT_NAME="ship-jarvis-hotfix"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CANONICAL_MAIN_REPO="/Users/user/Programming_Projects/openclaw"
MAIN_REPO_RAW="${OPENCLAW_MAIN_REPO:-${CANONICAL_MAIN_REPO}}"
MAIN_REPO="${MAIN_REPO_RAW}"
if [[ -d "${MAIN_REPO_RAW}" ]]; then
  MAIN_REPO="$(cd -- "${MAIN_REPO_RAW}" && pwd -P)"
fi

SHIP_TEST_MODE=0
# Test indirection is accepted only outside the canonical production checkout.
# An ambient variable in the sacred clone must never replace release authority.
if [[ "${OPENCLAW_SHIP_JARVIS_HOTFIX_TEST_MODE:-0}" == "1" &&
  "${ROOT_DIR}" != "${CANONICAL_MAIN_REPO}" &&
  "${MAIN_REPO}" == "${ROOT_DIR}" &&
  "${OPENCLAW_EXPECTED_MAIN_REPO:-}" == "${ROOT_DIR}" ]]; then
  SHIP_TEST_MODE=1
fi

if [[ "${SHIP_TEST_MODE}" == "1" ]]; then
  GH_BIN="${OPENCLAW_GH_BIN:-gh}"
  GIT_BIN="${OPENCLAW_GIT_BIN:-git}"
  JQ_BIN="${OPENCLAW_JQ_BIN:-jq}"
  LAUNCHCTL_BIN="${OPENCLAW_LAUNCHCTL_BIN:-launchctl}"
  LSOF_BIN="${OPENCLAW_LSOF_BIN:-lsof}"
  ID_BIN="${OPENCLAW_ID_BIN:-id}"
  UNAME_BIN="${OPENCLAW_UNAME_BIN:-uname}"
  SHASUM_BIN="${OPENCLAW_SHASUM_BIN:-shasum}"
else
  GH_BIN="/opt/homebrew/bin/gh"
  GIT_BIN="/usr/bin/git"
  JQ_BIN="/usr/bin/jq"
  LAUNCHCTL_BIN="/bin/launchctl"
  LSOF_BIN="/usr/sbin/lsof"
  ID_BIN="/usr/bin/id"
  UNAME_BIN="/usr/bin/uname"
  SHASUM_BIN="/usr/bin/shasum"
fi
if [[ "${SHIP_TEST_MODE}" == "1" ]]; then
  PLISTBUDDY_BIN="${OPENCLAW_PLISTBUDDY_BIN:-/usr/libexec/PlistBuddy}"
else
  PLISTBUDDY_BIN="/usr/libexec/PlistBuddy"
fi

if [[ "${SHIP_TEST_MODE}" == "1" ]]; then
  PR_REQUIRED_SCRIPT="${OPENCLAW_SHIP_PR_REQUIRED_SCRIPT:-${MAIN_REPO}/scripts/pr-required-status.sh}"
else
  PR_REQUIRED_SCRIPT="${CANONICAL_MAIN_REPO}/scripts/pr-required-status.sh"
fi
if [[ "${SHIP_TEST_MODE}" == "1" ]]; then
  PACKAGE_SCRIPT="${OPENCLAW_SHIP_PACKAGE_SCRIPT:-${MAIN_REPO}/scripts/package-consumer-mac-app-fast.sh}"
  CODESIGN_SCRIPT="${OPENCLAW_SHIP_CODESIGN_SCRIPT:-${MAIN_REPO}/scripts/codesign-mac-app.sh}"
  VERIFY_APP_SCRIPT="${OPENCLAW_SHIP_VERIFY_APP_SCRIPT:-${MAIN_REPO}/scripts/verify-consumer-mac-app.sh}"
  OPEN_APP_SCRIPT="${OPENCLAW_SHIP_OPEN_APP_SCRIPT:-${MAIN_REPO}/scripts/open-consumer-mac-app.sh}"
  PROTECT_SCRIPT="${OPENCLAW_SHIP_PROTECT_SCRIPT:-${MAIN_REPO}/scripts/protect-jarvis-runtime-from-app-reseed.sh}"
  PROVE_RUNTIME_SCRIPT="${OPENCLAW_SHIP_PROVE_RUNTIME_SCRIPT:-${MAIN_REPO}/scripts/prove-jarvis-runtime.sh}"
else
  PACKAGE_SCRIPT="${CANONICAL_MAIN_REPO}/scripts/package-consumer-mac-app-fast.sh"
  CODESIGN_SCRIPT="${CANONICAL_MAIN_REPO}/scripts/codesign-mac-app.sh"
  VERIFY_APP_SCRIPT="${CANONICAL_MAIN_REPO}/scripts/verify-consumer-mac-app.sh"
  OPEN_APP_SCRIPT="${CANONICAL_MAIN_REPO}/scripts/open-consumer-mac-app.sh"
  PROTECT_SCRIPT="${CANONICAL_MAIN_REPO}/scripts/protect-jarvis-runtime-from-app-reseed.sh"
  PROVE_RUNTIME_SCRIPT="${CANONICAL_MAIN_REPO}/scripts/prove-jarvis-runtime.sh"
fi

if [[ "${SHIP_TEST_MODE}" == "1" ]]; then
  JARVIS_APP_PATH="${OPENCLAW_SHIP_JARVIS_APP_PATH:-${MAIN_REPO}/dist/Jarvis.app}"
  INSTALLED_JARVIS_APP_PATH="${OPENCLAW_INSTALLED_JARVIS_APP_PATH:-/Applications/Jarvis.app}"
  JARVIS_HOME="${OPENCLAW_JARVIS_HOME:-${HOME}/Library/Application Support/Jarvis}"
  JARVIS_STATE_DIR="${OPENCLAW_JARVIS_STATE_DIR:-${JARVIS_HOME}/.jarvis}"
  JARVIS_CONFIG_PATH="${OPENCLAW_JARVIS_CONFIG_PATH:-${JARVIS_STATE_DIR}/openclaw.json}"
  JARVIS_LOG_DIR="${OPENCLAW_JARVIS_LOG_DIR:-${JARVIS_STATE_DIR}/logs}"
  JARVIS_MANIFEST="${OPENCLAW_SHIP_INSTALLED_MANIFEST:-${JARVIS_STATE_DIR}/.consumer-bundled-runtime.json}"
  JARVIS_PROTECTION_MARKER="${OPENCLAW_SHIP_PROTECTION_MARKER:-${JARVIS_STATE_DIR}/.consumer-bundled-runtime.protection.json}"
  JARVIS_NODE="${OPENCLAW_JARVIS_NODE_BIN:-${JARVIS_STATE_DIR}/tools/node/bin/node}"
  JARVIS_ENTRYPOINT="${OPENCLAW_JARVIS_ENTRYPOINT:-${JARVIS_STATE_DIR}/lib/openclaw-bundled/dist/index.js}"
  JARVIS_LABEL="${OPENCLAW_JARVIS_GATEWAY_LABEL:-ai.jarvis.gateway}"
  PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
else
  JARVIS_APP_PATH="${CANONICAL_MAIN_REPO}/dist/Jarvis.app"
  INSTALLED_JARVIS_APP_PATH="/Applications/Jarvis.app"
  JARVIS_HOME="/Users/user/Library/Application Support/Jarvis"
  JARVIS_STATE_DIR="${JARVIS_HOME}/.jarvis"
  JARVIS_CONFIG_PATH="${JARVIS_STATE_DIR}/openclaw.json"
  JARVIS_LOG_DIR="${JARVIS_STATE_DIR}/logs"
  JARVIS_MANIFEST="${JARVIS_STATE_DIR}/.consumer-bundled-runtime.json"
  JARVIS_PROTECTION_MARKER="${JARVIS_STATE_DIR}/.consumer-bundled-runtime.protection.json"
  JARVIS_NODE="${JARVIS_STATE_DIR}/tools/node/bin/node"
  JARVIS_ENTRYPOINT="${JARVIS_STATE_DIR}/lib/openclaw-bundled/dist/index.js"
  JARVIS_LABEL="ai.jarvis.gateway"
  PORT="18789"
fi
INSTALLED_JARVIS_INFO_PLIST="${INSTALLED_JARVIS_APP_PATH}/Contents/Info.plist"
INSTALLED_JARVIS_APP_MANIFEST="${INSTALLED_JARVIS_APP_PATH}/Contents/Resources/OpenClawRuntime/manifest.json"
SEED_TIMEOUT_SECONDS="${OPENCLAW_SHIP_SEED_TIMEOUT_SECONDS:-60}"
SEED_POLL_SECONDS="${OPENCLAW_SHIP_SEED_POLL_SECONDS:-1}"
GATEWAY_READY_TIMEOUT_SECONDS="${OPENCLAW_SHIP_GATEWAY_READY_TIMEOUT_SECONDS:-120}"
GATEWAY_READY_POLL_SECONDS="${OPENCLAW_SHIP_GATEWAY_READY_POLL_SECONDS:-2}"
CI_TIMEOUT_SECONDS="${OPENCLAW_SHIP_CI_TIMEOUT_SECONDS:-1800}"

PR_NUMBER=""
MAIN_POLICY=""
HOTFIX_PHASE="one-shot"
PREPARE_OUTPUT=""
PREPARED_RECEIPT=""
APPROVED_PROTECTED_PRS=()
REVIEWED_ROUTINE_PROTECTED_PRS=()
DRY_RUN=0
STATUS_STDOUT_FILE=""
STATUS_STDERR_FILE=""
STATUS_JSON_FILE=""
TRANSACTION_ARMED=0
TRANSACTION_EXPECTED_COMMIT=""
TRANSACTION_LAUNCH_RECEIPT_DIR=""
TRANSACTION_STAGED_APP=""
TRANSACTION_ROLLBACK_APP=""
TRANSACTION_CANONICAL_UNCOMMITTED=0
CONFIRMED_PR_MERGE_COMMIT=""

assert_source_checkout_safe() {
  local branch=""
  [[ "${ROOT_DIR}" == "${CANONICAL_MAIN_REPO}" ]] || \
    die "production entry must be the sacred main wrapper at ${CANONICAL_MAIN_REPO}"
  [[ "$(pwd -P)" == "${CANONICAL_MAIN_REPO}" ]] || \
    die "run from clean sacred main: cd ${CANONICAL_MAIN_REPO}"
  branch="$(/usr/bin/git -C "${CANONICAL_MAIN_REPO}" branch --show-current)"
  [[ "${branch}" == "main" ]] || die "sacred repo must be on main, got ${branch:-detached}"
  [[ -z "$(/usr/bin/git -C "${CANONICAL_MAIN_REPO}" status --porcelain)" ]] || \
    die "sacred main has local changes; refusing to load release helpers"
  /usr/bin/git -C "${CANONICAL_MAIN_REPO}" diff --quiet HEAD -- \
    scripts/ship-jarvis-hotfix.sh \
    scripts/lib/ship-jarvis-hotfix-guarded-entry.sh \
    scripts/lib/jarvis-hotfix-prepared-artifact.mjs \
    scripts/package-mac-app.sh \
    scripts/codesign-mac-app.sh \
    scripts/verify-consumer-mac-app.sh \
    scripts/lib/heavy-local-slot.sh \
    scripts/lib/shared-resource-lock.sh \
    scripts/with-shared-resource-lock.pl \
    scripts/lib/jarvis-release-lock.sh \
    scripts/lib/jarvis-release-disk-preflight.sh || \
    die "release wrapper or helper differs from sacred main HEAD"
}

load_release_helpers() {
  # Source only after the source-free sacred checkout gate has passed.
  # shellcheck source=scripts/lib/heavy-local-slot.sh
  source "${ROOT_DIR}/scripts/lib/heavy-local-slot.sh"
  # shellcheck source=scripts/lib/jarvis-release-lock.sh
  source "${ROOT_DIR}/scripts/lib/jarvis-release-lock.sh"
  # shellcheck source=scripts/lib/jarvis-release-disk-preflight.sh
  source "${ROOT_DIR}/scripts/lib/jarvis-release-disk-preflight.sh"
}

log() {
  printf '[%s] %s\n' "${SCRIPT_NAME}" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/ship-jarvis-hotfix.sh --pr <number> --main-policy <exact-pr|current-green-main> [--prepare-output <unique-dir> | --apply-prepared <receipt.json>] [--reviewed-routine-protected-pr <number>]... [--approved-protected-pr <number>]... [--dry-run]

Ship an already-merged main-targeted PR to this Mac's default Jarvis as an
explicit app-support break-glass hotfix. The wrapper builds and launches only
dist/Jarvis.app; it never replaces /Applications/Jarvis.app and never claims a
public release or managed-bundle steady state.

The default remains the proven one-shot rollback path. --prepare-output builds
an unsigned exact-HEAD candidate in an isolated clone without shared resource
locks. --apply-prepared fail-fast acquires both existing locks, validates the
immutable receipt, copies/signs/verifies the exact candidate, then runs the
unchanged seed/restart/protection/final-proof transaction.

The main policy must match the delivery authority recorded when the task began:
  exact-pr            Ship only when current main is the requested PR merge.
  current-green-main  Ship later routine merged PRs after their protected-path,
                      exact merge identity, and required-check proof passes.

Protected paths always require exact-diff review. When that review proves the
PR adds no new permission, capability, external effect, destructive action,
credential use, release/publication, shared-runtime mutation class, or material
scope, record it with --reviewed-routine-protected-pr. A real authority change
still requires explicit user approval and --approved-protected-pr. Both receipt
types bind to the current intervening PR set and cannot authorize future drift.
EOF
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --pr)
        PR_NUMBER="${2:-}"
        shift 2
        ;;
      --main-policy)
        MAIN_POLICY="${2:-}"
        shift 2
        ;;
      --prepare-output)
        [[ "${HOTFIX_PHASE}" == "one-shot" ]] || die "choose exactly one hotfix phase"
        HOTFIX_PHASE="prepare"
        PREPARE_OUTPUT="${2:-}"
        shift 2
        ;;
      --apply-prepared)
        [[ "${HOTFIX_PHASE}" == "one-shot" ]] || die "choose exactly one hotfix phase"
        HOTFIX_PHASE="apply"
        PREPARED_RECEIPT="${2:-}"
        shift 2
        ;;
      --approved-protected-pr)
        local approved_pr="${2:-}"
        [[ "${approved_pr}" =~ ^[1-9][0-9]*$ ]] || \
          die "--approved-protected-pr must be a positive PR number"
        local existing_pr=""
        if (( ${#APPROVED_PROTECTED_PRS[@]} > 0 )); then
          for existing_pr in "${APPROVED_PROTECTED_PRS[@]}"; do
            [[ "${existing_pr}" != "${approved_pr}" ]] || \
              die "duplicate --approved-protected-pr ${approved_pr}"
          done
        fi
        local already_reviewed_pr=""
        if (( ${#REVIEWED_ROUTINE_PROTECTED_PRS[@]} > 0 )); then
          for already_reviewed_pr in "${REVIEWED_ROUTINE_PROTECTED_PRS[@]}"; do
            [[ "${already_reviewed_pr}" != "${approved_pr}" ]] || \
              die "protected PR ${approved_pr} cannot be both reviewed-routine and user-approved"
          done
        fi
        APPROVED_PROTECTED_PRS+=("${approved_pr}")
        shift 2
        ;;
      --reviewed-routine-protected-pr)
        local reviewed_pr="${2:-}"
        [[ "${reviewed_pr}" =~ ^[1-9][0-9]*$ ]] || \
          die "--reviewed-routine-protected-pr must be a positive PR number"
        local existing_reviewed_pr=""
        if (( ${#REVIEWED_ROUTINE_PROTECTED_PRS[@]} > 0 )); then
          for existing_reviewed_pr in "${REVIEWED_ROUTINE_PROTECTED_PRS[@]}"; do
            [[ "${existing_reviewed_pr}" != "${reviewed_pr}" ]] || \
              die "duplicate --reviewed-routine-protected-pr ${reviewed_pr}"
          done
        fi
        local already_approved_pr=""
        if (( ${#APPROVED_PROTECTED_PRS[@]} > 0 )); then
          for already_approved_pr in "${APPROVED_PROTECTED_PRS[@]}"; do
            [[ "${already_approved_pr}" != "${reviewed_pr}" ]] || \
              die "protected PR ${reviewed_pr} cannot be both reviewed-routine and user-approved"
          done
        fi
        REVIEWED_ROUTINE_PROTECTED_PRS+=("${reviewed_pr}")
        shift 2
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done

  [[ "${PR_NUMBER}" =~ ^[1-9][0-9]*$ ]] || die "--pr must be a positive PR number"
  case "${MAIN_POLICY}" in
    exact-pr | current-green-main) ;;
    *) die "--main-policy must be exact-pr or current-green-main and match task-start authority" ;;
  esac
  if [[ "${HOTFIX_PHASE}" == "prepare" ]]; then
    [[ "${PREPARE_OUTPUT}" == /* ]] || die "--prepare-output must be an absolute path"
    [[ ! -e "${PREPARE_OUTPUT}" ]] || die "prepare output already exists: ${PREPARE_OUTPUT}"
  elif [[ "${HOTFIX_PHASE}" == "apply" ]]; then
    [[ "${PREPARED_RECEIPT}" == /* ]] || die "--apply-prepared must name an absolute receipt path"
  fi
  if (( DRY_RUN == 1 )) && [[ "${HOTFIX_PHASE}" != "one-shot" ]]; then
    die "--dry-run is supported only by the default one-shot rollback path"
  fi
  if [[ "${MAIN_POLICY}" != "current-green-main" ]] && \
    (( ${#APPROVED_PROTECTED_PRS[@]} > 0 || ${#REVIEWED_ROUTINE_PROTECTED_PRS[@]} > 0 )); then
    die "protected-drift receipts are valid only with task-start current-green-main authority"
  fi
}

require_command() {
  local command_name="$1"
  command -v "${command_name}" >/dev/null 2>&1 || die "missing required command: ${command_name}"
}

valid_commit() {
  [[ "${1:-}" =~ ^[0-9a-fA-F]{7,40}$ ]]
}

commit_matches() {
  local expected="$1"
  local actual="$2"
  valid_commit "${expected}" && valid_commit "${actual}" || return 1
  [[ "${expected}" == "${actual}"* || "${actual}" == "${expected}"* ]]
}

require_preflight_tools() {
  require_command "${GH_BIN}"
  require_command "${GIT_BIN}"
  require_command "${JQ_BIN}"
  require_command "${LAUNCHCTL_BIN}"
  require_command "${LSOF_BIN}"
  require_command "${ID_BIN}"
  require_command "${UNAME_BIN}"
  require_command "${PLISTBUDDY_BIN}"
  [[ -x "${PR_REQUIRED_SCRIPT}" ]] || die "required-check helper is missing or not executable: ${PR_REQUIRED_SCRIPT}"
  [[ -x "${PACKAGE_SCRIPT}" ]] || die "package helper is missing or not executable: ${PACKAGE_SCRIPT}"
  [[ -x "${CODESIGN_SCRIPT}" ]] || die "codesign helper is missing or not executable: ${CODESIGN_SCRIPT}"
  [[ -x "${VERIFY_APP_SCRIPT}" ]] || die "app verifier is missing or not executable: ${VERIFY_APP_SCRIPT}"
  [[ -x "${OPEN_APP_SCRIPT}" ]] || die "app-open helper is missing or not executable: ${OPEN_APP_SCRIPT}"
  [[ -x "${PROTECT_SCRIPT}" ]] || die "runtime-protection helper is missing or not executable: ${PROTECT_SCRIPT}"
  [[ -x "${PROVE_RUNTIME_SCRIPT}" ]] || die "runtime-proof helper is missing or not executable: ${PROVE_RUNTIME_SCRIPT}"
}

require_github_receipt_preflight() {
  # The connector evidence adapter presently verifies a candidate PR only. It
  # does not provide the merged-PR, required-check, and reviewer receipts this
  # protected hotfix workflow consumes, so do not silently downgrade those
  # gates when host `gh` authentication has expired. Probe before locks or
  # packaging and give the operator the exact recovery action instead.
  local preflight_output=""
  local -a preflight_env=(/usr/bin/env -i
    PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
    HOME="${HOME}"
    OPENCLAW_GITHUB_GH_BIN="${GH_BIN}")
  [[ -n "${GH_TOKEN:-}" ]] && preflight_env+=(GH_TOKEN="${GH_TOKEN}")
  [[ -n "${GITHUB_TOKEN:-}" ]] && preflight_env+=(GITHUB_TOKEN="${GITHUB_TOKEN}")

  if ! preflight_output="$("${preflight_env[@]}" /bin/bash "${ROOT_DIR}/scripts/github-auth-preflight.sh" \
      --context host --transport host-gh 2>&1)"; then
    printf '%s\n' "${preflight_output}" >&2
    die "protected-hotfix GitHub receipts require authenticated host gh API; connector candidate evidence lacks merged-PR/required-check/reviewer parity; reauthenticate gh before prepare, apply, or packaging"
  fi
  log "${preflight_output}"
}

run_pr_required() {
  if [[ "${SHIP_TEST_MODE}" == "1" ]]; then
    "${PR_REQUIRED_SCRIPT}" "$@"
    return
  fi

  # Required-check authority runs with a minimal, explicit environment. This
  # prevents ambient helper overrides from substituting GitHub evidence.
  local -a required_env=(/usr/bin/env -i
    PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
    HOME="${HOME}"
    OPENCLAW_GH_BIN="${GH_BIN}")
  [[ -n "${GH_TOKEN:-}" ]] && required_env+=(GH_TOKEN="${GH_TOKEN}")
  [[ -n "${GITHUB_TOKEN:-}" ]] && required_env+=(GITHUB_TOKEN="${GITHUB_TOKEN}")
  [[ -n "${NO_COLOR:-}" ]] && required_env+=(NO_COLOR="${NO_COLOR}")
  [[ -n "${TERM:-}" ]] && required_env+=(TERM="${TERM}")
  "${required_env[@]}" "${PR_REQUIRED_SCRIPT}" "$@"
}

expected_main_repo() {
  # Tests may exercise every fail-closed stage in a temporary git repository.
  # Production callers cannot redirect the sacred-path check with an ambient
  # variable alone; the explicit test-mode gate keeps the operator invariant.
  if [[ "${SHIP_TEST_MODE}" == "1" ]]; then
    local test_root="${OPENCLAW_EXPECTED_MAIN_REPO:-${MAIN_REPO}}"
    if [[ -d "${test_root}" ]]; then
      (cd -- "${test_root}" && pwd -P)
    else
      printf '%s\n' "${test_root}"
    fi
    return
  fi
  printf '%s\n' "${CANONICAL_MAIN_REPO}"
}

assert_clean_sacred_main() {
  local expected_root=""
  local git_root=""
  local branch=""
  expected_root="$(expected_main_repo)"
  git_root="$(${GIT_BIN} -C "${MAIN_REPO}" rev-parse --show-toplevel 2>/dev/null || true)"

  [[ "$(pwd -P)" == "${expected_root}" ]] || \
    die "run from clean sacred main: cd ${expected_root}"
  [[ "${MAIN_REPO}" == "${expected_root}" ]] || \
    die "OPENCLAW_MAIN_REPO resolved to ${MAIN_REPO}; expected ${expected_root}"
  [[ "${git_root}" == "${expected_root}" ]] || \
    die "${MAIN_REPO} is not the sacred main git root"

  branch="$(${GIT_BIN} -C "${MAIN_REPO}" branch --show-current)"
  [[ "${branch}" == "main" ]] || die "sacred repo must be on main, got ${branch:-detached}"
  if [[ -n "$(${GIT_BIN} -C "${MAIN_REPO}" status --porcelain)" ]]; then
    die "sacred main has local changes; refusing Jarvis runtime mutation"
  fi
}

pr_json() {
  "${GH_BIN}" pr view "${PR_NUMBER}" \
    --json number,state,isDraft,baseRefName,headRefOid,mergeCommit,title,url
}

assert_pr_can_ship() {
  local json="$1"
  local base=""
  local state=""
  base="$(printf '%s\n' "${json}" | "${JQ_BIN}" -r '.baseRefName // empty')"
  state="$(printf '%s\n' "${json}" | "${JQ_BIN}" -r '.state // empty')"

  [[ "${base}" == "main" ]] || die "refusing PR #${PR_NUMBER}: baseRefName=${base:-missing}, expected main"
  [[ "${state}" == "MERGED" ]] || \
    die "refusing PR #${PR_NUMBER}: state=${state:-missing}; source merge must complete first"
}

print_command() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
}

print_main_command() {
  printf '+ cd %q &&' "${MAIN_REPO}"
  printf ' %q' "$@"
  printf '\n'
}

confirm_merged_pr() {
  local json="$1"
  local state=""
  state="$(printf '%s\n' "${json}" | "${JQ_BIN}" -r '.state')"

  if (( DRY_RUN == 1 )); then
    print_command "${PR_REQUIRED_SCRIPT}" --pr "${PR_NUMBER}" --wait --timeout "${CI_TIMEOUT_SECONDS}"
    log "PR #${PR_NUMBER} is already merged; required checks still remain part of ship proof"
    return 0
  fi

  run_pr_required --pr "${PR_NUMBER}" --wait --timeout "${CI_TIMEOUT_SECONDS}"
  [[ "${state}" == "MERGED" ]] || die "PR #${PR_NUMBER} changed state during required-check proof"
  log "PR #${PR_NUMBER} is already merged; required checks confirmed"
}

assert_installed_app_needs_hotfix() {
  local expected_commit="$1"
  local installed_app_commit=""
  valid_commit "${expected_commit}" || die "expected hotfix commit is missing or invalid: ${expected_commit:-missing}"
  [[ -r "${INSTALLED_JARVIS_APP_MANIFEST}" ]] || \
    die "installed Jarvis app manifest is not readable: ${INSTALLED_JARVIS_APP_MANIFEST}"
  installed_app_commit="$("${JQ_BIN}" -r '.gitCommit // empty' "${INSTALLED_JARVIS_APP_MANIFEST}")"
  [[ "${installed_app_commit}" =~ ^[0-9a-fA-F]{7,40}$ ]] || \
    die "installed Jarvis app manifest gitCommit is missing or invalid"

  # If /Applications already contains this commit, app launch will preserve
  # managed provenance and the break-glass protection step correctly becomes a
  # no-op. Reject before packaging or runtime mutation instead of entering a
  # workflow whose promised jarvis-break-glass-hotfix proof is impossible.
  if commit_matches "${expected_commit}" "${installed_app_commit}"; then
    die "installed Jarvis app already contains commit ${installed_app_commit}; refuse break-glass hotfix and use scripts/prove-jarvis-runtime.sh"
  fi
}

pull_and_confirm_merge() {
  if (( DRY_RUN == 1 )); then
    print_main_command "${GIT_BIN}" pull --ff-only origin main
    return 0
  fi

  local merged_json=""
  local merge_sha=""
  local prevalidated_head=""
  local head_sha=""
  merged_json="$(pr_json)"
  assert_pr_can_ship "${merged_json}"
  [[ "$(printf '%s\n' "${merged_json}" | "${JQ_BIN}" -r '.state')" == "MERGED" ]] || \
    die "PR #${PR_NUMBER} did not confirm as merged after gh pr merge"
  merge_sha="$(printf '%s\n' "${merged_json}" | "${JQ_BIN}" -r '.mergeCommit.oid // empty')"
  valid_commit "${merge_sha}" || die "merged PR is missing a valid mergeCommit.oid"

  # Validate remote main with the currently loaded verifier and current queue
  # helper before pulling. Newly pulled release code therefore cannot classify,
  # package, launch, protect, or prove itself under stale authority.
  prevalidated_head="$(dry_run_reviewed_remote_main "${merge_sha}")"
  valid_commit "${prevalidated_head}" || die "pre-pull reviewed main receipt is missing or invalid"
  (cd "${MAIN_REPO}" && "${GIT_BIN}" pull --ff-only origin main)
  assert_clean_sacred_main
  head_sha="$(${GIT_BIN} -C "${MAIN_REPO}" rev-parse HEAD)"
  valid_commit "${head_sha}" || die "sacred main HEAD is not a valid git commit"
  commit_matches "${prevalidated_head}" "${head_sha}" || \
    die "main changed after pre-pull review proof: approved=${prevalidated_head} pulled=${head_sha}"
  CONFIRMED_PR_MERGE_COMMIT="${head_sha}"
}

associated_main_pr_json() {
  local commit_sha="$1"
  local repo=""
  local associated=""
  local pr_number=""
  repo="$(${GH_BIN} repo view --json nameWithOwner --jq '.nameWithOwner')"
  [[ -n "${repo}" ]] || die "could not resolve GitHub repository for reviewed-main proof"
  associated="$(${GH_BIN} api \
    -H 'Accept: application/vnd.github+json' \
    "repos/${repo}/commits/${commit_sha}/pulls")"
  pr_number="$(printf '%s\n' "${associated}" | "${JQ_BIN}" -r \
    --arg commit "${commit_sha}" \
    '[.[] | select(.merged_at != null and .base.ref == "main" and .merge_commit_sha == $commit)] | if length == 1 then .[0].number else empty end')"
  [[ "${pr_number}" =~ ^[1-9][0-9]*$ ]] || \
    die "main commit ${commit_sha} is not attributable to exactly one merged main PR"
  "${GH_BIN}" pr view "${pr_number}" --json number,state,baseRefName,mergeCommit
}

pr_proves_normal_merge() {
  local pr="$1"
  local commit_sha="$2"
  local json=""
  json="$("${GH_BIN}" pr view "${pr}" --json number,state,baseRefName,mergeCommit)"
  printf '%s\n' "${json}" | "${JQ_BIN}" -e --argjson pr "${pr}" --arg commit "${commit_sha}" '
    .number == $pr and
    .state == "MERGED" and
    .baseRefName == "main" and
    .mergeCommit.oid == $commit
  ' >/dev/null
}

moving_main_path_requires_new_approval() {
  local target_path="$1"
  case "${target_path}" in
    SECURITY.md | CODEOWNERS | docs/CODEOWNERS | .github/* | scripts/* | \
      src/security/* | src/secrets/* | src/config/*secret* | src/config/*/*secret* | \
      src/gateway/*auth* | src/gateway/*/*auth* | src/gateway/*secret* | src/gateway/*/*secret* | \
      src/gateway/security-path* | src/gateway/resolve-configured-secret-input-string* | \
      src/gateway/protocol/*/*secret* | src/gateway/server-methods/secrets* | \
      src/agents/*auth* | src/agents/*/*auth* | src/agents/tool-policy.ts | src/agents/sandbox.ts | src/agents/sandbox-* | \
      src/agents/sandbox/* | src/infra/secret-file* | src/cron/stagger.ts | src/cron/service/jobs.ts | \
      docs/security/* | docs/gateway/security/* | docs/gateway/*auth* | docs/gateway/*sandbox* | docs/gateway/*secret* | \
      docs/cli/approvals.md | docs/cli/sandbox.md | docs/cli/security.md | docs/cli/secrets.md | \
      docs/reference/secretref-* | docs/reference/RELEASING.md)
      return 0
      ;;
  esac
  return 1
}

pr_paths_are_routine() {
  local pr="$1"
  local protected_paths=""

  # Keep this compatibility predicate for focused callers, but let the richer
  # classifier below distinguish routine paths from indeterminate GitHub data.
  protected_paths="$(pr_protected_paths "${pr}")" || return 1
  [[ -z "${protected_paths}" ]]
}

pr_protected_paths() {
  local pr="$1"
  local json=""
  local target_path=""
  json="$("${GH_BIN}" pr view "${pr}" --json files)"
  [[ "$(printf '%s\n' "${json}" | "${JQ_BIN}" -r '.files | type')" == "array" ]] || return 1
  [[ "$(printf '%s\n' "${json}" | "${JQ_BIN}" -r '.files | length')" -gt 0 ]] || return 1
  while IFS= read -r target_path; do
    [[ -n "${target_path}" ]] || continue
    if moving_main_path_requires_new_approval "${target_path}"; then
      printf '%s\n' "${target_path}"
    fi
  done < <(printf '%s\n' "${json}" | "${JQ_BIN}" -r '.files[].path')
}

protected_pr_receipt_basis() {
  local pr="$1"
  local reviewed_pr=""
  local approved_pr=""
  if (( ${#REVIEWED_ROUTINE_PROTECTED_PRS[@]} > 0 )); then
    for reviewed_pr in "${REVIEWED_ROUTINE_PROTECTED_PRS[@]}"; do
      if [[ "${reviewed_pr}" == "${pr}" ]]; then
        printf 'reviewed-routine\n'
        return 0
      fi
    done
  fi
  if (( ${#APPROVED_PROTECTED_PRS[@]} > 0 )); then
    for approved_pr in "${APPROVED_PROTECTED_PRS[@]}"; do
      if [[ "${approved_pr}" == "${pr}" ]]; then
        printf 'user-approved\n'
        return 0
      fi
    done
  fi
  return 1
}

assert_protected_receipts_consumed() {
  local seen_prs="$1"
  local reviewed_pr=""
  local approved_pr=""
  local seen_pr=""
  local found=0

  # Reject either receipt type unless the exact PR is in the current protected
  # delta. Review authority and user authority are different, but neither may
  # become a reusable pass for a future main state.
  if (( ${#REVIEWED_ROUTINE_PROTECTED_PRS[@]} > 0 )); then
    for reviewed_pr in "${REVIEWED_ROUTINE_PROTECTED_PRS[@]}"; do
      found=0
      while IFS= read -r seen_pr; do
        if [[ "${seen_pr}" == "${reviewed_pr}" ]]; then
          found=1
          break
        fi
      done <<<"${seen_prs}"
      (( found == 1 )) || \
        die "reviewed-routine protected PR #${reviewed_pr} is not in the current intervening protected drift; refusing unused future authority"
    done
  fi
  if (( ${#APPROVED_PROTECTED_PRS[@]} > 0 )); then
    for approved_pr in "${APPROVED_PROTECTED_PRS[@]}"; do
      found=0
      while IFS= read -r seen_pr; do
        if [[ "${seen_pr}" == "${approved_pr}" ]]; then
          found=1
          break
        fi
      done <<<"${seen_prs}"
      (( found == 1 )) || \
        die "approved protected PR #${approved_pr} is not in the current intervening protected drift; refusing unused future authority"
    done
  fi
}

first_parent_main_commits() {
  local compare="$1"
  local merge_sha="$2"
  local head_sha="$3"

  # GitHub's compare response includes commits from the merged side branch.
  # Those commits are not commits on main and do not have the merge commit as
  # their associated PR identity. Walk parents from remote main instead so the
  # approval gate reviews only the exact first-parent mainline that will ship.
  printf '%s\n' "${compare}" | "${JQ_BIN}" -er \
    --arg merge "${merge_sha}" \
    --arg head "${head_sha}" '
      (.commits | map({ key: .sha, value: . }) | from_entries) as $by_sha |
      def first_parent($sha):
        if $sha == $merge then []
        else
          ($by_sha[$sha] // null) as $commit |
          if $commit == null or ($commit.parents[0].sha // "") == "" then
            error("compare response does not contain the complete first-parent mainline")
          else
            [$sha] + first_parent($commit.parents[0].sha)
          end
        end;
      first_parent($head)[]
    '
}

require_requested_pr_merge() {
  local merge_sha="$1"
  pr_proves_normal_merge "${PR_NUMBER}" "${merge_sha}" || \
    die "requested PR #${PR_NUMBER} is not a normal merged main PR at ${merge_sha}"
  run_pr_required --pr "${PR_NUMBER}" --wait --timeout "${CI_TIMEOUT_SECONDS}" >&2 || \
    die "requested PR #${PR_NUMBER} required checks are not green"
}

assert_main_policy_target() {
  local merge_sha="$1"
  local head_sha="$2"

  case "${MAIN_POLICY}" in
    exact-pr)
      commit_matches "${merge_sha}" "${head_sha}" || \
        die "exact-pr authority refuses current main ${head_sha}; requested PR merged at ${merge_sha}"
      ;;
    current-green-main)
      # Descendancy, complete first-parent history, PR identity, required CI,
      # and protected paths are proved by dry_run_reviewed_remote_main below.
      ;;
    *) die "delivery authority policy is missing or invalid before remote-main proof" ;;
  esac
}

dry_run_reviewed_remote_main() {
  local merge_sha="$1"
  local repo=""
  local head_sha=""
  local compare=""
  local total=""
  local returned=""
  local commit_sha=""
  local pr=""
  local json=""
  local mainline_commits=""
  local protected_paths=""
  local protected_paths_inline=""
  local receipt_basis=""
  local seen_receipted_protected_prs=""

  repo="$(${GH_BIN} repo view --json nameWithOwner --jq '.nameWithOwner')"
  [[ -n "${repo}" ]] || die "could not resolve GitHub repository for dry-run main proof"
  head_sha="$(${GH_BIN} api "repos/${repo}/commits/main" --jq '.sha')"
  valid_commit "${head_sha}" || die "remote main HEAD is missing or invalid in dry-run"
  require_requested_pr_merge "${merge_sha}"
  assert_main_policy_target "${merge_sha}" "${head_sha}"
  if [[ "${MAIN_POLICY}" == "exact-pr" ]]; then
    printf '%s\n' "${head_sha}"
    return 0
  fi
  commit_matches "${merge_sha}" "${head_sha}" && {
    assert_protected_receipts_consumed ""
    printf '%s\n' "${head_sha}"
    return 0
  }
  compare="$(${GH_BIN} api "repos/${repo}/compare/${merge_sha}...${head_sha}")"
  [[ "$(printf '%s\n' "${compare}" | "${JQ_BIN}" -r '.status // empty')" == "ahead" ]] || \
    die "remote main is not a strict descendant of requested PR merge in dry-run"
  total="$(printf '%s\n' "${compare}" | "${JQ_BIN}" -r '.total_commits // -1')"
  returned="$(printf '%s\n' "${compare}" | "${JQ_BIN}" -r '.commits | length')"
  [[ "${total}" =~ ^[0-9]+$ && "${total}" == "${returned}" ]] || \
    die "dry-run compare did not return every intervening main commit"
  if ! mainline_commits="$(first_parent_main_commits "${compare}" "${merge_sha}" "${head_sha}")"; then
    die "dry-run compare did not contain a complete first-parent mainline"
  fi
  [[ -n "${mainline_commits}" ]] || \
    die "dry-run compare returned an empty first-parent mainline"
  while IFS= read -r commit_sha; do
    json="$(associated_main_pr_json "${commit_sha}")"
    pr="$(printf '%s\n' "${json}" | "${JQ_BIN}" -r '.number // empty')"
    pr_proves_normal_merge "${pr}" "${commit_sha}" || \
      die "dry-run main commit ${commit_sha} PR #${pr:-unknown} is not a normal merged main PR"
    if ! protected_paths="$(pr_protected_paths "${pr}")"; then
      die "dry-run main commit ${commit_sha} PR #${pr:-unknown} paths are indeterminate"
    fi
    if [[ -n "${protected_paths}" ]]; then
      protected_paths_inline="${protected_paths//$'\n'/,}"
      receipt_basis="$(protected_pr_receipt_basis "${pr}")" || \
        die "protected drift requires classification: main commit ${commit_sha} PR #${pr} paths=${protected_paths_inline}; use --reviewed-routine-protected-pr ${pr} only after exact-diff review proves no authority expansion, otherwise obtain explicit approval and use --approved-protected-pr ${pr}"
      seen_receipted_protected_prs+="${pr}"$'\n'
      log "protected_drift_receipt=${receipt_basis} PR#${pr}@${commit_sha} paths=${protected_paths_inline}" >&2
    fi
    # Do not rely on Bash errexit here. A caller can evaluate this classifier
    # in a conditional, which suppresses inherited `set -e` behavior. Required
    # CI remains an explicit fail-closed authority check in every call context.
    run_pr_required --pr "${pr}" --wait --timeout "${CI_TIMEOUT_SECONDS}" >&2 || \
      die "dry-run main commit ${commit_sha} PR #${pr} required checks are not green"
  done <<<"${mainline_commits}"
  assert_protected_receipts_consumed "${seen_receipted_protected_prs}"
  printf '%s\n' "${head_sha}"
}

normal_package_build() {
  local app_version="$1"
  if [[ "${SHIP_TEST_MODE}" == "1" && -n "${OPENCLAW_SHIP_NORMAL_PACKAGE_BUILD:-}" ]]; then
    printf '%s\n' "${OPENCLAW_SHIP_NORMAL_PACKAGE_BUILD}"
    return 0
  fi

  # Match package-mac-app.sh instead of inventing a second version policy:
  # normal build is max(git commit count, canonical Sparkle build for version).
  (
    cd "${MAIN_REPO}"
    # shellcheck source=scripts/lib/validated-node.sh
    local git_count=""
    local canonical_build="0"
    local node_bin=""
    if [[ "${SHIP_TEST_MODE}" == "1" ]]; then
      node_bin="${OPENCLAW_NODE_BIN:-}"
    fi
    if [[ -z "${node_bin}" ]]; then
      source "${MAIN_REPO}/scripts/lib/validated-node.sh"
      openclaw_use_validated_node "${MAIN_REPO}" >/dev/null
      node_bin="${OPENCLAW_NODE_BIN}"
    fi
    [[ -x "${node_bin}" ]] || die "validated Node is missing or not executable: ${node_bin:-missing}"
    git_count="$(${GIT_BIN} rev-list --count HEAD)"
    [[ "${git_count}" =~ ^[0-9]+$ ]] || die "normal git-derived APP_BUILD is not numeric: ${git_count}"
    if [[ "${app_version}" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}([.-].*)?$ ]]; then
      canonical_build="$("${node_bin}" --import tsx \
        "${MAIN_REPO}/scripts/sparkle-build.ts" canonical-build "${app_version}")"
    fi
    [[ "${canonical_build}" =~ ^[0-9]+$ ]] || \
      die "canonical package-derived APP_BUILD is not numeric: ${canonical_build}"
    if (( canonical_build > git_count )); then
      printf '%s\n' "${canonical_build}"
    else
      printf '%s\n' "${git_count}"
    fi
  )
}

select_hotfix_version() {
  local installed_version=""
  if [[ "${SHIP_TEST_MODE}" == "1" ]]; then
    installed_version="${OPENCLAW_SHIP_INSTALLED_APP_VERSION:-}"
  fi
  if [[ -z "${installed_version}" ]]; then
    [[ -r "${INSTALLED_JARVIS_INFO_PLIST}" ]] || \
      die "installed Jarvis Info.plist is not readable: ${INSTALLED_JARVIS_INFO_PLIST}"
    installed_version="$("${PLISTBUDDY_BIN}" -c 'Print :CFBundleShortVersionString' \
      "${INSTALLED_JARVIS_INFO_PLIST}" 2>/dev/null || true)"
  fi
  [[ "${installed_version}" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}([.-][0-9A-Za-z.-]+)?$ ]] || \
    die "installed Jarvis CFBundleShortVersionString is invalid: ${installed_version:-missing}"
  printf '%s\n' "${installed_version}"
}

select_hotfix_build() {
  local app_version="$1"
  [[ -r "${JARVIS_MANIFEST}" ]] || die "installed Jarvis manifest is not readable: ${JARVIS_MANIFEST}"
  local installed_build=""
  local normal_build=""
  installed_build="$("${JQ_BIN}" -r '.bundleVersion // empty' "${JARVIS_MANIFEST}")"
  normal_build="$(normal_package_build "${app_version}")"
  [[ "${installed_build}" =~ ^[0-9]+$ ]] || die "installed Jarvis bundleVersion is not numeric: ${installed_build:-missing}"
  [[ "${normal_build}" =~ ^[0-9]+$ ]] || die "normal package APP_BUILD is not numeric: ${normal_build:-missing}"

  if (( installed_build + 1 > normal_build )); then
    printf '%s\n' "$((installed_build + 1))"
  else
    printf '%s\n' "${normal_build}"
  fi
}

hotfix_input_digest() {
  local root="$1"
  shift
  (
    cd "${root}"
    local input=""
    for input in "$@"; do
      [[ -f "${input}" ]] || die "prepared hotfix input is missing: ${input}"
      printf 'FILE %s\n' "${input}"
      "${SHASUM_BIN}" -a 256 "${input}"
    done
  ) | "${SHASUM_BIN}" -a 256 | /usr/bin/awk '{print $1}'
}

select_hotfix_signing_identity_line() {
  local team_id="$1"
  /usr/bin/awk -v team="${team_id}" '
    /Developer ID Application/ && index($0, "(" team ")") { print; exit }
  '
}

select_hotfix_signing_receipt() {
  local identity_line=""
  local identity_hash=""
  local identity_name=""
  local team_id=""
  team_id="$(/usr/bin/codesign -dv --verbose=4 "${INSTALLED_JARVIS_APP_PATH}" 2>&1 | \
    /usr/bin/awk -F= '/^TeamIdentifier=/{print $2; exit}')"
  [[ "${team_id}" =~ ^[A-Z0-9]{10}$ ]] || die "installed Jarvis Team ID is missing or invalid"
  identity_line="$(/usr/bin/security find-identity -p codesigning -v 2>/dev/null | \
    select_hotfix_signing_identity_line "${team_id}")"
  [[ -n "${identity_line}" ]] || \
    die "no Developer ID Application identity matches installed Jarvis Team ID ${team_id}"
  identity_hash="$(printf '%s\n' "${identity_line}" | /usr/bin/sed -nE 's/^[[:space:]]*[0-9]+\) ([0-9A-F]+) .*/\1/p')"
  identity_name="$(printf '%s\n' "${identity_line}" | /usr/bin/sed -nE 's/^[^"]*"([^"]+)".*/\1/p')"
  [[ "${identity_hash}" =~ ^[0-9A-F]{40}$ ]] || die "selected signing certificate hash is invalid"
  printf '%s\t%s\t%s\n' "${identity_hash}" "${identity_name}" "${team_id}"
}

resolve_prepared_source_commit() {
  local json=""
  local merge_sha=""
  local remote_head=""
  local local_head=""
  json="$(pr_json)"
  assert_pr_can_ship "${json}"
  # This resolver is consumed through command substitution. Keep confirmation
  # diagnostics visible on stderr so stdout remains the exact commit only.
  confirm_merged_pr "${json}" >&2
  merge_sha="$(printf '%s\n' "${json}" | "${JQ_BIN}" -r '.mergeCommit.oid // empty')"
  valid_commit "${merge_sha}" || die "merged PR is missing a valid mergeCommit.oid"
  remote_head="$(dry_run_reviewed_remote_main "${merge_sha}")"
  local_head="$(${GIT_BIN} -C "${MAIN_REPO}" rev-parse HEAD)"
  commit_matches "${remote_head}" "${local_head}" || \
    die "sacred main is not at reviewed remote main; run git pull --ff-only before prepare/apply"
  printf '%s\n' "${local_head}"
}

resolve_prepare_output_root() {
  local output_parent=""
  local output_root=""
  local main_root=""
  output_parent="$(cd "$(dirname "${PREPARE_OUTPUT}")" && pwd -P)" || \
    die "prepare output parent does not exist: $(dirname "${PREPARE_OUTPUT}")"
  output_root="${output_parent}/$(basename "${PREPARE_OUTPUT}")"
  main_root="$(cd "${MAIN_REPO}" && pwd -P)"
  case "${output_root}" in
    "${main_root}" | "${main_root}"/*)
      die "prepare output must be outside sacred main: ${output_root}"
      ;;
  esac
  printf '%s\n' "${output_root}"
}

prepare_hotfix_artifact() {
  local expected_commit="$1"
  local app_build="$2"
  local app_version="$3"
  local host_arch="$4"
  local output_root=""
  output_root="$(resolve_prepare_output_root)"
  local workspace="${output_root}/workspace"
  # Keep package outputs beside the detached clone. Creating them inside the
  # clone before package entry would invalidate the clean-checkout proof that
  # authorizes lock-free JS/UI/dependency writes in that clone.
  local package_root="${output_root}/package"
  local prepared_app="${package_root}/Jarvis.app"
  local artifact_root="${output_root}/artifact"
  local artifact_app="${artifact_root}/Jarvis.app"
  local prepare_tmp="${output_root}/tmp"
  local metadata_file="${output_root}/metadata.json"
  local receipt_file="${output_root}/receipt.json"
  local helper="${MAIN_REPO}/scripts/lib/jarvis-hotfix-prepared-artifact.mjs"
  local signing_receipt=""
  local signing_hash=""
  local signing_name=""
  local signing_team=""
  local lockfile_digest=""
  local packaging_digest=""
  local node_version=""
  local runtime_node=""
  local runtime_uv=""
  local runtime_key=""
  local receipt_node=""
  local created_at=""
  local expires_at=""
  local started_epoch=""
  local finished_epoch=""
  local free_before=""
  local free_after=""
  local cache_result="miss"

  [[ ! -e "${output_root}" ]] || die "prepare output already exists: ${output_root}"
  /bin/mkdir -p "${output_root}" "${artifact_root}" "${prepare_tmp}"
  /bin/chmod 700 "${output_root}" "${artifact_root}" "${prepare_tmp}"
  started_epoch="$(/bin/date +%s)"
  free_before="$(/bin/df -k "${output_root}" | /usr/bin/awk 'NR == 2 {print $4}')"
  log "prepare_locks gateway-main=false release-jarvis=false output=${output_root}"

  "${GIT_BIN}" clone --local --no-hardlinks --no-checkout "${MAIN_REPO}" "${workspace}"
  "${GIT_BIN}" -C "${workspace}" checkout --detach "${expected_commit}"
  [[ -z "$("${GIT_BIN}" -C "${workspace}" status --porcelain)" ]] || \
    die "isolated prepare clone is unexpectedly dirty"

  jarvis_release_disk_preflight_operation main-jarvis-cold-package \
    "$(jarvis_release_disk_post_write_floor_kib)" \
    "$(jarvis_release_disk_cold_package_reserve_kib)" \
    hotfix-output "${artifact_app}" \
    package-staging "${prepare_tmp}"
  /bin/mkdir -p "${package_root}"
  (
    cd "${workspace}"
    /usr/bin/env -i \
      PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin \
      HOME=/Users/user \
      TMPDIR="${prepare_tmp}" \
      APP_NAME=Jarvis \
      APP_BUNDLE_NAME=Jarvis.app \
      BUNDLE_ID=ai.openclaw.consumer.mac.debug \
      APP_VARIANT=consumer \
      URL_SCHEME=openclaw-consumer \
      APP_BUILD="${app_build}" \
      APP_VERSION="${app_version}" \
      BUILD_ARCHS="${host_arch}" \
      BUILD_CONFIG=release \
      ALLOW_SINGLE_ARCH_CONSUMER_SMOKE=1 \
      ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE=1 \
      SKIP_NOTARIZE=1 \
      SKIP_DSYM=1 \
      SKIP_PNPM_INSTALL=0 \
      SKIP_TSC=0 \
      SKIP_UI_BUILD=0 \
      OPENCLAW_RELEASE_DISK_ADMISSION_VERIFIED=1 \
      OPENCLAW_CONSUMER_FAST_PACKAGING=1 \
      OPENCLAW_CONSUMER_CLEAN_GIT_RUNTIME_CACHE=1 \
      OPENCLAW_CONSUMER_RUNTIME_CACHE_ROOT="${MAIN_REPO}/.cache/consumer-runtime-packages" \
      OPENCLAW_CONSUMER_RUNTIME_CACHE_READ_ONLY=1 \
      OPENCLAW_PACKAGE_UNSIGNED_PREPARE=1 \
      OPENCLAW_PACKAGE_PREPARE_ROOT="${package_root}" \
      OPENCLAW_PACKAGE_APP_ROOT="${prepared_app}" \
      OPENCLAW_PACKAGE_BUILD_ROOT="${package_root}/swift-build" \
      PACKAGE_TIMING=1 \
      /bin/bash "${workspace}/scripts/package-mac-app.sh"
  ) 2>&1 | /usr/bin/tee "${output_root}/prepare.log"

  [[ -d "${prepared_app}" ]] || die "unsigned prepare did not produce ${prepared_app}"
  /bin/mv "${prepared_app}" "${artifact_app}"
  /bin/rm -rf "${workspace}" "${package_root}" "${prepare_tmp}"
  # Use the same pinned Node resolver as packaging for both the receipt value
  # and the receipt writer. Ambient shell Node is not release authority.
  source "${MAIN_REPO}/scripts/lib/validated-node.sh"
  node_version="$(openclaw_validated_node_version "${MAIN_REPO}")"
  openclaw_use_validated_node "${MAIN_REPO}" >/dev/null
  receipt_node="${OPENCLAW_NODE_BIN}"
  runtime_node="$("${JQ_BIN}" -r '.nodeVersion // empty' "${artifact_app}/Contents/Resources/OpenClawRuntime/manifest.json")"
  runtime_uv="$("${JQ_BIN}" -r '.uvVersion // empty' "${artifact_app}/Contents/Resources/OpenClawRuntime/manifest.json")"
  runtime_key="$("${JQ_BIN}" -r '.runtimeInputKey // empty' "${artifact_app}/Contents/Resources/OpenClawRuntime/manifest.json")"
  lockfile_digest="$(hotfix_input_digest "${MAIN_REPO}" pnpm-lock.yaml apps/macos/Package.resolved)"
  packaging_digest="$(hotfix_input_digest "${MAIN_REPO}" scripts/package-mac-app.sh scripts/codesign-mac-app.sh scripts/verify-consumer-mac-app.sh scripts/ship-jarvis-hotfix.sh scripts/lib/jarvis-hotfix-prepared-artifact.mjs)"
  signing_receipt="$(select_hotfix_signing_receipt)"
  IFS=$'\t' read -r signing_hash signing_name signing_team <<<"${signing_receipt}"
  created_at="$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
  expires_at="$(/bin/date -u -v+6H +%Y-%m-%dT%H:%M:%SZ)"
  finished_epoch="$(/bin/date +%s)"
  free_after="$(/bin/df -k "${output_root}" | /usr/bin/awk 'NR == 2 {print $4}')"
  if /usr/bin/grep -Fq 'Reusing cached bundled consumer runtime' "${output_root}/prepare.log"; then
    cache_result="hit"
  fi

  "${JQ_BIN}" -n \
    --argjson pr "${PR_NUMBER}" --arg policy "${MAIN_POLICY}" \
    --arg reviewed "${REVIEWED_ROUTINE_PROTECTED_PRS[*]:-}" \
    --arg approved "${APPROVED_PROTECTED_PRS[*]:-}" \
    --arg commit "${expected_commit}" --arg lockfiles "${lockfile_digest}" \
    --arg packaging "${packaging_digest}" --arg node "${node_version}" \
    --arg arch "${host_arch}" --arg runtimeNode "${runtime_node}" \
    --arg runtimeUv "${runtime_uv}" --arg runtimeKey "${runtime_key}" \
    --arg version "${app_version}" --arg build "${app_build}" \
    --arg certSha1 "${signing_hash}" --arg certName "${signing_name}" \
    --arg teamId "${signing_team}" --arg createdAt "${created_at}" \
    --arg expiresAt "${expires_at}" --arg cache "${cache_result}" \
    --argjson duration "$((finished_epoch - started_epoch))" \
    --argjson diskDelta "$((free_before - free_after))" \
    '{authority:{pr:$pr,mainPolicy:$policy,reviewedRoutineProtectedPrs:$reviewed,approvedProtectedPrs:$approved},source:{gitCommit:$commit},inputs:{lockfilesSha256:$lockfiles,packagingScriptsSha256:$packaging},toolchain:{nodeVersion:$node,hostArchitecture:$arch,runtimeNodeVersion:$runtimeNode,runtimeUvVersion:$runtimeUv,runtimeInputKey:$runtimeKey},app:{version:$version,build:$build},signing:{certificateSha1:$certSha1,certificateCommonName:$certName,teamId:$teamId,requirement:"Developer ID Application with hardened runtime and exact Team ID"},locks:{gatewayMain:false,releaseJarvis:false},metrics:{prepareSeconds:$duration,runtimeCache:$cache,diskDeltaKiB:$diskDelta},createdAt:$createdAt,expiresAt:$expiresAt}' \
    >"${metadata_file}"

  /bin/chmod -R a-w "${artifact_app}"
  /usr/bin/chflags -R uchg "${artifact_app}"
  "${receipt_node}" "${helper}" create "${artifact_app}" "${metadata_file}" "${receipt_file}" >/dev/null
  /bin/rm -f "${metadata_file}"
  /bin/chmod a-w "${receipt_file}" "${output_root}/prepare.log"
  /usr/bin/chflags uchg "${receipt_file}" "${output_root}/prepare.log"
  /bin/chmod a-w "${artifact_root}" "${output_root}"
  /usr/bin/chflags uchg "${artifact_root}" "${output_root}"
  log "prepare_complete receipt=${receipt_file} commit=${expected_commit} artifact_sha256=$("${JQ_BIN}" -r '.artifact.treeSha256' "${receipt_file}") duration_seconds=$((finished_epoch - started_epoch)) runtime_cache=${cache_result} disk_delta_kib=$((free_before - free_after))"
}

package_hotfix() {
  local app_build="$1"
  local app_version="$2"
  local host_arch="$3"
  local command=(
    /usr/bin/env
    -i
    "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    "HOME=/Users/user"
    "TMPDIR=${TMPDIR:-/tmp}"
    "APP_BUILD=${app_build}"
    "APP_VERSION=${app_version}"
    "BUILD_ARCHS=${host_arch}"
    "BUILD_CONFIG=release"
    "ALLOW_SINGLE_ARCH_CONSUMER_SMOKE=1"
    "ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE=1"
    "SKIP_NOTARIZE=1"
    "SKIP_DSYM=1"
    "SKIP_PNPM_INSTALL=0"
    "SKIP_TSC=0"
    "SKIP_UI_BUILD=0"
    "OPENCLAW_RELEASE_DISK_ADMISSION_VERIFIED=1"
  )
  if [[ "${SHIP_TEST_MODE}" == "1" && -n "${PACKAGE_MARKER:-}" ]]; then
    command+=("PACKAGE_MARKER=${PACKAGE_MARKER}")
  fi

  # Packaging is nested inside the hotfix owner's release + gateway resource
  # transaction. Preserve the inherited kernel descriptors through env -i so
  # the package helper reuses release-jarvis instead of deadlocking on itself.
  if (( DRY_RUN != 1 )); then
    [[ "${OPENCLAW_SHARED_RESOURCE_LOCK:-}" == *release-jarvis* ]] || \
      die "hotfix release resource is missing before package invocation"
    [[ "${OPENCLAW_SHARED_RESOURCE_LOCK_FD:-}" =~ ^[0-9]+(,[0-9]+)?$ ]] || \
      die "hotfix resource descriptors are missing before package invocation"
    [[ "${OPENCLAW_SHARED_RESOURCE_LOCK_CAPABILITY:-}" =~ ^[0-9a-f]{64}(,[0-9a-f]{64})?$ ]] || \
      die "hotfix resource capabilities are missing before package invocation"
    command+=(
      "OPENCLAW_SHARED_RESOURCE_LOCK=${OPENCLAW_SHARED_RESOURCE_LOCK}"
      "OPENCLAW_SHARED_RESOURCE_LOCK_FD=${OPENCLAW_SHARED_RESOURCE_LOCK_FD}"
      "OPENCLAW_SHARED_RESOURCE_LOCK_CAPABILITY=${OPENCLAW_SHARED_RESOURCE_LOCK_CAPABILITY}"
    )
  fi
  command+=(/bin/bash "${PACKAGE_SCRIPT}")

  if (( DRY_RUN == 1 )); then
    print_main_command "${command[@]}"
    return 0
  fi
  (cd "${MAIN_REPO}" && "${command[@]}")
}

require_hotfix_disk_preflight() {
  local post_write_floor_kib=""
  local expected_write_reserve_kib=""
  if [[ "${SHIP_TEST_MODE}" == "1" ]]; then
    post_write_floor_kib="${JARVIS_RELEASE_DISK_POST_WRITE_FLOOR_KIB:-$(jarvis_release_disk_post_write_floor_kib)}"
    expected_write_reserve_kib="${JARVIS_RELEASE_DISK_EXPECTED_WRITE_RESERVE_KIB:-$(jarvis_release_disk_cold_package_reserve_kib)}"
  else
    post_write_floor_kib="$(jarvis_release_disk_post_write_floor_kib)"
    expected_write_reserve_kib="$(jarvis_release_disk_cold_package_reserve_kib)"
    unset JARVIS_RELEASE_DISK_PROBE_COMMAND JARVIS_RELEASE_DISK_AVAILABLE_KIB_OVERRIDE
  fi

  # The hotfix package writes its final app under dist/ and performs its heavy
  # CLI/runtime staging under TMPDIR. The repo checkout, dependency install,
  # and dist output share the output target's filesystem in this lane.
  jarvis_release_disk_preflight_operation main-jarvis-cold-package \
    "${post_write_floor_kib}" "${expected_write_reserve_kib}" \
    hotfix-output "${JARVIS_APP_PATH}" \
    package-staging "${TMPDIR:-/tmp}"
}

preflight_and_package_hotfix() {
  require_hotfix_disk_preflight || return $?
  package_hotfix "$@"
}

verify_built_hotfix() {
  local expected_commit="$1"
  local expected_build="$2"
  local expected_version="$3"
  local app_path="${4:-${JARVIS_APP_PATH}}"
  local app_manifest="${app_path}/Contents/Resources/OpenClawRuntime/manifest.json"
  local runtime_package_json="${app_path}/Contents/Resources/OpenClawRuntime/openclaw/package.json"
  local info_plist="${app_path}/Contents/Info.plist"
  local app_commit=""
  local app_build=""
  local app_version=""
  local runtime_package_version=""

  [[ -r "${app_manifest}" ]] || die "built Jarvis runtime manifest is missing: ${app_manifest}"
  [[ -r "${runtime_package_json}" ]] || die "built Jarvis runtime package.json is missing: ${runtime_package_json}"
  [[ -r "${info_plist}" ]] || die "built Jarvis Info.plist is missing: ${info_plist}"
  app_commit="$("${JQ_BIN}" -r '.gitCommit // empty' "${app_manifest}")"
  app_build="$("${PLISTBUDDY_BIN}" -c 'Print :CFBundleVersion' "${info_plist}" 2>/dev/null || true)"
  app_version="$("${PLISTBUDDY_BIN}" -c 'Print :CFBundleShortVersionString' "${info_plist}" 2>/dev/null || true)"
  runtime_package_version="$("${JQ_BIN}" -r '.version // empty' "${runtime_package_json}")"
  valid_commit "${app_commit}" || \
    die "built Jarvis manifest gitCommit is missing or invalid: ${app_commit:-missing}"
  commit_matches "${expected_commit}" "${app_commit}" || \
    die "built Jarvis commit ${app_commit:-missing} does not match sacred main ${expected_commit}"
  [[ "${app_build}" == "${expected_build}" ]] || \
    die "built Jarvis CFBundleVersion ${app_build:-missing} does not match selected ${expected_build}"
  [[ "${app_version}" == "${expected_version}" ]] || \
    die "built Jarvis CFBundleShortVersionString ${app_version:-missing} does not preserve installed ${expected_version}"
  [[ "${runtime_package_version}" == "${expected_version}" ]] || \
    die "built runtime package version ${runtime_package_version:-missing} does not preserve installed ${expected_version}"
}

validate_prepared_hotfix() {
  local expected_commit="$1"
  local expected_build="$2"
  local expected_version="$3"
  local host_arch="$4"
  local receipt_file="${PREPARED_RECEIPT}"
  local output_root=""
  local artifact_app=""
  local helper="${MAIN_REPO}/scripts/lib/jarvis-hotfix-prepared-artifact.mjs"
  local receipt_node=""
  local verified=""
  local lockfile_digest=""
  local packaging_digest=""
  local signing_receipt=""
  local signing_hash=""
  local signing_name=""
  local signing_team=""

  [[ -f "${receipt_file}" && ! -L "${receipt_file}" ]] || \
    die "prepared receipt must be a regular non-symlink file: ${receipt_file}"
  output_root="$(cd "$(dirname "${receipt_file}")" && pwd -P)"
  receipt_file="${output_root}/$(basename "${receipt_file}")"
  [[ "${receipt_file}" == "${output_root}/receipt.json" ]] || die "prepared receipt must be the output root receipt.json"
  artifact_app="${output_root}/artifact/Jarvis.app"
  [[ -d "${artifact_app}" && ! -L "${artifact_app}" ]] || \
    die "prepared artifact must be a real directory: ${artifact_app}"
  [[ "$(/usr/bin/stat -f '%Sf' "${output_root}")" == *uchg* ]] || die "prepared output root is not immutable"
  [[ "$(/usr/bin/stat -f '%Sf' "${receipt_file}")" == *uchg* ]] || die "prepared receipt is not immutable"
  if /usr/bin/find "${artifact_app}" ! -flags uchg -print -quit | /usr/bin/grep -q .; then
    die "prepared artifact contains a non-immutable entry"
  fi

  source "${MAIN_REPO}/scripts/lib/validated-node.sh"
  openclaw_use_validated_node "${MAIN_REPO}" >/dev/null
  receipt_node="${OPENCLAW_NODE_BIN}"
  verified="$("${receipt_node}" "${helper}" verify "${artifact_app}" "${receipt_file}")"
  lockfile_digest="$(hotfix_input_digest "${MAIN_REPO}" pnpm-lock.yaml apps/macos/Package.resolved)"
  packaging_digest="$(hotfix_input_digest "${MAIN_REPO}" scripts/package-mac-app.sh scripts/codesign-mac-app.sh scripts/verify-consumer-mac-app.sh scripts/ship-jarvis-hotfix.sh scripts/lib/jarvis-hotfix-prepared-artifact.mjs)"
  signing_receipt="$(select_hotfix_signing_receipt)"
  IFS=$'\t' read -r signing_hash signing_name signing_team <<<"${signing_receipt}"

  printf '%s\n' "${verified}" | "${JQ_BIN}" -e \
    --argjson pr "${PR_NUMBER}" --arg policy "${MAIN_POLICY}" \
    --arg reviewed "${REVIEWED_ROUTINE_PROTECTED_PRS[*]:-}" \
    --arg approved "${APPROVED_PROTECTED_PRS[*]:-}" \
    --arg commit "${expected_commit}" --arg lockfiles "${lockfile_digest}" \
    --arg packaging "${packaging_digest}" --arg node "$(openclaw_validated_node_version "${MAIN_REPO}")" \
    --arg arch "${host_arch}" \
    --arg runtimeNode "$("${JQ_BIN}" -r '.nodeVersion // empty' "${artifact_app}/Contents/Resources/OpenClawRuntime/manifest.json")" \
    --arg runtimeUv "$("${JQ_BIN}" -r '.uvVersion // empty' "${artifact_app}/Contents/Resources/OpenClawRuntime/manifest.json")" \
    --arg runtimeKey "$("${JQ_BIN}" -r '.runtimeInputKey // empty' "${artifact_app}/Contents/Resources/OpenClawRuntime/manifest.json")" \
    --arg version "${expected_version}" --arg build "${expected_build}" \
    --arg certSha1 "${signing_hash}" --arg certName "${signing_name}" --arg teamId "${signing_team}" '
      .authority.pr == $pr and .authority.mainPolicy == $policy and
      .authority.reviewedRoutineProtectedPrs == $reviewed and
      .authority.approvedProtectedPrs == $approved and
      .source.gitCommit == $commit and
      .inputs.lockfilesSha256 == $lockfiles and
      .inputs.packagingScriptsSha256 == $packaging and
      .toolchain.nodeVersion == $node and .toolchain.hostArchitecture == $arch and
      .toolchain.runtimeNodeVersion == $runtimeNode and
      .toolchain.runtimeUvVersion == $runtimeUv and .toolchain.runtimeInputKey == $runtimeKey and
      .app.version == $version and .app.build == $build and
      .signing.certificateSha1 == $certSha1 and
      .signing.certificateCommonName == $certName and .signing.teamId == $teamId and
      .signing.requirement == "Developer ID Application with hardened runtime and exact Team ID" and
      .locks.gatewayMain == false and .locks.releaseJarvis == false
    ' >/dev/null || die "prepared receipt no longer matches exact source, authority, toolchain, app, or signing inputs"

  verify_built_hotfix "${expected_commit}" "${expected_build}" "${expected_version}" "${artifact_app}"
  printf '%s\t%s\t%s\t%s\n' \
    "${artifact_app}" \
    "${signing_hash}" \
    "${signing_name}" \
    "$(printf '%s\n' "${verified}" | "${JQ_BIN}" -r '.receiptDigest')"
}

place_sign_and_verify_prepared_hotfix() {
  local artifact_app="$1"
  local signing_hash="$2"
  local signing_name="$3"
  local expected_commit="$4"
  local expected_build="$5"
  local expected_version="$6"
  local staged_app="${MAIN_REPO}/dist/.Jarvis.hotfix-apply.$$.app"
  local expected_team=""
  local actual_team=""
  local actual_authority=""
  local rollback_app="${MAIN_REPO}/dist/.Jarvis.hotfix-rollback.$$.app"

  [[ ! -e "${staged_app}" && ! -e "${rollback_app}" ]] || \
    die "prepared apply staging or rollback path already exists"
  TRANSACTION_STAGED_APP="${staged_app}"
  /bin/mkdir -p "${MAIN_REPO}/dist"
  /usr/bin/ditto "${artifact_app}" "${staged_app}"
  /usr/bin/chflags -R nouchg "${staged_app}"
  /bin/chmod -R u+w "${staged_app}"
  verify_built_hotfix "${expected_commit}" "${expected_build}" "${expected_version}" "${staged_app}"
  # Bind signing to the exact receipt fingerprint. A display name alone can
  # match more than one valid certificate in the host keychain.
  SIGN_IDENTITY="${signing_hash}" CODESIGN_TIMESTAMP=on PACKAGE_TIMING=1 \
    /bin/bash "${CODESIGN_SCRIPT}" "${staged_app}"
  /bin/bash "${VERIFY_APP_SCRIPT}" "${staged_app}"
  expected_team="$(printf '%s\n' "${signing_name}" | /usr/bin/sed -nE 's/.*\(([A-Z0-9]{10})\)$/\1/p')"
  actual_team="$(/usr/bin/codesign -dv --verbose=4 "${staged_app}" 2>&1 | /usr/bin/awk -F= '/^TeamIdentifier=/{print $2; exit}')"
  actual_authority="$(/usr/bin/codesign -dv --verbose=4 "${staged_app}" 2>&1 | /usr/bin/awk -F= '/^Authority=/{print $2; exit}')"
  [[ -n "${expected_team}" && "${actual_team}" == "${expected_team}" ]] || \
    die "signed Jarvis Team ID ${actual_team:-missing} does not match prepared requirement ${expected_team:-missing}"
  [[ "${actual_authority}" == "${signing_name}" ]] || \
    die "signed Jarvis authority ${actual_authority:-missing} does not match prepared certificate ${signing_name}"
  verify_built_hotfix "${expected_commit}" "${expected_build}" "${expected_version}" "${staged_app}"

  # Rename the old and new bundles on the same filesystem. The EXIT guard keeps
  # the rollback path authoritative until the replacement passes final proof.
  if [[ -e "${JARVIS_APP_PATH}" ]]; then
    TRANSACTION_ROLLBACK_APP="${rollback_app}"
    /bin/mv "${JARVIS_APP_PATH}" "${rollback_app}"
  fi
  TRANSACTION_CANONICAL_UNCOMMITTED=1
  /bin/mv "${staged_app}" "${JARVIS_APP_PATH}"
  verify_built_hotfix "${expected_commit}" "${expected_build}" "${expected_version}"
  TRANSACTION_CANONICAL_UNCOMMITTED=0
  TRANSACTION_STAGED_APP=""
  TRANSACTION_ROLLBACK_APP=""
  if [[ -e "${rollback_app}" ]]; then
    /usr/bin/chflags -R nouchg "${rollback_app}" 2>/dev/null || true
    /bin/chmod -R u+w "${rollback_app}" 2>/dev/null || true
    /bin/rm -rf "${rollback_app}"
  fi
}

wait_for_seeded_runtime() {
  local expected_commit="$1"
  local expected_build="$2"
  local deadline=$((SECONDS + SEED_TIMEOUT_SECONDS))
  local installed_commit=""
  local installed_build=""

  while (( SECONDS <= deadline )); do
    if [[ -r "${JARVIS_MANIFEST}" ]]; then
      installed_commit="$("${JQ_BIN}" -r '.gitCommit // empty' "${JARVIS_MANIFEST}" 2>/dev/null || true)"
      installed_build="$("${JQ_BIN}" -r '.bundleVersion // empty' "${JARVIS_MANIFEST}" 2>/dev/null || true)"
      if [[ "${installed_build}" == "${expected_build}" ]] && \
          commit_matches "${expected_commit}" "${installed_commit}"; then
        return 0
      fi
    fi
    /bin/sleep "${SEED_POLL_SECONDS}"
  done
  die "dist/Jarvis.app did not seed expected commit=${expected_commit} build=${expected_build} into app support"
}

run_offline_seeded_protection() {
  local expected_commit="$1"
  local action="$2"
  local command=(
    /usr/bin/env
    -i
    "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    "HOME=/Users/user"
    "OPENCLAW_INSTALLED_JARVIS_APP_PATH=${INSTALLED_JARVIS_APP_PATH}"
    "OPENCLAW_JARVIS_HOME=${JARVIS_HOME}"
    "OPENCLAW_JARVIS_STATE_DIR=${JARVIS_STATE_DIR}"
    "OPENCLAW_JARVIS_CONFIG_PATH=${JARVIS_CONFIG_PATH}"
    "OPENCLAW_LSOF_BIN=${LSOF_BIN}"
    /bin/bash "${PROTECT_SCRIPT}"
    --expected-live-commit "${expected_commit}"
    --offline-seeded-fallback
  )
  case "${action}" in
    apply)
      "${command[@]}" --apply
      ;;
    verify)
      "${command[@]}" --verify
      ;;
    *)
      die "unknown offline protection action: ${action}"
      ;;
  esac
}

cleanup_launch_receipt() {
  [[ -n "${TRANSACTION_LAUNCH_RECEIPT_DIR}" ]] || return 0
  /bin/rm -f "${TRANSACTION_LAUNCH_RECEIPT_DIR}/launched-app-path"
  rmdir "${TRANSACTION_LAUNCH_RECEIPT_DIR}" 2>/dev/null || true
  TRANSACTION_LAUNCH_RECEIPT_DIR=""
}

cleanup_prepared_apply_artifacts() {
  # A rollback path means canonical replacement was not committed. Restore the
  # previous verified app with same-filesystem renames before deleting the
  # uncommitted candidate from its original staging path.
  if [[ -n "${TRANSACTION_ROLLBACK_APP}" && -e "${TRANSACTION_ROLLBACK_APP}" ]]; then
    if [[ -e "${JARVIS_APP_PATH}" ]]; then
      [[ -n "${TRANSACTION_STAGED_APP}" && ! -e "${TRANSACTION_STAGED_APP}" ]] && \
        /bin/mv "${JARVIS_APP_PATH}" "${TRANSACTION_STAGED_APP}"
    fi
    /bin/mv "${TRANSACTION_ROLLBACK_APP}" "${JARVIS_APP_PATH}"
  elif (( TRANSACTION_CANONICAL_UNCOMMITTED == 1 )) && [[ -e "${JARVIS_APP_PATH}" ]]; then
    [[ -n "${TRANSACTION_STAGED_APP}" && ! -e "${TRANSACTION_STAGED_APP}" ]] && \
      /bin/mv "${JARVIS_APP_PATH}" "${TRANSACTION_STAGED_APP}"
  fi
  TRANSACTION_ROLLBACK_APP=""
  TRANSACTION_CANONICAL_UNCOMMITTED=0

  if [[ -n "${TRANSACTION_STAGED_APP}" && -e "${TRANSACTION_STAGED_APP}" ]]; then
    /usr/bin/chflags -R nouchg "${TRANSACTION_STAGED_APP}" 2>/dev/null || true
    /bin/chmod -R u+w "${TRANSACTION_STAGED_APP}" 2>/dev/null || true
    /bin/rm -rf "${TRANSACTION_STAGED_APP}"
  fi
  TRANSACTION_STAGED_APP=""
}

exit_after_transaction_cleanup() {
  local status="$1"
  # Lock release is deliberately last. Every seeded-runtime recovery and proof
  # above this call still owns the same cross-worktree mutation boundary.
  openclaw_jarvis_release_lock_release || true
  exit "${status}"
}

transaction_exit_guard() {
  local original_status=$?
  trap - EXIT
  set +e
  # Final deep proof owns temporary status files. Clean them here so replacing
  # its old EXIT trap cannot bypass transaction recovery on proof failure.
  cleanup_status_files
  cleanup_launch_receipt
  cleanup_prepared_apply_artifacts
  if (( original_status == 0 || TRANSACTION_ARMED != 1 )); then
    exit_after_transaction_cleanup "${original_status}"
  fi

  # A failed post-launch path must not return control while the newly seeded
  # payload can be downgraded by the installed app. First prove protection;
  # if an interrupted write left the exact seeded manifest in place, complete
  # the same helper transaction and prove it before propagating the failure.
  if run_offline_seeded_protection "${TRANSACTION_EXPECTED_COMMIT}" verify; then
    log "transaction_recovery=protection-verified-before-nonzero-exit"
    exit_after_transaction_cleanup "${original_status}"
  fi

  # The helper validates both recoverable states: the exact seeded manifest,
  # or an installed-app compatibility manifest with a backup receipt bound to
  # that seed. Keep state interpretation in one audited implementation.
  if run_offline_seeded_protection "${TRANSACTION_EXPECTED_COMMIT}" apply && \
      run_offline_seeded_protection "${TRANSACTION_EXPECTED_COMMIT}" verify; then
    log "transaction_recovery=protection-applied-and-verified-before-nonzero-exit"
    exit_after_transaction_cleanup "${original_status}"
  fi

  log "CRITICAL: transaction recovery could not prove compatibility protection; Jarvis app must remain closed pending manual recovery" >&2
  exit_after_transaction_cleanup 125
}

launch_seed_and_restart() {
  local expected_commit="$1"
  local app_build="$2"
  local app_version="$3"
  local domain="gui/$(${ID_BIN} -u)"
  local old_pid=""
  local launch_receipt=""
  local launched_app_path=""
  local open_status=0

  if (( DRY_RUN == 1 )); then
    print_main_command /bin/bash "${OPEN_APP_SCRIPT}" --replace "${JARVIS_APP_PATH}"
    log "dry-run: wait for ${JARVIS_MANIFEST} commit=${expected_commit} version=${app_version} build=${app_build}"
    print_command /usr/bin/env \
      -i \
      "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
      "HOME=/Users/user" \
      "OPENCLAW_INSTALLED_JARVIS_APP_PATH=${INSTALLED_JARVIS_APP_PATH}" \
      "OPENCLAW_JARVIS_HOME=${JARVIS_HOME}" \
      "OPENCLAW_JARVIS_STATE_DIR=${JARVIS_STATE_DIR}" \
      /bin/bash "${PROTECT_SCRIPT}" --expected-live-commit "${expected_commit}" \
      --offline-seeded-fallback --apply
    print_command /usr/bin/env \
      -i \
      "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
      "HOME=/Users/user" \
      "OPENCLAW_INSTALLED_JARVIS_APP_PATH=${INSTALLED_JARVIS_APP_PATH}" \
      "OPENCLAW_JARVIS_HOME=${JARVIS_HOME}" \
      "OPENCLAW_JARVIS_STATE_DIR=${JARVIS_STATE_DIR}" \
      /bin/bash "${PROTECT_SCRIPT}" --expected-live-commit "${expected_commit}" \
      --offline-seeded-fallback --verify
    print_command "${LAUNCHCTL_BIN}" kickstart -k "${domain}/${JARVIS_LABEL}"
    return 0
  fi

  TRANSACTION_EXPECTED_COMMIT="${expected_commit}"
  TRANSACTION_LAUNCH_RECEIPT_DIR="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/jarvis-hotfix-launch.XXXXXX")"
  /bin/chmod 700 "${TRANSACTION_LAUNCH_RECEIPT_DIR}"
  launch_receipt="${TRANSACTION_LAUNCH_RECEIPT_DIR}/launched-app-path"
  (cd "${MAIN_REPO}" && \
    /usr/bin/env -i \
      PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin \
      HOME=/Users/user \
      TMPDIR="${TMPDIR:-/tmp}" \
      OPENCLAW_APP_LAUNCH_RECEIPT="${launch_receipt}" \
      /bin/bash "${OPEN_APP_SCRIPT}" --replace "${JARVIS_APP_PATH}") || open_status=$?

  # The helper can launch the app successfully and then fail while preparing
  # foreground activation. Its atomic receipt is therefore the transaction
  # boundary: receipt means async seeding may happen even when the helper exits
  # nonzero; no receipt means the launch definitely did not complete.
  if [[ -r "${launch_receipt}" ]]; then
    launched_app_path="$(<"${launch_receipt}")"
    [[ "${launched_app_path}" == "${JARVIS_APP_PATH}" ]] || \
      die "app launcher receipt path=${launched_app_path:-missing}, expected ${JARVIS_APP_PATH}"
    TRANSACTION_ARMED=1
  fi
  if (( open_status != 0 && TRANSACTION_ARMED != 1 )); then
    return "${open_status}"
  fi
  (( TRANSACTION_ARMED == 1 )) || die "app launcher succeeded without publishing its launch receipt"
  cleanup_launch_receipt
  wait_for_seeded_runtime "${expected_commit}" "${app_build}"
  run_offline_seeded_protection "${expected_commit}" apply
  run_offline_seeded_protection "${expected_commit}" verify
  if (( open_status != 0 )); then
    # `open` is asynchronous. A post-launch setup failure still waits for and
    # protects the exact seed before preserving the helper's nonzero status;
    # EXIT recovery alone could otherwise race ahead of app bootstrap.
    return "${open_status}"
  fi
  old_pid="$(${LAUNCHCTL_BIN} print "${domain}/${JARVIS_LABEL}" 2>/dev/null | /usr/bin/awk '$1 == "pid" && $2 == "=" { print $3; exit }' || true)"
  "${LAUNCHCTL_BIN}" kickstart -k "${domain}/${JARVIS_LABEL}"
  wait_for_restarted_gateway "${expected_commit}" "${app_version}" "${old_pid}"
}

gateway_status_is_ready() {
  local expected_commit="$1"
  local expected_version="$2"
  local stdout_file=""
  local json_file=""
  local runtime_commit=""
  local runtime_package_version=""
  local rpc_ok=""
  stdout_file="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/jarvis-hotfix-ready.XXXXXX")"
  json_file="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/jarvis-hotfix-ready.json.XXXXXX")"

  if ! OPENCLAW_HOME="${JARVIS_HOME}" \
      OPENCLAW_STATE_DIR="${JARVIS_STATE_DIR}" \
      OPENCLAW_CONFIG_PATH="${JARVIS_CONFIG_PATH}" \
      OPENCLAW_LOG_DIR="${JARVIS_LOG_DIR}" \
      OPENCLAW_PROFILE=consumer \
      OPENCLAW_LAUNCHD_LABEL="${JARVIS_LABEL}" \
      "${JARVIS_NODE}" "${JARVIS_ENTRYPOINT}" gateway status --deep --require-rpc --json \
        >"${stdout_file}" 2>/dev/null; then
    /bin/rm -f "${stdout_file}" "${json_file}"
    return 1
  fi

  # Status may prefix JSON with non-secret config warnings. Parse the payload
  # privately and emit nothing so failed startup attempts cannot leak config.
  if "${JQ_BIN}" -e . "${stdout_file}" >/dev/null 2>&1; then
    /bin/cp "${stdout_file}" "${json_file}"
  else
    /usr/bin/awk 'found || /^[[:space:]]*\{/ { found = 1; print }' "${stdout_file}" >"${json_file}"
  fi
  if ! "${JQ_BIN}" -e . "${json_file}" >/dev/null 2>&1; then
    /bin/rm -f "${stdout_file}" "${json_file}"
    return 1
  fi

  runtime_commit="$("${JQ_BIN}" -r '.runtimeFingerprint.runtimeCommit // empty' "${json_file}")"
  runtime_package_version="$("${JQ_BIN}" -r '.runtimeFingerprint.runtimePackageVersion // empty' "${json_file}")"
  rpc_ok="$("${JQ_BIN}" -r --arg url "ws://127.0.0.1:${PORT}" '
    .rpc.ok // ([.targets[]? | select(.url == $url and .connect.rpcOk == true)] | length > 0)
  ' "${json_file}")"
  /bin/rm -f "${stdout_file}" "${json_file}"
  commit_matches "${expected_commit}" "${runtime_commit}" && \
    [[ "${runtime_package_version}" == "${expected_version}" ]] && \
    [[ "${rpc_ok}" == "true" ]]
}

wait_for_restarted_gateway() {
  local expected_commit="$1"
  local expected_version="$2"
  local old_pid="$3"
  local domain="gui/$(${ID_BIN} -u)"
  local deadline=$((SECONDS + GATEWAY_READY_TIMEOUT_SECONDS))
  local print_output=""
  local pid=""
  local listener_output=""

  # launchctl accepting kickstart only proves that it queued work. Protection
  # reads the live daemon, so wait for the replacement PID, its listener, the
  # expected commit, and deep RPC before allowing any manifest mutation.
  while (( SECONDS <= deadline )); do
    print_output="$(${LAUNCHCTL_BIN} print "${domain}/${JARVIS_LABEL}" 2>/dev/null || true)"
    pid="$(printf '%s\n' "${print_output}" | /usr/bin/awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
    if [[ "${pid}" =~ ^[1-9][0-9]*$ ]] && \
        { [[ -z "${old_pid}" ]] || [[ "${pid}" != "${old_pid}" ]]; }; then
      listener_output="$(${LSOF_BIN} -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
      if printf '%s\n' "${listener_output}" | \
          /usr/bin/awk -v pid="${pid}" 'NR > 1 && $2 == pid { found=1 } END { exit(found ? 0 : 1) }' && \
          gateway_status_is_ready "${expected_commit}" "${expected_version}"; then
        log "gateway restart ready pid=${pid} port=${PORT} version=${expected_version} rpc=true"
        return 0
      fi
    fi
    /bin/sleep "${GATEWAY_READY_POLL_SECONDS}"
  done
  die "${JARVIS_LABEL} did not reach new-PID/listener/commit/RPC readiness within ${GATEWAY_READY_TIMEOUT_SECONDS}s"
}

protect_runtime() {
  local expected_commit="$1"
  local base_command=(
    /usr/bin/env
    -i
    "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    "HOME=/Users/user"
    "OPENCLAW_INSTALLED_JARVIS_APP_PATH=${INSTALLED_JARVIS_APP_PATH}"
    "OPENCLAW_JARVIS_HOME=${JARVIS_HOME}"
    "OPENCLAW_JARVIS_STATE_DIR=${JARVIS_STATE_DIR}"
    "OPENCLAW_JARVIS_CONFIG_PATH=${JARVIS_CONFIG_PATH}"
    "OPENCLAW_LSOF_BIN=${LSOF_BIN}"
    /bin/bash "${PROTECT_SCRIPT}"
    --expected-live-commit "${expected_commit}"
  )

  # The helper's no-flag mode is its audited dry run. Only after it proves the
  # exact live daemon do we repeat the same proof and apply the compatibility
  # manifest that prevents the older installed app from reseeding over it.
  if (( DRY_RUN == 1 )); then
    print_command "${base_command[@]}"
    print_command "${base_command[@]}" --apply
    return 0
  fi
  "${base_command[@]}"
  "${base_command[@]}" --apply
}

cleanup_status_files() {
  [[ -z "${STATUS_STDOUT_FILE}" ]] || /bin/rm -f "${STATUS_STDOUT_FILE}"
  [[ -z "${STATUS_STDERR_FILE}" ]] || /bin/rm -f "${STATUS_STDERR_FILE}"
  [[ -z "${STATUS_JSON_FILE}" ]] || /bin/rm -f "${STATUS_JSON_FILE}"
}

extract_status_json() {
  if "${JQ_BIN}" -e . "${STATUS_STDOUT_FILE}" >/dev/null 2>&1; then
    /bin/cp "${STATUS_STDOUT_FILE}" "${STATUS_JSON_FILE}"
    return 0
  fi
  /usr/bin/awk 'found || /^[[:space:]]*\{/ { found = 1; print }' "${STATUS_STDOUT_FILE}" >"${STATUS_JSON_FILE}"
  "${JQ_BIN}" -e . "${STATUS_JSON_FILE}" >/dev/null 2>&1 || \
    die "Jarvis status command did not emit parseable JSON"
}

telegram_default_proof() {
  local username="unavailable"
  local token=""
  local fingerprint="unavailable"
  local log_file="${JARVIS_LOG_DIR}/gateway.log"

  if [[ -r "${log_file}" ]]; then
    username="$(/usr/bin/tail -n 500 "${log_file}" | /usr/bin/sed -nE 's/^.*\[default\].*@([A-Za-z0-9_]+).*$/@\1/p' | /usr/bin/tail -n 1)"
    username="${username:-unavailable}"
  fi
  if [[ -r "${JARVIS_CONFIG_PATH}" ]]; then
    token="$("${JQ_BIN}" -r '
      .channels.telegram as $telegram
      | ($telegram.accounts.default.botToken // $telegram.botToken // empty)
      | select(type == "string")
    ' "${JARVIS_CONFIG_PATH}" 2>/dev/null || true)"
  fi
  if [[ -n "${token}" ]] && command -v "${SHASUM_BIN}" >/dev/null 2>&1; then
    # Hashing proves bot identity without exposing any token prefix or suffix.
    fingerprint="$(printf '%s' "${token}" | "${SHASUM_BIN}" -a 256 | /usr/bin/awk '{print substr($1, 1, 12)}')"
  fi

  printf 'telegram_default_bot=%s\n' "${username}"
  printf 'telegram_token_fingerprint=%s\n' "${fingerprint}"
}

prove_break_glass_runtime() {
  local expected_commit="$1"
  local expected_version="$2"
  local proof_output=""
  local pid=""
  local runtime_source=""
  local runtime_commit=""
  local runtime_package_version=""

  # Runtime shipping and the post-deploy canary share one read-only provenance
  # contract. Keep the wrapper's legacy summary keys as aliases only; the
  # canonical helper owns all source, protection, daemon, listener, and RPC checks.
  proof_output="$(
    /usr/bin/env -i \
    PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin \
    HOME=/Users/user \
    OPENCLAW_JARVIS_HOME="${JARVIS_HOME}" \
    OPENCLAW_JARVIS_STATE_DIR="${JARVIS_STATE_DIR}" \
    OPENCLAW_JARVIS_CONFIG_PATH="${JARVIS_CONFIG_PATH}" \
    OPENCLAW_JARVIS_LOG_DIR="${JARVIS_LOG_DIR}" \
    OPENCLAW_JARVIS_NODE_BIN="${JARVIS_NODE}" \
    OPENCLAW_JARVIS_ENTRYPOINT="${JARVIS_ENTRYPOINT}" \
    OPENCLAW_JARVIS_INSTALLED_MANIFEST="${JARVIS_MANIFEST}" \
    OPENCLAW_JARVIS_PROTECTION_MARKER="${JARVIS_PROTECTION_MARKER}" \
    OPENCLAW_INSTALLED_JARVIS_APP_PATH="${INSTALLED_JARVIS_APP_PATH}" \
    OPENCLAW_JARVIS_APP_MANIFEST="${INSTALLED_JARVIS_APP_MANIFEST}" \
    OPENCLAW_JARVIS_GATEWAY_LABEL="${JARVIS_LABEL}" \
      /bin/bash "${PROVE_RUNTIME_SCRIPT}" \
        --runtime-source jarvis-break-glass-hotfix \
        --expected-commit "${expected_commit}" \
        --expected-package-version "${expected_version}"
  )" || die "protected-hotfix runtime proof failed"
  printf '%s\n' "${proof_output}"

  runtime_commit="$(printf '%s\n' "${proof_output}" | /usr/bin/sed -nE 's/^.*runtime_commit=([^ ]+).*$/\1/p' | /usr/bin/tail -n 1)"
  runtime_package_version="$(printf '%s\n' "${proof_output}" | /usr/bin/sed -nE 's/^.*runtime_package_version=([^ ]+).*$/\1/p' | /usr/bin/tail -n 1)"
  runtime_source="$(printf '%s\n' "${proof_output}" | /usr/bin/sed -nE 's/^.*runtime_source=([^ ]+).*$/\1/p' | /usr/bin/tail -n 1)"
  pid="$(printf '%s\n' "${proof_output}" | /usr/bin/sed -nE 's/^.*pid=([1-9][0-9]*).*$/\1/p' | /usr/bin/tail -n 1)"
  [[ -n "${runtime_commit}" && -n "${runtime_package_version}" && -n "${runtime_source}" && -n "${pid}" ]] || \
    die "protected-hotfix runtime proof omitted required summary fields"

  printf 'installed_runtime_commit=%s\n' "${runtime_commit}"
  printf 'runtime_package_version=%s\n' "${runtime_package_version}"
  printf 'runtime_pid=%s\n' "${pid}"
  printf 'runtime_command=%s %s gateway --port %s\n' "${JARVIS_NODE}" "${JARVIS_ENTRYPOINT}" "${PORT}"
  printf 'runtime_port=%s\n' "${PORT}"
  printf 'runtime_rpc=true\n'
  printf 'runtime_source=%s\n' "${runtime_source}"
  telegram_default_proof
  printf 'applications_jarvis_app=untouched\n'
  printf 'public_release=false\n'
  printf 'managed_bundle_steady_state=false\n'
  printf 'post_deploy_telegram_canary=%s\n' \
    "bash scripts/prove-jarvis-telegram-runtime.sh --dry-run --runtime-source jarvis-break-glass-hotfix --expected-commit ${expected_commit}"
}

main() {
  parse_args "$@"
  log "delivery_authority_policy=${MAIN_POLICY} requested_pr=${PR_NUMBER} phase=${HOTFIX_PHASE} reviewed_routine_protected_prs=${REVIEWED_ROUTINE_PROTECTED_PRS[*]:-none} approved_protected_prs=${APPROVED_PROTECTED_PRS[*]:-none}"
  assert_source_checkout_safe
  load_release_helpers
  require_preflight_tools
  assert_clean_sacred_main
  require_github_receipt_preflight

  local json=""
  local pr_state=""
  local expected_commit=""
  local app_build=""
  local app_version=""
  local host_arch=""
  local apply_result=""
  local prepared_app=""
  local signing_hash=""
  local signing_name=""
  local prepared_receipt_digest=""
  local apply_started_epoch=""

  if [[ "${HOTFIX_PHASE}" == "prepare" ]]; then
    expected_commit="$(resolve_prepared_source_commit)"
    assert_installed_app_needs_hotfix "${expected_commit}"
    app_version="$(select_hotfix_version)"
    app_build="$(select_hotfix_build "${app_version}")"
    host_arch="$(${UNAME_BIN} -m)"
    [[ "${host_arch}" == "arm64" || "${host_arch}" == "x86_64" ]] || die "unsupported host architecture: ${host_arch}"
    log "selected APP_VERSION=${app_version} APP_BUILD=${app_build} for lock-free exact-HEAD prepare"
    prepare_hotfix_artifact "${expected_commit}" "${app_build}" "${app_version}" "${host_arch}"
    return 0
  fi

  trap transaction_exit_guard EXIT
  if (( DRY_RUN != 1 )); then
    # The shared gateway lock wraps the live hotfix transaction and precedes
    # the release mutex acquired below. Dry-run remains lock-free.
    openclaw_heavy_local_slot_require_or_reexec_with_policy \
      "jarvis-remediation" \
      "ship-jarvis-hotfix:pr-${PR_NUMBER}" \
      "$ROOT_DIR" \
      "$ROOT_DIR/scripts/lib/ship-jarvis-hotfix-guarded-entry.sh" \
      "$@"
  fi
  apply_started_epoch="$(/bin/date +%s)"
  json="$(pr_json)"
  assert_pr_can_ship "${json}"
  pr_state="$(printf '%s\n' "${json}" | "${JQ_BIN}" -r '.state')"
  if (( DRY_RUN != 1 )); then
    # One canonical cross-worktree owner must cover GitHub merge, dist writes,
    # app-support receipts, gateway restart, final proof, and EXIT recovery.
    # Acquisition is fail-fast and precedes the first mutation.
    openclaw_jarvis_release_lock_acquire "${MAIN_REPO}" "hotfix-ship-pr-${PR_NUMBER}"
    # The shared helper installs release-only traps. Replace them only after a
    # successful acquire so signals exit through transaction recovery first;
    # lock release remains the final cleanup performed by that EXIT trap.
    trap transaction_exit_guard EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
  fi

  if [[ "${HOTFIX_PHASE}" == "apply" ]]; then
    expected_commit="$(resolve_prepared_source_commit)"
    assert_installed_app_needs_hotfix "${expected_commit}"
    app_version="$(select_hotfix_version)"
    app_build="$(select_hotfix_build "${app_version}")"
    host_arch="$(${UNAME_BIN} -m)"
    [[ "${host_arch}" == "arm64" || "${host_arch}" == "x86_64" ]] || die "unsupported host architecture: ${host_arch}"
    apply_result="$(validate_prepared_hotfix "${expected_commit}" "${app_build}" "${app_version}" "${host_arch}")"
    IFS=$'\t' read -r prepared_app signing_hash signing_name prepared_receipt_digest <<<"${apply_result}"
    [[ -n "${prepared_app}" && "${signing_hash}" =~ ^[0-9A-Fa-f]{40}$ && -n "${signing_name}" && "${prepared_receipt_digest}" =~ ^[0-9a-f]{64}$ ]] || \
      die "prepared validation omitted exact artifact or signing identity"
    log "apply_locks gateway-main=true release-jarvis=true receipt_digest=${prepared_receipt_digest}"
    place_sign_and_verify_prepared_hotfix "${prepared_app}" "${signing_hash}" "${signing_name}" \
      "${expected_commit}" "${app_build}" "${app_version}"
    launch_seed_and_restart "${expected_commit}" "${app_build}" "${app_version}"
    protect_runtime "${expected_commit}"
    prove_break_glass_runtime "${expected_commit}" "${app_version}"
    "${JQ_BIN}" -n \
      --arg receiptDigest "${prepared_receipt_digest}" --arg commit "${expected_commit}" \
      --arg build "${app_build}" --arg version "${app_version}" \
      --argjson protectedSeconds "$(( $(/bin/date +%s) - apply_started_epoch ))" \
      '{schema:1,phase:"apply",receiptDigest:$receiptDigest,gitCommit:$commit,appVersion:$version,appBuild:$build,locks:{gatewayMain:true,releaseJarvis:true},protectedSeconds:$protectedSeconds,status:"complete"}' \
      >"${MAIN_REPO}/dist/jarvis-hotfix-apply-receipt.json"
    log "apply_complete receipt=${MAIN_REPO}/dist/jarvis-hotfix-apply-receipt.json protected_seconds=$(( $(/bin/date +%s) - apply_started_epoch ))"
    TRANSACTION_ARMED=0
    return 0
  fi

  confirm_merged_pr "${json}"
  pull_and_confirm_merge

  if (( DRY_RUN == 1 )) && [[ "${pr_state}" == "OPEN" ]]; then
    # Current main is pre-merge truth. Keep commit-dependent preview commands
    # explicit about that uncertainty; the real commit is resolved only after
    # the non-dry run merges and fast-forwards sacred main.
    expected_commit="<post-merge-main>"
    log "OPEN PR dry-run uses prospective commit ${expected_commit}; real commit resolves after merge and git pull"
  elif (( DRY_RUN == 1 )); then
    # Resolve remote main without mutating the sacred checkout, then apply the
    # same review, scope, and required-check gates as the live post-pull path.
    expected_commit="$(printf '%s\n' "${json}" | "${JQ_BIN}" -r '.mergeCommit.oid // empty')"
    [[ "${expected_commit}" =~ ^[0-9a-fA-F]{7,40}$ ]] || \
      die "merged PR is missing a valid mergeCommit.oid for dry-run"
    expected_commit="$(dry_run_reviewed_remote_main "${expected_commit}")"
    log "MERGED PR dry-run models reviewed remote main ${expected_commit}; local main advances only in the live git pull"
    assert_installed_app_needs_hotfix "${expected_commit}"
  else
    # Live packaging is pinned to the refetched PR receipt, not a fresh HEAD
    # lookup that could silently widen scope after the equality gate above.
    expected_commit="${CONFIRMED_PR_MERGE_COMMIT}"
    valid_commit "${expected_commit}" || die "live PR merge commit was not confirmed after pull"
    assert_installed_app_needs_hotfix "${expected_commit}"
  fi
  app_version="$(select_hotfix_version)"
  app_build="$(select_hotfix_build "${app_version}")"
  host_arch="$(${UNAME_BIN} -m)"
  [[ "${host_arch}" == "arm64" || "${host_arch}" == "x86_64" ]] || die "unsupported host architecture: ${host_arch}"

  log "selected APP_VERSION=${app_version} from installed Jarvis and APP_BUILD=${app_build} from installed-manifest+1 versus normal package build"
  preflight_and_package_hotfix "${app_build}" "${app_version}" "${host_arch}"
  if (( DRY_RUN == 1 )); then
    log "dry-run: verify ${JARVIS_APP_PATH} commit=${expected_commit} CFBundleShortVersionString=${app_version} CFBundleVersion=${app_build} runtime_package_version=${app_version}"
  else
    verify_built_hotfix "${expected_commit}" "${app_build}" "${app_version}"
  fi
  launch_seed_and_restart "${expected_commit}" "${app_build}" "${app_version}"
  protect_runtime "${expected_commit}"

  if (( DRY_RUN == 1 )); then
    log "dry-run complete; no merge, pull, package, app launch, gateway restart, or app-support mutation was performed"
    log "proof would require runtime_source=jarvis-break-glass-hotfix; /Applications/Jarvis.app remains untouched"
    return 0
  fi
  prove_break_glass_runtime "${expected_commit}" "${app_version}"
  TRANSACTION_ARMED=0
}

if [[ "${OPENCLAW_SHIP_JARVIS_HOTFIX_LIB_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
