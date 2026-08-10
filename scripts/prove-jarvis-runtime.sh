#!/usr/bin/env bash
set -euo pipefail

JARVIS_LABEL="${OPENCLAW_JARVIS_GATEWAY_LABEL:-ai.jarvis.gateway}"
OPENCLAW_SHARED_LABEL="ai.openclaw.gateway"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
JARVIS_HOME="${OPENCLAW_JARVIS_HOME:-${HOME}/Library/Application Support/Jarvis}"
JARVIS_STATE_DIR="${OPENCLAW_JARVIS_STATE_DIR:-${JARVIS_HOME}/.jarvis}"
JARVIS_CONFIG_PATH="${OPENCLAW_JARVIS_CONFIG_PATH:-${JARVIS_STATE_DIR}/openclaw.json}"
JARVIS_LOG_DIR="${OPENCLAW_JARVIS_LOG_DIR:-${JARVIS_STATE_DIR}/logs}"
JARVIS_NODE="${OPENCLAW_JARVIS_NODE_BIN:-${JARVIS_STATE_DIR}/tools/node/bin/node}"
JARVIS_ENTRYPOINT="${OPENCLAW_JARVIS_ENTRYPOINT:-${JARVIS_STATE_DIR}/lib/openclaw-bundled/dist/index.js}"
JARVIS_RUNTIME_ROOT="$(dirname -- "$(dirname -- "${JARVIS_ENTRYPOINT}")")"
JARVIS_BUILD_INFO="${JARVIS_RUNTIME_ROOT}/dist/build-info.json"
JARVIS_APP_PATH="${OPENCLAW_INSTALLED_JARVIS_APP_PATH:-/Applications/Jarvis.app}"
JARVIS_APP_MANIFEST="${OPENCLAW_JARVIS_APP_MANIFEST:-${JARVIS_APP_PATH}/Contents/Resources/OpenClawRuntime/manifest.json}"
JARVIS_INSTALLED_MANIFEST="${OPENCLAW_JARVIS_INSTALLED_MANIFEST:-${JARVIS_STATE_DIR}/.consumer-bundled-runtime.json}"
JARVIS_PROTECTION_MARKER="${OPENCLAW_JARVIS_PROTECTION_MARKER:-${JARVIS_STATE_DIR}/.consumer-bundled-runtime.protection.json}"
LAUNCHCTL_BIN="${OPENCLAW_LAUNCHCTL_BIN:-launchctl}"
LSOF_BIN="${OPENCLAW_LSOF_BIN:-lsof}"
JQ_BIN="${OPENCLAW_JQ_BIN:-jq}"
ID_BIN="${OPENCLAW_ID_BIN:-id}"
EXPECTED_COMMIT=""
EXPECTED_RUNTIME_SOURCE="jarvis-managed-bundle"
EXPECTED_PACKAGE_VERSION=""
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
Usage: scripts/prove-jarvis-runtime.sh [--expected-commit <sha>] [--runtime-source <source>]

Read-only proof for the installed Jarvis-managed gateway runtime.

The proof targets ai.jarvis.gateway, Jarvis app-support state, and the
app-managed bundled runtime by default. Pass
--runtime-source jarvis-break-glass-hotfix only for an explicitly protected
hotfix. It does not deploy, restart, bootout, install, touch
/Applications/Jarvis.app, or mutate ai.openclaw.gateway.
EOF
}

log() {
  printf '[prove-jarvis-runtime] %s\n' "$*"
}

