#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap '[[ "${PAIR_TEST_KEEP_TMP:-0}" == "1" ]] || rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  [[ "${PAIR_TEST_KEEP_TMP:-0}" != "1" ]] || echo "DEBUG_TMP: $TMP_DIR" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

assert_contains() {
  local file="$1"
  local expected="$2"
  rg -F -- "$expected" "$file" >/dev/null || fail "$file omitted: $expected"
}

make_job_root() {
  local root="$1"
  shift
  local test_path=""

  mkdir -p "$root/node_modules/.bin"
  printf 'node_modules/\n' >"$root/.gitignore"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$root/node_modules/.bin/vitest"
  chmod +x "$root/node_modules/.bin/vitest"
  for test_path in "$@"; do
    mkdir -p "$root/$(dirname "$test_path")"
    printf '// focused-pair fixture\n' >"$root/$test_path"
  done
  git -C "$root" init -q
  git -C "$root" add .
  git -C "$root" \
    -c user.name='Focused Pair Test' \
    -c user.email='focused-pair@example.invalid' \
    commit -qm 'test: create focused pair fixture'
}

FIXTURE="$TMP_DIR/repo"
SCRIPT_DIR="$FIXTURE/scripts"
mkdir -p "$SCRIPT_DIR/lib"
cp "$ROOT_DIR/scripts/run-focused-vitest-pair.sh" "$SCRIPT_DIR/run-focused-vitest-pair.sh"
chmod +x "$SCRIPT_DIR/run-focused-vitest-pair.sh"

# This fixture replaces only the already-tested canonical guard seam. Delegate
# mode proves the public entrypoint requests one wrapper transaction; admitted
# mode exercises the same production script after a simulated valid lease.
cat >"$SCRIPT_DIR/lib/heavy-local-slot.sh" <<'EOF'
openclaw_heavy_local_slot_require_or_reexec() {
  printf '%s\n' "$*" >>"$PAIR_TEST_GUARD_CALLS"
  if [[ "${PAIR_TEST_GUARD_MODE:-admitted}" == "delegate" ]]; then
    exit 42
  fi
  return 0
}
EOF

JOB_A_ROOT="$TMP_DIR/job-a"
JOB_B_ROOT="$TMP_DIR/job-b"
JOB_A_TESTS=(
  extensions/codex/index.test.ts
  extensions/codex/src/thread-service.test.ts
  src/cron/active-runtime.test.ts
  src/monitor/authority.test.ts
  src/gateway/server-cron.test.ts
)
JOB_B_TESTS=(src/commands/channels.status.command-flow.test.ts)
make_job_root "$JOB_A_ROOT" "${JOB_A_TESTS[@]}"
make_job_root "$JOB_B_ROOT" "${JOB_B_TESTS[@]}"

BIN_DIR="$TMP_DIR/bin"
mkdir -p "$BIN_DIR"
cat >"$BIN_DIR/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

job="b"
[[ "$PWD" == "$PAIR_TEST_JOB_A_ROOT" ]] && job="a"
printf '%s\t%s\t%s\t%s\n' "$$" "$PPID" "$PWD" "$*" >>"$PAIR_TEST_CALLS"
: >"$PAIR_TEST_STATE/$job.started"

if [[ "${PAIR_TEST_BLOCK:-0}" == "1" ]]; then
  trap ': >"$PAIR_TEST_STATE/'"$job"'.terminated"; exit 143' TERM INT HUP
  while :; do sleep 0.05; done
fi

# Keep both children live until their sibling has started. This proves the
# entrypoint launches a pair instead of serially invoking two focused tests.
for _attempt in $(seq 1 100); do
  [[ -f "$PAIR_TEST_STATE/a.started" && -f "$PAIR_TEST_STATE/b.started" ]] && break
  sleep 0.01
done
[[ -f "$PAIR_TEST_STATE/a.started" && -f "$PAIR_TEST_STATE/b.started" ]]

if [[ "$job" == "a" ]]; then
  exit "${PAIR_TEST_JOB_A_EXIT:-0}"
fi
exit "${PAIR_TEST_JOB_B_EXIT:-0}"
EOF
chmod +x "$BIN_DIR/pnpm"

