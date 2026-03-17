#!/usr/bin/env bash
set -euo pipefail

# Telegram live-test preflight (lane-aware, status-driven):
# - named branch (no detached HEAD)
# - token claim present (or auto-repaired once via lane-up)
# - expected lane profile/port resolved from token pool (or metadata fallback)
# - gateway health verified via `gateway status` (RPC required)
# - gateway runtime path ownership must match current worktree

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/telegram-e2e/lane-common.sh
source "${ROOT_DIR}/scripts/telegram-e2e/lane-common.sh"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "Error: openclaw CLI is required in PATH." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required in PATH." >&2
  exit 1
fi

LANE_UP_SCRIPT="${ROOT_DIR}/scripts/telegram-e2e/lane-up.sh"
WORKTREE="${ROOT_DIR}"
BRANCH="$(cd "${WORKTREE}" && git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
TOKEN_PRESENT="no"
AUTO_REPAIRED="no"
EXPECTED_PROFILE=""
EXPECTED_PORT=""
EXPECTED_TOKEN_FINGERPRINT=""
RUNTIME_WORKTREE=""
RUNTIME_STATE_DIR=""
RUNTIME_PORT=""
RUNTIME_PID=""
RUNTIME_LISTENER_PID=""
AGENT_AUTH_PROFILES="no"
STATUS_JSON=""

CHECK_ERRORS=()

append_error() {
  CHECK_ERRORS+=("$1")
}

reset_check_errors() {
  CHECK_ERRORS=()
}

print_check_errors() {
  local error=""
  for error in "${CHECK_ERRORS[@]}"; do
    echo "preflight: ${error}" >&2
  done
}

resolve_expected_lane() {
  local token=""
  token="$(lane_read_last_env_value "${TELEGRAM_LANE_ENV_LOCAL_FILE}" "TELEGRAM_BOT_TOKEN")"
  if [[ -n "${token}" ]]; then
    TOKEN_PRESENT="yes"
    if lane_resolve_from_token_pool "${token}" >/dev/null 2>&1; then
      EXPECTED_PROFILE="${LANE_PROFILE}"
      EXPECTED_PORT="${LANE_PORT}"
      EXPECTED_TOKEN_FINGERPRINT="${LANE_TOKEN_FINGERPRINT}"
      lane_write_metadata_file "${BRANCH:-unknown}" "${WORKTREE}"
      return 0
    fi
  fi

  if lane_load_metadata_file >/dev/null 2>&1; then
    EXPECTED_PROFILE="${OPENCLAW_TG_LANE_PROFILE:-}"
    EXPECTED_PORT="${OPENCLAW_TG_LANE_PORT:-}"
    EXPECTED_TOKEN_FINGERPRINT="${OPENCLAW_TG_LANE_TOKEN_FINGERPRINT:-}"
    if [[ -n "${EXPECTED_PROFILE}" && -n "${EXPECTED_PORT}" ]]; then
      return 0
    fi
  fi

  EXPECTED_PROFILE=""
  EXPECTED_PORT=""
  EXPECTED_TOKEN_FINGERPRINT=""
  return 1
}

run_local_openclaw() {
  (
    cd "${ROOT_DIR}"
    node scripts/run-node.mjs "$@"
  )
}

collect_status_json() {
  if [[ -z "${EXPECTED_PROFILE}" ]]; then
    STATUS_JSON=""
    return 1
  fi
  STATUS_JSON="$(run_local_openclaw --profile "${EXPECTED_PROFILE}" gateway status --deep --json 2>/dev/null || true)"
  if ! jq -e . >/dev/null 2>&1 <<<"${STATUS_JSON}"; then
    STATUS_JSON=""
    return 1
  fi
  return 0
}

