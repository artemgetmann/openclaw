#!/usr/bin/env bash
set -euo pipefail

# Durable terminal transport for the canonical Jarvis public-release wrapper.
# This helper deliberately owns no release state: intents, locks, checkpoints,
# phase selection, and recovery remain inside jarvis-public-release.sh.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/macos-release-gates.sh"

SESSION_NAME="${OPENCLAW_JARVIS_RELEASE_SESSION_NAME:-jarvis-public-release}"
TMUX_BIN="${OPENCLAW_JARVIS_RELEASE_TMUX_BIN:-tmux}"
# Target the session's active pane rather than assuming tmux base-index 0.
# Operators commonly configure windows/panes to start at 1.
PANE_TARGET="$SESSION_NAME"

usage() {
  cat <<'EOF'
Usage:
  scripts/jarvis-public-release-session.sh start -- <jarvis-public-release args...>
  scripts/jarvis-public-release-session.sh status
  scripts/jarvis-public-release-session.sh attach
  scripts/jarvis-public-release-session.sh log
  scripts/jarvis-public-release-session.sh clear

Run `start` with only the arguments that follow
`scripts/jarvis-public-release.sh` in an authorized persistent_command. The
fixed command is always the repository's canonical public-release wrapper.

tmux status and scrollback are transport evidence only. Release authority and
recovery come exclusively from the wrapper's intent, lock, checkpoints, and
printed recovery_command.
EOF
}

quote_cmd_exact() {
  local separator=""
  local arg

  # tmux starts a shell command string. Construct that string from argv with
  # shell quoting so a tag or intent value can never become executable syntax.
  for arg in "$@"; do
    printf '%s' "$separator"
    printf '%q' "$arg"
    separator=" "
  done
  printf '\n'
}

require_tmux() {
  case "$SESSION_NAME" in
    ''|*[!A-Za-z0-9_-]*)
      echo "ERROR: Jarvis release session name must use only letters, numbers, underscores, or hyphens." >&2
      exit 1
      ;;
  esac
  if ! command -v "$TMUX_BIN" >/dev/null 2>&1; then
    echo "ERROR: tmux is required for the durable Jarvis release session." >&2
    exit 1
  fi
}

session_exists() {
  "$TMUX_BIN" has-session -t "$SESSION_NAME" >/dev/null 2>&1
}

pane_state() {
  "$TMUX_BIN" display-message -p -t "$PANE_TARGET" '#{pane_dead}:#{pane_dead_status}'
}

print_recovery_instructions() {
  cat <<EOF
session_name=$SESSION_NAME
status_command=bash scripts/jarvis-public-release-session.sh status
attach_command=bash scripts/jarvis-public-release-session.sh attach
log_command=bash scripts/jarvis-public-release-session.sh log
release_recovery=use only the recovery_command printed in tmux scrollback
transport_authoritative=false
EOF
}

start_session() {
  if [[ "${1:-}" != "--" ]]; then
    echo "ERROR: start requires -- followed by jarvis-public-release wrapper arguments." >&2
    usage >&2
    exit 1
  fi
  shift
  if [[ "$#" -eq 0 ]]; then
    echo "ERROR: start requires at least one jarvis-public-release wrapper argument." >&2
    exit 1
  fi

  # Keep the release lane gate ahead of tmux creation. The tmux child still
  # enters the same fixed checkout and the wrapper repeats every authoritative
  # prewarm, intent, lock, checkpoint, and mutation gate.
  openclaw_require_jarvis_release_worktree "$ROOT_DIR"
  if session_exists; then
    echo "ERROR: Jarvis public-release session already exists." >&2
    print_recovery_instructions >&2
    exit 2
  fi

  local command_text
  command_text="$(
    quote_cmd_exact /bin/bash "$ROOT_DIR/scripts/jarvis-public-release.sh" "$@"
  )"

  # Create an inert pane first, enable remain-on-exit, then replace it with the
  # wrapper. This avoids losing a fast-failing command before tmux can preserve
  # its exit status and scrollback.
  "$TMUX_BIN" new-session -d -s "$SESSION_NAME" -c "$ROOT_DIR"
  if ! "$TMUX_BIN" set-option -w -t "$PANE_TARGET" remain-on-exit on; then
    "$TMUX_BIN" kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
    echo "ERROR: could not configure the durable Jarvis release pane." >&2
    exit 1
  fi
  if ! "$TMUX_BIN" respawn-pane -k -t "$PANE_TARGET" "$command_text"; then
    "$TMUX_BIN" kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
    echo "ERROR: could not start the canonical Jarvis public-release wrapper." >&2
    exit 1
  fi

  echo "jarvis_public_release_session=started"
  print_recovery_instructions
}

status_session() {
  if ! session_exists; then
    echo "jarvis_public_release_session=missing"
    echo "transport_authoritative=false"
    return 3
  fi

  local state
  state="$(pane_state)"
  case "$state" in
    0:*)
      echo "jarvis_public_release_session=running"
      ;;
    1:0)
      echo "jarvis_public_release_session=finished-success"
      echo "exit_status=0"
      ;;
    1:*)
      echo "jarvis_public_release_session=finished-failure"
      echo "exit_status=${state#1:}"
      ;;
    *)
      echo "ERROR: could not classify tmux pane state: $state" >&2
      return 1
      ;;
  esac
  echo "transport_authoritative=false"
}

attach_session() {
  if ! session_exists; then
    echo "ERROR: Jarvis public-release session is missing." >&2
    exit 3
  fi
  exec "$TMUX_BIN" attach-session -t "$SESSION_NAME"
}

log_session() {
  if ! session_exists; then
    echo "ERROR: Jarvis public-release session is missing." >&2
    exit 3
  fi
  echo "transport_authoritative=false"
  "$TMUX_BIN" capture-pane -p -S - -t "$PANE_TARGET"
}

clear_session() {
  if ! session_exists; then
    echo "jarvis_public_release_session=missing"
    return 0
  fi
  case "$(pane_state)" in
    0:*)
      echo "ERROR: refusing to clear a running Jarvis public-release session." >&2
      exit 2
      ;;
  esac
  "$TMUX_BIN" kill-session -t "$SESSION_NAME"
  echo "jarvis_public_release_session=cleared"
}

require_tmux
case "${1:-}" in
  start)
    shift
    start_session "$@"
    ;;
  status)
    [[ "$#" -eq 1 ]] || { usage >&2; exit 1; }
    status_session
    ;;
  attach)
    [[ "$#" -eq 1 ]] || { usage >&2; exit 1; }
    attach_session
    ;;
  log)
    [[ "$#" -eq 1 ]] || { usage >&2; exit 1; }
    log_session
    ;;
  clear)
    [[ "$#" -eq 1 ]] || { usage >&2; exit 1; }
    clear_session
    ;;
  --help|-h)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
