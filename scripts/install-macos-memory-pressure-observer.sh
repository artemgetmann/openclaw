#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MAIN_REPO="${OPENCLAW_MAIN_REPO:-/Users/user/Programming_Projects/openclaw}"
LABEL="ai.jarvis.memory-pressure-observer"
INTERVAL_SECS="${OPENCLAW_MEMORY_OBSERVER_INTERVAL_SECS:-300}"
LAUNCHCTL_BIN="${OPENCLAW_MEMORY_OBSERVER_LAUNCHCTL_BIN:-/bin/launchctl}"
PLIST_BUDDY_BIN="${OPENCLAW_MEMORY_OBSERVER_PLIST_BUDDY_BIN:-/usr/libexec/PlistBuddy}"
PLUTIL_BIN="${OPENCLAW_MEMORY_OBSERVER_PLUTIL_BIN:-/usr/bin/plutil}"
PLIST_PATH="${OPENCLAW_MEMORY_OBSERVER_PLIST_PATH:-${HOME}/Library/LaunchAgents/${LABEL}.plist}"
STATE_PATH="${OPENCLAW_MEMORY_OBSERVER_STATE_PATH:-${HOME}/Library/Application Support/Jarvis/.jarvis/ops/memory-pressure-observer/state.json}"
INSTALL_DIR="${OPENCLAW_MEMORY_OBSERVER_INSTALL_DIR:-${HOME}/Library/Application Support/Jarvis/.jarvis/ops/memory-pressure-observer}"
LOG_OUT="${OPENCLAW_MEMORY_OBSERVER_LOG_OUT:-/tmp/jarvis-memory-pressure-observer.out.log}"
LOG_ERR="${OPENCLAW_MEMORY_OBSERVER_LOG_ERR:-/tmp/jarvis-memory-pressure-observer.err.log}"
THREAD_ID="${OPENCLAW_MEMORY_OBSERVER_THREAD_ID:-}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/install-macos-memory-pressure-observer.sh <install|uninstall|status|run-now> [--dry-run] [--interval-secs N]
EOF
}

