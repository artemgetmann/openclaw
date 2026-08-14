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
INSPECTION_BIN_DIR="$TMP_DIR/inspection-bin"
IMMUTABLE_FIXTURE_PATH=""
IMMUTABLE_FIXTURE_SET=0
ACL_FIXTURE_PATH=""
ACL_FIXTURE_SET=0
PARENT_ACL_FIXTURE_PATH=""
PARENT_ACL_FIXTURE_SET=0

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
  # Only the fixture cleanup clears a flag, and only on the exact temp file the
  # test marked immutable. Production cleanup never calls chflags.
  if [[ "$IMMUTABLE_FIXTURE_SET" == "1" && -n "$IMMUTABLE_FIXTURE_PATH" ]]; then
    chflags nouchg "$IMMUTABLE_FIXTURE_PATH" 2>/dev/null || true
    IMMUTABLE_FIXTURE_SET=0
  fi
  # As with file flags, ACL mutation is fixture cleanup only and targets the
  # exact temporary file modified by this test.
  if [[ "$ACL_FIXTURE_SET" == "1" && -n "$ACL_FIXTURE_PATH" ]]; then
    chmod -N "$ACL_FIXTURE_PATH" 2>/dev/null || true
    ACL_FIXTURE_SET=0
  fi
  if [[ "$PARENT_ACL_FIXTURE_SET" == "1" && -n "$PARENT_ACL_FIXTURE_PATH" ]]; then
    chmod -N "$PARENT_ACL_FIXTURE_PATH" 2>/dev/null || true
    PARENT_ACL_FIXTURE_SET=0
  fi
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
PARTIAL_CANDIDATE="$BUILD_ROOT/tmp/partial-delete-candidate"
PARTIAL_NESTED="$PARTIAL_CANDIDATE/nested-inaccessible"
PARTIAL_SIBLING="$PARTIAL_CANDIDATE/accessible-sibling.txt"
IMMUTABLE_CANDIDATE="$BUILD_ROOT/tmp/immutable-delete-candidate"
IMMUTABLE_FILE="$IMMUTABLE_CANDIDATE/immutable.txt"
IMMUTABLE_SIBLING="$IMMUTABLE_CANDIDATE/sibling.txt"
ACL_CANDIDATE="$BUILD_ROOT/tmp/acl-delete-candidate"
ACL_FILE="$ACL_CANDIDATE/deny-delete.txt"
ACL_SIBLING="$ACL_CANDIDATE/sibling.txt"

mkdir -p "$GENERIC_OLD" "$RELEASE_OLD" "$PROTECTED" "$ACTIVE" "$RELEASE_NEW" "$PERMISSION_PROTECTED" "$PROCESS_ACTIVE" "$PARTIAL_NESTED" "$IMMUTABLE_CANDIDATE" "$ACL_CANDIDATE"
printf 'generic\n' >"$GENERIC_OLD/payload"
printf 'release\n' >"$RELEASE_OLD/payload"
printf 'keep\n' >"$PROTECTED/.openclaw-protected"
printf 'active\n' >"$ACTIVE/.openclaw-active"
printf 'newest\n' >"$RELEASE_NEW/payload"
printf 'protected\n' >"$PERMISSION_PROTECTED/payload"
printf 'actively tailed\n' >"$PROCESS_ACTIVE/payload"
printf 'must survive whole\n' >"$PARTIAL_SIBLING"
printf 'blocked child\n' >"$PARTIAL_NESTED/payload"
printf 'flagged\n' >"$IMMUTABLE_FILE"
printf 'must also survive\n' >"$IMMUTABLE_SIBLING"
printf 'deny delete\n' >"$ACL_FILE"
printf 'must survive ACL guard\n' >"$ACL_SIBLING"

# Explicit mtimes make newest-retention deterministic on macOS and Linux. Touch
# marker-bearing directories last because creating the marker updates mtime.
touch -t 202001010000 "$GENERIC_OLD" "$RELEASE_OLD"
touch -t 202101010000 "$PROTECTED"
touch -t 202101020000 "$ACTIVE"
touch -t 202201010000 "$RELEASE_NEW"
touch -t 202001020000 "$PERMISSION_PROTECTED"
touch -t 202001030000 "$PROCESS_ACTIVE"
touch -t 202001040000 "$PARTIAL_NESTED" "$PARTIAL_CANDIDATE"
touch -t 202001050000 "$IMMUTABLE_CANDIDATE"
touch -t 202001060000 "$ACL_CANDIDATE"
chmod 000 "$PERMISSION_PROTECTED"
chmod 000 "$PARTIAL_NESTED"

if [[ "$(uname -s)" == "Darwin" ]]; then
  command -v chflags >/dev/null 2>&1 || fail "macOS immutable fixture requires chflags"
  chflags uchg "$IMMUTABLE_FILE"
  IMMUTABLE_FIXTURE_PATH="$IMMUTABLE_FILE"
  IMMUTABLE_FIXTURE_SET=1
  chmod +a "everyone deny delete" "$ACL_FILE"
  ACL_FIXTURE_PATH="$ACL_FILE"
  ACL_FIXTURE_SET=1
else
  printf 'SKIP: immutable file-flag fixture requires macOS chflags\n'
  rm -rf "$IMMUTABLE_CANDIDATE"
  printf 'SKIP: extended ACL fixture requires macOS chmod/find\n'
  rm -rf "$ACL_CANDIDATE"
fi

