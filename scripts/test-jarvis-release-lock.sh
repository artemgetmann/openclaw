#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/jarvis-release-lock.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-intent.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

wait_for_file() {
  local path="$1"
  local attempt=0
  while [[ ! -f "$path" && "$attempt" -lt 100 ]]; do
    sleep 0.05
    attempt=$((attempt + 1))
  done
  [[ -f "$path" ]] || fail "timed out waiting for $path"
}

wait_for_absence() {
  local path="$1"
  local attempt=0
  while [[ -e "$path" && "$attempt" -lt 100 ]]; do
    sleep 0.05
    attempt=$((attempt + 1))
  done
  [[ ! -e "$path" ]] || fail "timed out waiting for removal of $path"
}

run_holder() {
  local lock_path="$1"
  local ready_path="$2"
  local release_path="$3"

  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" bash -c '
    set -euo pipefail
    source "$1/scripts/lib/jarvis-release-lock.sh"
    openclaw_jarvis_release_lock_acquire "$1" "test-holder"
    : >"$2"
    while [[ ! -f "$3" ]]; do sleep 0.05; done
  ' _ "$ROOT_DIR" "$ready_path" "$release_path"
}

prepare_clean_release_fixture() {
  local release_home="$1"
  local release_name="$2"
  local release_root="$release_home/.worktrees/$release_name"

  # Release intents bind to a clean tracked snapshot. The implementation
  # checkout is intentionally dirty while this regression runs, so mirror its
  # tracked diff into a disposable local clone and checkpoint that exact source
  # before exercising the real wrapper/package delegation path.
  git clone -q --shared "$ROOT_DIR" "$release_home"
  mkdir -p "$release_home/.worktrees"
  git -C "$release_home" worktree add -q "$release_root" -b "codex/$release_name"
  git -C "$ROOT_DIR" diff --binary HEAD -- . | git -C "$release_root" apply --whitespace=nowarn -

  # Before the implementation commit exists, new guard files are untracked and
  # therefore absent from git diff. Copy the complete guard runtime; after
  # commit these are idempotent overwrites of the already-cloned files.
  cp "$ROOT_DIR/scripts/lib/heavy-local-slot.sh" "$release_root/scripts/lib/heavy-local-slot.sh"
  cp \
    "$ROOT_DIR/scripts/lib/heavy-local-slot-runner.pl" \
    "$release_root/scripts/lib/heavy-local-slot-runner.pl"
  git -C "$release_root" add -A
  if ! git -C "$release_root" diff --cached --quiet; then
    git -C "$release_root" \
      -c user.name="Jarvis Release Lock Test" \
      -c user.email="jarvis-release-lock-test@example.invalid" \
      commit -qm "test: checkpoint clean release fixture"
  fi

  printf '%s\n' "$release_root"
}

test_acquire_and_cleanup() {
  local lock_path="$TMP_DIR/acquire.lock"
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" \
    bash -c 'source "$1/scripts/lib/jarvis-release-lock.sh"; openclaw_jarvis_release_lock_acquire "$1" "acquire-test"' _ "$ROOT_DIR"
  [[ ! -e "$lock_path" ]] || fail "normal exit left the lock behind"
  pass "acquire and cleanup"
}

test_live_contention() {
  local lock_path="$TMP_DIR/contention.lock"
  local ready_path="$TMP_DIR/contention.ready"
  local release_path="$TMP_DIR/contention.release"
  local err_path="$TMP_DIR/contention.err"
  local holder_pid status

  run_holder "$lock_path" "$ready_path" "$release_path" &
  holder_pid=$!
  wait_for_file "$ready_path"
  set +e
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" \
    bash -c 'source "$1/scripts/lib/jarvis-release-lock.sh"; openclaw_jarvis_release_lock_acquire "$1" "contender"' _ "$ROOT_DIR" \
      >/dev/null 2>"$err_path"
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || fail "live contender acquired the lock"
  kill -0 "$holder_pid" 2>/dev/null || fail "contention harmed the live owner"
  grep -q "owner_pid=" "$err_path" || fail "contention omitted owner PID"
  grep -q "explicit chat/session handoff" "$err_path" || fail "contention omitted safe operator action"
  : >"$release_path"
  wait "$holder_pid"
  pass "live contention fails without harming owner"
}