die() {
  # Keep failure metadata machine-readable and credential-free so callers can
  # explain a source mismatch without echoing raw launchd or status output.
  log "ERROR: $*; runtime_source_observed=${LIVE_RUNTIME_SOURCE:-unknown}; runtime_source_expected=${EXPECTED_RUNTIME_SOURCE}" >&2
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
      --runtime-source)
        EXPECTED_RUNTIME_SOURCE="${2:-}"
        [[ "${EXPECTED_RUNTIME_SOURCE}" == "jarvis-managed-bundle" || \
          "${EXPECTED_RUNTIME_SOURCE}" == "jarvis-break-glass-hotfix" ]] || \
          die "--runtime-source must be jarvis-managed-bundle or jarvis-break-glass-hotfix"
        shift 2
        ;;
      --expected-package-version)
        EXPECTED_PACKAGE_VERSION="${2:-}"
        [[ -n "${EXPECTED_PACKAGE_VERSION}" ]] || die "--expected-package-version requires a value"
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
  local list_available="$2"
  local jarvis_pid=""
  local openclaw_pid=""
  jarvis_pid="$(pid_for_label "${labels}" "${JARVIS_LABEL}")"
  openclaw_pid="$(pid_for_label "${labels}" "${OPENCLAW_SHARED_LABEL}")"

  if [[ "${list_available}" != "1" ]]; then
    local domain=""
    local jarvis_print=""
    local openclaw_print=""
    domain="gui/$("${ID_BIN}" -u)"
    jarvis_print="$("${LAUNCHCTL_BIN}" print "${domain}/${JARVIS_LABEL}" 2>/dev/null || true)"
    openclaw_print="$("${LAUNCHCTL_BIN}" print "${domain}/${OPENCLAW_SHARED_LABEL}" 2>/dev/null || true)"

    # Managed execution can deny `launchctl list` while direct service lookup
    # remains available. Recover ownership from that stronger scoped query
    # instead of misreporting an unavailable list as an unloaded gateway.
    jarvis_pid="$(awk '$1 == "pid" && $2 == "=" { print $3; exit }' <<<"${jarvis_print}")"
    if [[ -n "${openclaw_print}" ]]; then
      openclaw_pid="$(awk '$1 == "pid" && $2 == "=" { print $3; exit }' <<<"${openclaw_print}")"
      openclaw_pid="${openclaw_pid:-loaded}"
    fi
  fi

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

is_git_commit() {
  [[ "$1" =~ ^[0-9a-fA-F]{7,40}$ ]]
}

is_full_git_commit() {
  [[ "$1" =~ ^[0-9a-fA-F]{40}$ ]]
}

commit_is_prefix_of_exact() {
  local abbreviated="$1"
  local exact="$2"
  is_git_commit "${abbreviated}" && is_full_git_commit "${exact}" && [[ "${exact}" == "${abbreviated}"* ]]
}

canonicalize_live_protected_runtime_commit() {
  local build_commit=""

  [[ "${EXPECTED_RUNTIME_SOURCE}" == "jarvis-break-glass-hotfix" ]] || return 0
  is_git_commit "${LIVE_RUNTIME_COMMIT}" || \
    die "protected-hotfix runtimeCommit=${LIVE_RUNTIME_COMMIT:-missing} is not a git commit"
  is_full_git_commit "${LIVE_RUNTIME_COMMIT}" && return 0

  # Runtime identity intentionally reports a short commit for display. Expand
  # it only from build metadata inside the exact launchd-owned runtime tree.
  # A repository lookup or marker value would not bind the full hash to the
  # daemon whose entrypoint and working directory were already proven above.
  [[ -r "${JARVIS_BUILD_INFO}" ]] || \
    die "protected-hotfix build metadata is not readable: ${JARVIS_BUILD_INFO}"
  build_commit="$("${JQ_BIN}" -r '.commit // empty' "${JARVIS_BUILD_INFO}")"
  is_full_git_commit "${build_commit}" || \
    die "protected-hotfix build metadata has missing or non-exact commit"
  commit_is_prefix_of_exact "${LIVE_RUNTIME_COMMIT}" "${build_commit}" || \
    die "protected-hotfix runtimeCommit=${LIVE_RUNTIME_COMMIT} does not match exact build commit ${build_commit}"

  LIVE_RUNTIME_COMMIT="${build_commit}"
}

