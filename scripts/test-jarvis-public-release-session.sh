#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

FAKE_TMUX="$TMP_DIR/tmux"
FAKE_STATE="$TMP_DIR/state"
FAKE_COMMAND="$TMP_DIR/command"
FAKE_LOG="$TMP_DIR/log"
FAKE_RESPAWNS="$TMP_DIR/respawns"
FAKE_PANE_OPTION="$TMP_DIR/pane-option"
FAKE_ACTIVE_PANE="$TMP_DIR/active-pane"
FAKE_ALL_STATES="$TMP_DIR/all-states"
FAKE_TARGETS="$TMP_DIR/targets"
FAKE_ENV_UNSETS="$TMP_DIR/env-unsets"
FAKE_NEW_SESSION="$TMP_DIR/new-session"

cat >"$FAKE_TMUX" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "$1" in
  has-session)
    [[ -f "${FAKE_TMUX_STATE:?}" ]]
    ;;
  new-session)
    printf '%s\n' "$*" >"$FAKE_TMUX_NEW_SESSION"
    printf '0:0\n' >"$FAKE_TMUX_STATE"
    printf '%%1\n' >"$FAKE_TMUX_ACTIVE_PANE"
    printf '0:%%1\n' >"$FAKE_TMUX_ALL_STATES"
    ;;
  set-option)
    if [[ "$*" == *"@openclaw_jarvis_release_pane_id"* ]]; then
      printf '%s\n' "${!#}" >"$FAKE_TMUX_PANE_OPTION"
    fi
    ;;
  set-environment)
    [[ "$2" == "-u" ]] || {
      echo "fake tmux received a value-bearing environment update: $*" >&2
      exit 98
    }
    printf '%s\n' "${!#}" >>"$FAKE_TMUX_ENV_UNSETS"
    ;;
  respawn-pane)
    printf '%s\n' "${!#}" >"${FAKE_TMUX_COMMAND:?}"
    printf 'respawn\n' >>"${FAKE_TMUX_RESPAWNS:?}"
    ;;
  display-message)
    if [[ "${!#}" == '#{pane_id}' ]]; then
      cat "$FAKE_TMUX_ACTIVE_PANE"
    else
      printf 'display:%s\n' "$*" >>"$FAKE_TMUX_TARGETS"
      cat "$FAKE_TMUX_STATE"
    fi
    ;;
  show-options)
    cat "$FAKE_TMUX_PANE_OPTION"
    ;;
  list-panes)
    cat "$FAKE_TMUX_ALL_STATES"
    ;;
  capture-pane)
    printf 'capture:%s\n' "$*" >>"$FAKE_TMUX_TARGETS"
    cat "${FAKE_TMUX_LOG:?}"
    ;;
  kill-session)
    rm -f "$FAKE_TMUX_STATE" "$FAKE_TMUX_PANE_OPTION" "$FAKE_TMUX_ACTIVE_PANE" "$FAKE_TMUX_ALL_STATES"
    ;;
  attach-session)
    printf 'attached\n'
    ;;
  *)
    echo "unexpected fake tmux command: $*" >&2
    exit 99
    ;;
esac
EOF
chmod +x "$FAKE_TMUX"

run_helper() {
  OPENCLAW_MAIN_HOME_CLONE="$(cd "$ROOT_DIR/../.." && pwd -P)" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$(basename "$ROOT_DIR")" \
  OPENCLAW_JARVIS_RELEASE_TMUX_BIN="$FAKE_TMUX" \
  OPENCLAW_JARVIS_RELEASE_SESSION_NAME="jarvis-public-release-test" \
  FAKE_TMUX_STATE="$FAKE_STATE" \
  FAKE_TMUX_COMMAND="$FAKE_COMMAND" \
  FAKE_TMUX_LOG="$FAKE_LOG" \
  FAKE_TMUX_RESPAWNS="$FAKE_RESPAWNS" \
  FAKE_TMUX_PANE_OPTION="$FAKE_PANE_OPTION" \
  FAKE_TMUX_ACTIVE_PANE="$FAKE_ACTIVE_PANE" \
  FAKE_TMUX_ALL_STATES="$FAKE_ALL_STATES" \
  FAKE_TMUX_TARGETS="$FAKE_TARGETS" \
  FAKE_TMUX_ENV_UNSETS="$FAKE_ENV_UNSETS" \
  FAKE_TMUX_NEW_SESSION="$FAKE_NEW_SESSION" \
    /bin/bash "$ROOT_DIR/scripts/jarvis-public-release-session.sh" "$@"
}