test_locale_and_timezone_do_not_change_owner_identity() {
  local lock_path="$TMP_DIR/locale-contention.lock"
  local ready_path="$TMP_DIR/locale-contention.ready"
  local release_path="$TMP_DIR/locale-contention.release"
  local err_path="$TMP_DIR/locale-contention.err"
  local holder_pid status

  LC_ALL=fr_FR.UTF-8 TZ=Pacific/Honolulu \
    run_holder "$lock_path" "$ready_path" "$release_path" &
  holder_pid=$!
  wait_for_file "$ready_path"

  set +e
  LC_ALL=C TZ=UTC OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" \
    bash -c 'source "$1/scripts/lib/jarvis-release-lock.sh"; openclaw_jarvis_release_lock_acquire "$1" "cross-locale-contender"' _ "$ROOT_DIR" \
      >/dev/null 2>"$err_path"
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || fail "cross-locale contender reclaimed a live owner"
  grep -q "another Jarvis release owner is active" "$err_path" || fail "cross-locale contention did not identify the live owner"
  kill -0 "$holder_pid" 2>/dev/null || fail "cross-locale contention harmed the owner"
  : >"$release_path"
  wait "$holder_pid"
  pass "process identity is stable across locale and timezone"
}

test_stale_recovery() {
  local lock_path="$TMP_DIR/stale.lock"
  mkdir "$lock_path"
  {
    printf 'pid=99999999\n'
    printf 'token=dead-owner\n'
    printf 'process_start=Mon Jan 1 00:00:00 2001\n'
    printf 'context=abandoned-release\n'
  } >"$lock_path/owner"

  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" \
    bash -c 'source "$1/scripts/lib/jarvis-release-lock.sh"; openclaw_jarvis_release_lock_acquire "$1" "recovery-test"' _ "$ROOT_DIR"
  [[ ! -e "$lock_path" ]] || fail "recovered lock was not cleaned on exit"
  pass "dead owner is reclaimed"
}

test_unknown_owner_fails_safe() {
  local lock_path="$TMP_DIR/unknown-owner.lock"
  local err_path="$TMP_DIR/unknown-owner.err"
  local status
  mkdir "$lock_path"

  set +e
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" \
    bash -c 'source "$1/scripts/lib/jarvis-release-lock.sh"; openclaw_jarvis_release_lock_acquire "$1" "unknown-owner-test"' _ "$ROOT_DIR" \
      >/dev/null 2>"$err_path"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "lock without metadata was reclaimed"
  [[ -d "$lock_path" ]] || fail "unknown owner lock was deleted"
  grep -q "no readable owner metadata" "$err_path" || fail "unknown owner failure was not actionable"
  rm -rf "$lock_path"
  pass "missing owner metadata fails safe"
}

test_owner_safe_cleanup() {
  local lock_path="$TMP_DIR/owner-safe.lock"

  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" bash -c '
    set -euo pipefail
    source "$1/scripts/lib/jarvis-release-lock.sh"
    openclaw_jarvis_release_lock_acquire "$1" "owner-safe-test"
    sed "s/^token=.*/token=replacement-owner/" "$2/owner" >"$2/owner.next"
    mv "$2/owner.next" "$2/owner"
    openclaw_jarvis_release_lock_release
  ' _ "$ROOT_DIR" "$lock_path"

  [[ -d "$lock_path" ]] || fail "caller deleted a replacement owner's lock"
  [[ "$(openclaw_jarvis_release_lock_value "$lock_path/owner" token)" == "replacement-owner" ]] || fail "replacement metadata changed"
  rm -rf "$lock_path"
  pass "cleanup removes only caller ownership"
}