# The path is present in tail's command line and the payload remains open. This
# exercises the real process/open-file safety gates instead of marker logic.
/usr/bin/tail -f "$PROCESS_ACTIVE/payload" >/dev/null 2>&1 &
ACTIVE_PROCESS_PID=$!
export OPENCLAW_TEST_ACTIVE_PROCESS_PID="$ACTIVE_PROCESS_PID"

# Deterministic inspection wrappers keep the fixture independent of host TCC
# and lsof traversal behavior. The process wrapper reports only the deliberately
# active fixture while its real tail process exists; the lsof wrapper positively
# reports no matches.
mkdir -p "$INSPECTION_BIN_DIR"
cat >"$INSPECTION_BIN_DIR/ps" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${OPENCLAW_TEST_INSPECTION_LOG:-}" ]]; then
  printf 'ps %s\n' "$*" >>"$OPENCLAW_TEST_INSPECTION_LOG"
fi
if [[ -n "${OPENCLAW_TEST_ACTIVE_PROCESS_PID:-}" ]] && kill -0 "$OPENCLAW_TEST_ACTIVE_PROCESS_PID" 2>/dev/null; then
  printf '/usr/bin/tail -f %s/payload\n' "$OPENCLAW_TEST_PROCESS_ACTIVE"
fi
EOF
cat >"$INSPECTION_BIN_DIR/lsof" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${OPENCLAW_TEST_INSPECTION_LOG:-}" ]]; then
  printf 'lsof %s\n' "$*" >>"$OPENCLAW_TEST_INSPECTION_LOG"
fi
if [[ "${1:-}" == "-Fn" ]]; then
  exit 0
fi
if [[ "${1:-}" == "+D" && "${2:-}" == "${OPENCLAW_TEST_LSOF_MUTATION_TARGET:-}" &&
  -n "${OPENCLAW_TEST_LSOF_MUTATION_ACTION:-}" &&
  ! -e "${OPENCLAW_TEST_LSOF_MUTATION_SENTINEL:-/nonexistent}" ]]; then
  : >"$OPENCLAW_TEST_LSOF_MUTATION_SENTINEL"
  case "$OPENCLAW_TEST_LSOF_MUTATION_ACTION" in
    marker)
      : >"$OPENCLAW_TEST_LSOF_MUTATION_TARGET/.openclaw-protected"
      ;;
    dirty)
      printf 'late tracked state\n' >"$OPENCLAW_TEST_LSOF_MUTATION_TARGET/late-tracked.txt"
      git -C "$OPENCLAW_TEST_LSOF_MUTATION_WORKTREE" add -f dist/late-tracked.txt
      ;;
    release-receipt)
      printf 'late receipt\n' >"$OPENCLAW_TEST_LSOF_MUTATION_TARGET/Jarvis.app.notary.env"
      ;;
    age)
      touch "$OPENCLAW_TEST_LSOF_MUTATION_TARGET"
      ;;
    identity)
      mv "$OPENCLAW_TEST_LSOF_MUTATION_TARGET" "$OPENCLAW_TEST_LSOF_MUTATION_TARGET.replaced"
      mkdir -p "$OPENCLAW_TEST_LSOF_MUTATION_TARGET"
      printf 'replacement must survive\n' >"$OPENCLAW_TEST_LSOF_MUTATION_TARGET/replacement.txt"
      ;;
    tree-safety)
      mkdir -p "$OPENCLAW_TEST_LSOF_MUTATION_TARGET/late-protected"
      printf 'late protected state\n' >"$OPENCLAW_TEST_LSOF_MUTATION_TARGET/late-protected/state.txt"
      chmod 000 "$OPENCLAW_TEST_LSOF_MUTATION_TARGET/late-protected"
      ;;
    open-file)
      printf 'fixture 1 test 1r REG 1,1 1 1 %s/open-file\n' "$OPENCLAW_TEST_LSOF_MUTATION_TARGET"
      exit 0
      ;;
  esac
fi
exit 1
EOF
chmod +x "$INSPECTION_BIN_DIR/ps" "$INSPECTION_BIN_DIR/lsof"
export OPENCLAW_TEST_PROCESS_ACTIVE="$PROCESS_ACTIVE"
export OPENCLAW_CLEANUP_PS_BIN="$INSPECTION_BIN_DIR/ps"
export OPENCLAW_CLEANUP_LSOF_BIN="$INSPECTION_BIN_DIR/lsof"

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
assert_record "unknown" "$PARTIAL_CANDIDATE" "dry-run rejects candidate with inaccessible descendant"
if [[ "$IMMUTABLE_FIXTURE_SET" == "1" ]]; then
  assert_record "unknown" "$IMMUTABLE_CANDIDATE" "dry-run rejects immutable descendant"
fi
if [[ "$ACL_FIXTURE_SET" == "1" ]]; then
  assert_record "unknown" "$ACL_CANDIDATE" "dry-run rejects ACL-protected descendant"
fi
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
assert_file_exists "$PARTIAL_NESTED" "apply keeps candidate with inaccessible descendant"
assert_file_exists "$PARTIAL_SIBLING" "pre-delete validation leaves accessible sibling untouched"
if [[ "$IMMUTABLE_FIXTURE_SET" == "1" ]]; then
  assert_file_exists "$IMMUTABLE_FILE" "apply keeps immutable descendant"
  assert_file_exists "$IMMUTABLE_SIBLING" "immutable preflight leaves accessible sibling untouched"
