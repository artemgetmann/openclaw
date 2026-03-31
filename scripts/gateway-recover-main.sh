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
  printf '[gateway-recover-main] node runtime not found; set OPENCLAW_NODE_BIN to a launchd-visible node binary\n' >&2
  exit 1
}

run_openclaw_cli() {
  "${NODE_BIN}" "${OPENCLAW_ENTRYPOINT}" "$@"
}

log() {
  printf '[gateway-recover-main] %s\n' "$*"
}

log_block() {
  local title="$1"
  printf '\n[gateway-recover-main] %s\n' "$title"
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
  if [[ -f "${GATEWAY_ERR_LOG}" ]]; then
    tail -n 120 "${GATEWAY_ERR_LOG}" >&2 || true
  else
    printf 'missing: %s\n' "${GATEWAY_ERR_LOG}" >&2
  fi

  log_block "Tail ${WATCHDOG_ERR_LOG} (last 120 lines)"
  if [[ -f "${WATCHDOG_ERR_LOG}" ]]; then
    tail -n 120 "${WATCHDOG_ERR_LOG}" >&2 || true
  else
    printf 'missing: %s\n' "${WATCHDOG_ERR_LOG}" >&2
  fi
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

run_best_effort() {
  local output
  if output="$("$@" 2>&1)"; then
    if [[ -n "$output" ]]; then
      printf '%s\n' "$output"
    fi
    return 0
  fi
  if [[ -n "$output" ]]; then
    printf '%s\n' "$output"
  fi
  return 1
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

wait_for_rpc_probe() {
  local start_epoch
  start_epoch="$(date +%s)"
  local last_output=""

  while true; do
    local output=""
    if output="$(run_openclaw_cli gateway status --deep --require-rpc 2>&1)"; then
      printf '%s\n' "$output"
      return 0
    fi

    last_output="$output"
    local now elapsed
    now="$(date +%s)"
    elapsed="$((now - start_epoch))"
    if [[ "${elapsed}" -ge "${RPC_TIMEOUT_SECONDS}" ]]; then
      dump_failure_diagnostics "gateway status --deep --require-rpc" "$last_output"
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

  capture_best_effort "Baseline: status --deep --require-rpc" run_openclaw_cli gateway status --deep --require-rpc
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
  run_strict bash -lc "cd '${MAIN_REPO}' && pnpm build"
  # Recovery is specifically about reclaiming the default shared service for
  # the canonical main runtime, so install from the built repo entrypoint with
  # explicit takeover instead of going through a wrapper that can drift.
  run_strict bash -lc "cd '${MAIN_REPO}' && node dist/index.js gateway install --force --allow-shared-service-takeover --runtime node --port '${PORT}'"

  log_block "Bootstrap gateway launch agent"
  launchctl bootstrap "gui/$(id -u)" "${HOME}/Library/LaunchAgents/${GATEWAY_LABEL}.plist" 2>/dev/null || true
  run_strict launchctl kickstart -k "gui/$(id -u)/${GATEWAY_LABEL}"

  log_block "Readiness gates"
  wait_for_listener
  wait_for_rpc_probe

  if [[ "${MANAGE_WATCHDOG}" == "1" ]]; then
    log_block "Bootstrap watchdog launch agent"
    local watchdog_plist="${HOME}/Library/LaunchAgents/${WATCHDOG_LABEL}.plist"
    if [[ -f "${watchdog_plist}" ]]; then
      launchctl bootstrap "gui/$(id -u)" "${watchdog_plist}" 2>/dev/null || true
      # The gateway is already proven healthy by the listener/RPC gates above.
      # Missing or flaky watchdog launchd state should not false-fail main handoff.
      if run_best_effort launchctl kickstart -k "gui/$(id -u)/${WATCHDOG_LABEL}"; then
        stabilize_watchdog
      else
        log "watchdog kickstart failed; continuing because gateway readiness is already satisfied"
      fi
    else
      log "watchdog plist missing (${watchdog_plist}); continuing without watchdog bootstrap"
    fi
  fi

  log_block "Final verification"
  assert_main_runtime_path
  local launch_command
  launch_command="$(launchctl print "gui/$(id -u)/${GATEWAY_LABEL}" | grep -F -- "${EXPECTED_RUNTIME}" || true)"
  local rpc_result
  rpc_result="$(run_openclaw_cli gateway status --deep --require-rpc 2>&1)"
  local listener_result
  listener_result="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>&1)"

  printf 'LaunchAgent command path:\n%s\n' "${launch_command}"
  printf '\nRPC probe result:\n%s\n' "${rpc_result}"
  printf '\nListener result on %s:\n%s\n' "${PORT}" "${listener_result}"
}

main "$@"
