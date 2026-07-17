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

cat >"$FAKE_TMUX" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "$1" in
  has-session)
    [[ -f "${FAKE_TMUX_STATE:?}" ]]
    ;;
  new-session)
    printf '0:0\n' >"$FAKE_TMUX_STATE"
    ;;
  set-option)
    ;;
  respawn-pane)
    printf '%s\n' "${!#}" >"${FAKE_TMUX_COMMAND:?}"
    printf 'respawn\n' >>"${FAKE_TMUX_RESPAWNS:?}"
    ;;
  display-message)
    cat "$FAKE_TMUX_STATE"
    ;;
  capture-pane)
    cat "${FAKE_TMUX_LOG:?}"
    ;;
  kill-session)
    rm -f "$FAKE_TMUX_STATE"
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
    /bin/bash "$ROOT_DIR/scripts/jarvis-public-release-session.sh" "$@"
}

test_start_and_duplicate_guard() {
  local out="$TMP_DIR/start.out"
  local err="$TMP_DIR/start.err"
  local status

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
  printf 'recovery_command=bash scripts/jarvis-public-release.sh --authorize\n' >"$FAKE_LOG"
  run_helper status >"$out"
  grep -q '^jarvis_public_release_session=finished-success$' "$out" \
    || fail "status did not classify successful completion"
  run_helper log >"$out"
  grep -q '^transport_authoritative=false$' "$out" \
    || fail "log output implied tmux was release authority"
  grep -q '^recovery_command=' "$out" \
    || fail "log did not preserve wrapper recovery output"
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