fi
if [[ "$ACL_FIXTURE_SET" == "1" ]]; then
  assert_file_exists "$ACL_FILE" "apply keeps ACL-protected descendant"
  assert_file_exists "$ACL_SIBLING" "ACL preflight leaves accessible sibling untouched"
fi
assert_record "active-process" "$PROCESS_ACTIVE" "apply reports active process skip"
assert_record "unknown" "$PARTIAL_CANDIDATE" "apply reports inaccessible tree size as unknown"
assert_output_has "protected_descendant=$PARTIAL_NESTED" "apply identifies blocked nested directory"
if [[ "$IMMUTABLE_FIXTURE_SET" == "1" ]]; then
  assert_record "unknown" "$IMMUTABLE_CANDIDATE" "apply reports immutable tree size as unknown"
  assert_output_has "protected_descendant=$IMMUTABLE_FILE" "apply identifies exact immutable descendant"
  assert_output_has "protected_flags=uchg" "apply reports immutable file flags"
  [[ "$(stat -f '%Sf' "$IMMUTABLE_FILE")" == *uchg* ]] || fail "apply unexpectedly cleared immutable fixture flag"
  pass "apply leaves immutable flag unchanged"
fi
if [[ "$ACL_FIXTURE_SET" == "1" ]]; then
  assert_record "unknown" "$ACL_CANDIDATE" "apply reports ACL-protected tree size as unknown"
  assert_output_has "protected_descendant=$ACL_FILE" "apply identifies exact ACL-protected descendant"
  assert_output_has "protected_acl=extended" "apply reports extended ACL protection"
  [[ "$(find "$ACL_FILE" -acl -print)" == "$ACL_FILE" ]] || fail "apply unexpectedly cleared ACL fixture"
  pass "apply leaves ACL unchanged"
fi
assert_output_has "operator action:" "apply prints narrow permission remediation"
STOPPED_ACTIVE_PROCESS_PID="$ACTIVE_PROCESS_PID"
stop_active_process_fixture
if kill -0 "$STOPPED_ACTIVE_PROCESS_PID" 2>/dev/null; then
  fail "active process fixture was not terminated and reaped"
fi
pass "active process fixture is terminated and reaped"

if [[ "$(uname -s)" == "Darwin" ]]; then
  PARENT_ACL_BUILD_ROOT="$TMP_DIR/parent-acl-build-artifacts"
  PARENT_ACL_DIR="$PARENT_ACL_BUILD_ROOT/tmp"
  PARENT_ACL_CANDIDATE="$PARENT_ACL_DIR/parent-acl-candidate"
  PARENT_ACL_FIRST="$PARENT_ACL_CANDIDATE/first.txt"
  PARENT_ACL_SECOND="$PARENT_ACL_CANDIDATE/second.txt"
  mkdir -p "$PARENT_ACL_CANDIDATE"
  printf 'first must survive\n' >"$PARENT_ACL_FIRST"
  printf 'second must survive\n' >"$PARENT_ACL_SECOND"
  touch -t 202001010000 "$PARENT_ACL_CANDIDATE"
  chmod +a "everyone deny delete_child" "$PARENT_ACL_DIR"
  PARENT_ACL_FIXTURE_PATH="$PARENT_ACL_DIR"
  PARENT_ACL_FIXTURE_SET=1

  OPENCLAW_BUILD_ARTIFACT_ROOT="$PARENT_ACL_BUILD_ROOT" \
  OPENCLAW_CLEANUP_BUILD_TEMP_OLDER_THAN_DAYS=0 \
    /bin/bash "$ROOT_DIR/scripts/cleanup-build-artifacts.sh" \
      --build-cache \
      --apply >"$OUT" 2>&1

  assert_file_exists "$PARENT_ACL_FIRST" "parent ACL preflight keeps first candidate child"
  assert_file_exists "$PARENT_ACL_SECOND" "parent ACL preflight keeps second candidate child"
  assert_record "unknown" "$PARENT_ACL_CANDIDATE" "apply reports parent-ACL candidate size as unknown"
  assert_output_has "protected_parent=$PARENT_ACL_DIR" "apply identifies exact ACL-protected parent"
  assert_output_has "protected_acl=extended" "apply reports parent extended ACL protection"
  [[ "$(find "$PARENT_ACL_DIR" -prune -acl -print)" == "$PARENT_ACL_DIR" ]] || fail "apply unexpectedly cleared parent ACL fixture"
  pass "apply leaves parent ACL unchanged"
else
  printf 'SKIP: parent ACL fixture requires macOS chmod/find\n'
fi

RUNTIME_ROOT="$TMP_DIR/runtime-instances"
OLD_LOG="$RUNTIME_ROOT/manual-instance/logs/old.log"
LEGACY_PROTECTED_INSTANCE="$RUNTIME_ROOT/legacy-test-instance"
LEGACY_NESTED_CREDENTIAL="$LEGACY_PROTECTED_INSTANCE/.openclaw/credentials/provider.json"
LEGACY_NESTED_CONFIG="$LEGACY_PROTECTED_INSTANCE/.openclaw/config/openclaw.json"
mkdir -p "$(dirname "$OLD_LOG")" "$(dirname "$LEGACY_NESTED_CREDENTIAL")" "$(dirname "$LEGACY_NESTED_CONFIG")"
printf 'ordinary generated log\n' >"$OLD_LOG"
printf 'must survive cleanup\n' >"$LEGACY_NESTED_CREDENTIAL"
printf '{}\n' >"$LEGACY_NESTED_CONFIG"
chmod 600 "$OLD_LOG"
touch -t 202001010000 "$OLD_LOG"
touch -t 202001010000 "$LEGACY_PROTECTED_INSTANCE"
[[ ! -x "$OLD_LOG" ]] || fail "old log fixture must be non-executable"

