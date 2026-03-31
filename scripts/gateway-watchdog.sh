#!/usr/bin/env bash

set -euo pipefail

MAIN_REPO="${OPENCLAW_MAIN_REPO:-/Users/user/Programming_Projects/openclaw}"
EXPECTED_RUNTIME="${MAIN_REPO}/dist/index.js"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
CHECK_INTERVAL_SECONDS="${OPENCLAW_GATEWAY_WATCHDOG_CHECK_INTERVAL_SECONDS:-15}"
FAIL_THRESHOLD="${OPENCLAW_GATEWAY_WATCHDOG_FAIL_THRESHOLD:-2}"
RECOVER_SCRIPT="${MAIN_REPO}/scripts/gateway-recover-main.sh"
LOCK_DIR="${HOME}/.openclaw/watchdog"
LOCK_PATH="${LOCK_DIR}/gateway-watchdog.lock"
LOCK_PID_PATH="${LOCK_PATH}/pid"

mkdir -p "${LOCK_DIR}"

acquire_lock() {
  # The watchdog is itself launched by launchd. Use a lock directory plus pid
  # file so a crash or forced stop does not leave a permanent stale lock behind.
  if mkdir "${LOCK_PATH}" 2>/dev/null; then
    printf '%s\n' "$$" >"${LOCK_PID_PATH}"
    return 0
  fi

  if [[ -f "${LOCK_PID_PATH}" ]]; then
    local lock_pid
    lock_pid="$(tr -d '[:space:]' <"${LOCK_PID_PATH}" 2>/dev/null || true)"
    if [[ -n "${lock_pid}" ]] && kill -0 "${lock_pid}" 2>/dev/null; then
      echo "[gateway-watchdog] another watchdog instance is already active; exiting"
      exit 0
    fi
  fi

  rm -rf "${LOCK_PATH}"
  if mkdir "${LOCK_PATH}" 2>/dev/null; then
    printf '%s\n' "$$" >"${LOCK_PID_PATH}"
    return 0
  fi

  echo "[gateway-watchdog] unable to acquire watchdog lock; exiting"
  exit 1
}

acquire_lock

cleanup() {
  rm -f "${LOCK_PID_PATH}" 2>/dev/null || true
  rmdir "${LOCK_PATH}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

gateway_healthy() {
  # Require both the RPC health probe and the launchd program path match. That
  # prevents a random gateway on the same port from being treated as prod main.
  if ! openclaw gateway status --deep --require-rpc >/dev/null 2>&1; then
    return 1
  fi

  local launch_state=""
  if ! launch_state="$(launchctl print "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null)"; then
    return 1
  fi

  printf '%s\n' "${launch_state}" | grep -F -q -- "${EXPECTED_RUNTIME}"
}

failures=0

while true; do
  if gateway_healthy; then
    failures=0
  else
    failures=$((failures + 1))
    echo "[gateway-watchdog] shared gateway unhealthy (${failures}/${FAIL_THRESHOLD}); port=${PORT} repo=${MAIN_REPO}"
    if (( failures >= FAIL_THRESHOLD )); then
      # Reuse the repo-owned deterministic recovery flow instead of hand-rolling
      # restart logic here. The flag prevents recovery from tearing down the
      # watchdog process that invoked it.
      echo "[gateway-watchdog] reclaiming shared gateway from canonical main"
      OPENCLAW_GATEWAY_RECOVER_MANAGE_WATCHDOG=0 "${RECOVER_SCRIPT}"
      failures=0
    fi
  fi

  sleep "${CHECK_INTERVAL_SECONDS}"
done
