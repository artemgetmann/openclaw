#!/usr/bin/env bash
set -euo pipefail

JARVIS_LABEL="ai.jarvis.gateway"
OPENCLAW_SHARED_LABEL="ai.openclaw.gateway"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
JARVIS_HOME="${OPENCLAW_JARVIS_HOME:-${HOME}/Library/Application Support/Jarvis}"
JARVIS_STATE_DIR="${OPENCLAW_JARVIS_STATE_DIR:-${JARVIS_HOME}/.jarvis}"
JARVIS_CONFIG_PATH="${OPENCLAW_JARVIS_CONFIG_PATH:-${JARVIS_STATE_DIR}/openclaw.json}"
JARVIS_LOG_DIR="${OPENCLAW_JARVIS_LOG_DIR:-${JARVIS_STATE_DIR}/logs}"
JARVIS_NODE="${OPENCLAW_JARVIS_NODE_BIN:-${JARVIS_STATE_DIR}/tools/node/bin/node}"
JARVIS_ENTRYPOINT="${OPENCLAW_JARVIS_ENTRYPOINT:-${JARVIS_STATE_DIR}/lib/openclaw-bundled/dist/index.js}"
JARVIS_RUNTIME_ROOT="$(dirname -- "$(dirname -- "${JARVIS_ENTRYPOINT}")")"
LAUNCHCTL_BIN="${OPENCLAW_LAUNCHCTL_BIN:-launchctl}"
LSOF_BIN="${OPENCLAW_LSOF_BIN:-lsof}"
JQ_BIN="${OPENCLAW_JQ_BIN:-jq}"
ID_BIN="${OPENCLAW_ID_BIN:-id}"
EXPECTED_COMMIT=""
STATUS_STDOUT_FILE=""
STATUS_STDERR_FILE=""
STATUS_JSON_FILE=""
LIVE_SERVICE_LABEL=""
LIVE_RUNTIME_SOURCE=""
LIVE_RUNTIME_COMMIT=""
LIVE_RUNTIME_PACKAGE_VERSION=""
LIVE_LAUNCH_SERVICE_VERSION=""
LIVE_STATE_DIR=""
LIVE_CONFIG_PATH=""

usage() {
  cat <<'EOF'
Usage: scripts/prove-jarvis-runtime.sh [--expected-commit <sha>]

Read-only proof for the installed Jarvis-managed gateway runtime.

The proof targets ai.jarvis.gateway, Jarvis app-support state, and the
app-managed bundled runtime. It does not deploy, restart, bootout, install,
touch /Applications/Jarvis.app, or mutate ai.openclaw.gateway.
EOF
}

log() {
  printf '[prove-jarvis-runtime] %s\n' "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --expected-commit)
        EXPECTED_COMMIT="${2:-}"
        [[ -n "${EXPECTED_COMMIT}" ]] || die "--expected-commit requires a value"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done
}

require_readonly_tools() {
  command -v "${LAUNCHCTL_BIN}" >/dev/null 2>&1 || die "missing launchctl command"
  command -v "${LSOF_BIN}" >/dev/null 2>&1 || die "missing lsof command"
  command -v "${JQ_BIN}" >/dev/null 2>&1 || die "missing jq command"
  command -v "${ID_BIN}" >/dev/null 2>&1 || die "missing id command"
  [[ -x "${JARVIS_NODE}" ]] || die "Jarvis node runtime is missing or not executable: ${JARVIS_NODE}"
  [[ -r "${JARVIS_ENTRYPOINT}" ]] || die "Jarvis bundled runtime entrypoint is missing: ${JARVIS_ENTRYPOINT}"
}

pid_for_label() {
  local labels="$1"
  local label="$2"
  awk -v label="${label}" '$3 == label { print $1; exit }' <<<"${labels}"
}