OPENCLAW_RUNTIME_INSTANCES_ROOT="$RUNTIME_ROOT" \
OPENCLAW_CLEANUP_RUNTIME_LOGS_OLDER_THAN_DAYS=0 \
OPENCLAW_CLEANUP_RUNTIME_INSTANCE_OLDER_THAN_DAYS=0 \
  /bin/bash "$ROOT_DIR/scripts/cleanup-build-artifacts.sh" \
    --runtime-instances \
    --apply >"$OUT" 2>&1

assert_file_missing "$OLD_LOG" "apply deletes eligible non-executable old log"
assert_record "deleted" "$OLD_LOG" "cleanup reports non-executable log deletion"
assert_file_exists "$LEGACY_NESTED_CREDENTIAL" "apply keeps nested legacy credentials"
assert_file_exists "$LEGACY_NESTED_CONFIG" "apply keeps nested legacy control config"
assert_record "skip" "$LEGACY_PROTECTED_INSTANCE" "generated-name instance with nested state is protected"
assert_output_has "stateful-or-default" "nested runtime state explains protected instance"

WORKTREES_ROOT="$TMP_DIR/worktrees"
RELEASE_WORKTREE="$WORKTREES_ROOT/release-lane"
ORDINARY_WORKTREE="$WORKTREES_ROOT/ordinary-lane"
mkdir -p "$RELEASE_WORKTREE/dist" "$ORDINARY_WORKTREE/dist"
for fixture_repo in "$RELEASE_WORKTREE" "$ORDINARY_WORKTREE"; do
  git -C "$fixture_repo" init -q -b fixture
  printf 'fixture\n' >"$fixture_repo/tracked.txt"
  # Keep generated dist output ignored so a clean fixture remains clean after
  # dirty detection starts protecting unrelated untracked user files.
  printf '/dist/\n' >"$fixture_repo/.gitignore"
  git -C "$fixture_repo" add tracked.txt .gitignore
  git -C "$fixture_repo" -c user.name='Fixture' -c user.email='fixture@example.invalid' commit -qm 'fixture'
done
printf 'submission receipt\n' >"$RELEASE_WORKTREE/dist/Jarvis.app.notary.env"
printf 'ordinary generated output\n' >"$ORDINARY_WORKTREE/dist/payload.txt"
printf 'valuable dirty source\n' >>"$ORDINARY_WORKTREE/tracked.txt"
printf 'valuable untracked source\n' >"$ORDINARY_WORKTREE/user-notes.txt"
touch -t 202001010000 "$RELEASE_WORKTREE/dist" "$ORDINARY_WORKTREE/dist"

OPENCLAW_CLEANUP_OLDER_THAN_DAYS=0 \
  /bin/bash "$ROOT_DIR/scripts/cleanup-build-artifacts.sh" \
    --worktrees \
    --worktrees-root "$WORKTREES_ROOT" \
    --apply >"$OUT" 2>&1

assert_file_exists "$RELEASE_WORKTREE/dist/Jarvis.app.notary.env" "apply keeps resumable release receipt"
assert_file_missing "$ORDINARY_WORKTREE/dist" "apply still removes ordinary generated dist output"
assert_file_exists "$ORDINARY_WORKTREE/tracked.txt" "apply preserves modified source beside generated output"
assert_file_exists "$ORDINARY_WORKTREE/user-notes.txt" "apply preserves untracked source beside generated output"
assert_output_has "release-artifact-or-receipt" "cleanup explains protected release dist"

# Every destructive worktree-artifact policy is re-evaluated after the fresh
# process/open-file check. The lsof fixture mutates the exact candidate at that
# boundary to prove late markers, user state, receipts, age, identity, tree
# safety, and open-file evidence all stop deletion.
TOCTOU_ROOT="$TMP_DIR/toctou-worktrees"
mkdir -p "$TOCTOU_ROOT"
for mutation_action in marker dirty release-receipt age identity tree-safety open-file; do
  mutation_worktree="$TOCTOU_ROOT/$mutation_action"
  mutation_target="$mutation_worktree/dist"
  mutation_sentinel="$TMP_DIR/toctou-$mutation_action.done"
  mkdir -p "$mutation_target"
  git -C "$mutation_worktree" init -q -b fixture
  printf 'fixture\n' >"$mutation_worktree/tracked.txt"
  printf '/dist/\n' >"$mutation_worktree/.gitignore"
  git -C "$mutation_worktree" add tracked.txt .gitignore
  git -C "$mutation_worktree" -c user.name='Fixture' -c user.email='fixture@example.invalid' commit -qm 'fixture'
  printf 'old generated output\n' >"$mutation_target/payload.txt"
  touch -t 202001010000 "$mutation_target"

  OPENCLAW_TEST_LSOF_MUTATION_ACTION="$mutation_action" \
  OPENCLAW_TEST_LSOF_MUTATION_TARGET="$mutation_target" \
  OPENCLAW_TEST_LSOF_MUTATION_WORKTREE="$mutation_worktree" \
  OPENCLAW_TEST_LSOF_MUTATION_SENTINEL="$mutation_sentinel" \
  OPENCLAW_CLEANUP_OLDER_THAN_DAYS=1 \
    /bin/bash "$ROOT_DIR/scripts/cleanup-build-artifacts.sh" \
      --worktrees \
      --worktrees-root "$TOCTOU_ROOT" \
      --apply >"$OUT" 2>&1

  assert_file_exists "$mutation_target" "late $mutation_action mutation protects exact artifact"
  assert_record "skip" "$mutation_target" "late $mutation_action mutation is reported"
  if [[ "$mutation_action" == "tree-safety" ]]; then
    chmod 700 "$mutation_target/late-protected"
  fi
