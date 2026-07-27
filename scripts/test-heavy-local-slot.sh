#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WRAPPER="$ROOT_DIR/scripts/with-heavy-local-slot.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-heavy-local-slot-test.XXXXXX")"
FIXTURE_ROOT="$TMP_DIR/instrumented-root"
FIXTURE_WRAPPER="$FIXTURE_ROOT/scripts/with-heavy-local-slot.sh"
SIGINT_RESET_LAUNCHER="$TMP_DIR/reset-sigint-and-exec.pl"
PERL_BIN=""

cleanup() {
  local background_pid=""

  # A failed assertion must not leave a holder or guarded fixture alive. Scope
  # cleanup to jobs started by this test shell, then remove only its temp root.
  while IFS= read -r background_pid; do
    [[ -n "$background_pid" ]] || continue
    kill -TERM "$background_pid" 2>/dev/null || true
  done < <(jobs -pr)
  wait 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

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

  while [[ ! -f "$path" && "$attempt" -lt 200 ]]; do
    sleep 0.05
    attempt=$((attempt + 1))
  done
  [[ -f "$path" ]] || fail "timed out waiting for $path"
}

wait_for_absence() {
  local path="$1"
  local attempt=0

  while [[ -e "$path" && "$attempt" -lt 200 ]]; do
    sleep 0.05
    attempt=$((attempt + 1))
  done
  [[ ! -e "$path" ]] || fail "timed out waiting for removal of $path"
}

wait_for_dead_pid() {
  local pid="$1"
  local attempt=0

  while kill -0 "$pid" 2>/dev/null && [[ "$attempt" -lt 200 ]]; do
    sleep 0.05
    attempt=$((attempt + 1))
  done
  ! kill -0 "$pid" 2>/dev/null || fail "PID $pid remained alive"
}

write_healthy_samples() {
  local path="$1"
  local sample=0

  : >"$path"
  while [[ "$sample" -lt 20 ]]; do
    printf 'healthy\n' >>"$path"
    sample=$((sample + 1))
  done
}

create_instrumented_runtime() {
  local fixture_helper="$FIXTURE_ROOT/scripts/lib/heavy-local-slot.sh"
  local fixture_health_hook="$FIXTURE_ROOT/scripts/lib/heavy-local-slot-health-fixture.sh"
  local fixture_wrapper_tmp="$FIXTURE_WRAPPER.tmp"
  local injected_hook_count=0

  mkdir -p "$FIXTURE_ROOT/scripts/lib"
  cp "$ROOT_DIR/scripts/lib/heavy-local-slot.sh" "$fixture_helper"
  cp \
    "$ROOT_DIR/scripts/lib/jarvis-release-lock.sh" \
    "$FIXTURE_ROOT/scripts/lib/jarvis-release-lock.sh"

  # Only the disposable copy accepts a private path. Canonical scripts always
  # source the production helper, whose lock identity has no ambient override.
  cat >>"$fixture_helper" <<'EOF'

openclaw_heavy_local_slot_default_path() {
  [[ -n "${OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH:-}" ]] || return 1
  printf '%s\n' "$OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH"
}
EOF

  cat >"$fixture_health_hook" <<'EOF'
host_health_reason() {
  local test_health_file="${OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE:-}"
  local test_ready_file="${OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_READY_FILE:-}"
  local test_health_sample="" test_health_tmp=""

  # Runtime-stop tests must first prove that their complete child tree exists.
  # Until that fixture-owned marker appears, report healthy without consuming a
  # sample. This removes scheduler timing from the two-strike assertion.
  if [[ -n "$test_ready_file" && ! -f "$test_ready_file" ]]; then
    return 0
  fi

  if [[ -s "$test_health_file" ]]; then
    test_health_sample="$(/usr/bin/head -n 1 "$test_health_file")"
    test_health_tmp="${test_health_file}.tmp.$$"
    /usr/bin/tail -n +2 "$test_health_file" >"$test_health_tmp"
    /bin/mv "$test_health_tmp" "$test_health_file"
  fi
  if [[ -n "$test_health_sample" && "$test_health_sample" != "healthy" ]]; then
    printf '%s' "$test_health_sample"
  fi
}
EOF

  # Instrument only the copied wrapper after its production health function is
  # defined. The checked-in wrapper has no hook path or fake-health switch.
  /usr/bin/awk '
    $0 == "min_cpu_idle=${OPENCLAW_FLEET_MIN_CPU_IDLE_PERCENT:-35}" {
      print "source \"${ROOT_DIR}/scripts/lib/heavy-local-slot-health-fixture.sh\""
    }
    { print }
  ' "$WRAPPER" >"$fixture_wrapper_tmp"
  /bin/mv "$fixture_wrapper_tmp" "$FIXTURE_WRAPPER"
  chmod +x "$FIXTURE_WRAPPER"

  # Fail immediately if a production refactor moved the injection anchor. A
  # silently uninjected fixture would sample the real host and make this suite
  # nondeterministic instead of proving the intended health transitions.
  injected_hook_count="$(
    grep -Fc 'source "${ROOT_DIR}/scripts/lib/heavy-local-slot-health-fixture.sh"' \
      "$FIXTURE_WRAPPER" || true
  )"
  [[ "$injected_hook_count" -eq 1 ]] ||
    fail "instrumented wrapper contains $injected_hook_count health hooks instead of 1"
}