run_pair() {
  local receipt_dir="$1"
  PAIR_TEST_GUARD_MODE=admitted \
    PAIR_TEST_GUARD_CALLS="$TMP_DIR/guard.calls" \
    PAIR_TEST_CALLS="$TMP_DIR/pnpm.calls" \
    PAIR_TEST_STATE="$TMP_DIR/state" \
    PAIR_TEST_JOB_A_ROOT="$(cd "$JOB_A_ROOT" && pwd -P)" \
    PATH="$BIN_DIR:$PATH" \
    "$SCRIPT_DIR/run-focused-vitest-pair.sh" \
      --label shell-test \
      --job-a-root "$JOB_A_ROOT" \
      --job-b-root "$JOB_B_ROOT" \
      --receipt-dir "$receipt_dir"
}

test_argument_validation_precedes_guard() {
  local err="$TMP_DIR/invalid.err"
  : >"$TMP_DIR/guard.calls"
  set +e
  PAIR_TEST_GUARD_MODE=delegate PAIR_TEST_GUARD_CALLS="$TMP_DIR/guard.calls" \
    "$SCRIPT_DIR/run-focused-vitest-pair.sh" --unknown > /dev/null 2>"$err"
  local status=$?
  set -e
  [[ "$status" -eq 2 ]] || fail "unknown argument returned $status"
  [[ ! -s "$TMP_DIR/guard.calls" ]] || fail "invalid input reached the guard seam"

  set +e
  PAIR_TEST_GUARD_MODE=delegate PAIR_TEST_GUARD_CALLS="$TMP_DIR/guard.calls" \
    "$SCRIPT_DIR/run-focused-vitest-pair.sh" \
      --label invalid \
      --job-a-root relative \
      --job-b-root "$JOB_B_ROOT" \
      --receipt-dir "$TMP_DIR/invalid-receipt" >/dev/null 2>>"$err"
  status=$?
  set -e
  [[ "$status" -eq 2 ]] || fail "relative root returned $status"
  [[ ! -s "$TMP_DIR/guard.calls" ]] || fail "relative root reached the guard seam"

  ln -s "$JOB_A_ROOT" "$TMP_DIR/job-a-alias"
  set +e
  PAIR_TEST_GUARD_MODE=delegate PAIR_TEST_GUARD_CALLS="$TMP_DIR/guard.calls" \
    "$SCRIPT_DIR/run-focused-vitest-pair.sh" \
      --label invalid \
      --job-a-root "$JOB_A_ROOT" \
      --job-b-root "$TMP_DIR/job-a-alias" \
      --receipt-dir "$TMP_DIR/alias-receipt" >/dev/null 2>>"$err"
  status=$?
  set -e
  [[ "$status" -eq 2 ]] || fail "same canonical root alias returned $status"
  [[ ! -s "$TMP_DIR/guard.calls" ]] || fail "same canonical root reached the guard seam"
  pass "argument validation fails before admission"
}

test_exactly_one_canonical_supervisor_request() {
  : >"$TMP_DIR/guard.calls"
  set +e
  PAIR_TEST_GUARD_MODE=delegate PAIR_TEST_GUARD_CALLS="$TMP_DIR/guard.calls" \
    "$SCRIPT_DIR/run-focused-vitest-pair.sh" \
      --label delegation \
      --job-a-root "$JOB_A_ROOT" \
      --job-b-root "$JOB_B_ROOT" \
      --receipt-dir "$TMP_DIR/delegation-receipt" >/dev/null 2>&1
  local status=$?
  set -e
  [[ "$status" -eq 42 ]] || fail "delegation seam returned $status"
  [[ "$(wc -l <"$TMP_DIR/guard.calls" | tr -d ' ')" == "1" ]] ||
    fail "entrypoint requested more than one canonical supervisor"
  assert_contains "$TMP_DIR/guard.calls" "focused-vitest-pair:delegation"
  pass "one canonical supervisor is requested"
}

