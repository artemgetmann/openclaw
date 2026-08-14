#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-hotfix-phase-test.XXXXXX")"
trap 'chflags -R nouchg "${TMP_ROOT}" 2>/dev/null || true; chmod -R u+w "${TMP_ROOT}" 2>/dev/null || true; rm -rf "${TMP_ROOT}"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$*"
}

export OPENCLAW_SHIP_JARVIS_HOTFIX_LIB_ONLY=1
export OPENCLAW_SHIP_JARVIS_HOTFIX_TEST_MODE=1
export OPENCLAW_MAIN_REPO="${ROOT_DIR}"
export OPENCLAW_EXPECTED_MAIN_REPO="${ROOT_DIR}"
export OPENCLAW_HOTFIX_CLEAN_ENTRY=1
# shellcheck source=scripts/ship-jarvis-hotfix.sh
source "${ROOT_DIR}/scripts/ship-jarvis-hotfix.sh"
load_release_helpers

PR_NUMBER=""
MAIN_POLICY=""
HOTFIX_PHASE="one-shot"
PREPARE_OUTPUT=""
PREPARED_RECEIPT=""
DRY_RUN=0
parse_args --pr 42 --main-policy exact-pr
[[ "${HOTFIX_PHASE}" == "one-shot" ]] || fail "default one-shot rollback path changed"
pass "one-shot remains the default rollback path"

PR_NUMBER=""
MAIN_POLICY=""
HOTFIX_PHASE="one-shot"
PREPARE_OUTPUT=""
PREPARED_RECEIPT=""
parse_args --pr 42 --main-policy exact-pr --prepare-output "${TMP_ROOT}/future-output"
[[ "${HOTFIX_PHASE}" == "prepare" ]] || fail "prepare phase was not selected explicitly"
PR_NUMBER=""
MAIN_POLICY=""
HOTFIX_PHASE="one-shot"
PREPARE_OUTPUT=""
PREPARED_RECEIPT=""
parse_args --pr 42 --main-policy exact-pr --apply-prepared "${TMP_ROOT}/receipt.json"
[[ "${HOTFIX_PHASE}" == "apply" ]] || fail "apply phase was not selected explicitly"
pass "prepare and apply require explicit mutually exclusive arguments"

PREPARE_OUTPUT="${ROOT_DIR}/hotfix-prepare-output"
if (resolve_prepare_output_root) >/dev/null 2>&1; then
  fail "prepare accepted an output inside sacred main"
