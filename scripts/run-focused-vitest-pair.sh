#!/usr/bin/env bash

set -euo pipefail

# This entrypoint is intentionally a named, one-shot exception rather than a
# capacity knob. Its two test lists are the exact pair measured on this host;
# callers may choose only the two immutable worktree roots and receipt path.
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/heavy-local-slot.sh
source "$ROOT_DIR/scripts/lib/heavy-local-slot.sh"

readonly PROFILE="durable-monitor-authority-plus-channels-status"
readonly -a JOB_A_TESTS=(
  "extensions/codex/index.test.ts"
  "extensions/codex/src/thread-service.test.ts"
  "src/cron/active-runtime.test.ts"
  "src/monitor/authority.test.ts"
  "src/gateway/server-cron.test.ts"
)
readonly -a JOB_B_TESTS=(
  "src/commands/channels.status.command-flow.test.ts"
)
readonly -a VITEST_LIMITS=("--maxWorkers" "1" "--no-file-parallelism")

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/run-focused-vitest-pair.sh \
    --label <owner> \
    --job-a-root <absolute-clean-worktree> \
    --job-a-head <40-character-commit> \
    --job-b-root <absolute-clean-worktree> \
    --job-b-head <40-character-commit> \
    --receipt-dir <new-absolute-directory>

Runs only the repository's named measured Vitest pair. Arbitrary commands,
test paths, worker counts, runtime work, and ambient profile selection are not
supported.
EOF
  exit 2
}

LABEL=""
JOB_A_ROOT=""
EXPECTED_JOB_A_HEAD=""
JOB_B_ROOT=""
EXPECTED_JOB_B_HEAD=""
RECEIPT_DIR=""
ORIGINAL_ARGS=("$@")

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --label)
      [[ "$#" -ge 2 ]] || usage
      LABEL="$2"
      shift 2
      ;;
    --job-a-root)
      [[ "$#" -ge 2 ]] || usage
      JOB_A_ROOT="$2"
      shift 2
      ;;
    --job-a-head)
      [[ "$#" -ge 2 ]] || usage
      EXPECTED_JOB_A_HEAD="$2"
      shift 2
      ;;
    --job-b-root)
      [[ "$#" -ge 2 ]] || usage
      JOB_B_ROOT="$2"
      shift 2
      ;;
    --job-b-head)
      [[ "$#" -ge 2 ]] || usage
      EXPECTED_JOB_B_HEAD="$2"
      shift 2
      ;;
    --receipt-dir)
      [[ "$#" -ge 2 ]] || usage
      RECEIPT_DIR="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n "$LABEL" && -n "$JOB_A_ROOT" && -n "$EXPECTED_JOB_A_HEAD" &&
  -n "$JOB_B_ROOT" && -n "$EXPECTED_JOB_B_HEAD" && -n "$RECEIPT_DIR" ]] || usage
