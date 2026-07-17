#!/usr/bin/env bash
set -euo pipefail

# Durable terminal transport for the canonical Jarvis public-release wrapper.
# This helper deliberately owns no release state: intents, locks, checkpoints,
# phase selection, and recovery remain inside jarvis-public-release.sh.

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
if [[ "$SCRIPT_DIR" == "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="."
fi
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Durable release execution uses a fixed macOS tool search path. The two
# Homebrew prefixes cover native Apple Silicon and Intel/Rosetta installs;
# system directories cover the macOS release, signing, and shell tools. Never
# append the launcher's PATH because tmux persists that environment after the
# launching terminal has gone away.
TRUSTED_RELEASE_PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin"
# The launcher performs its gates and tmux operations with the same fixed path
# that the persistent pane receives. This also prevents ambient command
# shadowing before the release wrapper starts.
export PATH="$TRUSTED_RELEASE_PATH"

source "$ROOT_DIR/scripts/lib/macos-release-gates.sh"

SESSION_NAME="${OPENCLAW_JARVIS_RELEASE_SESSION_NAME:-jarvis-public-release}"
TMUX_BIN="${OPENCLAW_JARVIS_RELEASE_TMUX_BIN:-tmux}"
PANE_OPTION="@openclaw_jarvis_release_pane_id"

# Persistent release execution must not inherit credentials, smoke switches, or
# authority-changing test seams from the launching shell or an old tmux server.
# Keep this list explicit: /usr/bin/env receives names only, so neither tmux's
# command metadata nor test failures can disclose an ambient secret value.
RELEASE_ENV_VARS=(
  # Bash reads BASH_ENV before executing a non-interactive child script. Scrub
  # both shell startup hooks before the persistent child starts so an ambient
  # file cannot restore credentials or test seams after the remaining unsets.
  BASH_ENV
  ENV
  ZDOTDIR
  # GitHub CLI environment auth and host selection must come from the canonical
  # release.env loaded by the packaging lane, never from the launcher or tmux
  # server environment.
  GH_TOKEN
  GITHUB_TOKEN
  GH_ENTERPRISE_TOKEN
  GITHUB_ENTERPRISE_TOKEN
  GH_HOST
  OPENCLAW_RELEASE_ENV_LOADED
  OPENCLAW_RELEASE_ENV_FILE
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
  OPENCLAW_JARVIS_PUBLIC_RELEASE_SUMMARY
  OPENCLAW_CONSUMER_INSTANCE_ID
  OPENCLAW_CONSUMER_DIST_HANDOFF_DIR
  OPENCLAW_CONSUMER_APP_BUILD_RECEIPT
  OPENCLAW_CONSUMER_FAST_PACKAGING
  OPENCLAW_CONSUMER_CLEAN_GIT_RUNTIME_CACHE
  OPENCLAW_BUILD_ARTIFACT_ROOT
  OPENCLAW_RELEASE_ARTIFACT_RUN_ROOT
  # These hooks bypass production route checks or alter final intent guards.
  # They are valid only in synthetic tests and must never reach a durable
  # release child through ambient tmux state.
  OPENCLAW_NOTARY_PREFLIGHT_ROUTE_STUB
  OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ROOT
  OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ID
  OPENCLAW_NOTARY_FINAL_POLL_INTENT_ROOT
  OPENCLAW_NOTARY_FINAL_POLL_INTENT_ID
  OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_ROUTE_STUB
  OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_CURL_STUB
  OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_TIMEOUT_SECS
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
  JARVIS_RELEASE_DISK_AVAILABLE_KIB_OVERRIDE
  JARVIS_RELEASE_DISK_PROBE_COMMAND
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

trusted_account_home() {
  local account_name account_uid
  local metadata metadata_home metadata_name metadata_uid
  local directory_uid

  # HOME is launcher-controlled input. Resolve the current login account from
  # the kernel identity and trusted macOS account metadata instead.
  account_uid="$(/usr/bin/id -u)" || {
    echo "ERROR: could not determine the current macOS account ID." >&2
    return 1
  }
  account_name="$(/usr/bin/id -un)" || {
    echo "ERROR: could not determine the current macOS account name." >&2
    return 1
  }
  case "$account_name" in
    ''|*[!A-Za-z0-9._-]*)
      echo "ERROR: current macOS account name is not safe for account lookup." >&2
      return 1
      ;;
  esac
  [[ "$(/usr/bin/id -u "$account_name" 2>/dev/null)" == "$account_uid" ]] || {
    echo "ERROR: current macOS account name and ID are inconsistent." >&2
    return 1
  }

  metadata="$(/usr/bin/dscacheutil -q user -a uid "$account_uid" 2>/dev/null)" || {
    echo "ERROR: could not read the current macOS account home from account metadata." >&2
    return 1
  }
  metadata_home="$(printf '%s\n' "$metadata" | /usr/bin/awk \
    '/^dir: / { sub(/^dir: /, ""); print; found++ } END { if (found != 1) exit 1 }')" || {
    echo "ERROR: current macOS account has invalid home-directory metadata." >&2
    return 1
  }
  metadata_uid="$(printf '%s\n' "$metadata" | /usr/bin/awk \
    '/^uid: / { print $2; found++ } END { if (found != 1) exit 1 }')" || {
    echo "ERROR: current macOS account has invalid ID metadata." >&2
    return 1
  }
  metadata_name="$(printf '%s\n' "$metadata" | /usr/bin/awk \
    '/^name: / { print $2; found++ } END { if (found != 1) exit 1 }')" || {
    echo "ERROR: current macOS account has invalid name metadata." >&2
    return 1
  }
  [[ "$metadata_name" == "$account_name" ]] || {
    echo "ERROR: macOS account metadata does not match the current account name." >&2
    return 1
  }
  [[ "$metadata_uid" == "$account_uid" ]] || {
    echo "ERROR: macOS account metadata does not match the current account ID." >&2
    return 1
  }
  case "$metadata_home" in
    /*) ;;
    *)
      echo "ERROR: current macOS account home is not an absolute path." >&2
      return 1
      ;;
  esac
  [[ -d "$metadata_home" ]] || {
    echo "ERROR: current macOS account home directory does not exist." >&2
    return 1
  }
  directory_uid="$(/usr/bin/stat -f '%u' "$metadata_home" 2>/dev/null)" || {
    echo "ERROR: could not validate current macOS account home ownership." >&2
    return 1
  }
  [[ "$directory_uid" == "$account_uid" ]] || {
    echo "ERROR: current macOS account does not own its metadata-defined home." >&2
    return 1
  }

  printf '%s\n' "$metadata_home"
}

require_tmux() {
  local resolved_git
  local resolved_tmux

  case "$SESSION_NAME" in
    ''|*[!A-Za-z0-9_-]*)
      echo "ERROR: Jarvis release session name must use only letters, numbers, underscores, or hyphens." >&2
      exit 1
      ;;
  esac
  resolved_tmux="$(PATH="$TRUSTED_RELEASE_PATH" command -v "$TMUX_BIN" 2>/dev/null)" || {
    echo "ERROR: tmux is required for the durable Jarvis release session." >&2
    exit 1
  }
  case "$resolved_tmux" in
    /*) ;;
    *)
      echo "ERROR: tmux did not resolve to an absolute executable path." >&2
      exit 1
      ;;
  esac
  [[ -x "$resolved_tmux" && -x /usr/bin/env && -x /bin/bash ]] || {
    echo "ERROR: durable Jarvis release entrypoint dependencies are unavailable." >&2
    exit 1
  }
  resolved_git="$(PATH="$TRUSTED_RELEASE_PATH" command -v git 2>/dev/null)" || {
    echo "ERROR: git is unavailable on the fixed Jarvis release tool path." >&2
    exit 1
  }
  [[ "$resolved_git" == /* && -x "$resolved_git" ]] || {
    echo "ERROR: git did not resolve to a trusted executable path." >&2
    exit 1
  }
  TMUX_BIN="$resolved_tmux"
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
  local trusted_home

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

  # Pin HOME before any worktree gate. Shared gate helpers may derive paths
  # from HOME, so even pre-tmux checks must not observe the launcher's value.
  trusted_home="$(trusted_account_home)" || exit 1
  export HOME="$trusted_home"

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
  # Explicit assignments make the release wrapper, release.env lookup, and
  # every descendant use the same trusted account home and fixed tool path.
  # They also defend against future tmux environment behavior changes.
  command_argv+=(
    "HOME=$trusted_home"
    "PATH=$TRUSTED_RELEASE_PATH"
    /bin/bash "$ROOT_DIR/scripts/jarvis-public-release.sh" "$@"
  )
  command_text="$(
    quote_cmd_exact "${command_argv[@]}"
  )"

  # Create an inert pane first, enable remain-on-exit, then replace it with the
  # wrapper. This avoids losing a fast-failing command before tmux can preserve
  # its exit status and scrollback.
  # The first inert pane exists before session-level unsets are possible.
  # Disable tmux update-environment and neutralize non-interactive Bash/POSIX
  # hooks plus zsh's startup-file directory at creation, using only fixed empty
  # or system paths. This closes the pre-respawn startup window without
  # mutating the shared tmux server's global environment.
  "$TMUX_BIN" new-session -d -E \
    -e BASH_ENV= \
    -e ENV= \
    -e ZDOTDIR=/var/empty \
    -e "HOME=$trusted_home" \
    -e "PATH=$TRUSTED_RELEASE_PATH" \
    -s "$SESSION_NAME" \
    -c "$ROOT_DIR"
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

  # tmux evaluates the respawn command through a new pane shell. Remove every
  # controlled value from the session environment before that respawn shell
  # exists. Keep the command-side unsets too as defense in depth.
  for env_name in "${RELEASE_ENV_VARS[@]}"; do
    if ! "$TMUX_BIN" set-environment -u -t "$SESSION_NAME" "$env_name"; then
      "$TMUX_BIN" kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
      echo "ERROR: could not sanitize the durable Jarvis release environment." >&2
      exit 1
    fi
  done
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