test_start_and_duplicate_guard() {
  local out="$TMP_DIR/start.out"
  local err="$TMP_DIR/start.err"
  local status
  local env_name
  local control_env_vars=(
    BASH_ENV
    ENV
    ZDOTDIR
    GH_TOKEN
    GITHUB_TOKEN
    GH_ENTERPRISE_TOKEN
    GITHUB_ENTERPRISE_TOKEN
    GH_HOST
    OPENCLAW_MAIN_HOME_CLONE
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_CODESIGN_BIN
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_NOTARIZED_FAILURE
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_PLISTBUDDY
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_SPCTL_BIN
    OPENCLAW_JARVIS_RELEASE_CHECKPOINT_XCRUN_BIN
    OPENCLAW_JARVIS_RELEASE_INTENT_ACTION_FINGERPRINT
    OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE
    OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE
    OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH
    OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE
    OPENCLAW_JARVIS_RELEASE_INTENT_VALIDATED_ACTION_FINGERPRINT
    OPENCLAW_JARVIS_RELEASE_LOCK_CLAIMED_DIR
    OPENCLAW_JARVIS_RELEASE_LOCK_HELD
    OPENCLAW_JARVIS_RELEASE_LOCK_PARENT_PATH
    OPENCLAW_JARVIS_RELEASE_LOCK_PARENT_PID
    OPENCLAW_JARVIS_RELEASE_LOCK_PARENT_START
    OPENCLAW_JARVIS_RELEASE_LOCK_PARENT_TOKEN
    OPENCLAW_JARVIS_RELEASE_LOCK_PATH
    OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE
    OPENCLAW_JARVIS_RELEASE_LOCK_TOKEN
    OPENCLAW_JARVIS_RELEASE_LOCK_TRANSFER_PATH
    OPENCLAW_JARVIS_RELEASE_MANIFEST
    OPENCLAW_JARVIS_RELEASE_RECOVERY_OWNER
    OPENCLAW_JARVIS_RELEASE_SESSION_NAME
    OPENCLAW_JARVIS_RELEASE_STATE_ROOT
    OPENCLAW_JARVIS_RELEASE_TIMING_REPORT
    OPENCLAW_JARVIS_RELEASE_TMUX_BIN
    OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME
    JARVIS_RELEASE_DISK_AVAILABLE_KIB_OVERRIDE
    JARVIS_RELEASE_DISK_PROBE_COMMAND
    JARVIS_RELEASE_DISK_REQUIRED_KIB
    OPENCLAW_NOTARY_PREFLIGHT_ROUTE_STUB
    OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ROOT
    OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ID
    OPENCLAW_NOTARY_FINAL_POLL_INTENT_ROOT
    OPENCLAW_NOTARY_FINAL_POLL_INTENT_ID
    OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_ROUTE_STUB
    OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_CURL_STUB
    OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_TIMEOUT_SECS
  )

  # One shared marker proves shell startup hooks, credentials, and test bypasses
  # never enter tmux metadata. BASH_ENV points at a deliberately missing file:
  # the launcher Bash may inspect the name, but only the captured persistent
  # command is under test and it must unset the hook before its child starts.
  for env_name in "${control_env_vars[@]}"; do
    export "$env_name=ambient-release-control-value"
  done

  NOTARYTOOL_KEY='ambient-notary-secret-value' \
  SPARKLE_PRIVATE_KEY_FILE='ambient-sparkle-secret-value' \
  OPENCLAW_RELEASE_ENV_FILE='ambient-release-env-secret-value' \
  run_helper start -- \
    --release-intent fixture-intent \
    --github-release-tag 'v-test;still-one-argument' \
    >"$out"

  grep -q '^jarvis_public_release_session=started$' "$out" \
    || fail "start did not report the durable session"
  grep -q '^transport_authoritative=false$' "$out" \
    || fail "start implied tmux was release authority"
  grep -Fq "$ROOT_DIR/scripts/jarvis-public-release.sh" "$FAKE_COMMAND" \
    || fail "start did not pin execution to the canonical wrapper"
  grep -Fq 'new-session -d -E -e BASH_ENV= -e ENV= -e ZDOTDIR=/var/empty' "$FAKE_NEW_SESSION" \
    || fail "initial tmux pane did not neutralize shell startup hooks at creation"
  grep -Fq -- '-u OPENCLAW_RELEASE_ENV_LOADED' "$FAKE_COMMAND" \
    || fail "start did not clear the release-env loaded marker"
  grep -Fq -- '-u OPENCLAW_RELEASE_ENV_FILE' "$FAKE_COMMAND" \
    || fail "start did not force the canonical release-env path"
  grep -Fq -- '-u NOTARYTOOL_KEY' "$FAKE_COMMAND" \
    || fail "start did not scrub ambient notary credentials"
  grep -Fq -- '-u SPARKLE_PRIVATE_KEY_FILE' "$FAKE_COMMAND" \
    || fail "start did not scrub ambient Sparkle credentials"
  grep -Fq -- '-u ALLOW_SLOW_RELEASE_UPLOAD' "$FAKE_COMMAND" \
    || fail "start did not scrub ambient upload safety overrides"
  grep -Fq -- '-u OPENCLAW_RELEASE_ARTIFACT_RUN_ROOT' "$FAKE_COMMAND" \
    || fail "start did not scrub ambient artifact-root overrides"
  grep -Fq -- '-u CODESIGN_TIMESTAMP' "$FAKE_COMMAND" \
    || fail "start did not scrub ambient signing-mode overrides"
  for env_name in "${control_env_vars[@]}"; do
    grep -Fq -- "-u $env_name" "$FAKE_COMMAND" \
      || fail "start did not scrub ambient release control variable name: $env_name"
    grep -Fxq "$env_name" "$FAKE_ENV_UNSETS" \
      || fail "tmux session retained ambient release control variable: $env_name"
  done
  ! grep -Fq 'ambient-release-control-value' "$FAKE_COMMAND" \
    || fail "tmux command copied an ambient release control value"
  ! grep -Fq 'ambient-notary-secret-value' "$FAKE_COMMAND" \
    || fail "tmux command copied an ambient notary secret value"
  ! grep -Fq 'ambient-sparkle-secret-value' "$FAKE_COMMAND" \
    || fail "tmux command copied an ambient Sparkle secret value"
  ! grep -Fq 'ambient-release-env-secret-value' "$FAKE_COMMAND" \
    || fail "tmux command copied an ambient release-env override"
  grep -Fq 'v-test\;still-one-argument' "$FAKE_COMMAND" \
    || fail "start did not shell-quote a structured wrapper value"
  [[ "$(wc -l <"$FAKE_RESPAWNS" | tr -d ' ')" == "1" ]] \
    || fail "start spawned more than one worker"

  run_helper status >"$out"
  grep -q '^jarvis_public_release_session=running$' "$out" \
    || fail "status did not classify the surviving worker as running"

  set +e
  run_helper start -- --release-intent second-intent >"$out" 2>"$err"
  status=$?
  set -e
  [[ "$status" -eq 2 ]] || fail "duplicate start returned $status instead of 2"
  [[ "$(wc -l <"$FAKE_RESPAWNS" | tr -d ' ')" == "1" ]] \
    || fail "duplicate start created an uncontrolled second worker"
  pass "mocked start survives launcher return and duplicate start is rejected"
}