create_sigint_reset_launcher() {
  # Bash deliberately cannot trap SIGINT when it started with that signal
  # ignored. Perl is already used by canonical repo scripts and exposes the
  # underlying sigaction reset before exec, so the copied wrapper receives the
  # same default-at-startup disposition as a real foreground invocation.
  PERL_BIN="$(command -v perl || true)"
  [[ -n "$PERL_BIN" && -x "$PERL_BIN" ]] ||
    fail "signal proof requires Perl to reset inherited SIGINT; refusing to skip INT"

  cat >"$SIGINT_RESET_LAUNCHER" <<'EOF'
#!/usr/bin/env perl
use strict;
use warnings;

@ARGV or die "reset-sigint-and-exec requires a command\n";
$SIG{INT} = 'DEFAULT';
my $program = shift @ARGV;
exec {$program} $program, @ARGV;
die "could not exec $program: $!\n";
EOF
}

run_test_wrapper() {
  local lock_path="$1"
  local health_path="$2"
  local label="$3"
  local ready_path="${OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_READY_FILE:-}"
  shift 3

  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_READY_FILE="$ready_path" \
  OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS=0.05 \
    "$FIXTURE_WRAPPER" --label "$label" -- "$@"
}

test_production_has_no_ambient_test_bypass() {
  local production_script=""

  # The checked-in helper and wrapper must never learn fixture environment
  # names. Private locks and synthetic health exist only in the disposable
  # copies created above, so canonical commands cannot opt into them.
  for production_script in \
    "$ROOT_DIR/scripts/lib/heavy-local-slot.sh" \
    "$ROOT_DIR/scripts/with-heavy-local-slot.sh"; do
    if grep -Eq \
      'OPENCLAW_HEAVY_LOCAL_SLOT_(TEST|FIXTURE)|OPENCLAW_HEAVY_LOCAL_SLOT_TESTING' \
      "$production_script"; then
      fail "$production_script exposes an ambient test bypass"
    fi
  done
  pass "production helper and wrapper expose no ambient test bypass"
}

create_minimal_clone_pair() {
  local seed="$TMP_DIR/clone-seed"
  local clone_a="$TMP_DIR/clone-a"
  local clone_b="$TMP_DIR/clone-b"

  mkdir -p "$seed/scripts/lib"
  cp "$FIXTURE_WRAPPER" "$seed/scripts/with-heavy-local-slot.sh"
  cp "$FIXTURE_ROOT/scripts/lib/heavy-local-slot.sh" "$seed/scripts/lib/heavy-local-slot.sh"
  cp \
    "$FIXTURE_ROOT/scripts/lib/heavy-local-slot-health-fixture.sh" \
    "$seed/scripts/lib/heavy-local-slot-health-fixture.sh"
  git -C "$seed" init -q
  git -C "$seed" add scripts
  git -C "$seed" \
    -c user.name="Heavy Slot Test" \
    -c user.email="heavy-slot-test@example.invalid" \
    commit -qm "test: seed heavy slot clones"
  git clone -q "$seed" "$clone_a"
  git clone -q "$seed" "$clone_b"
}