COMMAND="${1:-status}"
if [[ $# -gt 0 ]]; then shift; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --interval-secs) INTERVAL_SECS="${2:?missing interval}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done
[[ "$INTERVAL_SECS" == "300" ]] || {
  echo "--interval-secs is fixed at 300 to preserve confirmation durations" >&2
  exit 1
}
if [[ -n "$THREAD_ID" && ( ! "$THREAD_ID" =~ ^[0-9]+$ || "$THREAD_ID" == "0" ) ]]; then
  echo "OPENCLAW_MEMORY_OBSERVER_THREAD_ID must be a positive integer" >&2
  exit 1
fi
if [[ "$COMMAND" == "install" && -z "$THREAD_ID" ]]; then
  echo "OPENCLAW_MEMORY_OBSERVER_THREAD_ID is required for install" >&2
  exit 1
fi
# Rendering an install plan is platform-neutral and is exercised by Linux CI.
# Every command that reads or mutates the actual service remains macOS-only.
if [[ "$(uname -s)" != "Darwin" && ! ( "$COMMAND" == "install" && "$DRY_RUN" == "1" ) ]]; then
  echo "This observer supports macOS only." >&2
  exit 1
fi

SCHEDULE_ROOT="$MAIN_REPO"
[[ -d "$SCHEDULE_ROOT/.git" ]] || SCHEDULE_ROOT="$REPO_ROOT"
OBSERVER_SOURCE="${REPO_ROOT}/scripts/macos-memory-pressure-observer.mjs"
OBSERVER="${INSTALL_DIR}/macos-memory-pressure-observer.mjs"
# launchd does not inherit the interactive shell PATH. Resolve and persist the
# exact repository-supported Node binary instead of hoping `env node` works.
source "${SCHEDULE_ROOT}/scripts/lib/validated-node.sh"
NODE_BIN=""

resolve_node() {
  if [[ -z "$NODE_BIN" ]]; then
    NODE_BIN="$(openclaw_resolve_validated_node_bin "$SCHEDULE_ROOT")"
  fi
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"; value="${value//</&lt;}"; value="${value//>/&gt;}"
  value="${value//\"/&quot;}"; value="${value//\'/&apos;}"
  printf '%s' "$value"
}

render_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>$(xml_escape "$OBSERVER")</string>
    <string>--state-path</string><string>$(xml_escape "$STATE_PATH")</string>
EOF
  # Keep the personal Telegram destination explicit in the installed job. The
  # portable source has no baked-in chat or topic identifier.
  if [[ -n "$THREAD_ID" ]]; then
    printf '    <string>--thread-id</string><string>%s</string>\n' "$(xml_escape "$THREAD_ID")"
  fi
  cat <<EOF
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$INSTALL_DIR")</string>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${INTERVAL_SECS}</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG_OUT")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG_ERR")</string>
</dict></plist>
EOF
}

read_installed_thread_id() {
  [[ -f "$PLIST_PATH" ]] || return 0
  "$PLIST_BUDDY_BIN" -c 'Print :ProgramArguments' "$PLIST_PATH" 2>/dev/null |
    awk '/--thread-id/ { getline; gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit }'
}

install_job() {
  resolve_node
  if (( DRY_RUN )); then
    echo "dry_run=1 label=${LABEL} plist=${PLIST_PATH} interval_secs=${INTERVAL_SECS} thread_id=${THREAD_ID:-wrapper-default}"
    render_plist
    return
  fi
  [[ -f "$OBSERVER_SOURCE" ]] || { echo "Observer source missing: $OBSERVER_SOURCE" >&2; exit 1; }
  mkdir -p "$(dirname "$PLIST_PATH")" "$INSTALL_DIR"
  chmod 700 "$INSTALL_DIR"
  local staged backup="" observer_staged observer_backup="" prior_loaded=0
  staged="$(mktemp "${PLIST_PATH}.staged.XXXXXX")"
  observer_staged="$(mktemp "${INSTALL_DIR}/observer.staged.XXXXXX")"
  render_plist >"$staged"
  chmod 600 "$staged"
  "$PLUTIL_BIN" -lint "$staged" >/dev/null
  cp "$OBSERVER_SOURCE" "$observer_staged"
  chmod 700 "$observer_staged"
  "$NODE_BIN" --input-type=module --check <"$observer_staged"
  if [[ -f "$PLIST_PATH" ]]; then
    backup="$(mktemp "${PLIST_PATH}.backup.XXXXXX")"
    cp -p "$PLIST_PATH" "$backup"
  fi
  if [[ -f "$OBSERVER" ]]; then
    observer_backup="$(mktemp "${INSTALL_DIR}/observer.backup.XXXXXX")"
    cp -p "$OBSERVER" "$observer_backup"
  fi
  if "$LAUNCHCTL_BIN" print "gui/${UID}/${LABEL}" >/dev/null 2>&1; then prior_loaded=1; fi
  "$LAUNCHCTL_BIN" bootout "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
  # Once the old job is stopped, every replacement step belongs to one guarded
  # transaction. Any failure restores both files and reloads the prior job.
  if ! mv "$observer_staged" "$OBSERVER" ||
    ! mv "$staged" "$PLIST_PATH" ||
    ! "$LAUNCHCTL_BIN" enable "gui/${UID}/${LABEL}" >/dev/null ||
    ! "$LAUNCHCTL_BIN" bootstrap "gui/${UID}" "$PLIST_PATH"; then
    "$LAUNCHCTL_BIN" bootout "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
    if [[ -n "$backup" ]]; then mv "$backup" "$PLIST_PATH"; else rm -f "$PLIST_PATH"; fi
    if [[ -n "$observer_backup" ]]; then mv "$observer_backup" "$OBSERVER"; else rm -f "$OBSERVER"; fi
    if (( prior_loaded )) && [[ -f "$PLIST_PATH" ]]; then
      "$LAUNCHCTL_BIN" bootstrap "gui/${UID}" "$PLIST_PATH" >/dev/null 2>&1 || true
    fi
    echo "Install failed; prior plist restored." >&2
    exit 1
  fi
  rm -f "$backup" "$observer_backup"
  echo "installed=1 label=${LABEL} interval_secs=${INTERVAL_SECS} thread_id=${THREAD_ID:-wrapper-default} plist=${PLIST_PATH}"
}

case "$COMMAND" in
  install) install_job ;;
  uninstall)
    if (( DRY_RUN )); then echo "dry_run=1 uninstall_label=${LABEL} plist=${PLIST_PATH}"; exit 0; fi
    if "$LAUNCHCTL_BIN" print "gui/${UID}/${LABEL}" >/dev/null 2>&1; then
      "$LAUNCHCTL_BIN" bootout "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
      if "$LAUNCHCTL_BIN" print "gui/${UID}/${LABEL}" >/dev/null 2>&1; then
        echo "Uninstall failed; observer is still loaded and files were preserved." >&2
        exit 1
      fi
    fi
    rm -f "$PLIST_PATH" "$OBSERVER"
    echo "uninstalled=1 label=${LABEL}"
    ;;
  status)
    if "$LAUNCHCTL_BIN" print "gui/${UID}/${LABEL}" >/dev/null 2>&1; then loaded=1; else loaded=0; fi
    echo "label=${LABEL} loaded=${loaded} plist=$([[ -f "$PLIST_PATH" ]] && echo 1 || echo 0) state=$([[ -f "$STATE_PATH" ]] && echo 1 || echo 0)"
    ;;
  run-now)
    resolve_node
    # Manual executions inherit the destination persisted in the installed
    # LaunchAgent, so they cannot silently fall back to Codex Pings.
    if [[ -z "$THREAD_ID" ]]; then
      THREAD_ID="$(read_installed_thread_id)"
    fi
    [[ -n "$THREAD_ID" ]] || {
      echo "Installed observer has no Telegram topic; reinstall with OPENCLAW_MEMORY_OBSERVER_THREAD_ID" >&2
      exit 1
    }
    run_args=("$OBSERVER" --state-path "$STATE_PATH")
    if [[ -n "$THREAD_ID" ]]; then run_args+=(--thread-id "$THREAD_ID"); fi
    if (( DRY_RUN )); then run_args+=(--dry-run); fi
    exec "$NODE_BIN" "${run_args[@]}"
    ;;
  *) usage >&2; exit 1 ;;
esac
