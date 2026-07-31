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
    --job-b-root <absolute-clean-worktree> \
    --receipt-dir <new-absolute-directory>

Runs only the repository's named measured Vitest pair. Arbitrary commands,
test paths, worker counts, runtime work, and ambient profile selection are not
supported.
EOF
  exit 2
}

LABEL=""
JOB_A_ROOT=""
JOB_B_ROOT=""
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
    --job-b-root)
      [[ "$#" -ge 2 ]] || usage
      JOB_B_ROOT="$2"
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

[[ -n "$LABEL" && -n "$JOB_A_ROOT" && -n "$JOB_B_ROOT" && -n "$RECEIPT_DIR" ]] || usage
[[ "$JOB_A_ROOT" == /* && "$JOB_B_ROOT" == /* && "$RECEIPT_DIR" == /* ]] || usage
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

# The public entrypoint validates all caller-controlled input before admission,
# then re-executes beneath the canonical wrapper. On the guarded pass, the live
# lease token and real ancestor chain must both match; a forged environment is
# therefore useless and there is no ambient capacity/profile selector.
openclaw_heavy_local_slot_require_or_reexec \
  "focused-vitest-pair:${LABEL}" \
  "$ROOT_DIR" \
  "$ROOT_DIR/scripts/run-focused-vitest-pair.sh" \
  "${ORIGINAL_ARGS[@]}"

validate_job_root() {
  local job_name="$1"
  local job_root="$2"
  shift 2
  local test_path=""

  [[ -z "$(git -C "$job_root" status --porcelain)" ]] || {
    echo "Refusing focused pair: $job_name worktree is dirty: $job_root" >&2
    return 2
  }
  [[ -x "$job_root/node_modules/.bin/vitest" ]] || {
    echo "Refusing focused pair: $job_name lacks its pinned Vitest executable." >&2
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
validate_job_root "job A" "$JOB_A_ROOT" "${JOB_A_TESTS[@]}"
validate_job_root "job B" "$JOB_B_ROOT" "${JOB_B_TESTS[@]}"
JOB_A_HEAD="$(git -C "$JOB_A_ROOT" rev-parse HEAD)"
JOB_B_HEAD="$(git -C "$JOB_B_ROOT" rev-parse HEAD)"

umask 077
mkdir -p "$RECEIPT_DIR"
JOB_A_LOG="$RECEIPT_DIR/job-a.log"
JOB_B_LOG="$RECEIPT_DIR/job-b.log"
RECEIPT="$RECEIPT_DIR/receipt.env"
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