test_machine_wide_default_and_separate_clone_contention() {
  local clone_a="$TMP_DIR/clone-a"
  local clone_b="$TMP_DIR/clone-b"
  local lock_path="$TMP_DIR/cross-clone.lock"
  local holder_health="$TMP_DIR/cross-clone-holder.health"
  local contender_health="$TMP_DIR/cross-clone-contender.health"
  local ready="$TMP_DIR/cross-clone.ready"
  local release="$TMP_DIR/cross-clone.release"
  local contender_err="$TMP_DIR/cross-clone-contender.err"
  local path_a="" path_b=""
  local holder_pid=0 status=0

  create_minimal_clone_pair
  path_a="$(
    cd "$clone_a"
    TMPDIR="$TMP_DIR/clone-a-tmp" \
      bash -c 'source "$1/scripts/lib/heavy-local-slot.sh"; openclaw_heavy_local_slot_resolve_path' _ "$ROOT_DIR"
  )"
  path_b="$(
    cd "$clone_b"
    TMPDIR="$TMP_DIR/clone-b-tmp" \
      bash -c 'source "$1/scripts/lib/heavy-local-slot.sh"; openclaw_heavy_local_slot_resolve_path' _ "$ROOT_DIR"
  )"
  [[ "$path_a" == "$path_b" ]] || fail "separate clones derived different default lock paths"
  [[ "$path_a" == /tmp/openclaw-heavy-local-slots-*/machine-wide.lock ]] ||
    fail "default lock path is not the UID-stable machine path"
  [[ "$path_a" != *"/.git/"* ]] || fail "default lock path still depends on Git metadata"

  write_healthy_samples "$holder_health"
  write_healthy_samples "$contender_health"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$holder_health" \
  OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS=0.05 \
    "$clone_a/scripts/with-heavy-local-slot.sh" \
      --label "clone-a-holder" \
      -- \
      bash -c ': >"$1"; while [[ ! -f "$2" ]]; do sleep 0.05; done' _ "$ready" "$release" &
  holder_pid=$!
  wait_for_file "$ready"

  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$contender_health" \
    "$clone_b/scripts/with-heavy-local-slot.sh" \
      --label "clone-b-contender" \
      -- true \
      >/dev/null 2>"$contender_err"
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "separate-clone contender returned $status instead of 75"
  grep -Fq 'clone-a-holder' "$contender_err" || fail "contention omitted live cross-clone owner"
  kill -0 "$holder_pid" 2>/dev/null || fail "cross-clone contention harmed the holder"

  : >"$release"
  wait "$holder_pid"
  wait_for_absence "$lock_path"
  pass "machine-wide path and separate-clone contention"
}

create_nested_fixture() {
  local fixture="$TMP_DIR/nested-fixture.sh"

  cat >"$fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

root="$1"
body_log="$2"
mode="$3"
depth="${4:-0}"
source "$root/scripts/lib/heavy-local-slot.sh"

openclaw_heavy_local_slot_require_or_reexec \
  "nested-fixture" \
  "$root" \
  "$0" \
  "$@"

printf 'body depth=%s token=%s\n' "$depth" "$OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN" >>"$body_log"
if [[ "$mode" == "nested" && "$depth" == "0" ]]; then
  "$0" "$root" "$body_log" "$mode" 1
fi
EOF
  chmod +x "$fixture"
  printf '%s\n' "$fixture"
}

