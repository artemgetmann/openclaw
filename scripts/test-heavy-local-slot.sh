#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WRAPPER="$ROOT_DIR/scripts/with-heavy-local-slot.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-heavy-local-slot-test.XXXXXX")"

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

run_test_wrapper() {
  local lock_path="$1"
  local health_path="$2"
  local label="$3"
  shift 3

  OPENCLAW_HEAVY_LOCAL_SLOT_TESTING=1 \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_HEALTH_FILE="$health_path" \
  OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS=0.05 \
    "$WRAPPER" --label "$label" -- "$@"
}

create_minimal_clone_pair() {
  local seed="$TMP_DIR/clone-seed"
  local clone_a="$TMP_DIR/clone-a"
  local clone_b="$TMP_DIR/clone-b"

  mkdir -p "$seed/scripts/lib"
  cp "$WRAPPER" "$seed/scripts/with-heavy-local-slot.sh"
  cp "$ROOT_DIR/scripts/lib/heavy-local-slot.sh" "$seed/scripts/lib/heavy-local-slot.sh"
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
    bash -c 'source scripts/lib/heavy-local-slot.sh; openclaw_heavy_local_slot_default_path'
  )"
  path_b="$(
    cd "$clone_b"
    bash -c 'source scripts/lib/heavy-local-slot.sh; openclaw_heavy_local_slot_default_path'
  )"
  [[ "$path_a" == "$path_b" ]] || fail "separate clones derived different default lock paths"
  [[ "$path_a" != *"/.git/"* ]] || fail "default lock path still depends on Git metadata"

  write_healthy_samples "$holder_health"
  write_healthy_samples "$contender_health"
  OPENCLAW_HEAVY_LOCAL_SLOT_TESTING=1 \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_HEALTH_FILE="$holder_health" \
  OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS=0.05 \
    "$clone_a/scripts/with-heavy-local-slot.sh" \
      --label "clone-a-holder" \
      -- \
      bash -c ': >"$1"; while [[ ! -f "$2" ]]; do sleep 0.05; done' _ "$ready" "$release" &
  holder_pid=$!
  wait_for_file "$ready"

  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_TESTING=1 \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_HEALTH_FILE="$contender_health" \
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
  OPENCLAW_HEAVY_LOCAL_SLOT_TESTING=1 \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_HEALTH_FILE="$health_path" \
  OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS=0.05 \
    "$fixture" "$ROOT_DIR" "$body_log" nested 0 >"$output"

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
  OPENCLAW_HEAVY_LOCAL_SLOT_TESTING=1 \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_HEALTH_FILE="$holder_health" \
  OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS=0.05 \
    "$WRAPPER" \
      --label "forged-holder" \
      -- \
      bash -c ': >"$1"; while [[ ! -f "$2" ]]; do sleep 0.05; done' _ "$ready" "$release" &
  holder_pid=$!
  wait_for_file "$ready"

  set +e
  OPENCLAW_HEAVY_LOCAL_SLOT_TESTING=1 \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_HEALTH_FILE="$contender_health" \
  OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN="$forged" \
    "$fixture" "$ROOT_DIR" "$body_log" forged 0 >/dev/null 2>"$err"
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
  OPENCLAW_HEAVY_LOCAL_SLOT_TESTING=1 \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_LOCK_PATH="$live_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_HEALTH_FILE="$live_health" \
  OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS=0.05 \
    "$WRAPPER" \
      --label "token-safe-holder" \
      -- \
      bash -c ': >"$1"; while [[ ! -f "$2" ]]; do sleep 0.05; done' _ "$ready" "$release" &
  holder_pid=$!
  wait_for_file "$ready"

  OPENCLAW_HEAVY_LOCAL_SLOT_TESTING=1 \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_LOCK_PATH="$live_lock" \
    bash -c '
      source "$1/scripts/lib/heavy-local-slot.sh"
      OPENCLAW_HEAVY_LOCAL_SLOT_CLAIMED_DIR=1
      OPENCLAW_HEAVY_LOCAL_SLOT_PATH="$2"
      OPENCLAW_HEAVY_LOCAL_SLOT_TOKEN="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      openclaw_heavy_local_slot_release
    ' _ "$ROOT_DIR" "$live_lock"
  [[ -f "$live_lock/owner" ]] || fail "mismatched late cleanup removed a live owner"
  kill -0 "$holder_pid" 2>/dev/null || fail "token-safe cleanup harmed the holder"

  : >"$release"
  wait "$holder_pid"
  pass "stale recovery and token-matched cleanup"
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
    printf 'healthy\n'
    printf 'synthetic host pressure\n'
    printf 'synthetic host pressure\n'
  } >"$health_path"
  set +e
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

test_signal_cleanup_kills_tree_and_releases() {
  local fixture="" lock_path="$TMP_DIR/signal.lock"
  local health_path="$TMP_DIR/signal.health"
  local child_pid_file="$TMP_DIR/signal.child"
  local grandchild_pid_file="$TMP_DIR/signal.grandchild"
  local output="$TMP_DIR/signal.out"
  local wrapper_pid=0 status=0 child_pid=0 grandchild_pid=0

  fixture="$(create_process_tree_fixture)"
  write_healthy_samples "$health_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_TESTING=1 \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_LOCK_PATH="$lock_path" \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_HEALTH_FILE="$health_path" \
  OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS=0.05 \
    "$WRAPPER" \
      --label "signal-cleanup" \
      -- \
      "$fixture" "$child_pid_file" "$grandchild_pid_file" \
      >"$output" 2>&1 &
  wrapper_pid=$!
  wait_for_file "$child_pid_file"
  wait_for_file "$grandchild_pid_file"
  child_pid="$(<"$child_pid_file")"
  grandchild_pid="$(<"$grandchild_pid_file")"

  kill -TERM "$wrapper_pid"
  set +e
  wait "$wrapper_pid"
  status=$?
  set -e
  [[ "$status" -eq 143 ]] || fail "TERM returned $status instead of 143"
  wait_for_dead_pid "$child_pid"
  wait_for_dead_pid "$grandchild_pid"
  wait_for_absence "$lock_path"
  pass "signals stop the guarded tree and release the lease"
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
  OPENCLAW_HEAVY_LOCAL_SLOT_TESTING=1 \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_LOCK_PATH="$fleet_lock" \
  OPENCLAW_HEAVY_LOCAL_SLOT_TEST_HEALTH_FILE="$health_path" \
  OPENCLAW_FLEET_MONITOR_INTERVAL_SECONDS=0.05 \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$release_lock" \
    "$fixture" "$ROOT_DIR" "$proof_file" >/dev/null
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

test_machine_wide_default_and_separate_clone_contention
test_nested_reuse_without_reacquire
test_forged_token_rejected
test_stale_recovery_and_token_safe_cleanup
test_child_status_propagation
test_two_sample_health_stop_kills_tree
test_signal_cleanup_kills_tree_and_releases
test_fleet_and_release_lock_coexistence_and_wiring

echo "All heavy-local slot tests passed."