fi
PREPARE_OUTPUT="${TMP_ROOT}/outside-main-output"
TMP_ROOT_CANONICAL="$(cd "${TMP_ROOT}" && pwd -P)"
[[ "$(resolve_prepare_output_root)" == "${TMP_ROOT_CANONICAL}"/* ]] || \
  fail "prepare did not resolve an external unique output"
pass "prepare output must remain outside sacred main"

current_head="$(git -C "${ROOT_DIR}" rev-parse HEAD)"
resolved_head="$(
  pr_json() {
    jq -n --arg commit "${current_head}" \
      '{baseRefName:"main",state:"MERGED",mergeCommit:{oid:$commit}}'
  }
  assert_pr_can_ship() { return 0; }
  confirm_merged_pr() { log "merged confirmation"; }
  dry_run_reviewed_remote_main() { printf '%s\n' "${current_head}"; }
  resolve_prepared_source_commit
)"
[[ "${resolved_head}" == "${current_head}" ]] || \
  fail "prepared source resolver mixed confirmation logs into exact commit output"
pass "prepared source resolution emits only the exact commit"

selected_identity="$(printf '%s\n' \
  '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Developer ID Application: OTHER (AAAAAAAAAA)"' \
  '  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Developer ID Application: ARTEM (SKDYY4SBVV)"' \
  | select_hotfix_signing_identity_line SKDYY4SBVV)"
[[ "${selected_identity}" == *'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'* ]] || \
  fail "signing identity selection did not search for the installed Team ID"
pass "signing identity selection matches the installed Team ID"

if OPENCLAW_PACKAGE_UNSIGNED_PREPARE=1 \
    OPENCLAW_PACKAGE_PREPARE_ROOT="${ROOT_DIR}/dist/private" \
    OPENCLAW_PACKAGE_APP_ROOT="${ROOT_DIR}/dist/private/Jarvis.app" \
    OPENCLAW_PACKAGE_BUILD_ROOT="${ROOT_DIR}/dist/private/swift" \
    /bin/bash "${ROOT_DIR}/scripts/package-mac-app.sh" >/dev/null 2>&1; then
  fail "unsigned prepare accepted canonical dist overlap"
fi
mkdir -p "${TMP_ROOT}/private"
if OPENCLAW_PACKAGE_UNSIGNED_PREPARE=1 \
    OPENCLAW_PACKAGE_PREPARE_ROOT="${TMP_ROOT}/private" \
    OPENCLAW_PACKAGE_APP_ROOT="${TMP_ROOT}/outside/Jarvis.app" \
    OPENCLAW_PACKAGE_BUILD_ROOT="${TMP_ROOT}/private/swift" \
    /bin/bash "${ROOT_DIR}/scripts/package-mac-app.sh" >/dev/null 2>&1; then
  fail "unsigned prepare accepted an output outside its unique root"
fi
pass "unsigned package mode cannot target canonical or non-private outputs"

mkdir -p "${TMP_ROOT}/direct-private"
if OPENCLAW_PACKAGE_UNSIGNED_PREPARE=1 \
    OPENCLAW_PACKAGE_PREPARE_ROOT="${TMP_ROOT}/direct-private" \
    OPENCLAW_PACKAGE_APP_ROOT="${TMP_ROOT}/direct-private/Jarvis.app" \
    OPENCLAW_PACKAGE_BUILD_ROOT="${TMP_ROOT}/direct-private/swift" \
    /bin/bash "${ROOT_DIR}/scripts/package-mac-app.sh" >/dev/null 2>&1; then
  fail "unsigned prepare bypassed the release lock from a linked source worktree"
fi
mkdir -p "${TMP_ROOT}/symlink-private" "${TMP_ROOT}/symlink-outside"
ln -s "${TMP_ROOT}/symlink-outside" "${TMP_ROOT}/symlink-private/escape"
if OPENCLAW_PACKAGE_UNSIGNED_PREPARE=1 \
    OPENCLAW_PACKAGE_PREPARE_ROOT="${TMP_ROOT}/symlink-private" \
    OPENCLAW_PACKAGE_APP_ROOT="${TMP_ROOT}/symlink-private/escape/Jarvis.app" \
    OPENCLAW_PACKAGE_BUILD_ROOT="${TMP_ROOT}/symlink-private/swift" \
    /bin/bash "${ROOT_DIR}/scripts/package-mac-app.sh" >/dev/null 2>&1; then
  fail "unsigned prepare accepted a symlink escape from its private root"
fi
grep -Fq 'install --frozen-lockfile --config.node-linker=hoisted' \
  "${ROOT_DIR}/scripts/package-mac-app.sh" || fail "unsigned prepare no longer requires frozen dependencies"
grep -Fq 'jarvis_release_disk_preflight_operation "$package_operation"' \
  "${ROOT_DIR}/scripts/package-mac-app.sh" || fail "unsigned prepare no longer uses read-only disk admission"
pass "lock bypass requires a clean detached standalone clone, frozen inputs, and read-only capacity checks"

EXPECTED_COMMIT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
EXPECTED_BUILD="2026081401"
EXPECTED_VERSION="2026.8.14"
EXPECTED_ARCH="arm64"
LOCK_DIGEST="$(hotfix_input_digest "${ROOT_DIR}" pnpm-lock.yaml apps/macos/Package.resolved)"
PACKAGE_DIGEST="$(hotfix_input_digest "${ROOT_DIR}" scripts/package-mac-app.sh scripts/codesign-mac-app.sh scripts/verify-consumer-mac-app.sh scripts/ship-jarvis-hotfix.sh scripts/lib/jarvis-hotfix-prepared-artifact.mjs)"
source "${ROOT_DIR}/scripts/lib/validated-node.sh"
NODE_VERSION="$(openclaw_validated_node_version "${ROOT_DIR}")"
openclaw_use_validated_node "${ROOT_DIR}" >/dev/null
RECEIPT_NODE="${OPENCLAW_NODE_BIN}"

select_hotfix_signing_receipt() {
  printf '%s\t%s\t%s\n' \
    AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
    'Developer ID Application: ARTEM GETMAN (SKDYY4SBVV)' \
    SKDYY4SBVV
}

make_candidate() {
  local root="$1"
  local policy="${2:-exact-pr}"
  local commit="${3:-${EXPECTED_COMMIT}}"
  local lock_digest="${4:-${LOCK_DIGEST}}"
  local arch="${5:-${EXPECTED_ARCH}}"
  local version="${6:-${EXPECTED_VERSION}}"
  local cert_sha="${7:-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA}"
  local runtime_node="${8:-${NODE_VERSION}}"
  local packaging_digest="${9:-${PACKAGE_DIGEST}}"
  local app="${root}/artifact/Jarvis.app"
  local metadata="${root}/metadata.json"
  local receipt="${root}/receipt.json"
  mkdir -p "${app}/Contents/Resources/OpenClawRuntime/openclaw" "${app}/Contents/MacOS"
  printf 'fake-binary\n' >"${app}/Contents/MacOS/OpenClaw"
  cp "${ROOT_DIR}/apps/macos/Sources/OpenClaw/Resources/Info.plist" "${app}/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${EXPECTED_BUILD}" "${app}/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${EXPECTED_VERSION}" "${app}/Contents/Info.plist"
  printf '{"gitCommit":"%s","bundleVersion":"%s","nodeVersion":"%s","uvVersion":"0.9.21","runtimeInputKey":"%064d"}\n' \
    "${EXPECTED_COMMIT:0:7}" "${EXPECTED_BUILD}" "${NODE_VERSION}" 0 \
    >"${app}/Contents/Resources/OpenClawRuntime/manifest.json"
  printf '{"version":"%s"}\n' "${EXPECTED_VERSION}" \
    >"${app}/Contents/Resources/OpenClawRuntime/openclaw/package.json"
  jq -n \
    --arg policy "${policy}" --arg commit "${commit}" --arg lockfiles "${lock_digest}" \
    --arg packaging "${packaging_digest}" --arg node "${NODE_VERSION}" --arg arch "${arch}" \
    --arg runtimeNode "${runtime_node}" --arg version "${version}" --arg certSha "${cert_sha}" \
    --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg expiresAt "$(date -u -v+6H +%Y-%m-%dT%H:%M:%SZ)" \
    '{authority:{pr:42,mainPolicy:$policy,reviewedRoutineProtectedPrs:"",approvedProtectedPrs:""},source:{gitCommit:$commit},inputs:{lockfilesSha256:$lockfiles,packagingScriptsSha256:$packaging},toolchain:{nodeVersion:$node,hostArchitecture:$arch,runtimeNodeVersion:$runtimeNode,runtimeUvVersion:"0.9.21",runtimeInputKey:("0"*64)},app:{version:$version,build:"2026081401"},signing:{certificateSha1:$certSha,certificateCommonName:"Developer ID Application: ARTEM GETMAN (SKDYY4SBVV)",teamId:"SKDYY4SBVV",requirement:"Developer ID Application with hardened runtime and exact Team ID"},locks:{gatewayMain:false,releaseJarvis:false},metrics:{prepareSeconds:300,runtimeCache:"hit",diskDeltaKiB:1},createdAt:$createdAt,expiresAt:$expiresAt}' \
    >"${metadata}"
  chmod -R a-w "${app}"
  chflags -R uchg "${app}"
  "${RECEIPT_NODE}" "${ROOT_DIR}/scripts/lib/jarvis-hotfix-prepared-artifact.mjs" create \
    "${app}" "${metadata}" "${receipt}" >/dev/null
  rm -f "${metadata}"
  chmod a-w "${receipt}" "${root}"
  chflags uchg "${receipt}" "${root}"
}

assert_candidate_rejected() {
  local name="$1"
  local root="$2"
  PREPARED_RECEIPT="${root}/receipt.json"
  if (validate_prepared_hotfix "${EXPECTED_COMMIT}" "${EXPECTED_BUILD}" "${EXPECTED_VERSION}" "${EXPECTED_ARCH}") \
      >/dev/null 2>&1; then
    fail "${name} drift unexpectedly passed"
  fi
}

VALID_ROOT="${TMP_ROOT}/valid"
make_candidate "${VALID_ROOT}"
PREPARED_RECEIPT="${VALID_ROOT}/receipt.json"
validated="$(validate_prepared_hotfix "${EXPECTED_COMMIT}" "${EXPECTED_BUILD}" "${EXPECTED_VERSION}" "${EXPECTED_ARCH}")"
VALID_ROOT_CANONICAL="$(cd "${VALID_ROOT}" && pwd -P)"
[[ "${validated}" == "${VALID_ROOT_CANONICAL}/artifact/Jarvis.app"$'\t'* ]] || fail "exact candidate did not validate"
IFS=$'\t' read -r _validated_app validated_signing_hash validated_signing_name _validated_digest <<<"${validated}"
[[ "${validated_signing_hash}" == "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" ]] || \
  fail "exact candidate did not return its receipt-bound signing certificate hash"
[[ "${validated_signing_name}" == 'Developer ID Application: ARTEM GETMAN (SKDYY4SBVV)' ]] || \
  fail "exact candidate did not return its receipt-bound signing authority"
pass "exact immutable receipt is consumed only with matching artifact and inputs"

sign_line="$(grep -nF 'SIGN_IDENTITY="${signing_hash}" CODESIGN_TIMESTAMP=on' "${ROOT_DIR}/scripts/ship-jarvis-hotfix.sh" | cut -d: -f1)"
verify_line="$(grep -nF '/bin/bash "${VERIFY_APP_SCRIPT}" "${staged_app}"' "${ROOT_DIR}/scripts/ship-jarvis-hotfix.sh" | cut -d: -f1)"
replace_line="$(grep -nF '/bin/mv "${staged_app}" "${JARVIS_APP_PATH}"' "${ROOT_DIR}/scripts/ship-jarvis-hotfix.sh" | cut -d: -f1)"
[[ "${sign_line}" =~ ^[0-9]+$ && "${verify_line}" =~ ^[0-9]+$ && "${replace_line}" =~ ^[0-9]+$ ]] || \
  fail "prepared apply signing/replacement contract is incomplete"
(( sign_line < verify_line && verify_line < replace_line )) || \
  fail "prepared apply replaces the canonical app before exact-certificate signing and verification"
grep -Fq 'TRANSACTION_ROLLBACK_APP="${rollback_app}"' "${ROOT_DIR}/scripts/ship-jarvis-hotfix.sh" || \
  fail "prepared apply replacement has no rollback receipt"
grep -Fq 'cleanup_prepared_apply_artifacts' "${ROOT_DIR}/scripts/ship-jarvis-hotfix.sh" || \
  fail "prepared apply staging is not registered with transaction cleanup"
pass "apply timestamps the receipt-bound certificate and keeps rollback-backed replacement cleanup"

FAILURE_ROOT="${TMP_ROOT}/apply-sign-failure"
mkdir -p \
  "${FAILURE_ROOT}/artifact/Jarvis.app" \
  "${FAILURE_ROOT}/repo/dist/Jarvis.app" \
  "${FAILURE_ROOT}/bin"
printf 'old-canonical\n' >"${FAILURE_ROOT}/repo/dist/Jarvis.app/identity"
printf 'new-candidate\n' >"${FAILURE_ROOT}/artifact/Jarvis.app/identity"
printf '%s\n' \
  '#!/bin/bash' \
  '[[ "${SIGN_IDENTITY:-}" == "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" ]] || exit 8' \
  '[[ "${CODESIGN_TIMESTAMP:-}" == "on" ]] || exit 8' \
  'exit 9' >"${FAILURE_ROOT}/bin/fail-sign.sh"
chmod +x "${FAILURE_ROOT}/bin/fail-sign.sh"
set +e
(
  set -e
  MAIN_REPO="${FAILURE_ROOT}/repo"
  JARVIS_APP_PATH="${MAIN_REPO}/dist/Jarvis.app"
  CODESIGN_SCRIPT="${FAILURE_ROOT}/bin/fail-sign.sh"
  verify_built_hotfix() { return 0; }
  openclaw_jarvis_release_lock_release() { return 0; }
  trap transaction_exit_guard EXIT
  place_sign_and_verify_prepared_hotfix \
    "${FAILURE_ROOT}/artifact/Jarvis.app" \
    AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
    'Developer ID Application: ARTEM GETMAN (SKDYY4SBVV)' \
    "${EXPECTED_COMMIT}" "${EXPECTED_BUILD}" "${EXPECTED_VERSION}"
) >"${FAILURE_ROOT}/failure.log" 2>&1
sign_failure_status=$?
set -e
if [[ "${sign_failure_status}" != "9" ]]; then
  sed -n '1,80p' "${FAILURE_ROOT}/failure.log" >&2
  fail "sign failure returned ${sign_failure_status}, expected 9"
fi
[[ "$(<"${FAILURE_ROOT}/repo/dist/Jarvis.app/identity")" == "old-canonical" ]] || \
  fail "sign failure changed the prior canonical app"
if find "${FAILURE_ROOT}/repo/dist" -maxdepth 1 -type d \
    \( -name '.Jarvis.hotfix-apply.*.app' -o -name '.Jarvis.hotfix-rollback.*.app' \) \
    -print -quit | grep -q .; then
  fail "sign failure leaked a staged or rollback app"
fi
pass "failed exact-certificate signing preserves canonical app and removes staging"

ROLLBACK_ROOT="${TMP_ROOT}/apply-replacement-failure"
mkdir -p \
  "${ROLLBACK_ROOT}/dist/Jarvis.app" \
  "${ROLLBACK_ROOT}/dist/.Jarvis.hotfix-rollback.test.app"
printf 'new-uncommitted\n' >"${ROLLBACK_ROOT}/dist/Jarvis.app/identity"
printf 'old-verified\n' >"${ROLLBACK_ROOT}/dist/.Jarvis.hotfix-rollback.test.app/identity"
(
  JARVIS_APP_PATH="${ROLLBACK_ROOT}/dist/Jarvis.app"
  TRANSACTION_STAGED_APP="${ROLLBACK_ROOT}/dist/.Jarvis.hotfix-apply.test.app"
  TRANSACTION_ROLLBACK_APP="${ROLLBACK_ROOT}/dist/.Jarvis.hotfix-rollback.test.app"
  TRANSACTION_CANONICAL_UNCOMMITTED=1
  cleanup_prepared_apply_artifacts
  [[ "$(<"${JARVIS_APP_PATH}/identity")" == "old-verified" ]] || \
    fail "interrupted replacement did not restore the prior canonical app"
  [[ ! -e "${TRANSACTION_ROLLBACK_APP}" ]] || fail "interrupted replacement left a rollback app"
)
pass "interrupted canonical replacement restores the prior verified app"

AUTHORITY_ROOT="${TMP_ROOT}/authority-drift"
make_candidate "${AUTHORITY_ROOT}" current-green-main
assert_candidate_rejected authority "${AUTHORITY_ROOT}"
SOURCE_ROOT="${TMP_ROOT}/source-drift"
make_candidate "${SOURCE_ROOT}" exact-pr bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
assert_candidate_rejected source "${SOURCE_ROOT}"
LOCK_ROOT="${TMP_ROOT}/dependency-drift"
make_candidate "${LOCK_ROOT}" exact-pr "${EXPECTED_COMMIT}" "$(printf 'f%.0s' {1..64})"
assert_candidate_rejected dependency "${LOCK_ROOT}"
PACKAGING_ROOT="${TMP_ROOT}/packaging-drift"
make_candidate "${PACKAGING_ROOT}" exact-pr "${EXPECTED_COMMIT}" "${LOCK_DIGEST}" arm64 "${EXPECTED_VERSION}" AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "${NODE_VERSION}" "$(printf 'e%.0s' {1..64})"
assert_candidate_rejected packaging "${PACKAGING_ROOT}"
ARCH_ROOT="${TMP_ROOT}/arch-drift"
make_candidate "${ARCH_ROOT}" exact-pr "${EXPECTED_COMMIT}" "${LOCK_DIGEST}" x86_64
assert_candidate_rejected architecture "${ARCH_ROOT}"
VERSION_ROOT="${TMP_ROOT}/version-drift"
make_candidate "${VERSION_ROOT}" exact-pr "${EXPECTED_COMMIT}" "${LOCK_DIGEST}" arm64 2026.8.15
assert_candidate_rejected version "${VERSION_ROOT}"
SIGNING_ROOT="${TMP_ROOT}/signing-drift"
make_candidate "${SIGNING_ROOT}" exact-pr "${EXPECTED_COMMIT}" "${LOCK_DIGEST}" arm64 "${EXPECTED_VERSION}" BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
assert_candidate_rejected signing "${SIGNING_ROOT}"
RUNTIME_ROOT="${TMP_ROOT}/runtime-drift"
make_candidate "${RUNTIME_ROOT}" exact-pr "${EXPECTED_COMMIT}" "${LOCK_DIGEST}" arm64 "${EXPECTED_VERSION}" AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA 0.0.0
assert_candidate_rejected runtime "${RUNTIME_ROOT}"
pass "authority, main, dependency, packaging, version, architecture, signing, and runtime drift fail closed"

artifact_digest_before="$("${RECEIPT_NODE}" "${ROOT_DIR}/scripts/lib/jarvis-hotfix-prepared-artifact.mjs" hash-tree "${VALID_ROOT}/artifact/Jarvis.app")"
set +e
"${ROOT_DIR}/scripts/lib/ship-jarvis-hotfix-guarded-entry.sh" --pr 42 --main-policy exact-pr \
  --apply-prepared "${VALID_ROOT}/receipt.json" >/dev/null 2>&1
busy_status=$?
set -e
[[ "${busy_status}" == "75" ]] || fail "missing apply locks returned ${busy_status}, expected 75"
artifact_digest_after="$("${RECEIPT_NODE}" "${ROOT_DIR}/scripts/lib/jarvis-hotfix-prepared-artifact.mjs" hash-tree "${VALID_ROOT}/artifact/Jarvis.app")"
[[ "${artifact_digest_before}" == "${artifact_digest_after}" ]] || fail "lock refusal modified prepared artifact"
pass "fail-fast apply contention returns 75 and preserves prepared artifact"

run_exit_guard_fixture() {
  local mode="$1"
  local log_file="$2"
  (
    TRANSACTION_ARMED=1
    TRANSACTION_EXPECTED_COMMIT="${EXPECTED_COMMIT}"
    protection_calls=0
    cleanup_status_files() { printf 'cleanup-status\n' >>"${log_file}"; }
    cleanup_launch_receipt() { printf 'cleanup-launch\n' >>"${log_file}"; }
    openclaw_jarvis_release_lock_release() { printf 'release-lock\n' >>"${log_file}"; }
    run_offline_seeded_protection() {
      protection_calls=$((protection_calls + 1))
      printf 'protection-%s-%s\n' "$2" "${protection_calls}" >>"${log_file}"
      case "${mode}:${protection_calls}" in
        recover:1) return 1 ;;
        recover:*) return 0 ;;
        protected:*) return 0 ;;
        fail:*) return 1 ;;
      esac
    }
    set +e
    false
    transaction_exit_guard
  )
}

RECOVERY_LOG="${TMP_ROOT}/recovery.log"
set +e
run_exit_guard_fixture recover "${RECOVERY_LOG}"
recovery_status=$?
set -e
[[ "${recovery_status}" == "1" ]] || fail "recoverable post-launch failure returned ${recovery_status}"
[[ "$(tail -n 1 "${RECOVERY_LOG}")" == "release-lock" ]] || fail "recovery did not release locks last"
grep -Fq 'protection-apply-2' "${RECOVERY_LOG}" || fail "recovery did not apply seeded protection"
grep -Fq 'protection-verify-3' "${RECOVERY_LOG}" || fail "recovery did not verify seeded protection"
pass "failed seed/restart/protection keeps recovery armed and releases locks last"

CRITICAL_LOG="${TMP_ROOT}/critical-recovery.log"
set +e
run_exit_guard_fixture fail "${CRITICAL_LOG}" >/dev/null 2>&1
critical_status=$?
set -e
[[ "${critical_status}" == "125" ]] || fail "unrecoverable protection failure returned ${critical_status}"
[[ "$(tail -n 1 "${CRITICAL_LOG}")" == "release-lock" ]] || fail "critical recovery did not release locks last"
pass "unrecoverable protection exits 125 only after final lock release"

printf 'All Jarvis hotfix prepare/apply contract tests passed.\n'