test_nested_reuse_without_reacquire() {
  local fixture="" lock_path="$TMP_DIR/nested.lock"
  local health_path="$TMP_DIR/nested.health"
  local body_log="$TMP_DIR/nested.body"
  local output="$TMP_DIR/nested.out"
  local grant_count=0 body_count=0 token_count=0

  fixture="$(create_nested_fixture)"
  write_healthy_samples "$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
  OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS=0.05 \
    "$fixture" "$FIXTURE_ROOT" "$body_log" nested 0 >"$output"

  grant_count="$(grep -c 'Heavy-local slot granted' "$output" || true)"
  body_count="$(wc -l <"$body_log" | tr -d ' ')"
  token_count="$(awk -F'token=' '{print $2}' "$body_log" | sort -u | wc -l | tr -d ' ')"
  [[ "$grant_count" -eq 1 ]] || fail "nested entrypoint acquired $grant_count wrappers"
  [[ "$body_count" -eq 2 ]] || fail "nested fixture executed $body_count bodies"
  [[ "$token_count" -eq 1 ]] || fail "nested fixture did not inherit one lease token"
  [[ ! -e "$lock_path" ]] || fail "nested fixture left its lock behind"
  pass "nested canonical entrypoints reuse one verified lease"
}

test_forged_token_rejected() {
  local fixture="" lock_path="$TMP_DIR/forged.lock"
  local holder_health="$TMP_DIR/forged-holder.health"
  local contender_health="$TMP_DIR/forged-contender.health"
  local ready="$TMP_DIR/forged.ready"
  local release="$TMP_DIR/forged.release"
  local body_log="$TMP_DIR/forged.body"
  local err="$TMP_DIR/forged.err"
  local forged="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  local holder_pid=0 status=0

  fixture="$(create_nested_fixture)"
  write_healthy_samples "$holder_health"
  write_healthy_samples "$contender_health"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$holder_health" \
  OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS=0.05 \
    "$FIXTURE_WRAPPER" \
      --label "forged-holder" \
      -- \
      bash -c ': >"$1"; while [[ ! -f "$2" ]]; do sleep 0.05; done' _ "$ready" "$release" &
  holder_pid=$!
  wait_for_file "$ready"

  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$contender_health" \
  OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN="$forged" \
    "$fixture" "$FIXTURE_ROOT" "$body_log" forged 0 >/dev/null 2>"$err"
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "forged token returned $status instead of contention"
  [[ ! -e "$body_log" ]] || fail "forged token reached guarded fixture body"
  grep -Fq 'forged-holder' "$err" || fail "forged token did not fall back to real admission"

  : >"$release"
  wait "$holder_pid"
  pass "forged inheritance token is rejected"
}

test_stale_recovery_and_token_safe_cleanup() {
  local stale_lock="$TMP_DIR/stale.lock"
  local stale_health="$TMP_DIR/stale.health"
  local stale_marker="$TMP_DIR/stale.marker"
  local live_lock="$TMP_DIR/token-safe.lock"
  local live_health="$TMP_DIR/token-safe.health"
  local ready="$TMP_DIR/token-safe.ready"
  local release="$TMP_DIR/token-safe.release"
  local holder_pid=0

  mkdir "$stale_lock"
  {
    printf 'pid=99999999\n'
    printf 'token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
    printf 'process_start=Mon Jan 1 00:00:00 2001\n'
    printf 'label=stale-owner\n'
  } >"$stale_lock/owner"
  write_healthy_samples "$stale_health"
  run_test_wrapper "$stale_lock" "$stale_health" "stale-reclaimer" touch "$stale_marker"
  [[ -f "$stale_marker" ]] || fail "stale lease was not reclaimed"
  [[ ! -e "$stale_lock" ]] || fail "reclaimed lease was not released"

  write_healthy_samples "$live_health"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$live_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$live_health" \
  OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS=0.05 \
    "$FIXTURE_WRAPPER" \
      --label "token-safe-holder" \
      -- \
      bash -c ': >"$1"; while [[ ! -f "$2" ]]; do sleep 0.05; done' _ "$ready" "$release" &
  holder_pid=$!
  wait_for_file "$ready"

  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$live_lock" \
    bash -c '
      source "$1/scripts/lib/heavy-local-slot.sh"
      OPENCLAW_HEAVY_LOCAL_SLOT_CLAIMED_DIR=1
      OPENCLAW_HEAVY_LOCAL_SLOT_PATH="$2"
      OPENCLAW_HEAVY_LOCAL_SLOT_TOKEN="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      openclaw_heavy_local_slot_release
    ' _ "$FIXTURE_ROOT" "$live_lock"
  [[ -f "$live_lock/owner" ]] || fail "mismatched late cleanup removed a live owner"
  kill -0 "$holder_pid" 2>/dev/null || fail "token-safe cleanup harmed the holder"

  : >"$release"
  wait "$holder_pid"
  pass "stale recovery and token-matched cleanup"
}