test_two_children_have_fixed_allowlists_and_caps() {
  rm -rf "$TMP_DIR/state" "$TMP_DIR/success-receipt"
  mkdir -p "$TMP_DIR/state"
  : >"$TMP_DIR/pnpm.calls"
  if ! run_pair "$TMP_DIR/success-receipt" >"$TMP_DIR/success.out" 2>"$TMP_DIR/success.err"; then
    cat "$TMP_DIR/success.err" >&2
    [[ ! -f "$TMP_DIR/success-receipt/job-a.log" ]] || cat "$TMP_DIR/success-receipt/job-a.log" >&2
    [[ ! -f "$TMP_DIR/success-receipt/job-b.log" ]] || cat "$TMP_DIR/success-receipt/job-b.log" >&2
    fail "successful pair fixture returned nonzero"
  fi

  [[ "$(wc -l <"$TMP_DIR/pnpm.calls" | tr -d ' ')" == "2" ]] ||
    fail "pair did not launch exactly two pnpm children"
  local receipt="$TMP_DIR/success-receipt/receipt.env"
  local supervisor_pid=""
  supervisor_pid="$(awk -F= '$1 == "supervisor_pid" { print $2 }' "$receipt")"
  [[ "$(awk -F '\t' -v parent="$supervisor_pid" '$2 == parent { count++ } END { print count + 0 }' "$TMP_DIR/pnpm.calls")" == "2" ]] ||
    fail "both workload roots were not direct children of one supervisor"
  [[ "$(awk -F '\t' '{ print $1 }' "$TMP_DIR/pnpm.calls" | sort -u | wc -l | tr -d ' ')" == "2" ]] ||
    fail "workload roots did not have distinct PIDs"
  assert_contains "$TMP_DIR/pnpm.calls" "--maxWorkers 1 --no-file-parallelism"
  assert_contains "$TMP_DIR/pnpm.calls" "extensions/codex/index.test.ts"
  assert_contains "$TMP_DIR/pnpm.calls" "src/commands/channels.status.command-flow.test.ts"
  assert_contains "$receipt" "status=passed"
  assert_contains "$receipt" "max_workers_per_job=1"
  assert_contains "$receipt" "file_parallelism=false"
  pass "two direct children use fixed allowlists and worker caps"
}

test_failure_propagates_after_complete_receipt() {
  rm -rf "$TMP_DIR/state" "$TMP_DIR/failure-receipt"
  mkdir -p "$TMP_DIR/state"
  : >"$TMP_DIR/pnpm.calls"
  set +e
  PAIR_TEST_JOB_A_EXIT=7 run_pair "$TMP_DIR/failure-receipt" >/dev/null
  local status=$?
  set -e
  [[ "$status" -eq 7 ]] || fail "job A failure returned $status"
  assert_contains "$TMP_DIR/failure-receipt/receipt.env" "status=failed"
  assert_contains "$TMP_DIR/failure-receipt/receipt.env" "reason=job_a_nonzero"
  assert_contains "$TMP_DIR/failure-receipt/receipt.env" "job_a_exit=7"
  assert_contains "$TMP_DIR/failure-receipt/receipt.env" "job_b_exit=0"
  pass "child failure propagates with both exits recorded"
}

test_signal_stops_both_children_and_records_interrupt() {
  rm -rf "$TMP_DIR/state" "$TMP_DIR/signal-receipt"
  mkdir -p "$TMP_DIR/state"
  : >"$TMP_DIR/pnpm.calls"
  PAIR_TEST_BLOCK=1 run_pair "$TMP_DIR/signal-receipt" >/dev/null 2>&1 &
  local supervisor_pid=$!
  local attempt=0
  while [[ (! -f "$TMP_DIR/state/a.started" || ! -f "$TMP_DIR/state/b.started") && "$attempt" -lt 100 ]]; do
    sleep 0.02
    attempt=$((attempt + 1))
  done
  [[ -f "$TMP_DIR/state/a.started" && -f "$TMP_DIR/state/b.started" ]] ||
    fail "signal fixture did not start both children"
  kill -TERM "$supervisor_pid"
  set +e
  wait "$supervisor_pid"
  local status=$?
  set -e
  [[ "$status" -eq 143 ]] || fail "TERM returned $status instead of 143"
  [[ -f "$TMP_DIR/state/a.terminated" && -f "$TMP_DIR/state/b.terminated" ]] ||
    fail "TERM did not reach both direct workload roots"
  assert_contains "$TMP_DIR/signal-receipt/receipt.env" "status=interrupted"
  assert_contains "$TMP_DIR/signal-receipt/receipt.env" "reason=signal_TERM"
  pass "signal cleanup stops both children and records interruption"
}

test_argument_validation_precedes_guard
test_exactly_one_canonical_supervisor_request
test_two_children_have_fixed_allowlists_and_caps
test_failure_propagates_after_complete_receipt
test_signal_stops_both_children_and_records_interrupt

echo "Focused Vitest pair shell tests passed."
