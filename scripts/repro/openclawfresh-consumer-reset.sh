#!/usr/bin/env bash
set -euo pipefail

# Reset the packaged consumer app state for the clean local macOS user before a
# first-run smoke rerun. This intentionally wipes only the consumer app's local
# runtime/config/cache surfaces for that user; it does not touch unrelated user
# data or system-wide app state.

TARGET_USER="${OPENCLAW_TARGET_USER:-openclawfresh}"
TARGET_HOME="/Users/${TARGET_USER}"
TARGET_UID=""

declare -a SUMMARY_LINES=()

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/repro/openclawfresh-consumer-reset.sh

Optional env:
  OPENCLAW_TARGET_USER=<macOS user>   defaults to openclawfresh

What this resets:
  - ~/Library/Application Support/OpenClaw Consumer
  - ~/Library/Caches/ai.openclaw.consumer*
  - ~/Library/HTTPStorages/ai.openclaw.consumer*
  - ~/Library/WebKit/ai.openclaw.consumer*
  - ~/Library/Saved Application State/ai.openclaw.consumer*.savedState
  - ~/Library/Preferences/ai.openclaw.consumer*.plist
  - ~/Library/LaunchAgents/ai.openclaw.consumer*.plist
EOF
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "ERROR: run this script with sudo." >&2
    exit 1
  fi
}

require_user_home() {
  if [[ ! -d "${TARGET_HOME}" ]]; then
    echo "ERROR: target home does not exist: ${TARGET_HOME}" >&2
    exit 1
  fi
  TARGET_UID="$(id -u "${TARGET_USER}")"
}

stop_user_processes() {
  echo "Stopping ${TARGET_USER} consumer processes if present..."
  pkill -9 -u "${TARGET_USER}" -f 'ai\.openclaw\.consumer' 2>/dev/null || true
  pkill -9 -u "${TARGET_USER}" -f 'OpenClaw Consumer' 2>/dev/null || true
  pkill -9 -u "${TARGET_USER}" -f 'ai.openclaw.consumer.gateway' 2>/dev/null || true
  pkill -9 -u "${TARGET_USER}" -f '/OpenClawRuntime/' 2>/dev/null || true
}

record_summary_line() {
  SUMMARY_LINES+=("$1")
}

remove_path() {
  local label="$1"
  local path="$2"

  if [[ -e "$path" || -L "$path" ]]; then
    rm -rf "$path"
    if [[ ! -e "$path" && ! -L "$path" ]]; then
      echo "Removed ${label}: ${path}"
      record_summary_line "removed ${label}: ${path}"
    else
      echo "WARNING: could not remove ${label}: ${path}" >&2
      record_summary_line "failed ${label}: ${path}"
    fi
  else
    echo "Not present ${label}: ${path}"
    record_summary_line "not present ${label}: ${path}"
  fi
}

remove_matching_paths() {
  local label="$1"
  local dir="$2"
  local pattern="$3"
  local -a matches=()
  local path=""

  shopt -s nullglob
  matches=( "${dir}"/${pattern} )
  shopt -u nullglob

  if [[ ${#matches[@]} -eq 0 ]]; then
    echo "No matches for ${label}: ${dir}/${pattern}"
    record_summary_line "no matches ${label}: ${dir}/${pattern}"
    return 0
  fi

  echo "Removing ${label} matches for pattern: ${dir}/${pattern}"
  record_summary_line "pattern ${label}: ${dir}/${pattern}"
  for path in "${matches[@]}"; do
    if [[ -e "$path" || -L "$path" ]]; then
      rm -rf "$path"
      if [[ ! -e "$path" && ! -L "$path" ]]; then
        echo "  removed ${path}"
        record_summary_line "removed ${path}"
      else
        echo "  WARNING: failed to remove ${path}" >&2
        record_summary_line "failed ${path}"
      fi
    fi
  done
}

remove_launch_agents() {
  local dir="${TARGET_HOME}/Library/LaunchAgents"
  local -a matches=()
  local path=""
  local label=""

  shopt -s nullglob
  matches=( "${dir}"/ai.openclaw.consumer*.plist )
  shopt -u nullglob

  if [[ ${#matches[@]} -eq 0 ]]; then
    echo "No launch agents matched: ${dir}/ai.openclaw.consumer*.plist"
    record_summary_line "no matches launch agents: ${dir}/ai.openclaw.consumer*.plist"
    return 0
  fi

  echo "Unloading and removing launch agents matched by label pattern: ${dir}/ai.openclaw.consumer*.plist"
  record_summary_line "pattern launch agents: ${dir}/ai.openclaw.consumer*.plist"
  for path in "${matches[@]}"; do
    label="${path##*/}"
    label="${label%.plist}"
    launchctl bootout "gui/${TARGET_UID}" "$path" 2>/dev/null || true
    launchctl bootout "gui/${TARGET_UID}/${label}" 2>/dev/null || true
    rm -f "$path"
    if [[ ! -e "$path" ]]; then
      echo "  removed ${path}"
      record_summary_line "removed ${path}"
    else
      echo "  WARNING: failed to remove ${path}" >&2
      record_summary_line "failed ${path}"
    fi
  done
}

wipe_consumer_state() {
  echo "Wiping packaged consumer state for ${TARGET_USER}..."
  remove_path "runtime root" "${TARGET_HOME}/Library/Application Support/OpenClaw Consumer"
  remove_matching_paths "cached state" "${TARGET_HOME}/Library/Caches" "ai.openclaw.consumer*"
  remove_matching_paths "HTTP storage" "${TARGET_HOME}/Library/HTTPStorages" "ai.openclaw.consumer*"
  remove_matching_paths "WebKit storage" "${TARGET_HOME}/Library/WebKit" "ai.openclaw.consumer*"
  remove_matching_paths "saved app state" "${TARGET_HOME}/Library/Saved Application State" "ai.openclaw.consumer*.savedState"
  remove_matching_paths "preferences plist" "${TARGET_HOME}/Library/Preferences" "ai.openclaw.consumer*.plist"
  remove_launch_agents
}

print_summary() {
  cat <<EOF
Reset complete for ${TARGET_USER}.

Summary:
EOF

  printf '  - %s\n' "${SUMMARY_LINES[@]}"

  cat <<EOF

Next:
  1. Log into the ${TARGET_USER} GUI session.
  2. Open the packaged zip:
     /Users/Shared/openclaw-consumer-clean-user/OpenClaw Consumer-2026.3.14.zip
  3. Rerun the packaged onboarding flow.
EOF
}

main() {
  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    usage
    exit 0
  fi

  require_root
  require_user_home
  stop_user_processes
  wipe_consumer_state
  print_summary
}

main "$@"
