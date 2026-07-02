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
JARVIS_GATEWAY_LABEL="${OPENCLAW_JARVIS_GATEWAY_LABEL:-ai.jarvis.gateway}"
WATCHDOG_LABEL="ai.openclaw.gateway-watchdog"
WATCHDOG_ERR_LOG="/tmp/openclaw/gateway-watchdog.err.log"
WATCHDOG_STABILIZE_SECONDS="${OPENCLAW_GATEWAY_WATCHDOG_STABILIZE_SECONDS:-8}"
WATCHDOG_AUTO_DISABLE_ON_DUPLICATE="${OPENCLAW_GATEWAY_WATCHDOG_AUTO_DISABLE_ON_DUPLICATE:-1}"
MANAGE_WATCHDOG="${OPENCLAW_GATEWAY_RECOVER_MANAGE_WATCHDOG:-1}"
ALLOW_SHARED_GATEWAY_WITH_JARVIS="${OPENCLAW_ALLOW_SHARED_GATEWAY_WITH_JARVIS:-0}"
DEFAULT_GATEWAY_STOPPED_FOR_RECOVERY=0
RECOVERY_MODE="${OPENCLAW_GATEWAY_RECOVER_MODE:-full}"
OPENCLAW_ENTRYPOINT="${MAIN_REPO}/openclaw.mjs"
VALIDATED_NODE_HELPER="${MAIN_REPO}/scripts/lib/validated-node.sh"
SHARED_RUNTIME_BUILD_SCRIPT="${MAIN_REPO}/scripts/build-shared-runtime.sh"
CANONICAL_OPENCLAW_HOME="${HOME}/Library/Application Support/OpenClaw"
CANONICAL_OPENCLAW_STATE_DIR="${CANONICAL_OPENCLAW_HOME}/.openclaw"
CANONICAL_OPENCLAW_CONFIG_PATH="${CANONICAL_OPENCLAW_STATE_DIR}/openclaw.json"
CANONICAL_OPENCLAW_LOG_DIR="${CANONICAL_OPENCLAW_STATE_DIR}/logs"
GATEWAY_ERR_LOG="${CANONICAL_OPENCLAW_LOG_DIR}/gateway.err.log"

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

NODE_BIN="${OPENCLAW_NODE_BIN:-}"

ensure_node_bin() {
  if [[ -n "${NODE_BIN}" && -x "${NODE_BIN}" ]]; then
    return 0
  fi

  NODE_BIN="$(resolve_node_bin)" || {
    printf '[gateway-recover-main] node runtime not found; set OPENCLAW_NODE_BIN to a launchd-visible node binary\n' >&2
    exit 1
  }
}

run_openclaw_cli() {
  ensure_node_bin
  "${NODE_BIN}" "${OPENCLAW_ENTRYPOINT}" "$@"
}

run_repo_pnpm() {
  ensure_node_bin
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

report_stopped_default_gateway_on_exit() {
  local exit_code="$?"
  if [[ "${DEFAULT_GATEWAY_STOPPED_FOR_RECOVERY}" == "1" ]]; then
    printf '[gateway-recover-main] ERROR: recovery exited while %s was intentionally stopped and not reloaded.\n' "${GATEWAY_LABEL}" >&2
    printf '[gateway-recover-main] Rerun from %s: bash scripts/gateway-recover-main.sh\n' "${MAIN_REPO}" >&2
  fi
  exit "${exit_code}"
}

trap report_stopped_default_gateway_on_exit EXIT

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

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --full)
        RECOVERY_MODE="full"
        ;;
      --shallow)
        RECOVERY_MODE="shallow"
        ;;
      *)
        printf '[gateway-recover-main] unknown argument: %s\n' "$1" >&2
        printf '[gateway-recover-main] usage: %s [--full|--shallow]\n' "$0" >&2
        exit 2
        ;;
    esac
    shift
  done

  case "${RECOVERY_MODE}" in
    full | shallow)
      ;;
    *)
      printf '[gateway-recover-main] invalid OPENCLAW_GATEWAY_RECOVER_MODE=%s; expected full or shallow\n' "${RECOVERY_MODE}" >&2
      exit 2
      ;;
  esac
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
  # The gateway's stable liveness route is /healthz. Probing "/" can return a
  # non-2xx even after the WebSocket gateway is listening, which makes recovery
  # falsely report failure after it has already repaired launchd.
  curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1
}

