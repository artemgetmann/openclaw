#!/usr/bin/env bash
set -euo pipefail

# Focused shell fixtures for the release disk gate and conservative cleanup.
# The test intentionally drives only public CLI behavior so internal helper
# refactors do not require rewriting the assertions.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
BUILD_ROOT="$TMP_DIR/build-artifacts"
OUT="$TMP_DIR/out.txt"
ACTIVE_PROCESS_PID=""

stop_active_process_fixture() {
  if [[ -z "$ACTIVE_PROCESS_PID" ]]; then
    return 0
  fi

  # TERM is enough for tail, and wait reaps the child so the Bash 3.2 test does
  # not leak a process or race temporary-directory cleanup. Keep this helper
  # idempotent because both the main path and EXIT trap call it.
  kill "$ACTIVE_PROCESS_PID" 2>/dev/null || true
  wait "$ACTIVE_PROCESS_PID" 2>/dev/null || true
  ACTIVE_PROCESS_PID=""
}

cleanup() {
  stop_active_process_fixture
  # The permission fixture is deliberately unreadable during the test. Restore
  # owner access only so the test harness can remove its own temporary tree.
  chmod -R u+rwx "$TMP_DIR" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$*"
}

assert_file_exists() {
  local path="$1"
  local label="$2"
  [[ -e "$path" ]] || fail "$label: expected path to exist: $path"
  pass "$label"
}

assert_file_missing() {
  local path="$1"
  local label="$2"
  [[ ! -e "$path" ]] || fail "$label: expected path to be removed: $path"
  pass "$label"
}

assert_output_has() {
  local pattern="$1"
  local label="$2"
  if ! grep -F -- "$pattern" "$OUT" >/dev/null; then
    sed -n '1,240p' "$OUT" >&2
    fail "$label: missing output: $pattern"
  fi
  pass "$label"
}

assert_record() {
  local action="$1"
  local path="$2"
  local label="$3"
  if ! awk -v action="$action" -v path="$path" 'index($0, action) && index($0, path) { found=1 } END { exit(found ? 0 : 1) }' "$OUT"; then
    sed -n '1,240p' "$OUT" >&2
    fail "$label: no $action record for $path"
  fi
  pass "$label"
}

RUNS="$BUILD_ROOT/runs"
GENERIC_OLD="$RUNS/20200101T000000Z-package-mac-app-100.old"
RELEASE_OLD="$RUNS/20200101T000000Z-jarvis-release-200.old"
PROTECTED="$RUNS/20210101T000000Z-jarvis-release-300.protected"
ACTIVE="$RUNS/20210102T000000Z-sparkle-400.active"
RELEASE_NEW="$RUNS/20220101T000000Z-jarvis-release-500.newest"
PERMISSION_PROTECTED="$RUNS/20200102T000000Z-package-mac-app-600.protected"
PROCESS_ACTIVE="$RUNS/20200103T000000Z-package-mac-app-700.active-process"

mkdir -p "$GENERIC_OLD" "$RELEASE_OLD" "$PROTECTED" "$ACTIVE" "$RELEASE_NEW" "$PERMISSION_PROTECTED" "$PROCESS_ACTIVE"
printf 'generic\n' >"$GENERIC_OLD/payload"
printf 'release\n' >"$RELEASE_OLD/payload"
printf 'keep\n' >"$PROTECTED/.openclaw-protected"
printf 'active\n' >"$ACTIVE/.openclaw-active"
printf 'newest\n' >"$RELEASE_NEW/payload"
printf 'protected\n' >"$PERMISSION_PROTECTED/payload"
printf 'actively tailed\n' >"$PROCESS_ACTIVE/payload"

# Explicit mtimes make newest-retention deterministic on macOS and Linux. Touch
# marker-bearing directories last because creating the marker updates mtime.
touch -t 202001010000 "$GENERIC_OLD" "$RELEASE_OLD"
touch -t 202101010000 "$PROTECTED"
touch -t 202101020000 "$ACTIVE"
touch -t 202201010000 "$RELEASE_NEW"
touch -t 202001020000 "$PERMISSION_PROTECTED"
touch -t 202001030000 "$PROCESS_ACTIVE"
chmod 000 "$PERMISSION_PROTECTED"

# The path is present in tail's command line and the payload remains open. This
# exercises the real process/open-file safety gates instead of marker logic.
/usr/bin/tail -f "$PROCESS_ACTIVE/payload" >/dev/null 2>&1 &
ACTIVE_PROCESS_PID=$!

OPENCLAW_BUILD_ARTIFACT_ROOT="$BUILD_ROOT" \
OPENCLAW_CLEANUP_BUILD_RUNS_OLDER_THAN_HOURS=0 \
OPENCLAW_CLEANUP_RELEASE_STAGING_OLDER_THAN_DAYS=0 \
  /bin/bash "$ROOT_DIR/scripts/cleanup-build-artifacts.sh" --build-cache >"$OUT" 2>&1

assert_record "would_rm" "$GENERIC_OLD" "dry-run reports generic candidate"
assert_record "would_rm" "$RELEASE_OLD" "dry-run reports stale failed release staging"
assert_record "skip" "$RELEASE_NEW" "dry-run keeps newest release staging"
assert_record "skip" "$PROTECTED" "dry-run keeps protected marker"
assert_record "skip" "$ACTIVE" "dry-run keeps active marker"
assert_record "active-process" "$PROCESS_ACTIVE" "dry-run detects genuinely active process"
assert_record "skip" "$PERMISSION_PROTECTED" "dry-run reports permission-protected entry"
assert_record "unknown" "$PERMISSION_PROTECTED" "dry-run does not misreport unreadable size as zero"
assert_output_has "owner=" "permission report includes owner metadata"
assert_output_has "mode=" "permission report includes mode metadata"