test_ambiguous_owner_identity_fails_closed() {
  local health_path="$TMP_DIR/ambiguous-owner.health"
  local missing_owner_lock="$TMP_DIR/missing-owner.lock"
  local missing_start_lock="$TMP_DIR/missing-start.lock"
  local reused_pid_lock="$TMP_DIR/reused-pid.lock"
  local err_path="$TMP_DIR/ambiguous-owner.err"
  local status=0

  write_healthy_samples "$health_path"

  mkdir "$missing_owner_lock"
  set +e
  run_test_wrapper "$missing_owner_lock" "$health_path" "missing-owner" true \
    >/dev/null 2>"$err_path"
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "missing owner metadata returned $status instead of 75"
  [[ -d "$missing_owner_lock" ]] || fail "missing owner metadata was reclaimed"
  grep -Fq 'no readable owner metadata' "$err_path" ||
    fail "missing owner metadata did not report fail-closed ownership"

  mkdir "$missing_start_lock"
  {
    printf 'pid=%s\n' "$$"
    printf 'token=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n'
    printf 'label=missing-start-owner\n'
  } >"$missing_start_lock/owner"
  set +e
  run_test_wrapper "$missing_start_lock" "$health_path" "missing-start" true \
    >/dev/null 2>"$err_path"
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "missing process start returned $status instead of 75"
  [[ -f "$missing_start_lock/owner" ]] || fail "missing process start was reclaimed"

  mkdir "$reused_pid_lock"
  {
    printf 'pid=%s\n' "$$"
    printf 'token=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n'
    printf 'process_start=Mon Jan 1 00:00:00 2001\n'
    printf 'label=reused-pid-owner\n'
  } >"$reused_pid_lock/owner"
  set +e
  run_test_wrapper "$reused_pid_lock" "$health_path" "reused-pid" true \
    >/dev/null 2>"$err_path"
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "PID-reuse ambiguity returned $status instead of 75"
  [[ -f "$reused_pid_lock/owner" ]] || fail "PID-reuse ambiguity was reclaimed"
  pass "missing metadata, missing start, and PID reuse fail closed"
}

test_child_status_propagation() {
  local lock_path="$TMP_DIR/status.lock"
  local health_path="$TMP_DIR/status.health"
  local status=0

  write_healthy_samples "$health_path"
  set +e
  run_test_wrapper "$lock_path" "$health_path" "status-probe" bash -c 'exit 42'
  status=$?
  set -e
  [[ "$status" -eq 42 ]] || fail "wrapper changed child status 42 to $status"
  [[ ! -e "$lock_path" ]] || fail "status propagation left its lock behind"
  pass "guarded child status propagates unchanged"
}

create_process_tree_fixture() {
  local fixture="$TMP_DIR/process-tree-fixture.sh"

  cat >"$fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

child_pid_file="$1"
grandchild_pid_file="$2"

bash -c '
  trap "exit 0" TERM HUP INT
  while true; do sleep 1; done
' &
grandchild_pid=$!
printf '%s\n' "$$" >"$child_pid_file"
printf '%s\n' "$grandchild_pid" >"$grandchild_pid_file"
wait "$grandchild_pid"
EOF
  chmod +x "$fixture"
  printf '%s\n' "$fixture"
}

