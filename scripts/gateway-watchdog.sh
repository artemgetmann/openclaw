#!/usr/bin/env bash

set -euo pipefail

MAIN_REPO="${OPENCLAW_MAIN_REPO:-/Users/user/Programming_Projects/openclaw}"
EXPECTED_RUNTIME="${MAIN_REPO}/dist/index.js"
OPENCLAW_ENTRYPOINT="${MAIN_REPO}/openclaw.mjs"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
CHECK_INTERVAL_SECONDS="${OPENCLAW_GATEWAY_WATCHDOG_CHECK_INTERVAL_SECONDS:-15}"
FAIL_THRESHOLD="${OPENCLAW_GATEWAY_WATCHDOG_FAIL_THRESHOLD:-2}"
RECOVER_SCRIPT="${OPENCLAW_GATEWAY_RECOVER_SCRIPT:-${MAIN_REPO}/scripts/gateway-recover-main.sh}"
WATCHDOG_STDOUT_PATH="${OPENCLAW_GATEWAY_WATCHDOG_STDOUT_PATH:-/tmp/openclaw/gateway-watchdog.log}"
WATCHDOG_STDERR_PATH="${OPENCLAW_GATEWAY_WATCHDOG_STDERR_PATH:-/tmp/openclaw/gateway-watchdog.err.log}"
WATCHDOG_LOG_MAX_BYTES="${OPENCLAW_GATEWAY_WATCHDOG_LOG_MAX_BYTES:-1048576}"
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

resolve_node_bin() {
  if [[ -n "${OPENCLAW_NODE_BIN:-}" && -x "${OPENCLAW_NODE_BIN}" ]]; then
    printf '%s\n' "${OPENCLAW_NODE_BIN}"
    return 0
  fi

  local resolved_node=""
  resolved_node="$(command -v node 2>/dev/null || true)"
  if [[ -n "${resolved_node}" && -x "${resolved_node}" ]]; then
    printf '%s\n' "${resolved_node}"
    return 0
  fi

  local candidate=""
  for candidate in /opt/homebrew/bin/node /opt/homebrew/opt/node/bin/node /usr/local/bin/node; do
    if [[ -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  return 1
}

NODE_BIN="$(resolve_node_bin)" || {
  printf '[gateway-watchdog] node runtime not found; set OPENCLAW_NODE_BIN to a launchd-visible node binary\n' >&2
  exit 1
}

run_openclaw_cli() {
  "${NODE_BIN}" "${OPENCLAW_ENTRYPOINT}" "$@"
}

file_size_bytes() {
  local file_path="$1"
  if [[ ! -e "${file_path}" ]]; then
    printf '0\n'
    return 0
  fi

  if stat -f '%z' "${file_path}" >/dev/null 2>&1; then
    stat -f '%z' "${file_path}"
    return 0
  fi

  stat -c '%s' "${file_path}" 2>/dev/null || printf '0\n'
}

cap_watchdog_log_file() {
  local file_path="$1"
  local size
  size="$(file_size_bytes "${file_path}")"
  if [[ "${size}" =~ ^[0-9]+$ ]] && (( size > WATCHDOG_LOG_MAX_BYTES )); then
    # launchd keeps these files open as the live stdout/stderr sink. Truncate
    # the active inode in place so disk is released immediately.
    : > "${file_path}"
    printf '[gateway-watchdog] truncated oversized log file path=%s previous_bytes=%s max_bytes=%s\n' \
      "${file_path}" "${size}" "${WATCHDOG_LOG_MAX_BYTES}"
  fi
}

cap_watchdog_logs() {
  mkdir -p "$(dirname "${WATCHDOG_STDOUT_PATH}")"
  cap_watchdog_log_file "${WATCHDOG_STDOUT_PATH}"
  cap_watchdog_log_file "${WATCHDOG_STDERR_PATH}"
}

http_ready() {
  curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1
}

gateway_healthy() {
  # Stage the cheaper checks first so a broken CLI path cannot dominate the hot
  # loop. The watchdog only needs enough confidence to decide whether recovery
  # is warranted; it should not be the source of heavyweight failures itself.
  if ! lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    return 1
  fi

  if ! http_ready; then
    return 1
  fi

  local launch_state=""
  if ! launch_state="$(launchctl print "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null)"; then
    return 1
  fi

  if ! printf '%s\n' "${launch_state}" | grep -F -q -- "${EXPECTED_RUNTIME}"; then
    return 1
  fi

  # Keep the direct-entry RPC probe as the last gate. If the CLI dependency
  # graph regresses again, the loop still stays bounded by the log truncation.
  run_openclaw_cli gateway status --deep --require-rpc >/dev/null 2>&1
}

failures=0

while true; do
  cap_watchdog_logs
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