validate_current_state() {
  reset_check_errors
  TOKEN_PRESENT="no"
  EXPECTED_PROFILE=""
  EXPECTED_PORT=""
  EXPECTED_TOKEN_FINGERPRINT=""
  STATUS_JSON=""
  RUNTIME_WORKTREE=""
  RUNTIME_STATE_DIR=""
  RUNTIME_PORT=""
  RUNTIME_PID=""
  RUNTIME_LISTENER_PID=""
  AGENT_AUTH_PROFILES="no"

  if [[ -z "${BRANCH}" || "${BRANCH}" == "HEAD" ]]; then
    append_error "branch is detached; switch to a named branch before live Telegram checks."
  fi

  if ! resolve_expected_lane; then
    append_error "unable to resolve lane mapping from .env.local/.env.bots or .telegram-lane.env."
  fi

  if [[ "${TOKEN_PRESENT}" != "yes" ]]; then
    append_error "TELEGRAM_BOT_TOKEN claim missing in ${TELEGRAM_LANE_ENV_LOCAL_FILE}."
  fi

  if [[ -n "${EXPECTED_PORT}" && ! "${EXPECTED_PORT}" =~ ^[0-9]+$ ]]; then
    append_error "resolved lane port is invalid (${EXPECTED_PORT})."
  fi

  if [[ "${#CHECK_ERRORS[@]}" -gt 0 ]]; then
    return 1
  fi

  if ! collect_status_json; then
    append_error "failed to parse gateway status JSON for profile ${EXPECTED_PROFILE}."
    return 1
  fi

  if ! run_local_openclaw --profile "${EXPECTED_PROFILE}" gateway status --deep --require-rpc >/dev/null 2>&1; then
    append_error "gateway status --deep --require-rpc failed for profile ${EXPECTED_PROFILE}."
  fi

  local rpc_ok=""
  local active_port=""
  rpc_ok="$(jq -r '.rpc.ok // false' <<<"${STATUS_JSON}")"
  active_port="$(jq -r '.gateway.port // empty' <<<"${STATUS_JSON}")"
  RUNTIME_WORKTREE="$(lane_runtime_worktree_from_status_json "${STATUS_JSON}")"
  RUNTIME_STATE_DIR="$(lane_status_runtime_state_dir_from_status_json "${STATUS_JSON}")"
  RUNTIME_PORT="$(lane_status_runtime_port_from_status_json "${STATUS_JSON}")"
  RUNTIME_PID="$(lane_status_runtime_pid_from_status_json "${STATUS_JSON}")"
  RUNTIME_LISTENER_PID="$(lane_listener_pid_for_port "${EXPECTED_PORT}")"

  if [[ "${rpc_ok}" != "true" ]]; then
    append_error "gateway RPC probe failed for profile ${EXPECTED_PROFILE}."
  fi
  if [[ "${active_port}" != "${EXPECTED_PORT}" && "${RUNTIME_PORT}" != "${EXPECTED_PORT}" ]]; then
    append_error "gateway port mismatch for profile ${EXPECTED_PROFILE} (expected ${EXPECTED_PORT}, got ${active_port:-unknown})."
  fi
  if [[ -z "${RUNTIME_LISTENER_PID}" ]]; then
    append_error "lane listener is not bound on expected port ${EXPECTED_PORT}."
  fi
  if [[ -n "${RUNTIME_PID}" && -n "${RUNTIME_LISTENER_PID}" && "${RUNTIME_LISTENER_PID}" != "${RUNTIME_PID}" ]] && \
    ! lane_pid_has_descendant "${RUNTIME_PID}" "${RUNTIME_LISTENER_PID}"; then
    append_error "lane listener pid mismatch (runtime ${RUNTIME_PID}, listener ${RUNTIME_LISTENER_PID})."
  fi
  if [[ -z "${RUNTIME_WORKTREE}" ]]; then
    append_error "gateway runtime path missing from service command metadata."
  elif [[ "${RUNTIME_WORKTREE}" != "${WORKTREE}" ]]; then
    append_error "gateway runtime path mismatch (expected ${WORKTREE}, got ${RUNTIME_WORKTREE})."
  fi
  if [[ -z "${RUNTIME_STATE_DIR}" ]]; then
    append_error "gateway runtime state dir missing from status metadata."
  fi
  if [[ -n "${EXPECTED_PROFILE}" ]] && lane_auth_profiles_present_for_profile "${EXPECTED_PROFILE}"; then
    AGENT_AUTH_PROFILES="yes"
  fi

  if [[ "${#CHECK_ERRORS[@]}" -gt 0 ]]; then
    return 1
  fi
  return 0
}

attempt_auto_repair_once() {
  if [[ ! -x "${LANE_UP_SCRIPT}" ]]; then
    append_error "lane-up script missing at ${LANE_UP_SCRIPT}."
    return 1
  fi

  if ! bash "${LANE_UP_SCRIPT}" >/dev/null 2>&1; then
    append_error "lane-up auto-repair failed."
    return 1
  fi
  AUTO_REPAIRED="yes"
  return 0
}

if ! validate_current_state; then
  print_check_errors
  if ! attempt_auto_repair_once; then
    print_check_errors
    echo "branch=${BRANCH:-unknown}"
    echo "worktree=${WORKTREE}"
    echo "runtime_worktree=${RUNTIME_WORKTREE}"
    echo "runtime_state_dir=${RUNTIME_STATE_DIR}"
    echo "runtime_port=${RUNTIME_PORT}"
    echo "token_fingerprint=${EXPECTED_TOKEN_FINGERPRINT:-unknown}"
    echo "agent_auth_profiles=${AGENT_AUTH_PROFILES}"
    echo "token_present=${TOKEN_PRESENT}"
    echo "profile=${EXPECTED_PROFILE}"
    echo "port=${EXPECTED_PORT}"
    echo "auto_repaired=${AUTO_REPAIRED}"
    exit 1
  fi

  if ! validate_current_state; then
    print_check_errors
    echo "branch=${BRANCH:-unknown}"
    echo "worktree=${WORKTREE}"
    echo "runtime_worktree=${RUNTIME_WORKTREE}"
    echo "runtime_state_dir=${RUNTIME_STATE_DIR}"
    echo "runtime_port=${RUNTIME_PORT}"
    echo "token_fingerprint=${EXPECTED_TOKEN_FINGERPRINT:-unknown}"
    echo "agent_auth_profiles=${AGENT_AUTH_PROFILES}"
    echo "token_present=${TOKEN_PRESENT}"
    echo "profile=${EXPECTED_PROFILE}"
    echo "port=${EXPECTED_PORT}"
    echo "auto_repaired=${AUTO_REPAIRED}"
    exit 1
  fi
fi

echo "branch=${BRANCH}"
echo "worktree=${WORKTREE}"
echo "runtime_worktree=${RUNTIME_WORKTREE}"
echo "runtime_state_dir=${RUNTIME_STATE_DIR}"
echo "runtime_port=${RUNTIME_PORT}"
echo "token_fingerprint=${EXPECTED_TOKEN_FINGERPRINT:-unknown}"
echo "agent_auth_profiles=${AGENT_AUTH_PROFILES}"
echo "token_present=${TOKEN_PRESENT}"
echo "profile=${EXPECTED_PROFILE}"
echo "port=${EXPECTED_PORT}"
echo "auto_repaired=${AUTO_REPAIRED}"