test_two_sample_health_stop_kills_tree() {
  local fixture="" lock_path="$TMP_DIR/health-stop.lock"
  local health_path="$TMP_DIR/health-stop.health"
  local child_pid_file="$TMP_DIR/health-stop.child"
  local grandchild_pid_file="$TMP_DIR/health-stop.grandchild"
  local output="$TMP_DIR/health-stop.out"
  local status=0 child_pid=0 grandchild_pid=0

  fixture="$(create_process_tree_fixture)"
  {
    printf 'synthetic host pressure\n'
    printf 'synthetic host pressure\n'
  } >"$health_path"
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_READY_FILE="$grandchild_pid_file" \
    run_test_wrapper \
      "$lock_path" \
      "$health_path" \
      "health-stop" \
      "$fixture" "$child_pid_file" "$grandchild_pid_file" \
      >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 75 ]] || fail "health stop returned $status instead of 75"
  wait_for_file "$child_pid_file"
  wait_for_file "$grandchild_pid_file"
  child_pid="$(<"$child_pid_file")"
  grandchild_pid="$(<"$grandchild_pid_file")"
  wait_for_dead_pid "$child_pid"
  wait_for_dead_pid "$grandchild_pid"
  grep -Fq 'repeated host-health failures' "$output" || fail "health stop omitted reason"
  [[ ! -e "$lock_path" ]] || fail "health stop left its lock behind"
  pass "two unhealthy samples stop child and grandchild"
}

signal_verified_slot_owner() {
  local signal_name="$1"
  local expected_label="$2"
  local lock_path="$3"
  local child_pid_file="$4"
  local grandchild_pid_file="$5"
  local result_file="$6"
  local owner_path="$lock_path/owner"
  local attempt=0
  local owner_pid="" owner_token="" owner_start="" owner_label="" current_start=""
  local current_pid="" current_token="" recorded_start="" current_label=""

  # This helper is the only background shell in a signal case. It must never
  # inherit the suite's EXIT cleanup or respond to the signal it will target at
  # the separately verified foreground wrapper.
  trap - EXIT INT TERM HUP

  # First resolve a real owner. A bounded wait converts wrapper startup failures
  # into a finite result instead of leaving a signaler alive indefinitely.
  while [[ ! -f "$owner_path" && "$attempt" -lt 200 ]]; do
    sleep 0.05
    attempt=$((attempt + 1))
  done
  if [[ ! -f "$owner_path" ]]; then
    printf 'owner metadata timeout before %s\n' "$signal_name" >"$result_file"
    return 1
  fi

  # Resolve and authenticate the exact lease owner rather than trusting the PID
  # of a shell job. This also proves the test exercises canonical owner metadata.
  source "$FIXTURE_ROOT/scripts/lib/heavy-local-slot.sh"
  owner_pid="$(openclaw_heavy_local_slot_value "$owner_path" pid)"
  owner_token="$(openclaw_heavy_local_slot_value "$owner_path" token)"
  owner_start="$(openclaw_heavy_local_slot_value "$owner_path" process_start)"
  owner_label="$(openclaw_heavy_local_slot_value "$owner_path" label)"
  current_start="$(openclaw_heavy_local_slot_process_start "$owner_pid" || true)"
  if [[ ! "$owner_pid" =~ ^[1-9][0-9]*$ ||
    ! "$owner_token" =~ ^[0-9a-fA-F]{64}$ ||
    -z "$owner_start" ||
    "$owner_start" != "$current_start" ||
    "$owner_label" != "$expected_label" ]] ||
    ! kill -0 "$owner_pid" 2>/dev/null; then
    printf 'owner verification failed before %s\n' "$signal_name" >"$result_file"
    return 1
  fi

  # Once the target is authenticated, wait separately for the child tree. On a
  # fixture readiness failure, terminate only that verified owner so the
  # foreground test cannot hang while reporting the harness failure.
  attempt=0
  while [[ "$attempt" -lt 200 ]]; do
    if [[ -f "$child_pid_file" && -f "$grandchild_pid_file" ]]; then
      break
    fi
    sleep 0.05
    attempt=$((attempt + 1))
  done
  if [[ ! -f "$child_pid_file" || ! -f "$grandchild_pid_file" ]]; then
    kill -TERM "$owner_pid" 2>/dev/null || true
    printf 'tree readiness timeout before %s; terminated verified owner PID %s\n' \
      "$signal_name" \
      "$owner_pid" >"$result_file"
    return 1
  fi

  # Re-read every identity field after the readiness wait. A replacement owner
  # must never receive a signal intended for the process verified above.
  current_pid="$(openclaw_heavy_local_slot_value "$owner_path" pid)"
  current_token="$(openclaw_heavy_local_slot_value "$owner_path" token)"
  recorded_start="$(openclaw_heavy_local_slot_value "$owner_path" process_start)"
  current_label="$(openclaw_heavy_local_slot_value "$owner_path" label)"
  current_start="$(openclaw_heavy_local_slot_process_start "$current_pid" || true)"
  if [[ "$current_pid" != "$owner_pid" ||
    "$current_token" != "$owner_token" ||
    "$recorded_start" != "$owner_start" ||
    "$current_start" != "$owner_start" ||
    "$current_label" != "$expected_label" ]] ||
    ! kill -0 "$owner_pid" 2>/dev/null; then
    printf 'owner changed before %s\n' "$signal_name" >"$result_file"
    return 1
  fi

  if ! kill "-$signal_name" "$owner_pid" 2>/dev/null; then
    printf 'could not send %s to verified owner PID %s\n' "$signal_name" "$owner_pid" >"$result_file"
    return 1
  fi
  printf 'sent %s to verified owner PID %s\n' "$signal_name" "$owner_pid" >"$result_file"
}

