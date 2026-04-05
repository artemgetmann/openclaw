#!/usr/bin/env bash

set -euo pipefail

MAIN_REPO="${OPENCLAW_MAIN_REPO:-/Users/user/Programming_Projects/openclaw}"
EXPECTED_RUNTIME="${MAIN_REPO}/dist/index.js"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
LISTENER_TIMEOUT_SECONDS="${OPENCLAW_GATEWAY_LISTENER_TIMEOUT_SECONDS:-300}"
RPC_TIMEOUT_SECONDS="${OPENCLAW_GATEWAY_RPC_TIMEOUT_SECONDS:-120}"
RETRY_KICKSTART_AFTER_SECONDS="${OPENCLAW_GATEWAY_RETRY_KICKSTART_AFTER_SECONDS:-30}"
POLL_INTERVAL_SECONDS="${OPENCLAW_GATEWAY_POLL_INTERVAL_SECONDS:-2}"
GATEWAY_LABEL="ai.openclaw.gateway"
WATCHDOG_LABEL="ai.openclaw.gateway-watchdog"
GATEWAY_ERR_LOG="${HOME}/.openclaw/logs/gateway.err.log"
WATCHDOG_ERR_LOG="/tmp/openclaw/gateway-watchdog.err.log"
WATCHDOG_STABILIZE_SECONDS="${OPENCLAW_GATEWAY_WATCHDOG_STABILIZE_SECONDS:-8}"
WATCHDOG_AUTO_DISABLE_ON_DUPLICATE="${OPENCLAW_GATEWAY_WATCHDOG_AUTO_DISABLE_ON_DUPLICATE:-1}"
MANAGE_WATCHDOG="${OPENCLAW_GATEWAY_RECOVER_MANAGE_WATCHDOG:-1}"
OPENCLAW_ENTRYPOINT="${MAIN_REPO}/openclaw.mjs"
VALIDATED_NODE_HELPER="${MAIN_REPO}/scripts/lib/validated-node.sh"
SHARED_RUNTIME_BUILD_SCRIPT="${MAIN_REPO}/scripts/build-shared-runtime.sh"

if [[ -f "${VALIDATED_NODE_HELPER}" ]]; then
  # shellcheck disable=SC1090
  source "${VALIDATED_NODE_HELPER}"
fi