done

# Default discovery must follow Git's registry rather than assuming every
# checkout is an immediate child of one filesystem root. A narrow Git wrapper
# supplies nested registered paths for this fixture and delegates status/repo
# validation to the real Git binary.
REAL_GIT="$(command -v git)"
REGISTERED_ROOT="$TMP_DIR/codex-worktrees"
REGISTERED_CLEAN="$REGISTERED_ROOT/clean-uuid/openclaw"
REGISTERED_UNTRACKED="$REGISTERED_ROOT/untracked-uuid/openclaw"
REGISTERED_MODIFIED="$REGISTERED_ROOT/modified-uuid/openclaw"
REGISTERED_STATUS_ERROR="$REGISTERED_ROOT/status-error-uuid/openclaw"
REGISTERED_TRACKED_DIST="$REGISTERED_ROOT/tracked-dist-uuid/openclaw"
REGISTERED_DIRTY_SWIFTPM="$REGISTERED_ROOT/dirty-swiftpm-uuid/openclaw"
REGISTERED_MAIN="$REGISTERED_ROOT/main-uuid/openclaw"
GIT_WRAPPER_DIR="$TMP_DIR/git-wrapper"
GIT_WRAPPER="$GIT_WRAPPER_DIR/git"
INSPECTION_LOG="$TMP_DIR/registered-inspection.log"
mkdir -p "$GIT_WRAPPER_DIR"

for fixture_repo in "$REGISTERED_CLEAN" "$REGISTERED_UNTRACKED" "$REGISTERED_MODIFIED" "$REGISTERED_STATUS_ERROR"; do
  mkdir -p "$fixture_repo/dist"
  git -C "$fixture_repo" init -q -b fixture
  printf 'fixture\n' >"$fixture_repo/tracked.txt"
  printf '/dist/\n' >"$fixture_repo/.gitignore"
  git -C "$fixture_repo" add tracked.txt .gitignore
  git -C "$fixture_repo" -c user.name='Fixture' -c user.email='fixture@example.invalid' commit -qm 'fixture'
  printf 'old generated output\n' >"$fixture_repo/dist/payload.txt"
  touch -t 202001010000 "$fixture_repo/dist"
done
printf 'untracked user state\n' >"$REGISTERED_UNTRACKED/user-notes.txt"
printf 'modified user state\n' >>"$REGISTERED_MODIFIED/tracked.txt"
mkdir -p "$REGISTERED_MODIFIED/apps/macos/.build"
printf '/apps/macos/.build/\n' >>"$REGISTERED_MODIFIED/.gitignore"
printf 'old Swift build output\n' >"$REGISTERED_MODIFIED/apps/macos/.build/payload.txt"
touch -t 202001010000 "$REGISTERED_MODIFIED/apps/macos/.build"

# A generated-looking name is not deletion authority. Tracked content beneath
# dist must survive even when the worktree itself is otherwise clean.
mkdir -p "$REGISTERED_TRACKED_DIST/dist"
git -C "$REGISTERED_TRACKED_DIST" init -q -b fixture
printf '/dist/\n' >"$REGISTERED_TRACKED_DIST/.gitignore"
printf 'tracked artifact state\n' >"$REGISTERED_TRACKED_DIST/dist/tracked.txt"
git -C "$REGISTERED_TRACKED_DIST" add .gitignore
git -C "$REGISTERED_TRACKED_DIST" add -f dist/tracked.txt
git -C "$REGISTERED_TRACKED_DIST" -c user.name='Fixture' -c user.email='fixture@example.invalid' commit -qm 'fixture'
touch -t 202001010000 "$REGISTERED_TRACKED_DIST/dist"

# `.swiftpm` can hold local package mirror or registry configuration, so dirty
# worktrees do not receive the generated-artifact exception for this path.
mkdir -p "$REGISTERED_DIRTY_SWIFTPM/.swiftpm"
git -C "$REGISTERED_DIRTY_SWIFTPM" init -q -b fixture
printf 'fixture\n' >"$REGISTERED_DIRTY_SWIFTPM/tracked.txt"
printf '/.swiftpm/\n' >"$REGISTERED_DIRTY_SWIFTPM/.gitignore"
git -C "$REGISTERED_DIRTY_SWIFTPM" add tracked.txt .gitignore
git -C "$REGISTERED_DIRTY_SWIFTPM" -c user.name='Fixture' -c user.email='fixture@example.invalid' commit -qm 'fixture'
printf 'local package state\n' >"$REGISTERED_DIRTY_SWIFTPM/.swiftpm/state.json"
printf 'dirty source\n' >>"$REGISTERED_DIRTY_SWIFTPM/tracked.txt"
touch -t 202001010000 "$REGISTERED_DIRTY_SWIFTPM/.swiftpm"
mkdir -p "$REGISTERED_MAIN/dist"
git -C "$REGISTERED_MAIN" init -q -b main
printf 'fixture\n' >"$REGISTERED_MAIN/tracked.txt"
printf '/dist/\n' >"$REGISTERED_MAIN/.gitignore"
git -C "$REGISTERED_MAIN" add tracked.txt .gitignore
git -C "$REGISTERED_MAIN" -c user.name='Fixture' -c user.email='fixture@example.invalid' commit -qm 'fixture'
printf 'sacred generated output\n' >"$REGISTERED_MAIN/dist/payload.txt"
touch -t 202001010000 "$REGISTERED_MAIN/dist"