run_signal_cleanup_case() {
  local signal_name="$1"
  local expected_status="$2"
  local fixture="$3"
  local expected_label="signal-cleanup-${signal_name}"
  local lock_path="$TMP_DIR/signal-${signal_name}.lock"
  local health_path="$TMP_DIR/signal-${signal_name}.health"
  local child_pid_file="$TMP_DIR/signal-${signal_name}.child"
  local grandchild_pid_file="$TMP_DIR/signal-${signal_name}.grandchild"
  local signaler_result="$TMP_DIR/signal-${signal_name}.signaler"
  local output="$TMP_DIR/signal-${signal_name}.out"
  local signaler_pid=0 signaler_status=0 status=0 child_pid=0 grandchild_pid=0

  write_healthy_samples "$health_path"
  signal_verified_slot_owner \
    "$signal_name" \
    "$expected_label" \
    "$lock_path" \
    "$child_pid_file" \
    "$grandchild_pid_file" \
    "$signaler_result" &
  signaler_pid=$!

  # Keep the wrapper in the foreground relative to this suite. The Perl shim
  # first resets SIGINT inherited from any outer guarded/background launcher,
  # then execs the copied wrapper so its production INT trap is testable.
  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
  OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS=0.05 \
    "$PERL_BIN" \
      "$SIGINT_RESET_LAUNCHER" \
      "$FIXTURE_WRAPPER" \
        --label "$expected_label" \
        -- \
        "$fixture" "$child_pid_file" "$grandchild_pid_file" \
      >"$output" 2>&1
  status=$?
  set -e

  set +e
  wait "$signaler_pid"
  signaler_status=$?
  set -e
  [[ "$signaler_status" -eq 0 ]] ||
    fail "$signal_name signaler failed: $(<"$signaler_result")"
  grep -Fq "sent $signal_name to verified owner PID" "$signaler_result" ||
    fail "$signal_name signaler did not record a verified send"

  child_pid="$(<"$child_pid_file")"
  grandchild_pid="$(<"$grandchild_pid_file")"
  [[ "$status" -eq "$expected_status" ]] ||
    fail "$signal_name returned $status instead of $expected_status"
  wait_for_dead_pid "$child_pid"
  wait_for_dead_pid "$grandchild_pid"
  wait_for_absence "$lock_path"
  pass "$signal_name stops the guarded tree with status $expected_status"
}

