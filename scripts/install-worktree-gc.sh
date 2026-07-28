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
LAUNCHCTL_BIN="${OPENCLAW_WORKTREE_GC_LAUNCHCTL_BIN:-launchctl}"
MV_BIN="${OPENCLAW_WORKTREE_GC_MV_BIN:-mv}"

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
  macOS installs a LaunchAgent that runs scripts/disk-retention.sh --auto.
  Linux installs a crontab entry that runs the same pressure-aware coordinator.
  Runtime instances and ambiguous authenticated state remain outside automatic
  cleanup; only age-gated rebuildable artifacts and safely retired worktrees
  are eligible.
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

RETENTION_ARGS=(--auto --base-branch "$BASE_BRANCH")
if [[ "$INCLUDE_DETACHED" == "1" ]]; then
  RETENTION_ARGS+=(--include-detached)
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

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

render_xml_string() {
  printf '    <string>%s</string>\n' "$(xml_escape "$1")"
}

render_launchd_plist() {
  local plist_path="$1"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
$(render_xml_string "${SCHEDULE_REPO_ROOT}/scripts/disk-retention.sh")
$(for arg in "${RETENTION_ARGS[@]}"; do render_xml_string "$arg"; done)
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$SCHEDULE_REPO_ROOT")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>$(xml_escape "$INTERVAL_SECS")</integer>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$DEFAULT_LOG_OUT")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$DEFAULT_LOG_ERR")</string>
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
    "${SCHEDULE_REPO_ROOT}/scripts/disk-retention.sh" \
    "$BASE_BRANCH" \
    "$include_detached_flag" \
    "$DEFAULT_LOG_OUT" \
    "$DEFAULT_LOG_ERR" \
    "$LABEL"
}

launchctl_enabled_state() {
  local disabled_output="$1"
  local label_pattern
  label_pattern="\"${LABEL}\"[[:space:]]*=>[[:space:]]*"

  if printf '%s\n' "$disabled_output" | grep -E "${label_pattern}true([[:space:]]|$)" >/dev/null 2>&1; then
    printf 'disabled\n'
    return 0
  fi
  if printf '%s\n' "$disabled_output" | grep -E "${label_pattern}false([[:space:]]|$)" >/dev/null 2>&1; then
    printf 'enabled\n'
    return 0
  fi

  # launchctl omits services that have no persistent override; omitted means
  # enabled. Only an explicit boolean true represents disabled state.
  printf 'enabled\n'
}

rollback_macos_install() {
  local plist_path="$1"
  local backup_path="$2"
  local prior_plist="$3"
  local prior_loaded="$4"
  local prior_enabled_state="$5"
  local rollback_failed=0

  # Enable temporarily so a previously loaded job can be bootstrapped from its
  # restored plist. The final enable/disable command restores the exact prior
  # persistent override.
  "$LAUNCHCTL_BIN" enable "gui/${UID}/${LABEL}" >/dev/null 2>&1 || rollback_failed=1
  "$LAUNCHCTL_BIN" bootout "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true

  if [[ "$prior_plist" == "1" ]]; then
    if ! "$MV_BIN" "$backup_path" "$plist_path"; then
      rollback_failed=1
    fi
  elif ! rm -f "$plist_path"; then
    rollback_failed=1
  fi

  if [[ "$prior_loaded" == "1" && "$prior_plist" == "1" ]]; then
    "$LAUNCHCTL_BIN" bootstrap "gui/${UID}" "$plist_path" >/dev/null 2>&1 || rollback_failed=1
  fi

  if [[ "$prior_enabled_state" == "disabled" ]]; then
    "$LAUNCHCTL_BIN" disable "gui/${UID}/${LABEL}" >/dev/null 2>&1 || rollback_failed=1
  else
    "$LAUNCHCTL_BIN" enable "gui/${UID}/${LABEL}" >/dev/null 2>&1 || rollback_failed=1
  fi

  return "$rollback_failed"
}

