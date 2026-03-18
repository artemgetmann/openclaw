#!/usr/bin/env bash
set -euo pipefail

# Bootstraps an isolated Telegram live-test lane for the current worktree.
# Lane identity is deterministic from BOT_TOKEN position in .env.bots.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/telegram-e2e/lane-common.sh
source "${SCRIPT_DIR}/lane-common.sh"

PREPARE_ONLY=0

usage() {
  cat <<'USAGE'
Usage:
  lane-up.sh [--prepare-only]

Options:
  --prepare-only   Only resolve token->lane mapping and write .telegram-lane.env
                   (no gateway install/start/health checks).

Env overrides:
  OPENCLAW_TG_LANE_PORT_BASE   Default: 19789
  OPENCLAW_TG_LANE_PORT_STEP   Default: 20
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prepare-only)
      PREPARE_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! command -v openclaw >/dev/null 2>&1; then
  echo "Error: openclaw CLI is required in PATH." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required in PATH." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required in PATH." >&2
  exit 1
fi

WORKTREE="${TELEGRAM_LANE_ROOT_DIR}"
BRANCH="$(cd "${WORKTREE}" && git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [[ -z "${BRANCH}" || "${BRANCH}" == "HEAD" ]]; then
  echo "Error: live lane requires a named branch (detached HEAD is not allowed)." >&2
  exit 1
fi

# Ensure this worktree has an assigned bot token claim.
TOKEN="$(lane_require_bot_token_assignment)"
if [[ -z "${TOKEN}" ]]; then
  echo "Error: TELEGRAM_BOT_TOKEN is required in ${TELEGRAM_LANE_ENV_LOCAL_FILE}." >&2
  exit 1
fi

lane_resolve_from_token_pool "${TOKEN}"
lane_write_metadata_file "${BRANCH}" "${WORKTREE}"

if [[ "${PREPARE_ONLY}" == "1" ]]; then
  echo "lane metadata prepared: ${TELEGRAM_LANE_METADATA_FILE}"
  echo "branch=${BRANCH}"
  echo "runtime_worktree=${WORKTREE}"
  echo "profile=${LANE_PROFILE}"
  echo "port=${LANE_PORT}"
  echo "slot=${LANE_SLOT}"
  echo "token_fingerprint=${LANE_TOKEN_FINGERPRINT}"
  exit 0
fi

run_local_openclaw() {
  (
    cd "${WORKTREE}"
    node scripts/run-node.mjs "$@"
  )
}

resolve_lane_state_dir() {
  local status_json=""
  local state_dir=""
  status_json="$(run_local_openclaw --profile "${LANE_PROFILE}" gateway status --deep --json 2>/dev/null || true)"
  state_dir="$(lane_status_runtime_state_dir_from_status_json "${status_json}")"
  if [[ -n "${state_dir}" ]]; then
    printf '%s' "${state_dir}"
    return
  fi
  lane_state_dir_for_profile "${LANE_PROFILE}"
}

lane_direct_pidfile_path() {
  local state_dir="$1"
  printf '%s' "${state_dir}/gateway-direct.pid"
}

stop_lane_direct_gateway() {
  local state_dir=""
  local pidfile=""
  local pid=""
  local listener_pid=""

  state_dir="$(resolve_lane_state_dir)"
  pidfile="$(lane_direct_pidfile_path "${state_dir}")"
  if [[ -f "${pidfile}" ]]; then
    pid="$(cat "${pidfile}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" >/dev/null 2>&1 || true
      sleep 1
      if kill -0 "${pid}" 2>/dev/null; then
        kill -9 "${pid}" >/dev/null 2>&1 || true
      fi
    fi
    rm -f "${pidfile}"
  fi

  listener_pid="$(lane_listener_pid_for_port "${LANE_PORT}")"
  if [[ -n "${listener_pid}" ]]; then
    kill "${listener_pid}" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "${listener_pid}" 2>/dev/null; then
      kill -9 "${listener_pid}" >/dev/null 2>&1 || true
    fi
  fi
}