test_error_and_signal_cleanup() {
  local error_lock="$TMP_DIR/error.lock"
  local signal_lock="$TMP_DIR/signal.lock"
  local ready_path="$TMP_DIR/signal.ready"
  local signal_pid status

  set +e
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$error_lock" \
    bash -c 'source "$1/scripts/lib/jarvis-release-lock.sh"; openclaw_jarvis_release_lock_acquire "$1" "error-test"; exit 23' _ "$ROOT_DIR" \
      >/dev/null
  status=$?
  set -e
  [[ "$status" -eq 23 ]] || fail "error path changed caller exit status"
  [[ ! -e "$error_lock" ]] || fail "error exit left a lock behind"

  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$signal_lock" bash -c '
    source "$1/scripts/lib/jarvis-release-lock.sh"
    openclaw_jarvis_release_lock_acquire "$1" "signal-test"
    : >"$2"
    while true; do sleep 1; done
  ' _ "$ROOT_DIR" "$ready_path" >/dev/null &
  signal_pid=$!
  wait_for_file "$ready_path"
  kill -TERM "$signal_pid"
  set +e
  wait "$signal_pid"
  status=$?
  set -e
  [[ "$status" -eq 143 ]] || fail "TERM path returned $status instead of 143"
  [[ ! -e "$signal_lock" ]] || fail "TERM left a lock behind"
  pass "errors and signals clean caller ownership"
}

test_interrupted_acquisition_cleans_ownerless_claim() {
  local lock_path="$TMP_DIR/interrupted-acquire.lock"
  local ready_path="$TMP_DIR/interrupted-acquire.ready"
  local child_pid status

  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" bash -c '
    source "$1/scripts/lib/jarvis-release-lock.sh"
    READY_PATH="$2"
    openclaw_jarvis_release_lock_after_mkdir() {
      : >"$READY_PATH"
      while true; do sleep 1; done
    }
    openclaw_jarvis_release_lock_acquire "$1" "interrupted-acquire-test"
  ' _ "$ROOT_DIR" "$ready_path" >/dev/null &
  child_pid=$!
  wait_for_file "$ready_path"
  [[ -d "$lock_path" && ! -f "$lock_path/owner" ]] || fail "fixture did not stop in ownerless mkdir window"
  kill -TERM "$child_pid"
  set +e
  wait "$child_pid"
  status=$?
  set -e
  [[ "$status" -eq 143 ]] || fail "interrupted acquisition returned $status instead of 143"
  [[ ! -e "$lock_path" ]] || fail "interrupted ownerless claim wedged the lock"
  pass "interrupted acquisition cleans its ownerless claim"
}

test_machine_wide_path_is_shared_across_clones() {
  local repo_one="$TMP_DIR/repo-one"
  local repo_two="$TMP_DIR/repo-two"
  local path_one path_one_other_tmp path_two

  git init -q "$repo_one"
  git init -q "$repo_two"
  path_one="$(openclaw_jarvis_release_lock_default_path "$repo_one")"
  path_one_other_tmp="$(TMPDIR="$TMP_DIR/alternate-tmp" openclaw_jarvis_release_lock_default_path "$repo_one")"
  path_two="$(openclaw_jarvis_release_lock_default_path "$repo_two")"
  [[ "$path_one" == "$path_one_other_tmp" ]] || fail "TMPDIR changed the repository lock path"
  [[ "$path_one" == "$path_two" ]] || fail "separate clones do not share the canonical release lock"
  [[ "$path_one" != "$repo_one"/* ]] || fail "lock path lives inside its repository"
  [[ "$path_two" != "$repo_two"/* ]] || fail "lock path lives inside its repository"
  [[ "$path_one" == /tmp/openclaw-jarvis-release-locks-*/canonical-jarvis-release.lock ]] \
    || fail "lock path does not use the stable machine-wide user path"
  pass "stable lock path is shared across clones and ignores TMPDIR"
}