assert_packaged_runtime_provenance() {
  local installed_commit=""
  local installed_version=""
  local protected_commit=""
  local compatibility_commit=""
  local compatibility_version=""

  [[ -r "${JARVIS_INSTALLED_MANIFEST}" ]] || \
    die "installed Jarvis runtime manifest is not readable: ${JARVIS_INSTALLED_MANIFEST}"
  installed_commit="$("${JQ_BIN}" -r '.gitCommit // empty' "${JARVIS_INSTALLED_MANIFEST}")"
  installed_version="$("${JQ_BIN}" -r '.bundleVersion // empty' "${JARVIS_INSTALLED_MANIFEST}")"
  is_git_commit "${installed_commit}" || die "installed Jarvis runtime manifest has missing or invalid gitCommit"
  [[ -n "${installed_version}" ]] || die "installed Jarvis runtime manifest is missing bundleVersion"

  if commit_matches "${installed_commit}" "${LIVE_RUNTIME_COMMIT}"; then
    return 0
  fi

  if [[ -r "${JARVIS_PROTECTION_MARKER}" ]]; then
    protected_commit="$("${JQ_BIN}" -r '.protectedRuntimeGitCommit // empty' "${JARVIS_PROTECTION_MARKER}")"
    compatibility_commit="$("${JQ_BIN}" -r '.compatibilityManifestGitCommit // empty' "${JARVIS_PROTECTION_MARKER}")"
    compatibility_version="$("${JQ_BIN}" -r '.compatibilityManifestBundleVersion // empty' "${JARVIS_PROTECTION_MARKER}")"
  fi

  if is_git_commit "${protected_commit}" && is_git_commit "${compatibility_commit}" && \
      commit_matches "${protected_commit}" "${LIVE_RUNTIME_COMMIT}" && \
      commit_matches "${compatibility_commit}" "${installed_commit}" && \
      [[ -n "${compatibility_version}" && "${compatibility_version}" == "${installed_version}" ]]; then
    die "runtimeSource=jarvis-break-glass-hotfix: live commit ${LIVE_RUNTIME_COMMIT} is protected behind compatibility manifest ${installed_commit}; packaged Jarvis proof refused"
  fi

  # An Application Support path is not provenance. Refuse inconsistent receipt
  # state even when an older running build still self-reports managed-bundle.
  die "Jarvis runtime commit ${LIVE_RUNTIME_COMMIT} does not match installed package manifest ${installed_commit}; packaged Jarvis proof refused"
}