require_single_jarvis_gateway_owner() {
  local labels="$1"
  local jarvis_pid=""
  local openclaw_pid=""
  jarvis_pid="$(pid_for_label "${labels}" "${JARVIS_LABEL}")"
  openclaw_pid="$(pid_for_label "${labels}" "${OPENCLAW_SHARED_LABEL}")"

  [[ -n "${jarvis_pid}" ]] || die "${JARVIS_LABEL} is not loaded; Jarvis runtime proof cannot use ${OPENCLAW_SHARED_LABEL}"
  if [[ -n "${openclaw_pid}" ]]; then
    die "both ${JARVIS_LABEL} (pid=${jarvis_pid}) and ${OPENCLAW_SHARED_LABEL} (pid=${openclaw_pid}) are loaded; refuse ambiguous Jarvis proof"
  fi

  printf '%s\n' "${jarvis_pid}"
}

require_jarvis_listener_owner() {
  local jarvis_pid="$1"
  local listener_output="$2"

  [[ -n "${listener_output}" ]] || die "no listener found on TCP port ${PORT}"
  if ! awk -v pid="${jarvis_pid}" 'NR > 1 && $2 == pid { found = 1 } END { exit(found ? 0 : 1) }' <<<"${listener_output}"; then
    die "TCP port ${PORT} is not owned by ${JARVIS_LABEL} pid=${jarvis_pid}"
  fi
}

require_live_gateway_log_owner() {
  local jarvis_pid="$1"
  local process_output=""
  process_output="$("${LSOF_BIN}" -nP -p "${jarvis_pid}" 2>/dev/null || true)"

  [[ "${process_output}" == *"${JARVIS_LOG_DIR}/gateway.log"* ]] || \
    die "${JARVIS_LABEL} pid=${jarvis_pid} does not have ${JARVIS_LOG_DIR}/gateway.log open; cannot bind runtime identity to the live daemon"
}

require_launchctl_print_line() {
  local print_output="$1"
  local expected="$2"
  local label="$3"

  awk -v expected="${expected}" '
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)
      if (line == expected) {
        found = 1
      }
    }
    END { exit(found ? 0 : 1) }
  ' <<<"${print_output}" || die "launchctl ${label} does not prove Jarvis runtime ownership"
}

require_loaded_launchctl_config() {
  local jarvis_pid="$1"
  local domain=""
  local print_output=""
  domain="gui/$("${ID_BIN}" -u)"
  print_output="$("${LAUNCHCTL_BIN}" print "${domain}/${JARVIS_LABEL}" 2>/dev/null || true)"

  [[ -n "${print_output}" ]] || die "launchctl print did not return loaded config for ${JARVIS_LABEL}"
  require_launchctl_print_line "${print_output}" "state = running" "state"
  require_launchctl_print_line "${print_output}" "pid = ${jarvis_pid}" "pid"
  require_launchctl_print_line "${print_output}" "program = ${JARVIS_NODE}" "program"
  require_launchctl_print_line "${print_output}" "${JARVIS_ENTRYPOINT}" "entrypoint"
  require_launchctl_print_line "${print_output}" "working directory = ${JARVIS_RUNTIME_ROOT}" "working directory"
  require_launchctl_print_line "${print_output}" "OPENCLAW_HOME => ${JARVIS_HOME}" "OPENCLAW_HOME"
  require_launchctl_print_line "${print_output}" "OPENCLAW_STATE_DIR => ${JARVIS_STATE_DIR}" "OPENCLAW_STATE_DIR"
  require_launchctl_print_line "${print_output}" "OPENCLAW_CONFIG_PATH => ${JARVIS_CONFIG_PATH}" "OPENCLAW_CONFIG_PATH"
  require_launchctl_print_line "${print_output}" "OPENCLAW_LOG_DIR => ${JARVIS_LOG_DIR}" "OPENCLAW_LOG_DIR"
  require_launchctl_print_line "${print_output}" "OPENCLAW_LAUNCHD_LABEL => ${JARVIS_LABEL}" "OPENCLAW_LAUNCHD_LABEL"
  require_launchctl_print_line "${print_output}" "OPENCLAW_PROFILE => consumer" "OPENCLAW_PROFILE"
  require_launchctl_print_line "${print_output}" "OPENCLAW_GATEWAY_PORT => ${PORT}" "OPENCLAW_GATEWAY_PORT"
}

commit_matches() {
  local expected="$1"
  local actual="$2"
  [[ -z "${expected}" ]] && return 0
  [[ -n "${actual}" ]] || return 1
  [[ "${expected}" == "${actual}"* || "${actual}" == "${expected}"* ]]
}