test_cross_clone_live_contention() {
  local repo_one="$TMP_DIR/contention-repo-one"
  local repo_two="$TMP_DIR/contention-repo-two"
  local ready_path="$TMP_DIR/cross-clone.ready"
  local release_path="$TMP_DIR/cross-clone.release"
  local err_path="$TMP_DIR/cross-clone.err"
  local holder_pid status

  git init -q "$repo_one"
  git init -q "$repo_two"
  bash -c '
    set -euo pipefail
    source "$1/scripts/lib/jarvis-release-lock.sh"
    openclaw_jarvis_release_lock_acquire "$2" "cross-clone-holder"
    : >"$3"
    while [[ ! -f "$4" ]]; do sleep 0.05; done
  ' _ "$ROOT_DIR" "$repo_one" "$ready_path" "$release_path" >/dev/null &
  holder_pid=$!
  wait_for_file "$ready_path"

  set +e
  bash -c '
    source "$1/scripts/lib/jarvis-release-lock.sh"
    openclaw_jarvis_release_lock_acquire "$2" "cross-clone-contender"
  ' _ "$ROOT_DIR" "$repo_two" >/dev/null 2>"$err_path"
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || fail "second clone acquired the canonical release lock"
  grep -q "another Jarvis release owner is active" "$err_path" \
    || fail "cross-clone contention did not identify the live owner"
  kill -0 "$holder_pid" 2>/dev/null || fail "cross-clone contention harmed the owner"
  : >"$release_path"
  wait "$holder_pid"
  pass "separate clones fail fast behind one live release owner"
}

test_pid_start_identity_controls_recovery() {
  local reused_lock="$TMP_DIR/reused-pid.lock"
  local unknown_lock="$TMP_DIR/missing-start.lock"
  local err_path="$TMP_DIR/missing-start.err"
  local status

  mkdir "$reused_lock"
  {
    printf 'pid=%s\n' "$$"
    printf 'token=reused-pid-owner\n'
    printf 'process_start=Mon Jan 1 00:00:00 2001\n'
    printf 'context=reused-pid-fixture\n'
  } >"$reused_lock/owner"
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$reused_lock" \
    bash -c 'source "$1/scripts/lib/jarvis-release-lock.sh"; openclaw_jarvis_release_lock_acquire "$1" "reused-pid-test"' _ "$ROOT_DIR" \
      >/dev/null
  [[ ! -e "$reused_lock" ]] || fail "mismatched PID fingerprint blocked stale recovery"

  mkdir "$unknown_lock"
  {
    printf 'pid=%s\n' "$$"
    printf 'token=unknown-start-owner\n'
    printf 'context=missing-start-fixture\n'
  } >"$unknown_lock/owner"
  set +e
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$unknown_lock" \
    bash -c 'source "$1/scripts/lib/jarvis-release-lock.sh"; openclaw_jarvis_release_lock_acquire "$1" "missing-start-test"' _ "$ROOT_DIR" \
      >/dev/null 2>"$err_path"
  status=$?
  set -e
  [[ "$status" -ne 0 && -d "$unknown_lock" ]] || fail "missing process identity did not fail safely"
  grep -q "owner identity is missing or unreadable" "$err_path" || fail "missing identity error was not actionable"
  rm -rf "$unknown_lock"
  pass "PID reuse recovers by fingerprint and missing identity fails safe"
}

