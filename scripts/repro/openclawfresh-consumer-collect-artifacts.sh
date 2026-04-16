#!/usr/bin/env bash
set -euo pipefail

# Copy the clean-user packaged-app rerun evidence into a world-readable shared
# location so the main dev user can inspect it without needing repeated sudo.

TARGET_USER="${OPENCLAW_TARGET_USER:-openclawfresh}"
TARGET_HOME="/Users/${TARGET_USER}"
OUT_DIR="${OPENCLAW_COLLECT_OUT_DIR:-/Users/Shared/openclawfresh-consumer-rerun-artifacts}"

declare -a SUMMARY_LINES=()

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/repro/openclawfresh-consumer-collect-artifacts.sh

Optional env:
  OPENCLAW_TARGET_USER=<macOS user>      defaults to openclawfresh
  OPENCLAW_COLLECT_OUT_DIR=<output dir>  defaults to /Users/Shared/openclawfresh-consumer-rerun-artifacts

What this collects:
  - ~/Library/Application Support/OpenClaw Consumer
  - ~/Library/Caches/ai.openclaw.consumer*
  - ~/Library/HTTPStorages/ai.openclaw.consumer*
  - ~/Library/WebKit/ai.openclaw.consumer*
  - ~/Library/Saved Application State/ai.openclaw.consumer*.savedState
  - ~/Library/Preferences/ai.openclaw.consumer*.plist
  - ~/Library/LaunchAgents/ai.openclaw.consumer*.plist
  - Desktop screenshots (*.png, *.jpg, *.jpeg)
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
}

record_summary_line() {
  SUMMARY_LINES+=("$1")
}

copy_path() {
  local label="$1"
  local source="$2"
  local dest="$3"

  if [[ -e "$source" || -L "$source" ]]; then
    mkdir -p "$(dirname "$dest")"
    cp -Rp "$source" "$dest"
    echo "Collected ${label}: ${source} -> ${dest}"
    record_summary_line "collected ${label}: ${source} -> ${dest}"
  else
    echo "Not present ${label}: ${source}"
    record_summary_line "not present ${label}: ${source}"
  fi
}

copy_matching_paths() {
  local label="$1"
  local dir="$2"
  local pattern="$3"
  local dest_dir="$4"
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

  mkdir -p "$dest_dir"
  echo "Collecting ${label} matches for pattern: ${dir}/${pattern}"
  record_summary_line "pattern ${label}: ${dir}/${pattern}"
  for path in "${matches[@]}"; do
    cp -Rp "$path" "$dest_dir/"
    echo "  collected ${path}"
    record_summary_line "collected ${path}"
  done
}

collect_artifacts() {
  echo "Collecting rerun artifacts from ${TARGET_USER}..."
  rm -rf "${OUT_DIR}"
  mkdir -p "${OUT_DIR}"

  copy_path "runtime root" "${TARGET_HOME}/Library/Application Support/OpenClaw Consumer" "${OUT_DIR}/Library/Application Support/OpenClaw Consumer"
  copy_matching_paths "cached state" "${TARGET_HOME}/Library/Caches" "ai.openclaw.consumer*" "${OUT_DIR}/Library/Caches"
  copy_matching_paths "HTTP storage" "${TARGET_HOME}/Library/HTTPStorages" "ai.openclaw.consumer*" "${OUT_DIR}/Library/HTTPStorages"
  copy_matching_paths "WebKit storage" "${TARGET_HOME}/Library/WebKit" "ai.openclaw.consumer*" "${OUT_DIR}/Library/WebKit"
  copy_matching_paths "saved app state" "${TARGET_HOME}/Library/Saved Application State" "ai.openclaw.consumer*.savedState" "${OUT_DIR}/Library/Saved Application State"
  copy_matching_paths "preferences plist" "${TARGET_HOME}/Library/Preferences" "ai.openclaw.consumer*.plist" "${OUT_DIR}/Library/Preferences"
  copy_matching_paths "launch agents" "${TARGET_HOME}/Library/LaunchAgents" "ai.openclaw.consumer*.plist" "${OUT_DIR}/Library/LaunchAgents"
  copy_matching_paths "desktop png screenshots" "${TARGET_HOME}/Desktop" "*.png" "${OUT_DIR}/Desktop"
  copy_matching_paths "desktop jpg screenshots" "${TARGET_HOME}/Desktop" "*.jpg" "${OUT_DIR}/Desktop"
  copy_matching_paths "desktop jpeg screenshots" "${TARGET_HOME}/Desktop" "*.jpeg" "${OUT_DIR}/Desktop"

  chmod -R a+rx "${OUT_DIR}" || true
  find "${OUT_DIR}" -type f -exec chmod a+r {} \; || true
}

print_summary() {
  echo "Artifacts copied to: ${OUT_DIR}"
  echo "Summary:"
  printf '  - %s\n' "${SUMMARY_LINES[@]}"
  find "${OUT_DIR}" -maxdepth 3 -type f | sort
}

main() {
  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    usage
    exit 0
  fi

  require_root
  require_user_home
  collect_artifacts
  print_summary
}

main "$@"