identity_field() {
  local line="$1"
  local key="$2"
  local value=""

  value="$(printf '%s\n' "${line}" | sed -E "s/^.*(^|[[:space:]])${key}=//")"
  [[ "${value}" != "${line}" ]] || return 1
  # Values can include spaces, for example paths under "Application Support".
  # Runtime identity fields are key=value pairs, so the next " key=" marks the
  # end of this value more reliably than plain shell word splitting.
  printf '%s\n' "${value}" | sed -E 's/[[:space:]][[:alpha:]_][[:alnum:]_]*=.*$//'
}

assert_identity_field() {
  local key="$1"
  local actual="$2"
  local expected="$3"

  [[ "${actual}" == "${expected}" ]] || die "live runtime ${key}=${actual:-missing}, expected ${expected}"
}

assert_live_runtime_identity() {
  local log_file="${JARVIS_LOG_DIR}/gateway.log"
  local line=""

  [[ -r "${log_file}" ]] || die "Jarvis gateway log is not readable: ${log_file}"
  line="$(grep -F "[gateway] runtime identity:" "${log_file}" | tail -n 1 || true)"
  [[ -n "${line}" ]] || die "Jarvis gateway log has no live runtime identity line"

  LIVE_SERVICE_LABEL="$(identity_field "${line}" "serviceLabel" || true)"
  LIVE_RUNTIME_SOURCE="$(identity_field "${line}" "runtimeSource" || true)"
  LIVE_RUNTIME_COMMIT="$(identity_field "${line}" "runtimeCommit" || true)"
  LIVE_RUNTIME_PACKAGE_VERSION="$(identity_field "${line}" "runtimePackageVersion" || true)"
  LIVE_LAUNCH_SERVICE_VERSION="$(identity_field "${line}" "launchServiceVersion" || true)"
  LIVE_STATE_DIR="$(identity_field "${line}" "stateDir" || true)"
  LIVE_CONFIG_PATH="$(identity_field "${line}" "configPath" || true)"

  assert_identity_field "serviceLabel" "${LIVE_SERVICE_LABEL}" "${JARVIS_LABEL}"
  assert_identity_field "runtimeSource" "${LIVE_RUNTIME_SOURCE}" "jarvis-managed-bundle"
  assert_identity_field "stateDir" "${LIVE_STATE_DIR}" "${JARVIS_STATE_DIR}"
  assert_identity_field "configPath" "${LIVE_CONFIG_PATH}" "${JARVIS_CONFIG_PATH}"
  [[ -n "${LIVE_RUNTIME_COMMIT}" ]] || die "runtimeCommit=missing, expected ${EXPECTED_COMMIT:-a live daemon revision}"
  commit_matches "${EXPECTED_COMMIT}" "${LIVE_RUNTIME_COMMIT}" || die "runtimeCommit=${LIVE_RUNTIME_COMMIT:-missing}, expected ${EXPECTED_COMMIT}"
}

run_status_json() {
  local stdout_file="$1"
  local stderr_file="$2"

  OPENCLAW_HOME="${JARVIS_HOME}" \
  OPENCLAW_STATE_DIR="${JARVIS_STATE_DIR}" \
  OPENCLAW_CONFIG_PATH="${JARVIS_CONFIG_PATH}" \
  OPENCLAW_LOG_DIR="${JARVIS_LOG_DIR}" \
  OPENCLAW_PROFILE=consumer \
  OPENCLAW_LAUNCHD_LABEL="${JARVIS_LABEL}" \
    "${JARVIS_NODE}" "${JARVIS_ENTRYPOINT}" gateway status --deep --require-rpc --json \
      >"${stdout_file}" 2>"${stderr_file}"
}

jq_field() {
  local file="$1"
  local expression="$2"
  "${JQ_BIN}" -r "${expression}" "${file}"
}