assert_protected_hotfix_runtime_provenance() {
  local installed_commit=""
  local installed_version=""
  local protected_commit=""
  local compatibility_commit=""
  local compatibility_version=""
  local backup_path=""
  local backup_commit=""
  local app_commit=""
  local app_version=""
  local compatibility_source=""

  # The compatibility manifest intentionally describes the installed app while
  # the marker and backup receipt preserve the newer live payload's identity.
  # All three records are required; a marker alone is not protection proof.
  [[ -r "${JARVIS_INSTALLED_MANIFEST}" ]] || \
    die "protected-hotfix compatibility manifest is not readable: ${JARVIS_INSTALLED_MANIFEST}"
  [[ -r "${JARVIS_PROTECTION_MARKER}" ]] || \
    die "protected-hotfix marker is not readable: ${JARVIS_PROTECTION_MARKER}"
  [[ -r "${JARVIS_APP_MANIFEST}" ]] || \
    die "installed Jarvis app manifest is not readable: ${JARVIS_APP_MANIFEST}"

  installed_commit="$("${JQ_BIN}" -r '.gitCommit // empty' "${JARVIS_INSTALLED_MANIFEST}")"
  installed_version="$("${JQ_BIN}" -r '.bundleVersion // empty' "${JARVIS_INSTALLED_MANIFEST}")"
  protected_commit="$("${JQ_BIN}" -r '.protectedRuntimeGitCommit // empty' "${JARVIS_PROTECTION_MARKER}")"
  compatibility_commit="$("${JQ_BIN}" -r '.compatibilityManifestGitCommit // empty' "${JARVIS_PROTECTION_MARKER}")"
  compatibility_version="$("${JQ_BIN}" -r '.compatibilityManifestBundleVersion // empty' "${JARVIS_PROTECTION_MARKER}")"
  compatibility_source="$("${JQ_BIN}" -r '.compatibilityManifestSource // empty' "${JARVIS_PROTECTION_MARKER}")"
  backup_path="$("${JQ_BIN}" -r '.backupPath // empty' "${JARVIS_PROTECTION_MARKER}")"
  app_commit="$("${JQ_BIN}" -r '.gitCommit // empty' "${JARVIS_APP_MANIFEST}")"
  app_version="$("${JQ_BIN}" -r '.bundleVersion // empty' "${JARVIS_APP_MANIFEST}")"

  is_git_commit "${installed_commit}" || die "protected-hotfix compatibility manifest has missing or invalid gitCommit"
  [[ -n "${installed_version}" ]] || die "protected-hotfix compatibility manifest is missing bundleVersion"
  is_git_commit "${protected_commit}" || die "protected-hotfix marker has missing or invalid protectedRuntimeGitCommit"
  is_git_commit "${compatibility_commit}" || die "protected-hotfix marker has missing or invalid compatibilityManifestGitCommit"
  is_git_commit "${app_commit}" || die "installed Jarvis app manifest has missing or invalid gitCommit"
  commit_is_prefix_of_exact "${protected_commit}" "${LIVE_RUNTIME_COMMIT}" || \
    die "protected-hotfix marker commit=${protected_commit:-missing}, expected ${LIVE_RUNTIME_COMMIT}"
  commit_matches "${installed_commit}" "${compatibility_commit}" || \
    die "protected-hotfix compatibility commit=${compatibility_commit:-missing}, expected ${installed_commit}"
  [[ "${compatibility_version}" == "${installed_version}" ]] || \
    die "protected-hotfix compatibility version=${compatibility_version:-missing}, expected ${installed_version}"
  [[ "${compatibility_source}" == "${JARVIS_APP_PATH}" ]] || \
    die "protected-hotfix compatibility source=${compatibility_source:-missing}, expected ${JARVIS_APP_PATH}"
  commit_matches "${installed_commit}" "${app_commit}" || \
    die "installed Jarvis app commit=${app_commit:-missing}, expected compatibility commit ${installed_commit}"
  [[ "${app_version}" == "${installed_version}" ]] || \
    die "installed Jarvis app version=${app_version:-missing}, expected compatibility version ${installed_version}"
  [[ -n "${backup_path}" && -r "${backup_path}" ]] || \
    die "protected-hotfix backup receipt is missing or unreadable"
  backup_commit="$("${JQ_BIN}" -r '.gitCommit // empty' "${backup_path}")"
  is_git_commit "${backup_commit}" || die "protected-hotfix backup receipt has missing or invalid gitCommit"
  commit_is_prefix_of_exact "${backup_commit}" "${LIVE_RUNTIME_COMMIT}" || \
    die "protected-hotfix backup commit=${backup_commit:-missing}, expected ${LIVE_RUNTIME_COMMIT}"
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
  if [[ "${EXPECTED_RUNTIME_SOURCE}" == "jarvis-managed-bundle" && \
    "${LIVE_RUNTIME_SOURCE}" == "jarvis-break-glass-hotfix" ]]; then
    die "runtimeSource=jarvis-break-glass-hotfix; packaged Jarvis proof refused"
  fi
  assert_identity_field "runtimeSource" "${LIVE_RUNTIME_SOURCE}" "${EXPECTED_RUNTIME_SOURCE}"
  canonicalize_live_protected_runtime_commit
  assert_identity_field "stateDir" "${LIVE_STATE_DIR}" "${JARVIS_STATE_DIR}"
  assert_identity_field "configPath" "${LIVE_CONFIG_PATH}" "${JARVIS_CONFIG_PATH}"
  [[ -n "${LIVE_RUNTIME_COMMIT}" ]] || die "runtimeCommit=missing, expected ${EXPECTED_COMMIT:-a live daemon revision}"
  commit_matches "${EXPECTED_COMMIT}" "${LIVE_RUNTIME_COMMIT}" || die "runtimeCommit=${LIVE_RUNTIME_COMMIT:-missing}, expected ${EXPECTED_COMMIT}"
  if [[ -n "${EXPECTED_PACKAGE_VERSION}" ]]; then
    assert_identity_field "runtimePackageVersion" "${LIVE_RUNTIME_PACKAGE_VERSION}" "${EXPECTED_PACKAGE_VERSION}"
  fi
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
  local status_service_label=""
  local status_runtime_source=""
  local status_runtime_commit=""
  local status_runtime_package_version=""
  local status_state_dir=""
  local status_config_path=""

  status_service_label="$(jq_field "${status_file}" '.runtimeFingerprint.serviceLabel // empty')"
  status_runtime_source="$(jq_field "${status_file}" '.runtimeFingerprint.runtimeSource // empty')"
  status_runtime_commit="$(jq_field "${status_file}" '.runtimeFingerprint.runtimeCommit // empty')"
  status_runtime_package_version="$(jq_field "${status_file}" '.runtimeFingerprint.runtimePackageVersion // empty')"
  status_state_dir="$(jq_field "${status_file}" '.runtimeFingerprint.stateDir // empty')"
  status_config_path="$(jq_field "${status_file}" '.runtimeFingerprint.configPath // empty')"

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
  assert_identity_field "status serviceLabel" "${status_service_label}" "${JARVIS_LABEL}"
  assert_identity_field "status runtimeSource" "${status_runtime_source}" "${EXPECTED_RUNTIME_SOURCE}"
  if [[ "${EXPECTED_RUNTIME_SOURCE}" == "jarvis-break-glass-hotfix" ]]; then
    commit_is_prefix_of_exact "${status_runtime_commit}" "${LIVE_RUNTIME_COMMIT}" || \
      die "live runtime status runtimeCommit=${status_runtime_commit:-missing}, expected ${LIVE_RUNTIME_COMMIT}"
  else
    commit_matches "${LIVE_RUNTIME_COMMIT}" "${status_runtime_commit}" || \
      die "live runtime status runtimeCommit=${status_runtime_commit:-missing}, expected ${LIVE_RUNTIME_COMMIT}"
  fi
  assert_identity_field "status stateDir" "${status_state_dir}" "${JARVIS_STATE_DIR}"
  assert_identity_field "status configPath" "${status_config_path}" "${JARVIS_CONFIG_PATH}"
  if [[ -n "${EXPECTED_PACKAGE_VERSION}" ]]; then
    assert_identity_field "status runtimePackageVersion" "${status_runtime_package_version}" "${EXPECTED_PACKAGE_VERSION}"
  fi
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
  log "launchctl_loaded_config=jarvis-application-support"
  log "rpc=ok"
  log "health=healthy"
  log "runtime_mutation=none"
  log "applications_jarvis_app=untouched"
}

main() {
  parse_args "$@"
  require_readonly_tools

  local labels=""
  local list_available="0"
  local jarvis_pid=""
  local listener_output=""
  if labels="$("${LAUNCHCTL_BIN}" list 2>/dev/null)"; then
    list_available="1"
  else
    labels=""
  fi
  jarvis_pid="$(require_single_jarvis_gateway_owner "${labels}" "${list_available}")"
  require_loaded_launchctl_config "${jarvis_pid}"
  listener_output="$("${LSOF_BIN}" -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  require_jarvis_listener_owner "${jarvis_pid}" "${listener_output}"
  require_live_gateway_log_owner "${jarvis_pid}"
  assert_live_runtime_identity
  if [[ "${EXPECTED_RUNTIME_SOURCE}" == "jarvis-managed-bundle" ]]; then
    assert_packaged_runtime_provenance
  else
    assert_protected_hotfix_runtime_provenance
  fi

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