test_finished_status_log_and_clear() {
  local out="$TMP_DIR/status.out"
  local status

  printf '1:0\n' >"$FAKE_STATE"
  printf '%%2\n' >"$FAKE_ACTIVE_PANE"
  printf '1:%%1\n' >"$FAKE_ALL_STATES"
  printf 'recovery_command=bash scripts/jarvis-public-release.sh --authorize\n' >"$FAKE_LOG"
  run_helper status >"$out"
  grep -q '^jarvis_public_release_session=finished-success$' "$out" \
    || fail "status did not classify successful completion"
  run_helper log >"$out"
  grep -q '^transport_authoritative=false$' "$out" \
    || fail "log output implied tmux was release authority"
  grep -q '^recovery_command=' "$out" \
    || fail "log did not preserve wrapper recovery output"
  grep -q 'display:.*-t %1 ' "$FAKE_TARGETS" \
    || fail "status did not target the pinned original pane"
  grep -q 'capture:.*-t %1' "$FAKE_TARGETS" \
    || fail "log did not target the pinned original pane"

  # Even after the release pane exits, an extra running pane makes session
  # deletion unsafe. Clear must inspect every pane, not only the pinned one.
  printf '1:%%1\n0:%%2\n' >"$FAKE_ALL_STATES"
  set +e
  run_helper clear >"$out" 2>"$TMP_DIR/clear-running.err"
  status=$?
  set -e
  [[ "$status" -eq 2 ]] || fail "clear ignored an extra running pane"
  [[ -f "$FAKE_STATE" ]] || fail "clear killed a session with an extra running pane"
  printf '1:%%1\n1:%%2\n' >"$FAKE_ALL_STATES"
  run_helper clear >"$out"
  grep -q '^jarvis_public_release_session=cleared$' "$out" \
    || fail "clear did not remove the finished transport"

  set +e
  run_helper status >"$out"
  status=$?
  set -e
  [[ "$status" -eq 3 ]] || fail "missing status returned $status instead of 3"
  grep -q '^jarvis_public_release_session=missing$' "$out" \
    || fail "status did not classify a missing session"

  run_helper start -- --release-intent failing-intent >/dev/null
  printf '1:23\n' >"$FAKE_STATE"
  printf '1:%%1\n' >"$FAKE_ALL_STATES"
  run_helper status >"$out"
  grep -q '^jarvis_public_release_session=finished-failure$' "$out" \
    || fail "status did not classify failed completion"
  grep -q '^exit_status=23$' "$out" \
    || fail "status did not preserve the wrapper exit status"
  pass "status distinguishes success, failure, and missing while log preserves recovery output"
}

test_start_and_duplicate_guard
test_finished_status_log_and_clear

echo "All Jarvis public release session tests passed."