{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'if [[ "$3" == "worktree" && "$4" == "list" && "$5" == "--porcelain" && "$6" == "-z" ]]; then'
  printf '%s\n' '  printf "worktree %s\0HEAD fixture\0branch refs/heads/fixture\0\0" "$REGISTERED_CLEAN"'
  printf '%s\n' '  printf "worktree %s\0HEAD fixture\0branch refs/heads/fixture\0\0" "$REGISTERED_UNTRACKED"'
  printf '%s\n' '  printf "worktree %s\0HEAD fixture\0branch refs/heads/fixture\0\0" "$REGISTERED_MODIFIED"'
  printf '%s\n' '  printf "worktree %s\0HEAD fixture\0branch refs/heads/fixture\0\0" "$REGISTERED_STATUS_ERROR"'
  printf '%s\n' '  printf "worktree %s\0HEAD fixture\0branch refs/heads/fixture\0\0" "$REGISTERED_TRACKED_DIST"'
  printf '%s\n' '  printf "worktree %s\0HEAD fixture\0branch refs/heads/fixture\0\0" "$REGISTERED_DIRTY_SWIFTPM"'
  printf '%s\n' '  printf "worktree %s\0HEAD fixture\0branch refs/heads/main\0\0" "$REGISTERED_MAIN"'
  printf '%s\n' '  exit 0'
  printf '%s\n' 'fi'
  printf '%s\n' 'if [[ "$1" == "-C" && "$2" == "$REGISTERED_STATUS_ERROR" && "$3" == "status" ]]; then'
  printf '%s\n' '  exit 1'
  printf '%s\n' 'fi'
  # Model a nested inspector that reads stdin. The production registry walker
  # must isolate each candidate inspection from its NUL-delimited input or the
  # first status call silently consumes every later worktree record.
  printf '%s\n' 'if [[ "$1" == "-C" && "$3" == "status" ]]; then'
  printf '%s\n' '  cat >/dev/null'
  printf '%s\n' 'fi'
  printf '%s\n' 'exec "$REAL_GIT" "$@"'
} >"$GIT_WRAPPER"
chmod +x "$GIT_WRAPPER"
export OPENCLAW_TEST_INSPECTION_LOG="$INSPECTION_LOG"

PATH="$GIT_WRAPPER_DIR:$PATH" \
REAL_GIT="$REAL_GIT" \
REGISTERED_CLEAN="$REGISTERED_CLEAN" \
REGISTERED_UNTRACKED="$REGISTERED_UNTRACKED" \
REGISTERED_MODIFIED="$REGISTERED_MODIFIED" \
REGISTERED_STATUS_ERROR="$REGISTERED_STATUS_ERROR" \
REGISTERED_TRACKED_DIST="$REGISTERED_TRACKED_DIST" \
REGISTERED_DIRTY_SWIFTPM="$REGISTERED_DIRTY_SWIFTPM" \
REGISTERED_MAIN="$REGISTERED_MAIN" \
OPENCLAW_CLEANUP_OLDER_THAN_DAYS=0 \
  /bin/bash "$ROOT_DIR/scripts/cleanup-build-artifacts.sh" \
    --worktrees >"$OUT" 2>&1

assert_record "would_rm" "$REGISTERED_CLEAN/dist" "default discovery finds nested registered worktree"
assert_record "would_rm" "$REGISTERED_UNTRACKED/dist" "untracked source no longer makes ignored generated output immortal"
assert_record "would_rm" "$REGISTERED_MODIFIED/dist" "modified source no longer makes ignored generated output immortal"
assert_record "would_rm" "$REGISTERED_MODIFIED/apps/macos/.build" "nested Swift build output is included in registered retention"
assert_record "skip" "$REGISTERED_STATUS_ERROR/dist" "status failure protects indeterminate worktree"
assert_record "skip" "$REGISTERED_TRACKED_DIST/dist" "tracked content under a generated-looking path remains protected"
assert_output_has "worktree-artifact-has-tracked-files" "tracked artifact protection is explicit"
assert_record "skip" "$REGISTERED_DIRTY_SWIFTPM/.swiftpm" "dirty worktree keeps local Swift package configuration"
assert_output_has "dirty-worktree-unsafe-artifact-kind" "unsafe dirty artifact kind is explicit"
assert_record "skip" "$REGISTERED_MAIN/dist" "sacred main worktree remains protected"
assert_output_has "control-or-release-worktree" "control-lane protection explains sacred main skip"
assert_file_exists "$REGISTERED_CLEAN/dist" "default registered-worktree fixture remains dry-run only"
if [[ "$(grep -c '^ps ' "$INSPECTION_LOG")" != "1" || "$(grep -c '^lsof -Fn$' "$INSPECTION_LOG")" != "1" ]]; then
  fail "registered scan must take one process and one open-file snapshot"