OPENCLAW_BUILD_ARTIFACT_ROOT="$BUILD_ROOT" \
OPENCLAW_CLEANUP_BUILD_RUNS_OLDER_THAN_HOURS=0 \
OPENCLAW_CLEANUP_RELEASE_STAGING_OLDER_THAN_DAYS=0 \
  /bin/bash "$ROOT_DIR/scripts/cleanup-build-artifacts.sh" --build-cache --apply >"$OUT" 2>&1

assert_file_missing "$GENERIC_OLD" "apply removes generic candidate"
assert_file_missing "$RELEASE_OLD" "apply removes stale failed release staging"
assert_file_exists "$RELEASE_NEW" "apply keeps newest release staging"
assert_file_exists "$PROTECTED" "apply keeps protected marker"
assert_file_exists "$ACTIVE" "apply keeps active marker"
assert_file_exists "$PROCESS_ACTIVE" "apply keeps genuinely active run"
assert_file_exists "$PERMISSION_PROTECTED" "apply keeps permission-protected entry and continues"
assert_record "active-process" "$PROCESS_ACTIVE" "apply reports active process skip"
assert_output_has "operator action:" "apply prints narrow permission remediation"
STOPPED_ACTIVE_PROCESS_PID="$ACTIVE_PROCESS_PID"
stop_active_process_fixture
if kill -0 "$STOPPED_ACTIVE_PROCESS_PID" 2>/dev/null; then
  fail "active process fixture was not terminated and reaped"
fi
pass "active process fixture is terminated and reaped"

WORKTREES_ROOT="$TMP_DIR/worktrees"
RELEASE_WORKTREE="$WORKTREES_ROOT/release-lane"
ORDINARY_WORKTREE="$WORKTREES_ROOT/ordinary-lane"
mkdir -p "$RELEASE_WORKTREE/dist" "$ORDINARY_WORKTREE/dist"
for fixture_repo in "$RELEASE_WORKTREE" "$ORDINARY_WORKTREE"; do
  git -C "$fixture_repo" init -q
  printf 'fixture\n' >"$fixture_repo/tracked.txt"
  git -C "$fixture_repo" add tracked.txt
  git -C "$fixture_repo" -c user.name='Fixture' -c user.email='fixture@example.invalid' commit -qm 'fixture'
done
printf 'submission receipt\n' >"$RELEASE_WORKTREE/dist/Jarvis.app.notary.env"
printf 'ordinary generated output\n' >"$ORDINARY_WORKTREE/dist/payload.txt"
touch -t 202001010000 "$RELEASE_WORKTREE/dist" "$ORDINARY_WORKTREE/dist"

OPENCLAW_CLEANUP_OLDER_THAN_DAYS=0 \
  /bin/bash "$ROOT_DIR/scripts/cleanup-build-artifacts.sh" \
    --worktrees \
    --worktrees-root "$WORKTREES_ROOT" \
    --apply >"$OUT" 2>&1

assert_file_exists "$RELEASE_WORKTREE/dist/Jarvis.app.notary.env" "apply keeps resumable release receipt"
assert_file_missing "$ORDINARY_WORKTREE/dist" "apply still removes ordinary generated dist output"
assert_output_has "release-artifact-or-receipt" "cleanup explains protected release dist"

set +e
JARVIS_RELEASE_DISK_AVAILABLE_KIB_OVERRIDE=1024 \
  /bin/bash "$ROOT_DIR/scripts/preflight-jarvis-release-disk.sh" \
    --path "$TMP_DIR/not-created-yet/dist" \
    --required-kib 2048 >"$OUT" 2>&1
LOW_SPACE_STATUS=$?
set -e
[[ "$LOW_SPACE_STATUS" -eq 1 ]] || fail "low-space preflight expected status 1, got $LOW_SPACE_STATUS"
assert_output_has "required_kib=2048" "low-space output reports required capacity"
assert_output_has "free_kib=1024" "low-space output reports free capacity"
assert_output_has "shortfall_kib=1024" "low-space output reports shortfall"
assert_output_has "status=fail" "low-space preflight fails before packaging"

JARVIS_RELEASE_DISK_AVAILABLE_KIB_OVERRIDE=4096 \
  /bin/bash "$ROOT_DIR/scripts/preflight-jarvis-release-disk.sh" \
    --path "$TMP_DIR/not-created-yet/dist" \
    --required-kib 2048 >"$OUT" 2>&1
assert_output_has "shortfall_kib=0" "capacity pass has no shortfall"
assert_output_has "status=pass" "capacity pass succeeds"

/bin/bash -n \
  "$ROOT_DIR/scripts/lib/build-artifacts.sh" \
  "$ROOT_DIR/scripts/lib/jarvis-release-disk-preflight.sh" \
  "$ROOT_DIR/scripts/cleanup-build-artifacts.sh" \
  "$ROOT_DIR/scripts/preflight-jarvis-release-disk.sh" \
  "$ROOT_DIR/scripts/test-release-disk-hygiene.sh"
pass "Bash syntax proof"