canonical_gateway_healthy() {
  local launch_state=""
  if ! launch_state="$(launchctl print "gui/$(id -u)/${GATEWAY_LABEL}" 2>/dev/null)"; then
    return 1
  fi

  # A listener on the right port is not enough: prove launchd is running the
  # canonical main runtime before treating recovery as already complete.
  if ! printf '%s\n' "${launch_state}" | grep -F -q -- "${EXPECTED_RUNTIME}"; then
    return 1
  fi
  if ! printf '%s\n' "${launch_state}" | grep -E -q 'state = running|pid = [1-9][0-9]*'; then
    return 1
  fi
  if ! listener_ready; then
    return 1
  fi
  if ! http_ready; then
    return 1
  fi

  return 0
}

jarvis_gateway_targets_shared_port() {
  local launch_state="$1"

  # Jarvis and the shared OpenClaw gateway both default to the same loopback
  # port. If Jarvis is loaded for this port, recovering ai.openclaw.gateway
  # creates ambiguous runtime ownership and can steal the live user path.
  #
  # launchd also prints an "inherited environment" block that can contain stale
  # values from the shell that bootstrapped the job. Ignore that block; only the
  # active environment block and explicit --port launch argument describe the
  # running service. Match the gateway command precedence: --port wins over
  # OPENCLAW_GATEWAY_PORT when both are present.
  awk -v port="${PORT}" '
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)

      if (line == "environment = {") {
        in_environment = 1
        previous = line
        next
      }
      if (in_environment && line == "}") {
        in_environment = 0
      }
      if (in_environment && line == "OPENCLAW_GATEWAY_PORT => " port) {
        env_port = port
      } else if (in_environment && line ~ /^OPENCLAW_GATEWAY_PORT => /) {
        env_port = line
        sub(/^OPENCLAW_GATEWAY_PORT => /, "", env_port)
      }
      if (previous == "--port") {
        arg_port = line
      } else if (line ~ /^--port=/) {
        # launchd prints ProgramArguments one item per line. The gateway CLI
        # supports both "--port 18789" and "--port=18789"; either form is an
        # explicit launch argument and therefore overrides the environment.
        arg_port = line
        sub(/^--port=/, "", arg_port)
      }
      previous = line
    }
    END {
      effective_port = arg_port != "" ? arg_port : env_port
      exit(effective_port == port ? 0 : 1)
    }
  ' <<<"${launch_state}"
}

assert_no_jarvis_gateway_conflict() {
  local launch_state=""

  if [[ "${ALLOW_SHARED_GATEWAY_WITH_JARVIS}" == "1" ]]; then
    log "OPENCLAW_ALLOW_SHARED_GATEWAY_WITH_JARVIS=1; bypassing Jarvis ownership guard"
    return 0
  fi

  if ! launch_state="$(launchctl print "gui/$(id -u)/${JARVIS_GATEWAY_LABEL}" 2>/dev/null)"; then
    return 0
  fi

  if ! jarvis_gateway_targets_shared_port "${launch_state}"; then
    return 0
  fi

  printf '[gateway-recover-main] refusing to recover %s while %s is loaded for port %s\n' \
    "${GATEWAY_LABEL}" "${JARVIS_GATEWAY_LABEL}" "${PORT}" >&2
  printf '[gateway-recover-main] Jarvis proof must use scripts/prove-jarvis-runtime.sh; shared OpenClaw proof is not Jarvis proof.\n' >&2
  printf '[gateway-recover-main] If you intentionally want the shared gateway instead, unload %s first or set OPENCLAW_ALLOW_SHARED_GATEWAY_WITH_JARVIS=1.\n' \
    "${JARVIS_GATEWAY_LABEL}" >&2
  exit 1
}

launch_agent_registered() {
  local label="$1"
  launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1
}

launchctl_not_loaded_detail() {
  local detail="$1"
  local normalized
  normalized="$(printf '%s' "${detail}" | tr '[:upper:]' '[:lower:]')"
  [[ "${normalized}" == *"no such process"* ||
    "${normalized}" == *"could not find service"* ||
    "${normalized}" == *"not found"* ]]
}