[[ "$JOB_A_ROOT" == /* && "$JOB_B_ROOT" == /* && "$RECEIPT_DIR" == /* ]] || usage
[[ "$EXPECTED_JOB_A_HEAD" =~ ^[0-9a-f]{40}$ &&
  "$EXPECTED_JOB_B_HEAD" =~ ^[0-9a-f]{40}$ ]] || usage
[[ "$JOB_A_ROOT" != *$'\n'* && "$JOB_A_ROOT" != *$'\r'* &&
  "$JOB_B_ROOT" != *$'\n'* && "$JOB_B_ROOT" != *$'\r'* &&
  "$RECEIPT_DIR" != *$'\n'* && "$RECEIPT_DIR" != *$'\r'* ]] || usage
[[ "$JOB_A_ROOT" != "$JOB_B_ROOT" ]] || {
  echo "Refusing focused pair: job roots must be distinct." >&2
  exit 2
}
[[ ! -e "$RECEIPT_DIR" ]] || {
  echo "Refusing focused pair: receipt directory already exists: $RECEIPT_DIR" >&2
  exit 2
}

canonical_worktree() {
  local candidate="$1"
  local resolved=""
  local top=""

  resolved="$(cd "$candidate" 2>/dev/null && pwd -P)" || return 1
  top="$(git -C "$resolved" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ "$resolved" == "$top" ]] || return 1
  printf '%s\n' "$resolved"
}

JOB_A_ROOT="$(canonical_worktree "$JOB_A_ROOT")" || {
  echo "Refusing focused pair: job A root is not a canonical Git worktree root." >&2
  exit 2
}
JOB_B_ROOT="$(canonical_worktree "$JOB_B_ROOT")" || {
  echo "Refusing focused pair: job B root is not a canonical Git worktree root." >&2
  exit 2
}
[[ "$JOB_A_ROOT" != "$JOB_B_ROOT" ]] || {
  echo "Refusing focused pair: canonical job roots must be distinct." >&2
  exit 2
}

guarded_pair_root_is_valid() {
  local expected_label=""
  local lock_path=""
  local owner_label=""
  local guarded_root_pid=""

  expected_label="$(openclaw_heavy_local_slot_safe_text "focused-vitest-pair:${LABEL}")"

  openclaw_heavy_local_slot_inherited_lease_is_valid "standard" || return 1
  lock_path="$(openclaw_heavy_local_slot_resolve_path)" || return 2
  owner_label="$(openclaw_heavy_local_slot_value "$lock_path/owner" label)"
  guarded_root_pid="$(openclaw_heavy_local_slot_value "$lock_path/child_pid" pid)"

  # A generic inherited lease proves ancestry, but not exclusivity. Require
  # this script to be the wrapper's committed workload root so an unrelated
  # guarded shell cannot add the pair beside already-running sibling work.
  [[ "$owner_label" == "$expected_label" && "$guarded_root_pid" == "$$" ]] || return 2
  return 0
}

write_shared_wrapper_receipt() {
  local wrapper_exit="$1"
  local cleanup_status="$2"
  local receipt_status="failed"
  local health_status="not_proven"
  local workload_status="missing"
  local shared_receipt="$RECEIPT_DIR/shared-health-cleanup.env"
  local shared_tmp="$shared_receipt.tmp.$$"

  [[ -d "$RECEIPT_DIR" ]] || return 0
  if [[ -f "$RECEIPT_DIR/receipt.env" ]]; then
    workload_status="$(awk -F= '$1 == "status" { print $2; exit }' "$RECEIPT_DIR/receipt.env")"
  fi
  if [[ "$wrapper_exit" -eq 0 ]]; then
    health_status="passed"
  fi
  if [[ "$wrapper_exit" -eq 0 && "$cleanup_status" == "owner_token_released" &&
    "$workload_status" == "passed" ]]; then
    receipt_status="passed"
  elif [[ "$workload_status" == "interrupted" || "$wrapper_exit" =~ ^(129|130|143)$ ]]; then
    receipt_status="interrupted"
  fi

  {
    printf 'version=1\n'
    printf 'profile=%s\n' "$PROFILE"
    printf 'status=%s\n' "$receipt_status"
    printf 'canonical_wrapper_exit=%s\n' "$wrapper_exit"
    printf 'workload_status=%s\n' "$workload_status"
    printf 'shared_health=%s\n' "$health_status"
    printf 'shared_cleanup=%s\n' "$cleanup_status"
    printf 'generic_machine_capacity=1_unchanged\n'
  } >"$shared_tmp"
  mv "$shared_tmp" "$shared_receipt"
}

run_canonical_wrapper_and_finalize() {
  local lock_path=""
  local wrapper_pid=""
  local wrapper_exit=75
  local wrapper_owner_token=""
  local current_owner_token=""
  local cleanup_status="owner_identity_not_observed"
  local signal_exit=0
  local attempt=0

  lock_path="$(openclaw_heavy_local_slot_resolve_path)" || return 75

  # The public launcher stays outside the heavy process group so it can persist
  # the wrapper's terminal health/cleanup outcome only after wrapper EXIT traps
  # have finished. The wrapper remains the sole canonical heavy owner.
  "$ROOT_DIR/scripts/with-heavy-local-slot.sh" \
    --label "focused-vitest-pair:${LABEL}" \
    -- \
    "$ROOT_DIR/scripts/run-focused-vitest-pair.sh" "${ORIGINAL_ARGS[@]}" &
  wrapper_pid="$!"

  forward_wrapper_signal() {
    local signal_name="$1"
    local requested_exit="$2"
    signal_exit="$requested_exit"
    kill -"$signal_name" "$wrapper_pid" 2>/dev/null || true
  }
  trap 'forward_wrapper_signal TERM 143' TERM
  trap 'forward_wrapper_signal INT 130' INT
  trap 'forward_wrapper_signal HUP 129' HUP

  # Observe this exact wrapper's opaque owner token while it is live. The token
  # is never persisted; after wait it distinguishes retained ownership from a
  # later legitimate owner that may acquire the shared path immediately.
  while kill -0 "$wrapper_pid" 2>/dev/null && [[ "$attempt" -lt 200 ]]; do
    if [[ "$(openclaw_heavy_local_slot_value "$lock_path/owner" pid)" == "$wrapper_pid" ]]; then
      wrapper_owner_token="$(openclaw_heavy_local_slot_value "$lock_path/owner" token)"
      [[ -n "$wrapper_owner_token" ]] && break
    fi
    sleep 0.01
    attempt=$((attempt + 1))
  done

  set +e
  wait "$wrapper_pid"
  wrapper_exit="$?"
  if [[ "$signal_exit" -ne 0 ]] && kill -0 "$wrapper_pid" 2>/dev/null; then
    wait "$wrapper_pid"
    wrapper_exit="$?"
  fi
  set -e
  trap - TERM INT HUP

  current_owner_token="$(openclaw_heavy_local_slot_value "$lock_path/owner" token)"
  if [[ -n "$wrapper_owner_token" && "$current_owner_token" != "$wrapper_owner_token" ]]; then
    cleanup_status="owner_token_released"
  elif [[ -n "$wrapper_owner_token" ]]; then
    cleanup_status="owner_token_retained"
  fi

  [[ "$signal_exit" -eq 0 ]] || wrapper_exit="$signal_exit"
  write_shared_wrapper_receipt "$wrapper_exit" "$cleanup_status"
  if [[ "$wrapper_exit" -eq 0 && "$cleanup_status" != "owner_token_released" ]]; then
    return 75
  fi
  return "$wrapper_exit"
}

if guarded_pair_root_is_valid; then
  :
else
  guarded_status="$?"
  if [[ "$guarded_status" -eq 2 ]]; then
    printf 'HEAVY_LOCAL_SLOT_REFUSAL class=guard_internal code=focused_pair_not_guarded_root\n' >&2
    echo "Refusing focused pair: entrypoint is nested beneath another guarded workload." >&2
    exit 75
  fi
  run_canonical_wrapper_and_finalize
  exit "$?"
fi

validate_job_root() {
  local job_name="$1"
  local job_root="$2"
  local expected_head="$3"
  shift 3
  local test_path=""

  [[ -z "$(git -C "$job_root" status --porcelain)" ]] || {
    echo "Refusing focused pair: $job_name worktree is dirty: $job_root" >&2
    return 2
  }
  [[ -x "$job_root/node_modules/.bin/vitest" ]] || {
    echo "Refusing focused pair: $job_name lacks its pinned Vitest executable." >&2
    return 2
  }
  [[ "$(git -C "$job_root" rev-parse HEAD)" == "$expected_head" ]] || {
    echo "Refusing focused pair: $job_name moved from expected head $expected_head." >&2
    return 2
  }
  for test_path in "$@"; do
    [[ -f "$job_root/$test_path" ]] || {
      echo "Refusing focused pair: $job_name is missing allowlisted test $test_path" >&2
      return 2
    }
  done
}

# Recheck every immutable input only after canonical admission. A checkout that
# drifts while queued must fail before either child starts, never run a partly
# validated pair.
validate_job_root "job A" "$JOB_A_ROOT" "$EXPECTED_JOB_A_HEAD" "${JOB_A_TESTS[@]}"
validate_job_root "job B" "$JOB_B_ROOT" "$EXPECTED_JOB_B_HEAD" "${JOB_B_TESTS[@]}"
JOB_A_HEAD="$EXPECTED_JOB_A_HEAD"
JOB_B_HEAD="$EXPECTED_JOB_B_HEAD"

umask 077
mkdir "$RECEIPT_DIR" || {
  echo "Refusing focused pair: receipt directory was created before guarded execution: $RECEIPT_DIR" >&2
  exit 2
}
JOB_A_LOG="$RECEIPT_DIR/job-a.log"
JOB_B_LOG="$RECEIPT_DIR/job-b.log"
RECEIPT="$RECEIPT_DIR/receipt.env"
JOB_A_RECEIPT="$RECEIPT_DIR/job-a.receipt.env"
JOB_B_RECEIPT="$RECEIPT_DIR/job-b.receipt.env"
JOB_A_PID=""
JOB_B_PID=""
JOB_A_EXIT="not_started"
JOB_B_EXIT="not_started"
STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

write_receipt() {
  local status="$1"
  local reason="$2"
  local receipt_tmp="$RECEIPT.tmp.$$"

  # Use a fixed, argument-free schema so receipts are useful without exposing
  # arbitrary commands, environment values, tokens, or other process details.
  {
    printf 'version=1\n'
    printf 'profile=%s\n' "$PROFILE"
    printf 'status=%s\n' "$status"
    printf 'reason=%s\n' "$reason"
    printf 'canonical_guard=required_and_verified\n'
    printf 'generic_machine_capacity=1_unchanged\n'
    printf 'supervisor_pid=%s\n' "$$"
    printf 'started_at=%s\n' "$STARTED_AT"
    printf 'finished_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'job_a_root=%s\n' "$JOB_A_ROOT"
    printf 'job_a_head=%s\n' "$JOB_A_HEAD"
    printf 'job_a_pid=%s\n' "${JOB_A_PID:-none}"
    printf 'job_a_exit=%s\n' "$JOB_A_EXIT"
    printf 'job_a_test_count=%s\n' "${#JOB_A_TESTS[@]}"
    printf 'job_a_tests=%s\n' "$(IFS=,; printf '%s' "${JOB_A_TESTS[*]}")"
    printf 'job_b_root=%s\n' "$JOB_B_ROOT"
    printf 'job_b_head=%s\n' "$JOB_B_HEAD"
    printf 'job_b_pid=%s\n' "${JOB_B_PID:-none}"
    printf 'job_b_exit=%s\n' "$JOB_B_EXIT"
    printf 'job_b_test_count=%s\n' "${#JOB_B_TESTS[@]}"
    printf 'job_b_tests=%s\n' "$(IFS=,; printf '%s' "${JOB_B_TESTS[*]}")"
    printf 'max_workers_per_job=1\n'
    printf 'file_parallelism=false\n'
  } >"$receipt_tmp"
  mv "$receipt_tmp" "$RECEIPT"

  # Per-job receipts let reviewers inspect each allowlisted outcome without
  # parsing logs. The outer launcher separately records wrapper health and
  # whole-group cleanup after this guarded process has exited.
  {
    printf 'version=1\n'
    printf 'job=a\n'
    printf 'root=%s\n' "$JOB_A_ROOT"
    printf 'head=%s\n' "$JOB_A_HEAD"
    printf 'pid=%s\n' "${JOB_A_PID:-none}"
    printf 'exit=%s\n' "$JOB_A_EXIT"
    printf 'test_count=%s\n' "${#JOB_A_TESTS[@]}"
    printf 'max_workers=1\n'
    printf 'file_parallelism=false\n'
  } >"$JOB_A_RECEIPT.tmp.$$"
  mv "$JOB_A_RECEIPT.tmp.$$" "$JOB_A_RECEIPT"
  {
    printf 'version=1\n'
    printf 'job=b\n'
    printf 'root=%s\n' "$JOB_B_ROOT"
    printf 'head=%s\n' "$JOB_B_HEAD"
    printf 'pid=%s\n' "${JOB_B_PID:-none}"
    printf 'exit=%s\n' "$JOB_B_EXIT"
    printf 'test_count=%s\n' "${#JOB_B_TESTS[@]}"
    printf 'max_workers=1\n'
    printf 'file_parallelism=false\n'
  } >"$JOB_B_RECEIPT.tmp.$$"
  mv "$JOB_B_RECEIPT.tmp.$$" "$JOB_B_RECEIPT"
}

stop_children() {
  local child_pid=""
  for child_pid in "$JOB_A_PID" "$JOB_B_PID"; do
    [[ "$child_pid" =~ ^[1-9][0-9]*$ ]] || continue
    kill -TERM "$child_pid" 2>/dev/null || true
  done
  for child_pid in "$JOB_A_PID" "$JOB_B_PID"; do
    [[ "$child_pid" =~ ^[1-9][0-9]*$ ]] || continue
    wait "$child_pid" 2>/dev/null || true
  done
}

handle_signal() {
  local signal_name="$1"
  local signal_exit="$2"
  trap - TERM INT HUP
  stop_children
  JOB_A_EXIT="interrupted"
  JOB_B_EXIT="interrupted"
  write_receipt "interrupted" "signal_${signal_name}"
  exit "$signal_exit"
}
trap 'handle_signal TERM 143' TERM
trap 'handle_signal INT 130' INT
trap 'handle_signal HUP 129' HUP

# `exec` makes these exact background PIDs the two workload roots. Both remain
# descendants of the one canonical supervisor/session, letting the outer guard
# apply its existing health monitor and TERM/KILL whole-group cleanup unchanged.
(
  cd "$JOB_A_ROOT"
  exec pnpm vitest run "${JOB_A_TESTS[@]}" "${VITEST_LIMITS[@]}"
) >"$JOB_A_LOG" 2>&1 &
JOB_A_PID="$!"
(
  cd "$JOB_B_ROOT"
  exec pnpm vitest run "${JOB_B_TESTS[@]}" "${VITEST_LIMITS[@]}"
) >"$JOB_B_LOG" 2>&1 &
JOB_B_PID="$!"

set +e
wait "$JOB_A_PID"
JOB_A_EXIT="$?"
wait "$JOB_B_PID"
JOB_B_EXIT="$?"
set -e

# A test command must not mutate or switch either source checkout. This second
# immutable-head/cleanliness proof closes the validation-to-exit window and
# keeps a passing receipt bound to the exact sources that were admitted.
if [[ "$(git -C "$JOB_A_ROOT" rev-parse HEAD)" != "$JOB_A_HEAD" ||
  -n "$(git -C "$JOB_A_ROOT" status --porcelain)" ||
  "$(git -C "$JOB_B_ROOT" rev-parse HEAD)" != "$JOB_B_HEAD" ||
  -n "$(git -C "$JOB_B_ROOT" status --porcelain)" ]]; then
  write_receipt "failed" "source_drift"
  exit 75
fi

# Propagate an allowlisted child failure without abandoning the sibling. Waiting
# for both keeps the receipt complete and leaves no child for the wrapper to
# discover after the supervisor returns.
if [[ "$JOB_A_EXIT" -ne 0 ]]; then
  write_receipt "failed" "job_a_nonzero"
  exit "$JOB_A_EXIT"
fi
if [[ "$JOB_B_EXIT" -ne 0 ]]; then
  write_receipt "failed" "job_b_nonzero"
  exit "$JOB_B_EXIT"
fi

write_receipt "passed" "both_jobs_zero"
printf 'FOCUSED_VITEST_PAIR status=passed profile=%s receipt=%s\n' "$PROFILE" "$RECEIPT"
