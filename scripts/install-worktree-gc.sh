#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MAIN_REPO_DEFAULT="/Users/user/Programming_Projects/openclaw"
LABEL="ai.openclaw.worktree-gc"
DEFAULT_INTERVAL_SECS="${OPENCLAW_WORKTREE_GC_INTERVAL_SECS:-3600}"
DEFAULT_CRON_SCHEDULE="${OPENCLAW_WORKTREE_GC_CRON:-0 * * * *}"
DEFAULT_BASE_BRANCH="${OPENCLAW_WORKTREE_GC_BASE_BRANCH:-main}"
DEFAULT_LOG_OUT="/tmp/openclaw-worktree-gc.out.log"
DEFAULT_LOG_ERR="/tmp/openclaw-worktree-gc.err.log"
SCHEDULE_REPO_ROOT="${OPENCLAW_WORKTREE_GC_REPO_ROOT:-${OPENCLAW_MAIN_REPO:-$MAIN_REPO_DEFAULT}}"

# Trim leading/trailing whitespace for robust .env parsing.
trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Remove one pair of matching outer quotes if present.
strip_outer_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  printf '%s' "$value"
}

# Parse KEY=value (with optional "export") and return the normalized value.
parse_env_assignment() {
  local key="$1"
  local line="$2"
  local parsed=""
  if [[ "$line" =~ ^(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    parsed="$(trim "${BASH_REMATCH[2]}")"
    parsed="$(strip_outer_quotes "$parsed")"
  fi
  printf '%s' "$parsed"
}

# Return the last occurrence of KEY from an env-style file.
read_last_env_value() {
  local file_path="$1"
  local key="$2"
  local line=""
  local trimmed=""
  local parsed=""
  local last_value=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim "$line")"
    if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
      continue
    fi
    parsed="$(parse_env_assignment "$key" "$trimmed")"
    if [[ -n "$parsed" ]]; then
      last_value="$parsed"
    fi
  done < "$file_path"

  printf '%s' "$last_value"
}

# Mask token output so logs never leak full credentials.
mask_token() {
  local token="$1"
  local len=${#token}
  if (( len <= 4 )); then
    printf '****'
    return
  fi
  if (( len <= 8 )); then
    printf '%s...%s' "${token:0:1}" "${token:len-1:1}"
    return
  fi
  printf '%s...%s' "${token:0:4}" "${token:len-4:4}"
}

usage() {
  cat <<'EOF'
Usage:
  scripts/install-worktree-gc.sh install [--interval-secs <n>] [--cron "<expr>"] [--base-branch <branch>] [--include-detached] [--dry-run]
  scripts/install-worktree-gc.sh uninstall [--dry-run]
  scripts/install-worktree-gc.sh status
  scripts/install-worktree-gc.sh run-now [--base-branch <branch>] [--include-detached]

Behavior:
  macOS installs a LaunchAgent that runs scripts/gc-worktrees.sh --auto on a timer.
  Linux installs a crontab entry that runs the same command on a cron schedule.
EOF
}

COMMAND="${1:-status}"
if [[ $# -gt 0 ]]; then
  shift
fi

INTERVAL_SECS="$DEFAULT_INTERVAL_SECS"
CRON_SCHEDULE="$DEFAULT_CRON_SCHEDULE"
BASE_BRANCH="$DEFAULT_BASE_BRANCH"
INCLUDE_DETACHED=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval-secs)
      if [[ $# -lt 2 ]]; then
        echo "Error: --interval-secs requires a value." >&2
        exit 1
      fi
      INTERVAL_SECS="$2"
      shift 2
      ;;
    --cron)
      if [[ $# -lt 2 ]]; then
        echo "Error: --cron requires a value." >&2
        exit 1
      fi
      CRON_SCHEDULE="$2"
      shift 2
      ;;
    --base-branch)
      if [[ $# -lt 2 ]]; then
        echo "Error: --base-branch requires a value." >&2
        exit 1
      fi
      BASE_BRANCH="$2"
      shift 2
      ;;
    --include-detached)
      INCLUDE_DETACHED=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! "$INTERVAL_SECS" =~ ^[0-9]+$ ]] || (( INTERVAL_SECS <= 0 )); then
  echo "Error: --interval-secs must be a positive integer." >&2
  exit 1
fi

GC_ARGS=(--auto --base-branch "$BASE_BRANCH")
if [[ "$INCLUDE_DETACHED" == "1" ]]; then
  GC_ARGS+=(--include-detached)
fi

# The scheduled GC job should normally anchor to the main checkout, not the
# transient feature worktree that happened to run the installer. That keeps the
# scheduler alive after the current worktree is deleted. Fall back to the
# current checkout only if the preferred main repo path is missing.
if [[ ! -d "$SCHEDULE_REPO_ROOT" ]]; then
  SCHEDULE_REPO_ROOT="$REPO_ROOT"
fi

launchd_plist_path() {
  printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$LABEL"
}

render_launchd_plist() {
  local plist_path="$1"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${SCHEDULE_REPO_ROOT}/scripts/gc-worktrees.sh</string>
$(for arg in "${GC_ARGS[@]}"; do printf '    <string>%s</string>\n' "$arg"; done)
  </array>
  <key>WorkingDirectory</key>
  <string>${SCHEDULE_REPO_ROOT}</string>
  <key>StartInterval</key>
  <integer>${INTERVAL_SECS}</integer>
  <key>StandardOutPath</key>
  <string>${DEFAULT_LOG_OUT}</string>
  <key>StandardErrorPath</key>
  <string>${DEFAULT_LOG_ERR}</string>
</dict>
</plist>
EOF
}

render_cron_entry() {
  local include_detached_flag=""
  if [[ "$INCLUDE_DETACHED" == "1" ]]; then
    include_detached_flag=" --include-detached"
  fi
  printf '%s cd %q && /bin/bash %q --auto --base-branch %q%s >>%q 2>>%q # %s\n' \
    "$CRON_SCHEDULE" \
    "$SCHEDULE_REPO_ROOT" \
    "${SCHEDULE_REPO_ROOT}/scripts/gc-worktrees.sh" \
    "$BASE_BRANCH" \
    "$include_detached_flag" \
    "$DEFAULT_LOG_OUT" \
    "$DEFAULT_LOG_ERR" \
    "$LABEL"
}

install_macos() {
  local plist_path
  plist_path="$(launchd_plist_path)"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "dry_run=1"
    echo "platform=darwin"
    echo "repo_root=${SCHEDULE_REPO_ROOT}"
    echo "plist_path=${plist_path}"
    render_launchd_plist "$plist_path"
    return 0
  fi

  mkdir -p "$(dirname "$plist_path")"
  render_launchd_plist "$plist_path" > "$plist_path"

  launchctl bootout "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/${UID}" "$plist_path"

  echo "installed=1"
  echo "platform=darwin"
  echo "repo_root=${SCHEDULE_REPO_ROOT}"
  echo "label=${LABEL}"
  echo "plist_path=${plist_path}"
}

uninstall_macos() {
  local plist_path
  plist_path="$(launchd_plist_path)"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "dry_run=1"
    echo "platform=darwin"
    echo "repo_root=${SCHEDULE_REPO_ROOT}"
    echo "plist_path=${plist_path}"
    return 0
  fi

  launchctl bootout "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
  rm -f "$plist_path"

  echo "uninstalled=1"
  echo "platform=darwin"
  echo "repo_root=${SCHEDULE_REPO_ROOT}"
  echo "plist_path=${plist_path}"
}

status_macos() {
  local plist_path
  plist_path="$(launchd_plist_path)"
  echo "platform=darwin"
  echo "repo_root=${SCHEDULE_REPO_ROOT}"
  echo "plist_path=${plist_path}"
  if [[ -f "$plist_path" ]]; then
    echo "installed=yes"
  else
    echo "installed=no"
  fi
  launchctl print "gui/${UID}/${LABEL}" 2>/dev/null || true
}

install_linux() {
  local entry
  entry="$(render_cron_entry)"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "dry_run=1"
    echo "platform=linux"
    echo "repo_root=${SCHEDULE_REPO_ROOT}"
    printf '%s' "$entry"
    return 0
  fi

  local current_crontab
  current_crontab="$(crontab -l 2>/dev/null || true)"
  {
    printf '%s\n' "$current_crontab" | sed "/# ${LABEL//\//\\/}$/d"
    printf '%s' "$entry"
  } | crontab -

  echo "installed=1"
  echo "platform=linux"
  echo "repo_root=${SCHEDULE_REPO_ROOT}"
  printf '%s' "$entry"
}

uninstall_linux() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "dry_run=1"
    echo "platform=linux"
    echo "repo_root=${SCHEDULE_REPO_ROOT}"
    echo "label=${LABEL}"
    return 0
  fi

  local current_crontab
  current_crontab="$(crontab -l 2>/dev/null || true)"
  printf '%s\n' "$current_crontab" | sed "/# ${LABEL//\//\\/}$/d" | crontab -

  echo "uninstalled=1"
  echo "platform=linux"
  echo "repo_root=${SCHEDULE_REPO_ROOT}"
}

status_linux() {
  echo "platform=linux"
  echo "repo_root=${SCHEDULE_REPO_ROOT}"
  local current_crontab
  current_crontab="$(crontab -l 2>/dev/null || true)"
  if printf '%s\n' "$current_crontab" | grep -F "# ${LABEL}" >/dev/null 2>&1; then
    echo "installed=yes"
    printf '%s\n' "$current_crontab" | grep -F "# ${LABEL}"
  else
    echo "installed=no"
  fi
}

run_now() {
  (
    cd "$SCHEDULE_REPO_ROOT"
    bash scripts/gc-worktrees.sh "${GC_ARGS[@]}"
  )
}

platform="$(uname -s)"
case "$COMMAND" in
  install)
    case "$platform" in
      Darwin) install_macos ;;
      Linux) install_linux ;;
      *)
        echo "Error: unsupported platform for install: ${platform}" >&2
        exit 1
        ;;
    esac
    ;;
  uninstall)
    case "$platform" in
      Darwin) uninstall_macos ;;
      Linux) uninstall_linux ;;
      *)
        echo "Error: unsupported platform for uninstall: ${platform}" >&2
        exit 1
        ;;
    esac
    ;;
  status)
    case "$platform" in
      Darwin) status_macos ;;
      Linux) status_linux ;;
      *)
        echo "platform=${platform}"
        echo "installed=unknown"
        ;;
    esac
    ;;
  run-now)
    run_now
    ;;
  *)
    echo "Error: unknown command: ${COMMAND}" >&2
    usage >&2
    exit 1
    ;;
esac