resolve_node_bin_fallback() {
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

resolve_node_bin() {
  # Recovery must not depend on launchd inheriting an interactive shell PATH.
  # Reuse the repo-pinned Node/Corepack toolchain first, then fall back only
  # for older installs that do not ship the helper.
  if declare -F openclaw_use_validated_node >/dev/null 2>&1 &&
    openclaw_use_validated_node "${MAIN_REPO}" >/dev/null 2>&1; then
    printf '%s\n' "${OPENCLAW_NODE_BIN}"
    return 0
  fi

  resolve_node_bin_fallback
}

NODE_BIN="$(resolve_node_bin)" || {
  printf '[gateway-recover-main] node runtime not found; set OPENCLAW_NODE_BIN to a launchd-visible node binary\n' >&2
  exit 1
}

run_openclaw_cli() {
  "${NODE_BIN}" "${OPENCLAW_ENTRYPOINT}" "$@"
}

run_repo_pnpm() {
  if declare -F openclaw_run_repo_pnpm >/dev/null 2>&1; then
    # Propagate the helper exit code so recovery stops on a failed build rather
    # than reinstalling whatever stale dist/ happened to already exist.
    openclaw_run_repo_pnpm "${MAIN_REPO}" "$@"
    return $?
  fi

  local corepack_bin
  corepack_bin="$(dirname "${NODE_BIN}")/corepack"
  if [[ -x "${corepack_bin}" ]]; then
    (
      cd "${MAIN_REPO}"
      "${NODE_BIN}" "${corepack_bin}" pnpm "$@"
    )
    return $?
  fi

  (
    cd "${MAIN_REPO}"
    pnpm "$@"
  )
  return $?
}

run_shared_runtime_build() {
  if [[ -x "${SHARED_RUNTIME_BUILD_SCRIPT}" ]]; then
    (
      cd "${MAIN_REPO}"
      "${SHARED_RUNTIME_BUILD_SCRIPT}"
    )
    return $?
  fi

  run_repo_pnpm build
}

log() {
  printf '[gateway-recover-main] %s\n' "$*"
}

log_block() {
  local title="$1"
  printf '\n[gateway-recover-main] %s\n' "$title"
}

resolve_fd_path() {
  local fd="$1"
  lsof -a -p "$$" -d "$fd" -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n '1p'
}

same_file_path() {
  local left="$1"
  local right="$2"
  if [[ -z "$left" || -z "$right" ]]; then
    return 1
  fi
  [[ "$(python3 - <<'PY' "$left" "$right"
import os
import sys

left = sys.argv[1]
right = sys.argv[2]

try:
    left_real = os.path.realpath(left)
except Exception:
    left_real = os.path.abspath(left)

try:
    right_real = os.path.realpath(right)
except Exception:
    right_real = os.path.abspath(right)

print("1" if left_real == right_real else "0")
PY
)" == "1" ]]
}

tail_file_to_stderr_unless_self() {
  local file_path="$1"
  if [[ ! -f "${file_path}" ]]; then
    printf 'missing: %s\n' "${file_path}" >&2
    return 0
  fi

  local stderr_target=""
  stderr_target="$(resolve_fd_path 2)"
  if same_file_path "${stderr_target}" "${file_path}"; then
    printf 'skipped tail for %s because stderr points at the same file\n' "${file_path}" >&2
    return 0
  fi

  tail -n 120 "${file_path}" >&2 || true
}

dump_failure_diagnostics() {
  local failed_command="$1"
  local failed_output="$2"
  log_block "FAILURE DIAGNOSTICS"
  printf 'Failed command: %s\n' "$failed_command" >&2
  if [[ -n "$failed_output" ]]; then
    printf '%s\n' "$failed_output" >&2
  fi

  log_block "Tail ${GATEWAY_ERR_LOG} (last 120 lines)"
  tail_file_to_stderr_unless_self "${GATEWAY_ERR_LOG}"

  log_block "Tail ${WATCHDOG_ERR_LOG} (last 120 lines)"
  tail_file_to_stderr_unless_self "${WATCHDOG_ERR_LOG}"
}

run_strict() {
  local output
  if ! output="$("$@" 2>&1)"; then
    dump_failure_diagnostics "$*" "$output"
    exit 1
  fi
  if [[ -n "$output" ]]; then
    printf '%s\n' "$output"
  fi
}

capture_best_effort() {
  local title="$1"
  shift
  log_block "$title"
  local output
  if output="$("$@" 2>&1)"; then
    printf '%s\n' "$output"
  else
    printf '%s\n' "$output"
    printf '[gateway-recover-main] (best-effort capture; non-zero exit ignored)\n'
  fi
}

listener_ready() {
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { found = 1 } END { exit(found ? 0 : 1) }'
}

http_ready() {
  curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1
}

assert_main_runtime_path() {
  local output
  if ! output="$(launchctl print "gui/$(id -u)/${GATEWAY_LABEL}" 2>&1)"; then
    dump_failure_diagnostics "launchctl print gui/\$(id -u)/${GATEWAY_LABEL}" "$output"
    exit 1
  fi
  if ! printf '%s\n' "$output" | grep -F -q -- "${EXPECTED_RUNTIME}"; then
    dump_failure_diagnostics "assert launchctl command path contains ${EXPECTED_RUNTIME}" "$output"
    exit 1
  fi
}

wait_for_listener() {
  local start_epoch
  start_epoch="$(date +%s)"
  local retried=0

  while true; do
    if listener_ready; then
      return 0
    fi

    local now elapsed
    now="$(date +%s)"
    elapsed="$((now - start_epoch))"

    if [[ "${retried}" -eq 0 && "${elapsed}" -ge "${RETRY_KICKSTART_AFTER_SECONDS}" ]]; then
      log "listener not ready after ${elapsed}s; issuing one controlled gateway kickstart"
      run_strict launchctl kickstart -k "gui/$(id -u)/${GATEWAY_LABEL}"
      retried=1
    fi

    if [[ "${elapsed}" -ge "${LISTENER_TIMEOUT_SECONDS}" ]]; then
      local lsof_output
      lsof_output="$(lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>&1 || true)"
      dump_failure_diagnostics "wait for listener on ${PORT}" "$lsof_output"
      exit 1
    fi

    sleep "${POLL_INTERVAL_SECONDS}"
  done
}

wait_for_http_probe() {
  local start_epoch
  start_epoch="$(date +%s)"

  while true; do
    if http_ready; then
      printf 'HTTP probe reachable on http://127.0.0.1:%s/\n' "${PORT}"
      return 0
    fi

    local now elapsed
    now="$(date +%s)"
    elapsed="$((now - start_epoch))"
    if [[ "${elapsed}" -ge "${RPC_TIMEOUT_SECONDS}" ]]; then
      dump_failure_diagnostics "curl -fsS http://127.0.0.1:${PORT}/" "HTTP probe failed before timeout"
      exit 1
    fi
    sleep "${POLL_INTERVAL_SECONDS}"
  done
}

resolve_launchctl_gateway_pid() {
  launchctl print "gui/$(id -u)/${GATEWAY_LABEL}" 2>/dev/null | awk '/pid =/ { print $3; exit }'
}

pid_matches_main_runtime() {
  local pid="$1"
  local cwd=""
  local command_line=""

  if [[ -z "$pid" ]]; then
    return 1
  fi

  # The host can legitimately run other OpenClaw gateways in isolated worktrees.
  # Only treat a pid as a duplicate if it is rooted in the canonical main repo
  # or its command line still points at the canonical runtime entrypoint.
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n '1p' || true)"
  if [[ -n "$cwd" ]]; then
    if [[ "$cwd" == "$MAIN_REPO" || "$cwd" == "$MAIN_REPO/"* ]]; then
      return 0
    fi
  fi

  command_line="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  if [[ -n "$command_line" && "$command_line" == *"$EXPECTED_RUNTIME"* ]]; then
    return 0
  fi

  return 1
}

install_main_launch_agent() {
  (
    cd "${MAIN_REPO}"
    "${NODE_BIN}" dist/index.js gateway install --force --allow-shared-service-takeover --runtime node --port "${PORT}"
  )
}

stabilize_watchdog() {
  local gateway_pid
  gateway_pid="$(resolve_launchctl_gateway_pid)"
  if [[ -z "${gateway_pid}" ]]; then
    dump_failure_diagnostics "resolve gateway pid from launchctl" "missing gateway pid in launchctl state"
    exit 1
  fi

  sleep "${WATCHDOG_STABILIZE_SECONDS}"

  local all_gateway_pids=()
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] && all_gateway_pids+=("${pid}")
  done < <(pgrep -x openclaw-gateway || true)

  local extra_gateway_pids=()
  for pid in "${all_gateway_pids[@]}"; do
    if [[ "${pid}" != "${gateway_pid}" ]]; then
      if pid_matches_main_runtime "${pid}"; then
        extra_gateway_pids+=("${pid}")
      fi
    fi
  done

  if [[ "${#extra_gateway_pids[@]}" -eq 0 ]]; then
    return 0
  fi

  # On a machine with isolated worktree runtimes, additional `openclaw-gateway`
  # processes are normal and should not take down the shared main watchdog.
  # The watchdog's job is to protect the canonical launchd-owned main runtime,
  # not to treat every same-named process on the host as a fatal duplicate.
  log "watchdog observed additional gateway pids and will continue: ${extra_gateway_pids[*]}"
  return 0
}

