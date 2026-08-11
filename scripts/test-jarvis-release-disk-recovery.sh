#!/usr/bin/env bash
set -euo pipefail

# Public-interface regression for release-owned capacity recovery. Fixtures vary
# only filesystem observations and the cleanup result; callers do not need to
# know how candidate classification works inside cleanup-build-artifacts.sh.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-release-disk-recovery.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

PROBE="$TMP_ROOT/probe.sh"
CLEANUP="$TMP_ROOT/cleanup.sh"
STATE="$TMP_ROOT/recovered"
CALLED="$TMP_ROOT/cleanup-called"
AUTHORIZED="$TMP_ROOT/cleanup-authorized"
OUTPUT="$TMP_ROOT/output"

cat >"$PROBE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "${TEST_EXTERNAL_TARGET:-/never}" ]]; then
  printf 'external-fs\t/external\t1024\t%s\n' "$1"
  exit 0
fi
if [[ -e "${TEST_RECOVERY_STATE}" ]]; then
  free_kib=4096
else
  free_kib=1024
fi
printf 'fixture-fs\t/fixture\t%s\t%s\n' "$free_kib" "$1"
EOF

cat >"$CLEANUP" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'cleanup_called=true\n'
[[ -e "${TEST_CLEANUP_AUTHORIZED}" ]] || exit 91
: >"${TEST_CLEANUP_CALLED}"
[[ "${TEST_CLEANUP_RECOVERS:-0}" == "1" ]] || exit 0
: >"${TEST_RECOVERY_STATE}"
EOF
chmod +x "$PROBE" "$CLEANUP"

authorize_cleanup() {
  : >"$TEST_CLEANUP_AUTHORIZED"
}

reject_cleanup() {
  return 75
}

# shellcheck source=scripts/lib/jarvis-release-disk-preflight.sh
source "$ROOT_DIR/scripts/lib/jarvis-release-disk-preflight.sh"

TEST_RECOVERY_STATE="$STATE" \
TEST_CLEANUP_CALLED="$CALLED" \
TEST_CLEANUP_AUTHORIZED="$AUTHORIZED" \
TEST_CLEANUP_RECOVERS=1 \
OPENCLAW_BUILD_ARTIFACT_ROOT="$TMP_ROOT/build-cache" \
JARVIS_RELEASE_DISK_PROBE_COMMAND="$PROBE" \
JARVIS_RELEASE_DISK_CLEANUP_COMMAND="$CLEANUP" \
JARVIS_RELEASE_DISK_BEFORE_CLEANUP_FUNCTION=authorize_cleanup \
  jarvis_release_disk_ensure_capacity \
    "$ROOT_DIR" 2048 release-output "$TMP_ROOT/dist" >"$OUTPUT"
grep -Fq 'release_disk_recovery=started' "$OUTPUT" || fail "low capacity did not start cleanup"
grep -Fq 'cleanup_called=true' "$OUTPUT" || fail "cleanup command did not run"
grep -Fq 'release_disk_capacity_status=recovered' "$OUTPUT" || fail "recovered capacity did not continue"

rm -f "$STATE"
rm -f "$CALLED"
rm -f "$AUTHORIZED"
set +e
TEST_RECOVERY_STATE="$STATE" \
TEST_CLEANUP_CALLED="$CALLED" \
TEST_CLEANUP_AUTHORIZED="$AUTHORIZED" \
TEST_CLEANUP_RECOVERS=0 \
OPENCLAW_BUILD_ARTIFACT_ROOT="$TMP_ROOT/build-cache" \
JARVIS_RELEASE_DISK_PROBE_COMMAND="$PROBE" \
JARVIS_RELEASE_DISK_CLEANUP_COMMAND="$CLEANUP" \
JARVIS_RELEASE_DISK_BEFORE_CLEANUP_FUNCTION=authorize_cleanup \
  jarvis_release_disk_ensure_capacity \
    "$ROOT_DIR" 2048 release-output "$TMP_ROOT/dist" >"$OUTPUT"
blocked_status=$?
set -e
[[ "$blocked_status" -eq 1 ]] || fail "exhausted cleanup returned $blocked_status instead of 1"
grep -Fq 'release_disk_capacity_status=blocked' "$OUTPUT" || fail "exhausted cleanup omitted blocker status"
grep -Fq 'safe_repo_cleanup_exhausted_protected_or_external_capacity_required' "$OUTPUT" || \
  fail "exhausted cleanup omitted the protected-capacity blocker"

rm -f "$CALLED"
rm -f "$AUTHORIZED"
set +e
TEST_RECOVERY_STATE="$STATE" \
TEST_CLEANUP_CALLED="$CALLED" \
TEST_CLEANUP_AUTHORIZED="$AUTHORIZED" \
TEST_EXTERNAL_TARGET="$TMP_ROOT/external-staging" \
JARVIS_RELEASE_DISK_PROBE_COMMAND="$PROBE" \
JARVIS_RELEASE_DISK_CLEANUP_COMMAND="$CLEANUP" \
JARVIS_RELEASE_DISK_BEFORE_CLEANUP_FUNCTION=authorize_cleanup \
OPENCLAW_BUILD_ARTIFACT_ROOT="$TMP_ROOT/build-cache" \
  jarvis_release_disk_ensure_capacity \
    "$ROOT_DIR" 2048 release-staging "$TMP_ROOT/external-staging" >"$OUTPUT"
external_status=$?
set -e
[[ "$external_status" -eq 1 ]] || fail "external shortfall returned $external_status instead of 1"
[[ ! -e "$CALLED" ]] || fail "external shortfall deleted unrelated local caches"
grep -Fq 'release_disk_cleanup_reason=cache_filesystem_did_not_fail' "$OUTPUT" || \
  fail "external shortfall omitted cleanup skip reason"
grep -Fq 'release_disk_blocker=external_capacity_required' "$OUTPUT" || \
  fail "external shortfall omitted exact blocker"

rm -f "$CALLED" "$AUTHORIZED"
set +e
TEST_RECOVERY_STATE="$STATE" \
TEST_CLEANUP_CALLED="$CALLED" \
TEST_CLEANUP_AUTHORIZED="$AUTHORIZED" \
TEST_CLEANUP_RECOVERS=1 \
OPENCLAW_BUILD_ARTIFACT_ROOT="$TMP_ROOT/build-cache" \
JARVIS_RELEASE_DISK_PROBE_COMMAND="$PROBE" \
JARVIS_RELEASE_DISK_CLEANUP_COMMAND="$CLEANUP" \
JARVIS_RELEASE_DISK_BEFORE_CLEANUP_FUNCTION=reject_cleanup \
  jarvis_release_disk_ensure_capacity \
    "$ROOT_DIR" 2048 release-output "$TMP_ROOT/dist" >"$OUTPUT"
authorization_status=$?
set -e
[[ "$authorization_status" -eq 75 ]] || fail "revoked authorization returned $authorization_status instead of 75"
[[ ! -e "$CALLED" ]] || fail "cleanup ran after authorization was revoked"

printf 'PASS: Jarvis release disk recovery is automatic and bounded\n'
