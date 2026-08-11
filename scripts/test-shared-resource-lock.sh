#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WRAPPER="$ROOT_DIR/scripts/with-shared-resource-lock.pl"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-shared-resource-lock-test.XXXXXX")"
RESOURCE_PREFIX="lock-test-$$-${RANDOM:-0}"
BACKGROUND_PIDS=()

cleanup() {
  local pid
  for pid in "${BACKGROUND_PIDS[@]:-}"; do
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

wait_for_file() {
  local path="$1"
  local attempts=0
  while [ ! -e "$path" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -le 200 ] || fail "timed out waiting for $path"
    sleep 0.01
  done
}

start_holder() {
  local resource="$1"
  local ready_path="$2"

  "$WRAPPER" --resource "$resource" --label test-holder -- \
    /usr/bin/perl -e '$SIG{TERM} = sub { exit 0 }; open my $fh, q{>}, $ARGV[0] or die $!; close $fh; sleep 30' \
    "$ready_path" &
  HOLDER_PID=$!
  BACKGROUND_PIDS+=("$HOLDER_PID")
  wait_for_file "$ready_path"
}

remove_background_pid() {
  local removed="$1"
  local kept=()
  local pid
  for pid in "${BACKGROUND_PIDS[@]:-}"; do
    [ "$pid" = "$removed" ] || kept+=("$pid")
  done
  BACKGROUND_PIDS=("${kept[@]:-}")
}

# Check mode succeeds when no process owns the named resource.
check_resource="$RESOURCE_PREFIX-check"
check_output="$($WRAPPER --resource "$check_resource" --label check-test --check)"
[[ "$check_output" == *"SHARED_RESOURCE_LOCK_AVAILABLE resource=$check_resource"* ]] ||
  fail "check mode did not report availability"

# A second process must be refused while an identical resource is held.
same_resource="$RESOURCE_PREFIX-same"
start_holder "$same_resource" "$TEST_DIR/same.ready"
same_holder_pid="$HOLDER_PID"
set +e
same_output="$($WRAPPER --resource "$same_resource" --label contender --check 2>&1)"
same_status=$?
set -e
[ "$same_status" -eq 75 ] || fail "same-resource contention returned $same_status instead of 75"
[[ "$same_output" == *"SHARED_RESOURCE_LOCK_REFUSED resource=$same_resource"* ]] ||
  fail "same-resource contention lacked a clear refusal"

# A held resource must not serialize an independently named resource.
different_resource="$RESOURCE_PREFIX-different"
different_output="$($WRAPPER --resource "$different_resource" --label parallel-test -- \
  /usr/bin/printf '%s' different-resource-ran)"
[ "$different_output" = "different-resource-ran" ] || fail "different resource did not run concurrently"

# A transaction may atomically hold two resources in sorted order. Either
# constituent resource must then refuse an overlapping contender.
multi_primary="$RESOURCE_PREFIX-multi-a"
multi_secondary="$RESOURCE_PREFIX-multi-b"
$WRAPPER --resource "$multi_primary" --also-resource "$multi_secondary" --label multi-holder -- \
  /usr/bin/perl -e 'open my $fh, q{>}, $ARGV[0] or die $!; close $fh; sleep 30' \
  "$TEST_DIR/multi.ready" &
multi_holder_pid=$!
BACKGROUND_PIDS+=("$multi_holder_pid")
wait_for_file "$TEST_DIR/multi.ready"
set +e
$WRAPPER --resource "$multi_secondary" --label multi-contender --check >/dev/null 2>&1
multi_status=$?
set -e
[ "$multi_status" -eq 75 ] || fail "second resource in a multi-lock transaction was not held"
kill -KILL "$multi_holder_pid"
wait "$multi_holder_pid" 2>/dev/null || true
remove_background_pid "$multi_holder_pid"
$WRAPPER --resource "$multi_primary" --label after-multi-kill --check >/dev/null ||
  fail "primary multi-lock resource remained held after SIGKILL"
$WRAPPER --resource "$multi_secondary" --label after-multi-kill --check >/dev/null ||
  fail "secondary multi-lock resource remained held after SIGKILL"

# Bounded waiting admits exactly once after the current kernel lease ends.
wait_resource="$RESOURCE_PREFIX-wait"
"$WRAPPER" --resource "$wait_resource" --label short-holder -- \
  /usr/bin/perl -MTime::HiRes=sleep -e \
  'open my $fh, q{>}, $ARGV[0] or die $!; close $fh; sleep 0.2' \
  "$TEST_DIR/wait.ready" &
wait_holder_pid=$!
BACKGROUND_PIDS+=("$wait_holder_pid")
wait_for_file "$TEST_DIR/wait.ready"
wait_output="$($WRAPPER --resource "$wait_resource" --label bounded-wait --wait-seconds 2 -- \
  /usr/bin/printf '%s' admitted-after-wait)"
[ "$wait_output" = "admitted-after-wait" ] || fail "bounded wait did not run after release"
wait "$wait_holder_pid"
remove_background_pid "$wait_holder_pid"

# Normal process exit releases the kernel lock without an explicit cleanup path.
kill -TERM "$same_holder_pid"
wait "$same_holder_pid"
remove_background_pid "$same_holder_pid"
$WRAPPER --resource "$same_resource" --label after-normal-exit --check >/dev/null ||
  fail "resource remained locked after normal exit"

# SIGKILL cannot run user cleanup; the kernel must still release the lease.
kill_resource="$RESOURCE_PREFIX-kill"
start_holder "$kill_resource" "$TEST_DIR/kill.ready"
kill_holder_pid="$HOLDER_PID"
kill -KILL "$kill_holder_pid"
set +e
wait "$kill_holder_pid" 2>/dev/null
kill_status=$?
set -e
remove_background_pid "$kill_holder_pid"
[ "$kill_status" -eq 137 ] || fail "SIGKILL holder returned unexpected status $kill_status"
$WRAPPER --resource "$kill_resource" --label after-sigkill --check >/dev/null ||
  fail "resource remained locked after SIGKILL"

# exec preserves the guarded command's exact exit status.
set +e
$WRAPPER --resource "$RESOURCE_PREFIX-status" --label exit-status -- /bin/sh -c 'exit 37'
child_status=$?
set -e
[ "$child_status" -eq 37 ] || fail "guarded command status became $child_status instead of 37"

# Nested ownership is a capability, not an environment assertion. The wrapper
# must reject stdout (or any other unrelated open descriptor) even when the
# caller supplies a plausible resource name and token-shaped value.
set +e
OPENCLAW_SHARED_RESOURCE_LOCK="$RESOURCE_PREFIX-spoof" \
OPENCLAW_SHARED_RESOURCE_LOCK_FD=1 \
OPENCLAW_SHARED_RESOURCE_LOCK_CAPABILITY="$(printf 'a%.0s' {1..64})" \
  bash -c 'source "$1/scripts/lib/shared-resource-lock.sh"; openclaw_shared_resource_lock_is_held "$2"' \
  _ "$ROOT_DIR" "$RESOURCE_PREFIX-spoof"
spoof_status=$?
set -e
[ "$spoof_status" -ne 0 ] || fail "an unrelated descriptor was accepted as lock ownership"

# The exact descriptor and capability emitted by the wrapper must validate in
# the guarded process, proving legitimate nested entrypoints still compose.
verified_resource="$RESOURCE_PREFIX-verified"
verified_output="$($WRAPPER --resource "$verified_resource" --label inherited-proof -- \
  bash -c 'source "$1/scripts/lib/shared-resource-lock.sh"; openclaw_shared_resource_lock_is_held "$2" && printf verified' \
  _ "$ROOT_DIR" "$verified_resource")"
[ "$verified_output" = verified ] || fail "a legitimate inherited lock did not validate"

# Resource names are identifiers, never paths or loosely sanitized aliases.
set +e
invalid_output="$($WRAPPER --resource '../invalid' --label invalid-test --check 2>&1)"
invalid_status=$?
set -e
[ "$invalid_status" -eq 2 ] || fail "invalid resource returned $invalid_status instead of usage status 2"
[[ "$invalid_output" == Usage:* ]] || fail "invalid resource did not produce usage guidance"

set +e
$WRAPPER --resource "$RESOURCE_PREFIX-invalid-wait" --wait-seconds 86401 -- /usr/bin/true \
  >"$TEST_DIR/invalid-wait.out" 2>&1
invalid_wait_status=$?
set -e
[ "$invalid_wait_status" -eq 2 ] || fail "unbounded wait value was accepted"

printf 'PASS: shared resource lock tests\n'