main() {
  log "starting deterministic recovery (port=${PORT}, main=${MAIN_REPO})"

  capture_best_effort "Baseline: HTTP probe" curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/"
  capture_best_effort "Baseline: lsof listener check" lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN
  capture_best_effort \
    "Baseline: launchctl print (program/arguments/pid/state)" \
    bash -lc "launchctl print gui/\$(id -u)/${GATEWAY_LABEL} | grep -E 'program =|arguments =|pid =|state ='"

  log_block "Full clean stop"
  local uid
  uid="$(id -u)"
  launchctl bootout "gui/${uid}/${GATEWAY_LABEL}" 2>/dev/null || true
  if [[ "${MANAGE_WATCHDOG}" == "1" ]]; then
    launchctl bootout "gui/${uid}/${WATCHDOG_LABEL}" 2>/dev/null || true
  fi
  run_openclaw_cli gateway stop 2>/dev/null || true
  pkill -9 -f openclaw-gateway 2>/dev/null || true
  pkill -9 -f 'dist/index.js gateway' 2>/dev/null || true
  pkill -9 -f 'openclaw.mjs gateway' 2>/dev/null || true
  run_strict bash -lc "ps aux | grep -E 'openclaw-gateway|dist/index.js gateway|openclaw.mjs gateway|ai.openclaw.gateway|gateway-health-watchdog' || true"
  run_strict bash -lc "lsof -nP -iTCP:${PORT} -sTCP:LISTEN || true"

  log_block "Rebuild and reinstall from main runtime"
  run_strict run_shared_runtime_build
  # Recovery is specifically about reclaiming the default shared service for
  # the canonical main runtime, so install from the built repo entrypoint with
  # explicit takeover instead of going through a wrapper that can drift.
  run_strict install_main_launch_agent

  log_block "Bootstrap gateway launch agent"
  launchctl bootstrap "gui/$(id -u)" "${HOME}/Library/LaunchAgents/${GATEWAY_LABEL}.plist" 2>/dev/null || true
  run_strict launchctl kickstart -k "gui/$(id -u)/${GATEWAY_LABEL}"

  log_block "Readiness gates"
  wait_for_listener
  wait_for_http_probe

  if [[ "${MANAGE_WATCHDOG}" == "1" ]]; then
    log_block "Bootstrap watchdog launch agent"
    launchctl bootstrap "gui/$(id -u)" "${HOME}/Library/LaunchAgents/${WATCHDOG_LABEL}.plist" 2>/dev/null || true
    run_strict launchctl kickstart -k "gui/$(id -u)/${WATCHDOG_LABEL}"
    stabilize_watchdog
  fi

  log_block "Final verification"
  assert_main_runtime_path
  local launch_command
  launch_command="$(launchctl print "gui/$(id -u)/${GATEWAY_LABEL}" | grep -F -- "${EXPECTED_RUNTIME}" || true)"
  local http_result
  http_result="$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/" 2>&1 | head -n 5)"
  local listener_result
  listener_result="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>&1)"

  printf 'LaunchAgent command path:\n%s\n' "${launch_command}"
  printf '\nHTTP probe result:\n%s\n' "${http_result}"
  printf '\nListener result on %s:\n%s\n' "${PORT}" "${listener_result}"
}

main "$@"