install_macos() {
  local plist_path
  local plist_dir
  local staged_path=""
  local backup_path=""
  local prior_plist=0
  local prior_loaded=0
  local prior_enabled_state=""
  local disabled_output=""
  local launchctl_print_output=""
  local launchctl_print_status=0
  local failure_step=""
  plist_path="$(launchd_plist_path)"
  plist_dir="$(dirname "$plist_path")"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "dry_run=1"
    echo "platform=darwin"
    echo "repo_root=${SCHEDULE_REPO_ROOT}"
    echo "plist_path=${plist_path}"
    render_launchd_plist "$plist_path"
    return 0
  fi

  # The persistent disabled bit is part of the pre-install snapshot. Refuse to
  # mutate anything if launchctl cannot provide it because rollback would have
  # no trustworthy state to restore.
  if ! disabled_output="$("$LAUNCHCTL_BIN" print-disabled "gui/${UID}" 2>&1)"; then
    echo "Error: unable to inspect launchd enabled state; install not changed." >&2
    return 1
  fi
  prior_enabled_state="$(launchctl_enabled_state "$disabled_output")"

  if launchctl_print_output="$("$LAUNCHCTL_BIN" print "gui/${UID}/${LABEL}" 2>&1)"; then
    prior_loaded=1
  else
    launchctl_print_status=$?
    # launchctl uses 113 when a service is absent. Any other error leaves loaded
    # state unknown, so replacing the plist would make exact rollback impossible.
    if [[ "$launchctl_print_status" != "113" ]]; then
      echo "Error: unable to inspect launchd loaded state; install not changed." >&2
      return 1
    fi
  fi

  # A loaded job without a plist cannot be restored after replacement. Refuse
  # before writing anything rather than silently converting a live service into
  # an unrecoverable state.
  if [[ "$prior_loaded" == "1" && ! -f "$plist_path" ]]; then
    echo "Error: loaded launchd service has no plist snapshot; install not changed." >&2
    return 1
  fi

  mkdir -p "$plist_dir"
  staged_path="$(mktemp "${plist_path}.staged.XXXXXX")"
  if [[ -f "$plist_path" ]]; then
    prior_plist=1
    backup_path="$(mktemp "${plist_path}.backup.XXXXXX")"
    if ! cp -p "$plist_path" "$backup_path"; then
      rm -f "$staged_path" "$backup_path"
      echo "Error: unable to snapshot existing plist; install not changed." >&2
      return 1
    fi
  fi

  if ! render_launchd_plist "$plist_path" > "$staged_path"; then
    rm -f "$staged_path" "$backup_path"
    echo "Error: unable to stage launchd plist; install not changed." >&2
    return 1
  fi
  if ! chmod 644 "$staged_path"; then
    rm -f "$staged_path" "$backup_path"
    echo "Error: unable to set launchd plist permissions; install not changed." >&2
    return 1
  fi

  if ! "$MV_BIN" "$staged_path" "$plist_path"; then
    failure_step="plist-overwrite"
  elif ! "$LAUNCHCTL_BIN" enable "gui/${UID}/${LABEL}"; then
    failure_step="enable"
  elif [[ "$prior_loaded" == "1" ]] && ! "$LAUNCHCTL_BIN" bootout "gui/${UID}/${LABEL}" >/dev/null 2>&1; then
    failure_step="bootout"
  elif ! "$LAUNCHCTL_BIN" bootstrap "gui/${UID}" "$plist_path"; then
    failure_step="bootstrap"
  fi

  if [[ -n "$failure_step" ]]; then
    rm -f "$staged_path"
    if ! rollback_macos_install "$plist_path" "$backup_path" "$prior_plist" "$prior_loaded" "$prior_enabled_state"; then
      echo "Error: install failed at ${failure_step}; rollback was incomplete." >&2
    else
      echo "Error: install failed at ${failure_step}; prior launchd state restored." >&2
    fi
    rm -f "$backup_path"
    return 1
  fi

  rm -f "$backup_path"

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

  "$LAUNCHCTL_BIN" bootout "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
  rm -f "$plist_path"

  echo "uninstalled=1"
  echo "platform=darwin"
  echo "repo_root=${SCHEDULE_REPO_ROOT}"
  echo "plist_path=${plist_path}"
}

status_macos() {
  local plist_path
  local launchctl_output=""
  local disabled_output=""
  local status=0
  plist_path="$(launchd_plist_path)"
  echo "platform=darwin"
  echo "repo_root=${SCHEDULE_REPO_ROOT}"
  echo "plist_path=${plist_path}"
  if [[ -f "$plist_path" ]]; then
    echo "installed=yes"
  else
    echo "installed=no"
    status=1
  fi

  # Plist presence proves only that a file was written. Loaded state and the
  # persistent launchctl disabled bit are separate host truths and must both be
  # visible to operators.
  if launchctl_output="$("$LAUNCHCTL_BIN" print "gui/${UID}/${LABEL}" 2>&1)"; then
    echo "loaded=yes"
    printf '%s\n' "$launchctl_output"
  else
    echo "loaded=no"
    status=1
  fi

  if disabled_output="$("$LAUNCHCTL_BIN" print-disabled "gui/${UID}" 2>&1)"; then
    if [[ "$(launchctl_enabled_state "$disabled_output")" == "disabled" ]]; then
      echo "enabled=no"
      status=1
    else
      echo "enabled=yes"
    fi
  else
    echo "enabled=unknown"
    status=1
  fi

  return "$status"
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
    return 1
  fi
}

run_now() {
  (
    cd "$SCHEDULE_REPO_ROOT"
    bash scripts/disk-retention.sh "${RETENTION_ARGS[@]}"
  )
}

platform="${OPENCLAW_WORKTREE_GC_PLATFORM_OVERRIDE:-$(uname -s)}"
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
