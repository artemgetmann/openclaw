#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"
source "$ROOT_DIR/scripts/lib/consumer-mac-test-lifecycle.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

declare -a TEST_PROCESS_LINES=()
declare -a TEST_KILLED_PIDS=()
declare -a TEST_QUARANTINED_INSTANCES=()
declare -a TEST_PLIST_ROWS=()

consumer_mac_test_list_process_lines() {
  printf '%s\n' "${TEST_PROCESS_LINES[@]}"
}

consumer_mac_test_plist_value() {
  local plist_path="$1"
  local key="$2"
  local row=""
  local path=""
  local row_key=""
  local value=""

  for row in "${TEST_PLIST_ROWS[@]}"; do
    IFS='|' read -r path row_key value <<<"$row"
    if [[ "$path" == "$plist_path" && "$row_key" == "$key" ]]; then
      printf '%s\n' "$value"
      return
    fi
  done
}

consumer_mac_test_terminate_pid() {
  TEST_KILLED_PIDS+=("$1")
}

consumer_mac_test_quarantine_gateway() {
  TEST_QUARANTINED_INSTANCES+=("$1")
}

make_test_app() {
  local app_path="$1"
  local bundle_id="$2"
  local instance_id="$3"
  local plist_path="${app_path}/Contents/Info.plist"

  mkdir -p "${app_path}/Contents/MacOS"
  : >"$plist_path"
  TEST_PLIST_ROWS+=("${plist_path}|CFBundleIdentifier|${bundle_id}")
  TEST_PLIST_ROWS+=("${plist_path}|OpenClawConsumerInstanceID|${instance_id}")
}

export OPENCLAW_CONSUMER_TEST_REGISTRY_PATH="$TMP_DIR/registry/current.tsv"

PRODUCTION_APP="/Applications/Jarvis.app"
OLD_APP="$TMP_DIR/Jarvis (old-proof).app"
NEW_APP="$TMP_DIR/Jarvis (new-proof).app"
DEFAULT_DEBUG_APP="$TMP_DIR/Jarvis.app"
make_test_app "$OLD_APP" "ai.openclaw.consumer.mac.debug.old-proof" "old-proof"
make_test_app "$NEW_APP" "ai.openclaw.consumer.mac.debug.new-proof" "new-proof"
make_test_app "$DEFAULT_DEBUG_APP" "ai.openclaw.consumer.mac.debug" ""

TEST_PROCESS_LINES=(
  "101 /Applications/Jarvis.app/Contents/MacOS/OpenClaw"
  "202 $OLD_APP/Contents/MacOS/OpenClaw"
)

if consumer_mac_test_prepare_launch "new-proof" "$NEW_APP" 0 >/dev/null 2>&1; then
  fail "non-replacing launch should refuse a second tester app"
fi
[[ "${#TEST_KILLED_PIDS[@]}" -eq 0 ]] || fail "refusal must not terminate any app"
pass "refuses a second tester without --replace"

consumer_mac_test_prepare_launch "new-proof" "$NEW_APP" 1 >/dev/null
[[ "${TEST_KILLED_PIDS[*]}" == "202" ]] || fail "replace should terminate only the old tester PID"
[[ "${TEST_QUARANTINED_INSTANCES[*]}" == "old-proof" ]] || fail "replace should quarantine only the old tester gateway"
pass "replace retires exact previous tester app and gateway"

TEST_KILLED_PIDS=()
TEST_QUARANTINED_INSTANCES=()
TEST_PROCESS_LINES=(
  "101 /Applications/Jarvis.app/Contents/MacOS/OpenClaw"
  "303 $DEFAULT_DEBUG_APP/Contents/MacOS/OpenClaw"
)
consumer_mac_test_prepare_launch "new-proof" "$NEW_APP" 1 >/dev/null
[[ "${TEST_KILLED_PIDS[*]}" == "303" ]] || fail "default source-built debug app should be retired"
[[ "${#TEST_QUARANTINED_INSTANCES[@]}" -eq 0 ]] || fail "empty/default instance must never derive a gateway cleanup target"
pass "preserves production while retiring default debug app"

TEST_KILLED_PIDS=()
TEST_QUARANTINED_INSTANCES=()
TEST_PROCESS_LINES=()
consumer_mac_test_record_launch "old-proof" "$OLD_APP"
consumer_mac_test_prepare_launch "new-proof" "$NEW_APP" 1 >/dev/null
[[ "${TEST_QUARANTINED_INSTANCES[*]}" == "old-proof" ]] || fail "registry handoff should retire a gateway even after its app exited"
pass "registry prevents gateway-only tester leaks"

TEST_KILLED_PIDS=()
TEST_QUARANTINED_INSTANCES=()
DELETED_APP="$TMP_DIR/Jarvis (deleted-worktree).app"
TEST_PROCESS_LINES=("404 $DELETED_APP/Contents/MacOS/OpenClaw")
consumer_mac_test_record_launch "deleted-worktree" "$DELETED_APP"
consumer_mac_test_prepare_launch "new-proof" "$NEW_APP" 1 >/dev/null
[[ "${TEST_KILLED_PIDS[*]}" == "404" ]] || fail "registry should retire an exact app process after its bundle is deleted"
[[ "${TEST_QUARANTINED_INSTANCES[*]}" == "deleted-worktree" ]] || fail "deleted-worktree handoff should quarantine its named gateway"
pass "registry retires a running app after its bundle disappears"

TEST_KILLED_PIDS=()
TEST_QUARANTINED_INSTANCES=()
TEST_PROCESS_LINES=()
SAME_INSTANCE_APP="$TMP_DIR/other-worktree/Jarvis (new-proof).app"
consumer_mac_test_record_launch "new-proof" "$SAME_INSTANCE_APP"
consumer_mac_test_prepare_launch "new-proof" "$NEW_APP" 1 >/dev/null
[[ "${#TEST_QUARANTINED_INSTANCES[@]}" -eq 0 ]] || fail "same-instance path transfer must preserve its gateway"
pass "same-instance path transfer preserves its gateway"

consumer_mac_test_record_launch "new-proof" "$NEW_APP"
grep -F $'instance_id\tnew-proof' "$OPENCLAW_CONSUMER_TEST_REGISTRY_PATH" >/dev/null || fail "registry should record current instance"
grep -F $'app_path\t'"$NEW_APP" "$OPENCLAW_CONSUMER_TEST_REGISTRY_PATH" >/dev/null || fail "registry should record current app path"
pass "records the current tester owner atomically"

CONSUMER_MAC_TEST_LOCK_OWNED=""
consumer_mac_test_acquire_lock
[[ -d "$(consumer_mac_test_lock_path)" ]] || fail "acquire should create the tester-slot lock"
consumer_mac_test_release_lock
[[ ! -e "$(consumer_mac_test_lock_path)" ]] || fail "release should remove the tester-slot lock"
pass "serializes tester-slot acquisition"

TEST_PROCESS_LINES=("505 $OLD_APP/Contents/MacOS/OpenClaw")
if consumer_mac_test_begin_launch "new-proof" "$NEW_APP" 0 >/dev/null 2>&1; then
  fail "begin launch should propagate a conflicting-slot refusal"
fi
[[ ! -e "$(consumer_mac_test_lock_path)" ]] || fail "failed launch preparation must release the tester-slot lock"
pass "releases the slot lock when preparation fails"

TEST_PROCESS_LINES=("606 $NEW_APP/Contents/MacOS/OpenClaw")
consumer_mac_test_wait_for_app_path "$NEW_APP"
pass "holds the slot until the launched app is observable"