start_lane_gateway_direct() {
  local state_dir=""
  local pidfile=""
  local out_log=""
  local err_log=""
  local direct_pid=""

  state_dir="$(resolve_lane_state_dir)"
  pidfile="$(lane_direct_pidfile_path "${state_dir}")"
  out_log="${state_dir}/logs/gateway-direct.out.log"
  err_log="${state_dir}/logs/gateway-direct.err.log"

  mkdir -p "${state_dir}/logs"
  run_local_openclaw --profile "${LANE_PROFILE}" gateway stop >/dev/null 2>&1 || true
  stop_lane_direct_gateway
  (
    cd "${WORKTREE}"
    nohup node scripts/run-node.mjs \
      --profile "${LANE_PROFILE}" \
      gateway run \
      --bind loopback \
      --port "${LANE_PORT}" \
      --force >"${out_log}" 2>"${err_log}" < /dev/null &
    echo $! > "${pidfile}"
  )

  direct_pid="$(cat "${pidfile}" 2>/dev/null || true)"
  if [[ -z "${direct_pid}" ]] || ! kill -0 "${direct_pid}" 2>/dev/null; then
    return 1
  fi
  return 0
}

start_lane_gateway() {
  if run_local_openclaw --profile "${LANE_PROFILE}" gateway start; then
    return 0
  fi

  run_local_openclaw \
    --profile "${LANE_PROFILE}" \
    gateway install --force --runtime node --port "${LANE_PORT}" >/dev/null 2>&1 || true
  if run_local_openclaw --profile "${LANE_PROFILE}" gateway start; then
    return 0
  fi

  # launchctl fallback: some environments report "service not loaded" immediately
  # after install even though the plist was written correctly.
  if [[ "${OSTYPE:-}" == darwin* ]] && command -v launchctl >/dev/null 2>&1; then
    local label="ai.openclaw.${LANE_PROFILE}"
    local plist="${HOME}/Library/LaunchAgents/${label}.plist"
    if [[ -f "${plist}" ]]; then
      launchctl bootstrap "gui/$(id -u)" "${plist}" 2>/dev/null || true
      if launchctl kickstart -k "gui/$(id -u)/${label}" >/dev/null 2>&1; then
        return 0
      fi
    fi
  fi

  return 1
}

stop_lane_gateway() {
  run_local_openclaw --profile "${LANE_PROFILE}" gateway stop >/dev/null 2>&1 || true
  stop_lane_direct_gateway
}