fi
pass "registered scan cost is bounded to one host inspection snapshot"
unset OPENCLAW_TEST_INSPECTION_LOG

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

# Admission is the protected post-write floor plus the expected writes for the
# selected operation. Prove the production constants and the exact boundary.
source "$ROOT_DIR/scripts/lib/jarvis-release-disk-preflight.sh"
[[ "$(jarvis_release_disk_post_write_floor_kib)" == "36700160" ]] || \
  fail "protected post-write floor drifted"
[[ "$(jarvis_release_disk_dependency_reserve_kib)" == "6291456" ]] || \
  fail "dependency reserve drifted"
[[ "$(jarvis_release_disk_warm_package_reserve_kib)" == "3145728" ]] || \
  fail "warm package reserve drifted"
[[ "$(jarvis_release_disk_cold_package_reserve_kib)" == "9437184" ]] || \
  fail "cold package reserve drifted"
[[ "$(jarvis_release_disk_full_release_reserve_kib)" == "10485760" ]] || \
  fail "full release reserve drifted"
[[ "$(jarvis_release_disk_admission_required_kib 36700160 9437184)" == "46137344" ]] || \
  fail "cold package admission arithmetic is wrong"
pass "operation reserves produce exact admission thresholds"

JARVIS_RELEASE_DISK_AVAILABLE_KIB_OVERRIDE=46137344 \
  jarvis_release_disk_preflight_operation cold-consumer-package \
    36700160 9437184 target "$TMP_DIR/not-created-yet/dist" >"$OUT" 2>&1
assert_output_has "operation=cold-consumer-package" "operation admission reports write class"
assert_output_has "post_write_floor_kib=36700160" "operation admission reports protected floor"
assert_output_has "expected_write_reserve_kib=9437184" "operation admission reports reserve"
assert_output_has "admission_required_kib=46137344" "operation admission reports threshold"
assert_output_has "projected_post_write_kib=36700160" "threshold equality preserves exact floor"
assert_output_has "status=pass" "threshold equality passes"

set +e
JARVIS_RELEASE_DISK_AVAILABLE_KIB_OVERRIDE=46137343 \
  jarvis_release_disk_preflight_operation cold-consumer-package \
    36700160 9437184 target "$TMP_DIR/not-created-yet/dist" >"$OUT" 2>&1
ADMISSION_LOW_STATUS=$?
set -e
[[ "$ADMISSION_LOW_STATUS" -eq 1 ]] || fail "one-KiB admission shortfall returned $ADMISSION_LOW_STATUS"
assert_output_has "shortfall_kib=1" "one-KiB admission shortfall is exact"
assert_output_has "projected_post_write_kib=36700159" "failed admission reports projected remainder"
assert_output_has "reason=projected-post-write-capacity-below-protected-floor" "failed admission explains protected-floor risk"

PREFLIGHT_SCRIPT="$ROOT_DIR/scripts/preflight-jarvis-release-disk.sh"
[[ -x "$PREFLIGHT_SCRIPT" ]] || fail "release disk preflight must remain executable"
pass "release disk preflight has executable mode"

# Exercise the same helper used by package-openclaw-mac-dist.sh and lock its
# filesystem contract: the heavy-write root is a unique jarvis-release child
# under the build-artifact runs parent.
PACKAGE_CONTRACT_ROOT="$TMP_DIR/package-contract-build-artifacts"
PACKAGE_CONTRACT_RUN="$(
  OPENCLAW_BUILD_ARTIFACT_ROOT="$PACKAGE_CONTRACT_ROOT" \
    /bin/bash -c 'source "$1"; openclaw_build_run_root jarvis-release' \
      fixture "$ROOT_DIR/scripts/lib/build-artifacts.sh"
)"
[[ "$(dirname "$PACKAGE_CONTRACT_RUN")" == "$PACKAGE_CONTRACT_ROOT/runs" ]] || \
  fail "package run helper escaped build-artifact runs parent: $PACKAGE_CONTRACT_RUN"
pass "package run helper selects build runs parent"
case "$(basename "$PACKAGE_CONTRACT_RUN")" in
  *-jarvis-release-*) pass "package run helper creates unique jarvis-release child" ;;
  *) fail "package run helper produced unexpected child name: $PACKAGE_CONTRACT_RUN" ;;
esac

DISK_PROBE_STUB="$TMP_DIR/disk-probe-stub.sh"
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'if [[ "$1" == "${EXPECTED_DEFAULT_OUTPUT:-}" || "$1" == "${EXPECTED_DEFAULT_STAGING:-}" ]]; then'
  printf '%s\n' '  printf "fs-default\t/Volumes/default\t8192\t%s\n" "$1"'
  printf '%s\n' '  exit 0'
  printf '%s\n' 'fi'
  printf '%s\n' 'case "$1" in'
  printf '%s\n' '  */shared-output|*/shared-staging) printf "fs-shared\t/Volumes/shared\t4096\t%s\n" "$1" ;;'
  printf '%s\n' '  */other-output) printf "fs-other\t/Volumes/other\t8192\t%s\n" "$1" ;;'
  printf '%s\n' '  */low-staging) printf "fs-low\t/Volumes/low\t1024\t%s\n" "$1" ;;'
  printf '%s\n' '  *) exit 1 ;;'
  printf '%s\n' 'esac'
} >"$DISK_PROBE_STUB"
chmod +x "$DISK_PROBE_STUB"

