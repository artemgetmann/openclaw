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
OUTPUT="$TMP_ROOT/output"

cat >"$PROBE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
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
[[ "${TEST_CLEANUP_RECOVERS:-0}" == "1" ]] || exit 0
: >"${TEST_RECOVERY_STATE}"
EOF
chmod +x "$PROBE" "$CLEANUP"

# shellcheck source=scripts/lib/jarvis-release-disk-preflight.sh
source "$ROOT_DIR/scripts/lib/jarvis-release-disk-preflight.sh"

TEST_RECOVERY_STATE="$STATE" \
TEST_CLEANUP_RECOVERS=1 \
JARVIS_RELEASE_DISK_PROBE_COMMAND="$PROBE" \
JARVIS_RELEASE_DISK_CLEANUP_COMMAND="$CLEANUP" \
  jarvis_release_disk_ensure_capacity \
    "$ROOT_DIR" 2048 release-output "$TMP_ROOT/dist" >"$OUTPUT"
grep -Fq 'release_disk_recovery=started' "$OUTPUT" || fail "low capacity did not start cleanup"
grep -Fq 'cleanup_called=true' "$OUTPUT" || fail "cleanup command did not run"
grep -Fq 'release_disk_capacity_status=recovered' "$OUTPUT" || fail "recovered capacity did not continue"

rm -f "$STATE"
set +e
TEST_RECOVERY_STATE="$STATE" \
TEST_CLEANUP_RECOVERS=0 \
JARVIS_RELEASE_DISK_PROBE_COMMAND="$PROBE" \
JARVIS_RELEASE_DISK_CLEANUP_COMMAND="$CLEANUP" \
  jarvis_release_disk_ensure_capacity \
    "$ROOT_DIR" 2048 release-output "$TMP_ROOT/dist" >"$OUTPUT"
blocked_status=$?
set -e
[[ "$blocked_status" -eq 1 ]] || fail "exhausted cleanup returned $blocked_status instead of 1"
grep -Fq 'release_disk_capacity_status=blocked' "$OUTPUT" || fail "exhausted cleanup omitted blocker status"
grep -Fq 'safe_repo_cleanup_exhausted_protected_or_external_capacity_required' "$OUTPUT" || \
  fail "exhausted cleanup omitted the protected-capacity blocker"

printf 'PASS: Jarvis release disk recovery is automatic and bounded\n'