wait_for_lane_rpc() {
  local timeout_seconds="${OPENCLAW_TG_LANE_RPC_TIMEOUT_SECONDS:-300}"
  local poll_seconds="${OPENCLAW_TG_LANE_RPC_POLL_SECONDS:-2}"
  local direct_fallback_after_seconds="${OPENCLAW_TG_LANE_DIRECT_FALLBACK_AFTER_SECONDS:-30}"
  local attempted_direct_start=0
  if [[ ! "${timeout_seconds}" =~ ^[0-9]+$ ]] || [[ "${timeout_seconds}" == "0" ]]; then
    timeout_seconds=300
  fi
  if [[ ! "${poll_seconds}" =~ ^[0-9]+$ ]] || [[ "${poll_seconds}" == "0" ]]; then
    poll_seconds=2
  fi
  if [[ ! "${direct_fallback_after_seconds}" =~ ^[0-9]+$ ]]; then
    direct_fallback_after_seconds=30
  fi

  local started_at
  local consecutive_ready=0
  started_at="$(date +%s)"
  while true; do
    local status_json=""
    local runtime_port=""
    local runtime_pid=""
    local listener_pid=""
    local runtime_worktree=""
    local service_missing_unit=""
    local now=""
    local elapsed=""

    status_json="$(run_local_openclaw --profile "${LANE_PROFILE}" gateway status --deep --json 2>/dev/null || true)"
    service_missing_unit="$(lane_status_service_missing_unit_from_status_json "${status_json}")"
    listener_pid="$(lane_listener_pid_for_port "${LANE_PORT}")"
    now="$(date +%s)"
    elapsed=$((now - started_at))
    if [[ "${service_missing_unit}" == "true" && "${attempted_direct_start}" == "0" ]]; then
      if start_lane_gateway_direct; then
        attempted_direct_start=1
      fi
    fi
    if [[ -z "${listener_pid}" && "${attempted_direct_start}" == "0" ]] && \
      (( elapsed >= direct_fallback_after_seconds )); then
      if start_lane_gateway_direct; then
        attempted_direct_start=1
      fi
    fi

    if run_local_openclaw --profile "${LANE_PROFILE}" gateway status --deep --require-rpc >/dev/null 2>&1; then
      runtime_port="$(lane_status_runtime_port_from_status_json "${status_json}")"
      runtime_pid="$(lane_status_runtime_pid_from_status_json "${status_json}")"
      runtime_worktree="$(lane_runtime_worktree_from_status_json "${status_json}")"

      if [[ "${runtime_port}" == "${LANE_PORT}" && -n "${listener_pid}" && "${runtime_worktree}" == "${WORKTREE}" ]]; then
        if [[ -n "${runtime_pid}" && "${runtime_pid}" != "${listener_pid}" ]] && \
          ! lane_pid_has_descendant "${runtime_pid}" "${listener_pid}"; then
          consecutive_ready=0
        else
          consecutive_ready=$((consecutive_ready + 1))
          if (( consecutive_ready >= 2 )); then
            return 0
          fi
        fi
      else
        consecutive_ready=0
      fi
    else
      consecutive_ready=0
    fi

    if (( elapsed >= timeout_seconds )); then
      return 1
    fi
    sleep "${poll_seconds}"
  done
}

start_lane_gateway_with_retries() {
  local attempts="${OPENCLAW_TG_LANE_START_ATTEMPTS:-3}"
  if [[ ! "${attempts}" =~ ^[0-9]+$ ]] || [[ "${attempts}" == "0" ]]; then
    attempts=3
  fi

  stop_lane_direct_gateway

  local try=1
  while (( try <= attempts )); do
    if (( try > 1 )); then
      stop_lane_gateway
      run_local_openclaw \
        --profile "${LANE_PROFILE}" \
        gateway install --force --runtime node --port "${LANE_PORT}" >/dev/null 2>&1 || true
      sleep 1
    fi
    if start_lane_gateway && wait_for_lane_rpc; then
      return 0
    fi
    if start_lane_gateway_direct && wait_for_lane_rpc; then
      return 0
    fi
    stop_lane_gateway
    sleep 2
    try=$((try + 1))
  done
  return 1
}

sync_lane_agent_auth() {
  if lane_sync_auth_profiles_to_profile "${LANE_PROFILE}"; then
    echo "lane agent auth: synced (${LANE_PROFILE})"
    return 0
  fi

  if lane_auth_profiles_present_for_profile "${LANE_PROFILE}"; then
    echo "lane agent auth: present (${LANE_PROFILE})"
    return 0
  fi

  echo "lane agent auth: missing (${LANE_PROFILE})"
  return 1
}

