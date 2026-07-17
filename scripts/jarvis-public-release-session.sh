#!/usr/bin/env bash
set -euo pipefail

# Durable terminal transport for the canonical Jarvis public-release wrapper.
# This helper deliberately owns no release state: intents, locks, checkpoints,
# phase selection, and recovery remain inside jarvis-public-release.sh.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/macos-release-gates.sh"

SESSION_NAME="${OPENCLAW_JARVIS_RELEASE_SESSION_NAME:-jarvis-public-release}"
TMUX_BIN="${OPENCLAW_JARVIS_RELEASE_TMUX_BIN:-tmux}"
PANE_OPTION="@openclaw_jarvis_release_pane_id"

# Persistent release execution must not inherit credentials, smoke switches, or
# stale state-path overrides from the launching shell or an old tmux server.
# The child keeps ordinary process context (HOME, PATH, locale) but clears every
# release input below so package-openclaw-mac-dist.sh reloads the canonical
# ~/Library/Application Support/OpenClaw/release.env deterministically.
RELEASE_ENV_VARS=(
  OPENCLAW_RELEASE_ENV_LOADED
  OPENCLAW_RELEASE_ENV_FILE
  OPENCLAW_JARVIS_RELEASE_INTENT_ACTION_FINGERPRINT
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT
  OPENCLAW_JARVIS_RELEASE_TIMING_REPORT
  OPENCLAW_JARVIS_PUBLIC_RELEASE_SUMMARY
  OPENCLAW_CONSUMER_INSTANCE_ID
  OPENCLAW_CONSUMER_DIST_HANDOFF_DIR
  OPENCLAW_CONSUMER_APP_BUILD_RECEIPT
  OPENCLAW_CONSUMER_FAST_PACKAGING
  OPENCLAW_CONSUMER_CLEAN_GIT_RUNTIME_CACHE
  OPENCLAW_BUILD_ARTIFACT_ROOT
  OPENCLAW_RELEASE_ARTIFACT_RUN_ROOT
  APP_NAME
  APP_BUNDLE_NAME
  APP_VERSION
  APP_BUILD
  BUILD_CONFIG
  BUILD_ARCHS
  BUNDLE_ID
  URL_SCHEME
  SIGN_IDENTITY
  SIGNING_AUTHORITY
  CODESIGN_TIMESTAMP
  DISABLE_LIBRARY_VALIDATION
  SKIP_TEAM_ID_CHECK
  SKIP_PNPM_INSTALL
  SKIP_NOTARIZE
  SKIP_DSYM
  ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE
  ALLOW_SINGLE_ARCH_CONSUMER_SMOKE
  ALLOW_COLD_RELEASE_LANE
  ALLOW_NON_INCREMENTAL_SPARKLE_BUILD
  ALLOW_SLOW_NOTARY_UPLOAD
  ALLOW_SLOW_RELEASE_UPLOAD
  VERSIONED_ARTIFACT_NAMES
  JARVIS_RELEASE_DISK_REQUIRED_KIB
  NOTARYTOOL_KEY
  NOTARYTOOL_KEY_ID
  NOTARYTOOL_ISSUER
  NOTARYTOOL_PROFILE
  NOTARYTOOL_SUBMIT_HEARTBEAT_SECS
  SPARKLE_FEED_URL
  SPARKLE_PUBLIC_ED_KEY
  SPARKLE_PRIVATE_KEY_FILE
  SPARKLE_EXPECTED_PUBLIC_ED_KEY
  GITHUB_RELEASE_REPO
  OPENCLAW_GITHUB_RELEASE_RETRY_ATTEMPTS
  OPENCLAW_GITHUB_RELEASE_RETRY_SLEEP_SECS
)

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
  local pane_id
  pane_id="$(release_pane_id)" || return 1
  "$TMUX_BIN" display-message -p -t "$pane_id" '#{pane_dead}:#{pane_dead_status}'
}

release_pane_id() {
  local pane_id
  pane_id="$("$TMUX_BIN" show-options -qv -t "$SESSION_NAME" "$PANE_OPTION")" || return 1
  case "$pane_id" in
    %*) printf '%s\n' "$pane_id" ;;
    *) return 1 ;;
  esac
}

session_has_running_pane() {
  local pane_states
  pane_states="$("$TMUX_BIN" list-panes -s -t "$SESSION_NAME" -F '#{pane_dead}:#{pane_id}')" \
    || return 2
  [[ -n "$pane_states" ]] || return 2
  if printf '%s\n' "$pane_states" | /usr/bin/grep -q '^0:'; then
    return 0
  fi
  return 1
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
  local pane_id
  local command_argv=(/usr/bin/env)
  local env_name
  for env_name in "${RELEASE_ENV_VARS[@]}"; do
    command_argv+=(-u "$env_name")
  done
  command_argv+=(/bin/bash "$ROOT_DIR/scripts/jarvis-public-release.sh" "$@")
  command_text="$(
    quote_cmd_exact "${command_argv[@]}"
  )"

  # Create an inert pane first, enable remain-on-exit, then replace it with the
  # wrapper. This avoids losing a fast-failing command before tmux can preserve
  # its exit status and scrollback.
  "$TMUX_BIN" new-session -d -s "$SESSION_NAME" -c "$ROOT_DIR"
  pane_id="$("$TMUX_BIN" display-message -p -t "$SESSION_NAME" '#{pane_id}')" || {
    "$TMUX_BIN" kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
    echo "ERROR: could not identify the durable Jarvis release pane." >&2
    exit 1
  }
  case "$pane_id" in
    %*) ;;
    *)
      "$TMUX_BIN" kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
      echo "ERROR: tmux returned an invalid durable release pane ID." >&2
      exit 1
      ;;
  esac
  # Store tmux's immutable pane ID on the session. Status/log must never follow
  # whichever pane an operator later makes active.
  if ! "$TMUX_BIN" set-option -t "$SESSION_NAME" "$PANE_OPTION" "$pane_id" \
    || ! "$TMUX_BIN" set-option -w -t "$pane_id" remain-on-exit on; then
    "$TMUX_BIN" kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
    echo "ERROR: could not configure the durable Jarvis release pane." >&2
    exit 1
  fi
  if ! "$TMUX_BIN" respawn-pane -k -t "$pane_id" "$command_text"; then
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
  if ! state="$(pane_state)"; then
    echo "ERROR: durable Jarvis release pane metadata is missing or invalid." >&2
    return 1
  fi
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
  local pane_id
  pane_id="$(release_pane_id)" || {
    echo "ERROR: durable Jarvis release pane metadata is missing or invalid." >&2
    exit 1
  }
  "$TMUX_BIN" capture-pane -p -S - -t "$pane_id"
}

clear_session() {
  if ! session_exists; then
    echo "jarvis_public_release_session=missing"
    return 0
  fi
  if session_has_running_pane; then
    echo "ERROR: refusing to clear a Jarvis public-release session while any pane is running." >&2
    exit 2
  else
    case "$?" in
      1) ;;
      *)
        echo "ERROR: could not prove every Jarvis public-release session pane is stopped; refusing clear." >&2
        exit 2
        ;;
    esac
  fi
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