test_interrupted_transfer_preserves_parent() {
  local lock_path="$TMP_DIR/interrupted-transfer.lock"
  local ready_path="$TMP_DIR/interrupted-transfer.ready"
  local child_done_path="$TMP_DIR/interrupted-transfer.child-done"
  local child_pid_path="$TMP_DIR/interrupted-transfer.child-pid"
  local parent_release_path="$TMP_DIR/interrupted-transfer.parent-release"
  local contender_err="$TMP_DIR/interrupted-transfer.contender.err"
  local parent_pid child_pid status owner_pid

  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" bash -c '
    set -euo pipefail
    source "$1/scripts/lib/jarvis-release-lock.sh"
    openclaw_jarvis_release_lock_acquire "$1" "transfer-parent"
    bash -c '\''
      source "$1/scripts/lib/jarvis-release-lock.sh"
      READY_PATH="$2"
      PID_PATH="$3"
      openclaw_jarvis_release_lock_after_transfer_prepare() {
        printf "%s\n" "$$" >"$PID_PATH"
        : >"$READY_PATH"
        while true; do sleep 1; done
      }
      openclaw_jarvis_release_lock_acquire "$1" "transfer-child"
    '\'' _ "$1" "$2" "$3" >/dev/null &
    child=$!
    wait "$child" || true
    : >"$4"
    while [[ ! -f "$5" ]]; do sleep 0.05; done
  ' _ "$ROOT_DIR" "$ready_path" "$child_pid_path" "$child_done_path" "$parent_release_path" >/dev/null &
  parent_pid=$!
  wait_for_file "$ready_path"
  child_pid="$(<"$child_pid_path")"
  kill -TERM "$child_pid"
  wait_for_file "$child_done_path"
  owner_pid="$(openclaw_jarvis_release_lock_value "$lock_path/owner" pid)"
  [[ "$owner_pid" == "$parent_pid" ]] || fail "interrupted transfer changed durable ownership"
  if compgen -G "${lock_path}.transfer.*" >/dev/null; then
    fail "interrupted transfer left a sibling record"
  fi

  set +e
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" \
    bash -c 'source "$1/scripts/lib/jarvis-release-lock.sh"; openclaw_jarvis_release_lock_acquire "$1" "transfer-contender"' _ "$ROOT_DIR" \
      >/dev/null 2>"$contender_err"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "contender bypassed parent after interrupted transfer"
  kill -0 "$parent_pid" 2>/dev/null || fail "interrupted transfer harmed parent"
  : >"$parent_release_path"
  wait "$parent_pid"
  [[ ! -e "$lock_path" ]] || fail "parent cleanup failed after interrupted transfer"
  pass "interrupted transfer preserves parent ownership and cleans sibling"
}

test_child_survives_killed_parent_as_owner() {
  local lock_path="$TMP_DIR/killed-parent.lock"
  local ready_path="$TMP_DIR/killed-parent.ready"
  local child_pid_path="$TMP_DIR/killed-parent.child-pid"
  local child_release_path="$TMP_DIR/killed-parent.child-release"
  local contender_err="$TMP_DIR/killed-parent.contender.err"
  local parent_pid child_pid status

  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" bash -c '
    set -euo pipefail
    source "$1/scripts/lib/jarvis-release-lock.sh"
    openclaw_jarvis_release_lock_acquire "$1" "kill-parent-wrapper"
    bash -c '\''
      source "$1/scripts/lib/jarvis-release-lock.sh"
      openclaw_jarvis_release_lock_acquire "$1" "kill-parent-package"
      printf "%s\n" "$$" >"$2"
      : >"$3"
      while [[ ! -f "$4" ]]; do sleep 0.05; done
    '\'' _ "$1" "$2" "$3" "$4" >/dev/null &
    wait $!
  ' _ "$ROOT_DIR" "$child_pid_path" "$ready_path" "$child_release_path" >/dev/null &
  parent_pid=$!
  wait_for_file "$ready_path"
  child_pid="$(<"$child_pid_path")"
  kill -KILL "$parent_pid"
  set +e
  wait "$parent_pid"
  status=$?
  set -e
  [[ "$status" -eq 137 ]] || fail "killed parent returned $status instead of 137"

  set +e
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" \
    bash -c 'source "$1/scripts/lib/jarvis-release-lock.sh"; openclaw_jarvis_release_lock_acquire "$1" "post-parent-kill-contender"' _ "$ROOT_DIR" \
      >/dev/null 2>"$contender_err"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "contender reclaimed from live transferred child"
  kill -0 "$child_pid" 2>/dev/null || fail "contender harmed transferred child"
  grep -q "owner_pid=$child_pid" "$contender_err" || fail "contention did not report child as owner"

  : >"$child_release_path"
  wait_for_absence "$lock_path"
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" \
    bash -c 'source "$1/scripts/lib/jarvis-release-lock.sh"; openclaw_jarvis_release_lock_acquire "$1" "after-child-exit"' _ "$ROOT_DIR" \
      >/dev/null
  [[ ! -e "$lock_path" ]] || fail "lock was not reusable after child exit"
  pass "transferred child remains owner after parent SIGKILL"
}

