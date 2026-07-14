#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/jarvis-release-lock.sh"

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

test_stale_recovery() {
  local lock_path="$TMP_DIR/stale.lock"
  mkdir "$lock_path"
  {
    printf 'pid=99999999\n'
    printf 'token=dead-owner\n'
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

test_repository_paths_are_isolated() {
  local repo_one="$TMP_DIR/repo-one"
  local repo_two="$TMP_DIR/repo-two"
  local path_one path_two

  git init -q "$repo_one"
  git init -q "$repo_two"
  path_one="$(openclaw_jarvis_release_lock_default_path "$repo_one")"
  path_two="$(openclaw_jarvis_release_lock_default_path "$repo_two")"
  [[ "$path_one" != "$path_two" ]] || fail "unrelated repositories share a lock path"
  [[ "$path_one" != "$repo_one"/* ]] || fail "lock path lives inside its repository"
  [[ "$path_two" != "$repo_two"/* ]] || fail "lock path lives inside its repository"
  pass "lock paths stay external and isolate repositories"
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

test_delegated_package_path_has_one_owner() {
  local package_script wrapper_script
  package_script="$(<"$ROOT_DIR/scripts/package-openclaw-mac-dist.sh")"
  wrapper_script="$(<"$ROOT_DIR/scripts/jarvis-public-release.sh")"

  [[ "$package_script" == *'openclaw_jarvis_release_lock_acquire "$ROOT_DIR" "package-phase:$PACKAGE_PHASE"'* ]] || fail "package path does not acquire the lock"
  [[ "$wrapper_script" != *"openclaw_jarvis_release_lock_acquire"* ]] || fail "public wrapper double-locks delegated package work"
  [[ "$wrapper_script" == *'CMD=(bash "$PACKAGE_SCRIPT" --phase "$SELECTED_PHASE")'* ]] || fail "public wrapper no longer delegates through package"
  pass "public-release to package path has one owner"
}

test_acquire_and_cleanup
test_live_contention
test_stale_recovery
test_unknown_owner_fails_safe
test_owner_safe_cleanup
test_error_and_signal_cleanup
test_repository_paths_are_isolated
test_package_integration_contention
test_delegated_package_path_has_one_owner