# The package wrapper creates one unique jarvis-release child below this runs
# parent. The standalone gate must inspect that parent filesystem without
# calling the mkdir/mktemp helper or otherwise creating staging.
DEFAULT_ARTIFACT_ROOT="$TMP_DIR/default-build-artifacts"
EXPECTED_DEFAULT_OUTPUT="$ROOT_DIR/dist" \
EXPECTED_DEFAULT_STAGING="$DEFAULT_ARTIFACT_ROOT/runs" \
OPENCLAW_BUILD_ARTIFACT_ROOT="$DEFAULT_ARTIFACT_ROOT" \
JARVIS_RELEASE_DISK_PROBE_COMMAND="$DISK_PROBE_STUB" \
  "$PREFLIGHT_SCRIPT" --required-kib 2048 >"$OUT" 2>&1
assert_output_has "target[1].label=release-output" "standalone default labels release output"
assert_output_has "target[1].path=$ROOT_DIR/dist" "standalone default selects repo dist output"
assert_output_has "target[2].label=release-staging" "standalone default labels release staging"
assert_output_has "target[2].path=$DEFAULT_ARTIFACT_ROOT/runs" "standalone default selects build runs parent"
[[ ! -e "$DEFAULT_ARTIFACT_ROOT" ]] || fail "read-only standalone preflight unexpectedly created staging"
pass "standalone default does not create release staging"

# Alternate wrapper paths are caller-owned. Prove the public flags forward both
# exact strings instead of replacing them with the standalone defaults.
EXPLICIT_OUTPUT="$TMP_DIR/shared-output"
EXPLICIT_STAGING="$TMP_DIR/shared-staging"
JARVIS_RELEASE_DISK_PROBE_COMMAND="$DISK_PROBE_STUB" \
  "$PREFLIGHT_SCRIPT" \
    --output-path "$EXPLICIT_OUTPUT" \
    --staging-path "$EXPLICIT_STAGING" \
    --required-kib 2048 >"$OUT" 2>&1
assert_output_has "target[1].path=$EXPLICIT_OUTPUT" "explicit release output path passes unchanged"
assert_output_has "target[2].path=$EXPLICIT_STAGING" "explicit release staging path passes unchanged"

JARVIS_RELEASE_DISK_PROBE_COMMAND="$DISK_PROBE_STUB" \
  /bin/bash "$ROOT_DIR/scripts/preflight-jarvis-release-disk.sh" \
    --target release-output "$TMP_DIR/shared-output" \
    --target release-staging "$TMP_DIR/shared-staging" \
    --target secondary-output "$TMP_DIR/other-output" \
    --required-kib 2048 >"$OUT" 2>&1
assert_output_has "target[2].deduplicated=true" "multi-target gate deduplicates shared filesystem"
assert_output_has "filesystem[1].labels=release-output,release-staging" "deduplicated filesystem retains both labels"
assert_output_has "targets_checked=3" "multi-target gate reports every selected target"
assert_output_has "filesystems_checked=2" "multi-target gate checks each unique filesystem once"
assert_output_has "status=pass" "multi-target gate passes when every filesystem has capacity"

set +e
JARVIS_RELEASE_DISK_PROBE_COMMAND="$DISK_PROBE_STUB" \
  /bin/bash "$ROOT_DIR/scripts/preflight-jarvis-release-disk.sh" \
    --target release-output "$TMP_DIR/other-output" \
    --target release-staging "$TMP_DIR/low-staging" \
    --required-kib 2048 >"$OUT" 2>&1
MULTI_LOW_STATUS=$?
set -e
[[ "$MULTI_LOW_STATUS" -eq 1 ]] || fail "multi-target low-space preflight expected status 1, got $MULTI_LOW_STATUS"
assert_output_has "filesystem[2].shortfall_kib=1024" "low staging filesystem reports exact shortfall"
assert_output_has "filesystem[2].status=fail" "low staging filesystem fails independently"
assert_output_has "filesystems_checked=2" "low-space gate still reports both filesystems"
assert_output_has "status=fail" "low space on any filesystem fails the gate"

set +e
JARVIS_RELEASE_DISK_PROBE_COMMAND="$DISK_PROBE_STUB" \
  /bin/bash "$ROOT_DIR/scripts/preflight-jarvis-release-disk.sh" \
    --target unresolved "$TMP_DIR/not-in-probe" \
    --required-kib 2048 >"$OUT" 2>&1
UNRESOLVED_STATUS=$?
set -e
[[ "$UNRESOLVED_STATUS" -eq 2 ]] || fail "unresolved target preflight expected status 2, got $UNRESOLVED_STATUS"
assert_output_has "reason=filesystem-resolution-failed" "unresolved target fails conservatively"
assert_output_has "status=fail" "unresolved target produces failed final status"

/bin/bash -n \
  "$ROOT_DIR/scripts/lib/build-artifacts.sh" \
  "$ROOT_DIR/scripts/lib/jarvis-release-disk-preflight.sh" \
  "$ROOT_DIR/scripts/cleanup-build-artifacts.sh" \
  "$ROOT_DIR/scripts/preflight-jarvis-release-disk.sh" \
  "$ROOT_DIR/scripts/package-jarvis-consumer-rc.sh" \
  "$ROOT_DIR/scripts/package-mac-app.sh" \
  "$ROOT_DIR/scripts/test-release-disk-hygiene.sh"
pass "Bash syntax proof"