test_signal_cleanup_kills_tree_and_releases() {
  local fixture=""

  fixture="$(create_process_tree_fixture)"
  run_signal_cleanup_case TERM 143 "$fixture"
  run_signal_cleanup_case INT 130 "$fixture"
  run_signal_cleanup_case HUP 129 "$fixture"
  pass "TERM, INT, and HUP stop the guarded tree and release the lease"
}

create_lock_order_fixture() {
  local fixture="$TMP_DIR/lock-order-fixture.sh"

  cat >"$fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

root="$1"
proof_file="$2"
source "$root/scripts/lib/heavy-local-slot.sh"
source "$root/scripts/lib/jarvis-release-lock.sh"

openclaw_heavy_local_slot_require_or_reexec \
  "fleet-release-order" \
  "$root" \
  "$0" \
  "$@"

heavy_path="$(openclaw_heavy_local_slot_resolve_path)"
[[ -f "$heavy_path/owner" ]]
[[ ! -e "$OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE" ]]
openclaw_jarvis_release_lock_acquire "$root" "fleet-release-order"
[[ -f "$heavy_path/owner" ]]
[[ -f "$OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE/owner" ]]
printf 'fleet_then_release\n' >"$proof_file"
EOF
  chmod +x "$fixture"
  printf '%s\n' "$fixture"
}

test_fleet_and_release_lock_coexistence_and_wiring() {
  local fixture="" fleet_lock="$TMP_DIR/order-fleet.lock"
  local release_lock="$TMP_DIR/order-release.lock"
  local health_path="$TMP_DIR/order.health"
  local proof_file="$TMP_DIR/order.proof"
  local script="" guard_line=0 release_line=0

  fixture="$(create_lock_order_fixture)"
  write_healthy_samples "$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_LOCK_PATH="$fleet_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_FIXTURE_HEALTH_FILE="$health_path" \
  OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS=0.05 \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$release_lock" \
    "$fixture" "$FIXTURE_ROOT" "$proof_file" >/dev/null
  [[ "$(<"$proof_file")" == "fleet_then_release" ]] || fail "lock coexistence proof did not run"
  [[ ! -e "$fleet_lock" && ! -e "$release_lock" ]] || fail "lock-order fixture leaked a lease"

  for script in \
    scripts/ship-jarvis-hotfix.sh \
    scripts/package-openclaw-mac-dist.sh \
    scripts/jarvis-public-release.sh; do
    guard_line="$(
      grep -n 'openclaw_heavy_local_slot_require_or_reexec' "$ROOT_DIR/$script" |
        head -n 1 |
        cut -d: -f1
    )"
    release_line="$(
      grep -n 'openclaw_jarvis_release_lock_acquire' "$ROOT_DIR/$script" |
        head -n 1 |
        cut -d: -f1
    )"
    [[ -n "$guard_line" && -n "$release_line" && "$guard_line" -lt "$release_line" ]] ||
      fail "$script does not enforce fleet -> release lock order"
  done

  for script in \
    scripts/jarvis-release-worktree.sh \
    scripts/rebuild-relaunch-consumer-mac-app.sh \
    scripts/package-consumer-mac-app.sh \
    scripts/package-mac-app.sh \
    scripts/package-mac-dist.sh; do
    grep -Fq 'openclaw_heavy_local_slot_require_or_reexec' "$ROOT_DIR/$script" ||
      fail "$script does not self-enforce the fleet slot"
  done
  pass "fleet lease precedes and coexists with release lock"
}

create_instrumented_runtime
create_sigint_reset_launcher
test_production_has_no_ambient_test_bypass
test_machine_wide_default_and_separate_clone_contention
test_nested_reuse_without_reacquire
test_forged_token_rejected
test_stale_recovery_and_token_safe_cleanup
test_ambiguous_owner_identity_fails_closed
test_child_status_propagation
test_two_sample_health_stop_kills_tree
test_signal_cleanup_kills_tree_and_releases
test_fleet_and_release_lock_coexistence_and_wiring

echo "All heavy-local slot tests passed."