# Each isolated lane must force local gateway mode and its deterministic port.
# Without this, service start can be blocked by unset/non-local gateway.mode.
# Lane profiles are isolated, so we must also copy the assigned bot token into
# the profile config; otherwise Telegram updates arrive but no bot channel binds.
# Keep lane profiles deterministic by only allowing the Telegram plugin.
# This avoids unrelated plugin side effects while preserving real Telegram I/O.
run_local_openclaw --profile "${LANE_PROFILE}" config set gateway.mode local
run_local_openclaw --profile "${LANE_PROFILE}" config set gateway.port "${LANE_PORT}"
run_local_openclaw --profile "${LANE_PROFILE}" config set channels.telegram.botToken "${TOKEN}"
run_local_openclaw --profile "${LANE_PROFILE}" config set channels.telegram.enabled true
run_local_openclaw --profile "${LANE_PROFILE}" config set channels.telegram.allowFrom '["*"]'
run_local_openclaw --profile "${LANE_PROFILE}" config set channels.telegram.dmPolicy open
run_local_openclaw --profile "${LANE_PROFILE}" config set channels.telegram.groupPolicy open
run_local_openclaw --profile "${LANE_PROFILE}" config set plugins.enabled true
run_local_openclaw --profile "${LANE_PROFILE}" config set plugins.allow '["telegram"]'

LANE_AGENT_AUTH_PRESENT="no"
if sync_lane_agent_auth; then
  LANE_AGENT_AUTH_PRESENT="yes"
fi

run_local_openclaw --profile "${LANE_PROFILE}" gateway install --force --runtime node --port "${LANE_PORT}"

if ! start_lane_gateway_with_retries; then
  echo "Error: lane gateway did not pass deterministic startup gates for profile ${LANE_PROFILE}." >&2
  exit 1
fi
status_json="$(run_local_openclaw --profile "${LANE_PROFILE}" gateway status --deep --json 2>/dev/null || true)"
if ! jq -e . >/dev/null 2>&1 <<<"${status_json}"; then
  echo "Error: failed to parse gateway status JSON for profile ${LANE_PROFILE}." >&2
  exit 1
fi

rpc_ok="$(jq -r '.rpc.ok // false' <<<"${status_json}")"
runtime_worktree="$(lane_runtime_worktree_from_status_json "${status_json}")"
runtime_pid="$(lane_status_runtime_pid_from_status_json "${status_json}")"
runtime_port="$(lane_status_runtime_port_from_status_json "${status_json}")"
runtime_state_dir="$(lane_status_runtime_state_dir_from_status_json "${status_json}")"
listener_pid="$(lane_listener_pid_for_port "${LANE_PORT}")"
if [[ "${runtime_port}" != "${LANE_PORT}" ]]; then
  echo "Error: lane port mismatch (expected ${LANE_PORT}, got ${runtime_port:-unknown})." >&2
  exit 1
fi
if [[ "${rpc_ok}" != "true" ]]; then
  echo "Error: gateway RPC probe failed for lane profile ${LANE_PROFILE}." >&2
  exit 1
fi
if [[ -z "${listener_pid}" ]]; then
  echo "Error: lane listener missing on port ${LANE_PORT} despite running status." >&2
  exit 1
fi
if [[ -n "${runtime_pid}" && "${listener_pid}" != "${runtime_pid}" ]] && \
  ! lane_pid_has_descendant "${runtime_pid}" "${listener_pid}"; then
  echo "Error: lane listener PID mismatch (runtime ${runtime_pid}, listener ${listener_pid})." >&2
  exit 1
fi
if [[ -z "${runtime_worktree}" || "${runtime_worktree}" != "${WORKTREE}" ]]; then
  echo "Error: gateway runtime ownership mismatch (expected ${WORKTREE}, got ${runtime_worktree:-unknown})." >&2
  exit 1
fi

echo "lane up: ${LANE_PROFILE} (slot=${LANE_SLOT}, port=${LANE_PORT}, token=${LANE_TOKEN_FINGERPRINT})"
echo "branch=${BRANCH}"
echo "runtime_worktree=${runtime_worktree}"
echo "runtime_state_dir=${runtime_state_dir}"
echo "runtime_port=${runtime_port}"
echo "token_fingerprint=${LANE_TOKEN_FINGERPRINT}"
echo "agent_auth_profiles=${LANE_AGENT_AUTH_PRESENT}"
echo "profile=${LANE_PROFILE}"
echo "port=${LANE_PORT}"