extract_status_json() {
  local raw_file="$1"
  local json_file="$2"

  if "${JQ_BIN}" -e . "${raw_file}" >/dev/null 2>&1; then
    cp "${raw_file}" "${json_file}"
    return 0
  fi

  # Runtime status can print config warnings before the machine JSON. Keep the
  # proof strict about the payload while tolerating those non-secret warnings.
  # Status JSON is pretty-printed, so extract the full block instead of looking
  # for a single parseable line.
  awk 'found || /^[[:space:]]*\{/ { found = 1; print }' "${raw_file}" >"${json_file}"
  if [[ -s "${json_file}" ]] && "${JQ_BIN}" -e . "${json_file}" >/dev/null 2>&1; then
    return 0
  fi

  die "Jarvis status command did not emit parseable JSON"
}

assert_status_probe() {
  local status_file="$1"
  local rpc_ok=""
  local healthy=""

  rpc_ok="$(
    "${JQ_BIN}" -r --arg probe_url "ws://127.0.0.1:${PORT}" '
      .rpc.ok // (
        [
          .targets[]?
          | select((.id == "localLoopback" or .kind == "localLoopback" or .url == $probe_url) and .connect.rpcOk == true)
        ] | length > 0
      )
    ' "${status_file}"
  )"
  healthy="$(
    "${JQ_BIN}" -r --arg probe_url "ws://127.0.0.1:${PORT}" '
      .health.healthy // (
        [
          .targets[]?
          | select(.id == "localLoopback" or .kind == "localLoopback" or .url == $probe_url)
          | .health as $health
          | select(($health == true) or (($health | type) == "object" and (($health.healthy // $health.ok) == true)))
        ] | length > 0
      )
    ' "${status_file}"
  )"

  [[ "${rpc_ok}" == "true" ]] || die "RPC probe is not ok"
  [[ "${healthy}" == "true" ]] || die "gateway health is not healthy"
}

print_proof() {
  local jarvis_pid="$1"
  log "jarvis_runtime_proof=true"
  log "service_label=${LIVE_SERVICE_LABEL}"
  log "runtime_source=${LIVE_RUNTIME_SOURCE}"
  log "runtime_commit=${LIVE_RUNTIME_COMMIT:-unknown}"
  log "runtime_package_version=${LIVE_RUNTIME_PACKAGE_VERSION:-unknown}"
  log "launch_service_version=${LIVE_LAUNCH_SERVICE_VERSION:-unknown}"
  log "state_dir=${LIVE_STATE_DIR}"
  log "config_path=${LIVE_CONFIG_PATH}"
  log "pid=${jarvis_pid}"
  log "listener=127.0.0.1:${PORT}"
  log "launchctl_loaded_config=jarvis-managed-bundle"
  log "rpc=ok"
  log "health=healthy"
  log "runtime_mutation=none"
  log "applications_jarvis_app=untouched"
}

main() {
  parse_args "$@"
  require_readonly_tools

  local labels=""
  local jarvis_pid=""
  local listener_output=""
  labels="$("${LAUNCHCTL_BIN}" list 2>/dev/null || true)"
  jarvis_pid="$(require_single_jarvis_gateway_owner "${labels}")"
  require_loaded_launchctl_config "${jarvis_pid}"
  listener_output="$("${LSOF_BIN}" -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  require_jarvis_listener_owner "${jarvis_pid}" "${listener_output}"
  require_live_gateway_log_owner "${jarvis_pid}"
  assert_live_runtime_identity

  STATUS_STDOUT_FILE="$(mktemp "${TMPDIR:-/tmp}/jarvis-runtime-status.XXXXXX")"
  STATUS_STDERR_FILE="$(mktemp "${TMPDIR:-/tmp}/jarvis-runtime-status.err.XXXXXX")"
  STATUS_JSON_FILE="$(mktemp "${TMPDIR:-/tmp}/jarvis-runtime-status.json.XXXXXX")"
  cleanup() {
    rm -f "${STATUS_STDOUT_FILE}" "${STATUS_STDERR_FILE}" "${STATUS_JSON_FILE}"
  }
  trap cleanup EXIT

  if ! run_status_json "${STATUS_STDOUT_FILE}" "${STATUS_STDERR_FILE}"; then
    die "Jarvis status command failed; stderr saved at ${STATUS_STDERR_FILE}"
  fi
  extract_status_json "${STATUS_STDOUT_FILE}" "${STATUS_JSON_FILE}"

  assert_status_probe "${STATUS_JSON_FILE}"
  print_proof "${jarvis_pid}"
}

main "$@"