bootstrap_launch_agent_or_exit() {
  local label="$1"
  local plist_path="$2"
  local domain="gui/$(id -u)"
  local target="${domain}/${label}"
  local output=""

  # launchd can remember a disabled state after bootout. Clearing it here makes
  # recovery idempotent when the previous install died between plist creation
  # and service registration.
  launchctl enable "${target}" 2>/dev/null || true

  if launch_agent_registered "${label}"; then
    return 0
  fi

  if output="$(launchctl bootstrap "${domain}" "${plist_path}" 2>&1)"; then
    return 0
  fi

  # A concurrent RunAtLoad registration can make bootstrap report an error even
  # though the label is now present. Trust launchctl print over the bootstrap
  # exit code so recovery does not stop on a harmless race.
  if launch_agent_registered "${label}"; then
    return 0
  fi

  dump_failure_diagnostics "launchctl bootstrap ${domain} ${plist_path}" "${output}"
  exit 1
}

kickstart_launch_agent_or_exit() {
  local label="$1"
  local plist_path="$2"
  local domain="gui/$(id -u)"
  local target="${domain}/${label}"
  local output=""

  bootstrap_launch_agent_or_exit "${label}" "${plist_path}"

  if output="$(launchctl kickstart -k "${target}" 2>&1)"; then
    return 0
  fi

  # If launchd lost the registration between bootstrap and kickstart, register
  # once more and retry. Other kickstart errors are real runtime failures and
  # should still fail loudly with diagnostics.
  if launchctl_not_loaded_detail "${output}"; then
    bootstrap_launch_agent_or_exit "${label}" "${plist_path}"
    if output="$(launchctl kickstart -k "${target}" 2>&1)"; then
      return 0
    fi
  fi

  dump_failure_diagnostics "launchctl kickstart -k ${target}" "${output}"
  exit 1
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

assert_launch_agent_running_or_exit() {
  local label="$1"
  local output=""
  if ! output="$(launchctl print "gui/$(id -u)/${label}" 2>&1)"; then
    dump_failure_diagnostics "launchctl print gui/\$(id -u)/${label}" "$output"
    exit 1
  fi

  if ! printf '%s\n' "$output" | grep -E -q 'state = running|pid = [1-9][0-9]*'; then
    dump_failure_diagnostics "assert ${label} launch agent is running" "$output"
    exit 1
  fi
}

launch_agent_running() {
  local label="$1"
  local output=""
  if ! output="$(launchctl print "gui/$(id -u)/${label}" 2>/dev/null)"; then
    return 1
  fi

  printf '%s\n' "$output" | grep -E -q 'state = running|pid = [1-9][0-9]*'
}

ensure_gateway_launch_agent_started_or_exit() {
  local plist_path="${HOME}/Library/LaunchAgents/${GATEWAY_LABEL}.plist"

  # Shallow recovery is the watchdog path. It must repair a missing launchd
  # registration without reflexively restarting a gateway that launchd already
  # reports as running and that may only be warming its HTTP health route.
  bootstrap_launch_agent_or_exit "${GATEWAY_LABEL}" "${plist_path}"
  if launch_agent_running "${GATEWAY_LABEL}"; then
    return 0
  fi

  kickstart_launch_agent_or_exit "${GATEWAY_LABEL}" "${plist_path}"
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
      kickstart_launch_agent_or_exit "${GATEWAY_LABEL}" "${HOME}/Library/LaunchAgents/${GATEWAY_LABEL}.plist"
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
      dump_failure_diagnostics "curl -fsS http://127.0.0.1:${PORT}/healthz" "HTTP health probe failed before timeout"
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

collect_canonical_main_runtime_pids() {
  local pid=""
  local seen=" "

  # Start with launchd's recorded pid because that is the canonical owner for
  # the shared main gateway. Then add only same-named processes that prove they
  # belong to the canonical repo/runtime, leaving isolated tester runtimes alone.
  pid="$(resolve_launchctl_gateway_pid || true)"
  if [[ -n "${pid}" && "${pid}" =~ ^[0-9]+$ ]] && pid_matches_main_runtime "${pid}"; then
    printf '%s\n' "${pid}"
    seen=" ${pid} "
  fi

  while IFS= read -r pid; do
    [[ -n "${pid}" && "${pid}" =~ ^[0-9]+$ ]] || continue
    [[ "${seen}" == *" ${pid} "* ]] && continue
    if pid_matches_main_runtime "${pid}"; then
      printf '%s\n' "${pid}"
      seen="${seen}${pid} "
    fi
  done < <(pgrep -x openclaw-gateway 2>/dev/null || true)

  while IFS= read -r pid; do
    [[ -n "${pid}" && "${pid}" =~ ^[0-9]+$ ]] || continue
    [[ "${seen}" == *" ${pid} "* ]] && continue
    if pid_matches_main_runtime "${pid}"; then
      printf '%s\n' "${pid}"
      seen="${seen}${pid} "
    fi
  done < <(
    ps -axo pid=,command= 2>/dev/null |
      awk -v runtime="${EXPECTED_RUNTIME}" -v entrypoint="${OPENCLAW_ENTRYPOINT}" '
        index($0, runtime) > 0 || (index($0, entrypoint) > 0 && index($0, " gateway") > 0) {
          print $1
        }
      '
  )
}

stop_canonical_main_runtime_pids() {
  local pids=()
  local pid=""

  while IFS= read -r pid; do
    [[ -n "${pid}" ]] && pids+=("${pid}")
  done < <(collect_canonical_main_runtime_pids)

  if [[ "${#pids[@]}" -eq 0 ]]; then
    log "no canonical main runtime pids required cleanup"
    return 0
  fi

  log "stopping canonical main runtime pids: ${pids[*]}"
  kill -TERM "${pids[@]}" 2>/dev/null || true
  sleep 2

  local remaining=()
  for pid in "${pids[@]}"; do
    if kill -0 "${pid}" 2>/dev/null; then
      remaining+=("${pid}")
    fi
  done

  if [[ "${#remaining[@]}" -gt 0 ]]; then
    log "force-stopping canonical main runtime pids: ${remaining[*]}"
    kill -KILL "${remaining[@]}" 2>/dev/null || true
  fi
}

install_main_launch_agent() {
  mkdir -p "${CANONICAL_OPENCLAW_LOG_DIR}"
  ensure_node_bin
  (
    cd "${MAIN_REPO}"
    # Recovery always reclaims the default shared gateway for the app-owned
    # runtime under ~/Library/Application Support/OpenClaw. Do not inherit
    # OPENCLAW_HOME, OPENCLAW_STATE_DIR, or OPENCLAW_PROFILE from the caller:
    # stale shells and consumer lanes can otherwise reinstall ai.openclaw.gateway
    # against ~/.openclaw or a profile-normalized identity that looks healthy
    # but boots the wrong runtime.
    #
    # Keep this env intentionally small. The gateway installer persists selected
    # service env into launchd, so passing a full shell environment here could
    # accidentally snapshot tokens or other secrets into the LaunchAgent plist.
    env -i \
      HOME="${HOME}" \
      USER="${USER:-}" \
      LOGNAME="${LOGNAME:-${USER:-}}" \
      TMPDIR="${TMPDIR:-/tmp}" \
      PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}" \
      OPENCLAW_HOME="${CANONICAL_OPENCLAW_HOME}" \
      OPENCLAW_STATE_DIR="${CANONICAL_OPENCLAW_STATE_DIR}" \
      OPENCLAW_CONFIG_PATH="${CANONICAL_OPENCLAW_CONFIG_PATH}" \
      OPENCLAW_LOG_DIR="${CANONICAL_OPENCLAW_LOG_DIR}" \
      OPENCLAW_GATEWAY_BIND="loopback" \
      OPENCLAW_LAUNCHD_LABEL="${GATEWAY_LABEL}" \
      OPENCLAW_MAIN_REPO="${MAIN_REPO}" \
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
  parse_args "$@"
  log "starting deterministic recovery (mode=${RECOVERY_MODE}, port=${PORT}, main=${MAIN_REPO})"

  capture_best_effort "Baseline: HTTP health probe" curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/healthz"
  capture_best_effort "Baseline: lsof listener check" lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN
  capture_best_effort \
    "Baseline: launchctl print (program/arguments/pid/state)" \
    bash -lc "launchctl print gui/\$(id -u)/${GATEWAY_LABEL} | grep -E 'program =|arguments =|pid =|state ='"

  assert_no_jarvis_gateway_conflict

  if canonical_gateway_healthy; then
    log "canonical gateway is already healthy; exiting without restart"
    return 0
  fi

  if [[ "${RECOVERY_MODE}" == "shallow" ]]; then
    log_block "Shallow launchd recovery"
    ensure_gateway_launch_agent_started_or_exit
    assert_launch_agent_running_or_exit "${GATEWAY_LABEL}"

    log_block "Readiness gates"
    wait_for_listener
    wait_for_http_probe

    log_block "Final verification"
    assert_main_runtime_path
    assert_launch_agent_running_or_exit "${GATEWAY_LABEL}"
    log "shallow recovery complete"
    return 0
  fi

  log_block "Full clean stop"
  local uid
  uid="$(id -u)"
  DEFAULT_GATEWAY_STOPPED_FOR_RECOVERY=1
  launchctl bootout "gui/${uid}/${GATEWAY_LABEL}" 2>/dev/null || true
  if [[ "${MANAGE_WATCHDOG}" == "1" ]]; then
    launchctl bootout "gui/${uid}/${WATCHDOG_LABEL}" 2>/dev/null || true
  fi
  stop_canonical_main_runtime_pids
  run_strict bash -lc "ps aux | grep -E 'openclaw-gateway|dist/index.js gateway|openclaw.mjs gateway|ai.openclaw.gateway|gateway-health-watchdog' || true"
  run_strict bash -lc "lsof -nP -iTCP:${PORT} -sTCP:LISTEN || true"

  log_block "Rebuild and reinstall from main runtime"
  run_strict run_shared_runtime_build
  # Recovery is specifically about reclaiming the default shared service for
  # the canonical main runtime, so install from the built repo entrypoint with
  # explicit takeover instead of going through a wrapper that can drift.
  run_strict install_main_launch_agent

  log_block "Bootstrap gateway launch agent"
  kickstart_launch_agent_or_exit "${GATEWAY_LABEL}" "${HOME}/Library/LaunchAgents/${GATEWAY_LABEL}.plist"
  assert_launch_agent_running_or_exit "${GATEWAY_LABEL}"
  DEFAULT_GATEWAY_STOPPED_FOR_RECOVERY=0

  log_block "Readiness gates"
  wait_for_listener
  wait_for_http_probe

  if [[ "${MANAGE_WATCHDOG}" == "1" ]]; then
    log_block "Bootstrap watchdog launch agent"
    kickstart_launch_agent_or_exit "${WATCHDOG_LABEL}" "${HOME}/Library/LaunchAgents/${WATCHDOG_LABEL}.plist"
    assert_launch_agent_running_or_exit "${WATCHDOG_LABEL}"
    stabilize_watchdog
  else
    printf '[gateway-recover-main] Watchdog management disabled by OPENCLAW_GATEWAY_RECOVER_MANAGE_WATCHDOG=0; not asserting %s.\n' "${WATCHDOG_LABEL}" >&2
  fi

  log_block "Final verification"
  assert_main_runtime_path
  assert_launch_agent_running_or_exit "${GATEWAY_LABEL}"
  if [[ "${MANAGE_WATCHDOG}" == "1" ]]; then
    assert_launch_agent_running_or_exit "${WATCHDOG_LABEL}"
  fi
  local launch_command
  launch_command="$(launchctl print "gui/$(id -u)/${GATEWAY_LABEL}" | grep -F -- "${EXPECTED_RUNTIME}" || true)"
  local watchdog_command=""
  if [[ "${MANAGE_WATCHDOG}" == "1" ]]; then
    watchdog_command="$(launchctl print "gui/$(id -u)/${WATCHDOG_LABEL}" | grep -F -- "gateway-watchdog.sh" || true)"
  fi
  local http_result
  http_result="$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/healthz" 2>&1 | head -n 5)"
  local listener_result
  listener_result="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>&1)"

  printf 'LaunchAgent command path:\n%s\n' "${launch_command}"
  if [[ "${MANAGE_WATCHDOG}" == "1" ]]; then
    printf '\nWatchdog LaunchAgent command path:\n%s\n' "${watchdog_command}"
  fi
  printf '\nHTTP probe result:\n%s\n' "${http_result}"
  printf '\nListener result on %s:\n%s\n' "${PORT}" "${listener_result}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