test_package_integration_contention() {
  local lock_path="$TMP_DIR/package-integration.lock"
  local ready_path="$TMP_DIR/package-integration.ready"
  local release_path="$TMP_DIR/package-integration.release"
  local mutate_err="$TMP_DIR/package-integration-mutate.err"
  local verify_err="$TMP_DIR/package-integration-verify.err"
  local release_home release_name holder_pid status

  release_home="$(cd "$ROOT_DIR/../.." && pwd)"
  release_name="$(basename "$ROOT_DIR")"
  run_holder "$lock_path" "$ready_path" "$release_path" &
  holder_pid=$!
  wait_for_file "$ready_path"

  set +e
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" \
    bash "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" --phase create-local-release-assets-only \
      >/dev/null 2>"$mutate_err"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "mutating package phase bypassed contention"
  grep -q "another Jarvis release owner is active" "$mutate_err" || fail "mutating package phase did not fail at the lock"
  [[ "$(grep -c '^recovery_command=' "$mutate_err")" == "1" ]] \
    || fail "package lock contention did not print exactly one recovery command"
  kill -0 "$holder_pid" 2>/dev/null || fail "package contention harmed the owner"

  set +e
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" \
    bash "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" --phase verify-public-assets-only \
      >/dev/null 2>"$verify_err"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "verify package phase bypassed contention"
  grep -q "another Jarvis release owner is active" "$verify_err" || fail "verify package phase did not fail at the lock"

  : >"$release_path"
  wait "$holder_pid"
  pass "package locks mutating and manifest-writing verification phases"
}

test_parent_delegation_and_wrapper_contention() {
  local lock_path="$TMP_DIR/wrapper.lock"
  local ready_path="$TMP_DIR/wrapper.ready"
  local release_path="$TMP_DIR/wrapper.release"
  local delegated_out="$TMP_DIR/delegated.out"
  local contender_out="$TMP_DIR/wrapper-contender.out"
  local contender_err="$TMP_DIR/wrapper-contender.err"
  local contender_combined="$TMP_DIR/wrapper-contender.combined"
  local dry_run_out="$TMP_DIR/wrapper-dry-run.out"
  local delegated_wrapper_out="$TMP_DIR/wrapper-delegated.out"
  local delegated_wrapper_err="$TMP_DIR/wrapper-delegated.err"
  local release_home release_name release_root holder_pid status intent_id

  release_home="$TMP_DIR/wrapper-release-home"
  release_name="wrapper-release-fixture"
  release_root="$(prepare_clean_release_fixture "$release_home" "$release_name")"
  export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$TMP_DIR/wrapper.intent"
  intent_id="$(openclaw_jarvis_release_intent_authorize "$release_root" 3600)"
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" bash -c '
    set -euo pipefail
    source "$1/scripts/lib/jarvis-release-lock.sh"
    openclaw_jarvis_release_lock_acquire "$1" "public-release-orchestration"
    bash -c '\''
      source "$1/scripts/lib/jarvis-release-lock.sh"
      openclaw_jarvis_release_lock_acquire "$1" "package-phase:full"
      : >"$2"
      while [[ ! -f "$3" ]]; do sleep 0.05; done
    '\'' _ "$1" "$3" "$4" >"$2" &
    wait $!
  ' _ "$ROOT_DIR" "$delegated_out" "$ready_path" "$release_path" &
  holder_pid=$!
  wait_for_file "$ready_path"
  grep -q "jarvis_release_lock=transferred_to_child" "$delegated_out" || fail "direct package child did not take parent ownership"

  set +e
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" \
    bash "$release_root/scripts/jarvis-public-release.sh" --phase full \
      --release-intent "$intent_id" \
      >"$contender_out" 2>"$contender_err"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "second public wrapper bypassed the owner"
  grep -q "another Jarvis release owner is active" "$contender_err" || fail "second wrapper did not fail at the lock"
  ! grep -q "selected_phase=" "$contender_out" || fail "second wrapper selected a stale phase before locking"
  { /bin/cat "$contender_out"; /bin/cat "$contender_err"; } >"$contender_combined"
  [[ "$(grep -c '^recovery_command=' "$contender_combined")" == "1" ]] \
    || fail "wrapper lock contention did not print exactly one recovery command"
  grep -Fq "recovery_command=bash scripts/jarvis-public-release.sh --phase full --release-intent $intent_id " "$contender_combined" \
    || fail "wrapper lock contention did not print the replayable wrapper command"
  kill -0 "$holder_pid" 2>/dev/null || fail "wrapper contention harmed the live owner"

  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" \
    bash "$release_root/scripts/jarvis-public-release.sh" --dry-run --phase full >"$dry_run_out"
  grep -q "dry_run=true" "$dry_run_out" || fail "dry-run did not remain lock-free"

  : >"$release_path"
  wait "$holder_pid"

  set +e
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$lock_path" \
  OPENCLAW_JARVIS_PUBLIC_RELEASE_SUMMARY="$TMP_DIR/wrapper-delegated-summary.env" \
  OPENCLAW_JARVIS_RELEASE_TIMING_REPORT="$TMP_DIR/wrapper-delegated-timing.tsv" \
    bash "$release_root/scripts/jarvis-public-release.sh" \
      --phase create-local-release-assets-only \
      --release-intent "$intent_id" \
      --github-release-tag v-current \
      >"$delegated_wrapper_out" 2>"$delegated_wrapper_err"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "delegated wrapper fixture unexpectedly created release assets"
  grep -q "jarvis_release_lock=transferred_to_child" "$delegated_wrapper_out" || fail "actual package child did not take wrapper ownership"
  [[ ! -e "$lock_path" ]] || fail "wrapper failure left its parent-owned lock behind"
  pass "wrapper owns selection, delegates to child, and leaves dry-run unlocked"
}

test_release_entrypoint_wiring() {
  local package_script wrapper_script
  package_script="$(<"$ROOT_DIR/scripts/package-openclaw-mac-dist.sh")"
  wrapper_script="$(<"$ROOT_DIR/scripts/jarvis-public-release.sh")"

  [[ "$package_script" == *'openclaw_jarvis_release_lock_acquire "$ROOT_DIR" "package-phase:$PACKAGE_PHASE"'* ]] || fail "package path does not acquire the lock"
  [[ "$wrapper_script" == *'openclaw_jarvis_release_lock_acquire "$ROOT_DIR" "public-release-orchestration"'* ]] || fail "public wrapper does not own phase selection"
  [[ "$wrapper_script" == *'CMD=(bash "$PACKAGE_SCRIPT" --phase "$SELECTED_PHASE")'* ]] || fail "public wrapper no longer delegates through package"
  [[ "$wrapper_script" == *'CMD+=(--release-intent "$RELEASE_INTENT_ID")'* ]] || fail "public wrapper no longer transfers release intent to package"
  pass "release entrypoints use atomic parent-to-child ownership transfer"
}

test_acquire_and_cleanup
test_live_contention
test_locale_and_timezone_do_not_change_owner_identity
test_stale_recovery
test_unknown_owner_fails_safe
test_owner_safe_cleanup
test_error_and_signal_cleanup
test_interrupted_acquisition_cleans_ownerless_claim
test_machine_wide_path_is_shared_across_clones
test_cross_clone_live_contention
test_pid_start_identity_controls_recovery
test_interrupted_transfer_preserves_parent
test_child_survives_killed_parent_as_owner
test_package_integration_contention
test_parent_delegation_and_wrapper_contention
test_release_entrypoint_wiring
