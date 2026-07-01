#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="protect-jarvis-runtime-from-app-reseed"
JARVIS_LABEL="ai.jarvis.gateway"
OPENCLAW_SHARED_LABEL="ai.openclaw.gateway"
APP_PATH="${OPENCLAW_INSTALLED_JARVIS_APP_PATH:-/Applications/Jarvis.app}"
JARVIS_HOME="${OPENCLAW_JARVIS_HOME:-${HOME}/Library/Application Support/Jarvis}"
JARVIS_STATE_DIR="${OPENCLAW_JARVIS_STATE_DIR:-${JARVIS_HOME}/.jarvis}"
JARVIS_CONFIG_PATH="${OPENCLAW_JARVIS_CONFIG_PATH:-${JARVIS_STATE_DIR}/openclaw.json}"
JARVIS_LOG_DIR="${OPENCLAW_JARVIS_LOG_DIR:-${JARVIS_STATE_DIR}/logs}"
JARVIS_NODE="${OPENCLAW_JARVIS_NODE_BIN:-${JARVIS_STATE_DIR}/tools/node/bin/node}"
JARVIS_ENTRYPOINT="${OPENCLAW_JARVIS_ENTRYPOINT:-${JARVIS_STATE_DIR}/lib/openclaw-bundled/dist/index.js}"
JARVIS_RUNTIME_ROOT="$(dirname -- "$(dirname -- "${JARVIS_ENTRYPOINT}")")"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
LAUNCHCTL_BIN="${OPENCLAW_LAUNCHCTL_BIN:-launchctl}"
LSOF_BIN="${OPENCLAW_LSOF_BIN:-lsof}"
ID_BIN="${OPENCLAW_ID_BIN:-id}"
EXPECTED_LIVE_COMMIT=""
APPLY=0

log() {
  printf '[%s] %s\n' "${SCRIPT_NAME}" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/protect-jarvis-runtime-from-app-reseed.sh --expected-live-commit <sha> --apply

Protects the current Jarvis app-support runtime from being silently reseeded by
an already-installed older /Applications/Jarvis.app.

This script does not touch /Applications/Jarvis.app. It mutates only:
  ~/Library/Application Support/Jarvis/.jarvis/.consumer-bundled-runtime.json
  ~/Library/Application Support/Jarvis/.jarvis/.consumer-bundled-runtime.protection.json

Why this exists:
  Old app builds decide whether to reseed by comparing their bundled manifest to
  the installed app-support manifest. If the live runtime was refreshed from a
  newer source build but /Applications/Jarvis.app is still old, reopening that
  app can overwrite the live fixed runtime. This script writes a compatibility
  manifest matching the installed app while preserving an audit marker with the
  actual live runtime commit.

Options:
  --expected-live-commit <sha>  Required. Refuses to protect the wrong runtime.
  --app <path>                  Jarvis app bundle. Default: /Applications/Jarvis.app
  --state-dir <path>            Jarvis state dir. Default: ~/Library/Application Support/Jarvis/.jarvis
  --apply                       Required for mutation. Without it, this is a dry run.
EOF
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --expected-live-commit)
        EXPECTED_LIVE_COMMIT="${2:-}"
        shift 2
        ;;
      --app)
        APP_PATH="${2:-}"
        shift 2
        ;;
      --state-dir)
        JARVIS_STATE_DIR="${2:-}"
        JARVIS_HOME="$(dirname -- "${JARVIS_STATE_DIR}")"
        JARVIS_CONFIG_PATH="${JARVIS_STATE_DIR}/openclaw.json"
        JARVIS_LOG_DIR="${JARVIS_STATE_DIR}/logs"
        JARVIS_NODE="${JARVIS_STATE_DIR}/tools/node/bin/node"
        JARVIS_ENTRYPOINT="${JARVIS_STATE_DIR}/lib/openclaw-bundled/dist/index.js"
        JARVIS_RUNTIME_ROOT="$(dirname -- "$(dirname -- "${JARVIS_ENTRYPOINT}")")"
        shift 2
        ;;
      --apply)
        APPLY=1
        shift
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

  [[ -n "${EXPECTED_LIVE_COMMIT}" ]] || die "--expected-live-commit is required"
}

require_tools() {
  command -v jq >/dev/null 2>&1 || die "missing jq"
  command -v sed >/dev/null 2>&1 || die "missing sed"
  command -v awk >/dev/null 2>&1 || die "missing awk"
  command -v "${LAUNCHCTL_BIN}" >/dev/null 2>&1 || die "missing launchctl command"
  command -v "${LSOF_BIN}" >/dev/null 2>&1 || die "missing lsof command"
  command -v "${ID_BIN}" >/dev/null 2>&1 || die "missing id command"
  [[ -x "${JARVIS_NODE}" ]] || die "Jarvis node runtime is missing or not executable: ${JARVIS_NODE}"
  [[ -r "${JARVIS_ENTRYPOINT}" ]] || die "Jarvis bundled runtime entrypoint is missing: ${JARVIS_ENTRYPOINT}"
}

json_field() {
  local file="$1"
  local field="$2"
  jq -r --arg field "${field}" '.[$field] // empty' "${file}"
}

commit_matches() {
  local expected="$1"
  local actual="$2"
  [[ -n "${expected}" && -n "${actual}" ]] || return 1
  [[ "${expected}" == "${actual}"* || "${actual}" == "${expected}"* ]]
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

  [[ -n "${jarvis_pid}" ]] || die "${JARVIS_LABEL} is not loaded; refusing to protect ${OPENCLAW_SHARED_LABEL}"
  if [[ -n "${openclaw_pid}" ]]; then
    die "both ${JARVIS_LABEL} (pid=${jarvis_pid}) and ${OPENCLAW_SHARED_LABEL} (pid=${openclaw_pid}) are loaded; refuse ambiguous Jarvis protection"
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

require_launchctl_line() {
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

require_live_launchctl_runtime() {
  local jarvis_pid="$1"
  local domain=""
  local print_output=""

  domain="gui/$("${ID_BIN}" -u)"
  print_output="$("${LAUNCHCTL_BIN}" print "${domain}/${JARVIS_LABEL}" 2>/dev/null || true)"
  [[ -n "${print_output}" ]] || die "launchctl print did not return loaded config for ${JARVIS_LABEL}"

  require_launchctl_line "${print_output}" "state = running" "state"
  require_launchctl_line "${print_output}" "pid = ${jarvis_pid}" "pid"
  require_launchctl_line "${print_output}" "program = ${JARVIS_NODE}" "program"
  require_launchctl_line "${print_output}" "${JARVIS_ENTRYPOINT}" "entrypoint"
  require_launchctl_line "${print_output}" "working directory = ${JARVIS_RUNTIME_ROOT}" "working directory"
  require_launchctl_line "${print_output}" "OPENCLAW_HOME => ${JARVIS_HOME}" "OPENCLAW_HOME"
  require_launchctl_line "${print_output}" "OPENCLAW_STATE_DIR => ${JARVIS_STATE_DIR}" "OPENCLAW_STATE_DIR"
  require_launchctl_line "${print_output}" "OPENCLAW_CONFIG_PATH => ${JARVIS_CONFIG_PATH}" "OPENCLAW_CONFIG_PATH"
  require_launchctl_line "${print_output}" "OPENCLAW_LOG_DIR => ${JARVIS_LOG_DIR}" "OPENCLAW_LOG_DIR"
  require_launchctl_line "${print_output}" "OPENCLAW_LAUNCHD_LABEL => ${JARVIS_LABEL}" "OPENCLAW_LAUNCHD_LABEL"
  require_launchctl_line "${print_output}" "OPENCLAW_PROFILE => consumer" "OPENCLAW_PROFILE"
  require_launchctl_line "${print_output}" "OPENCLAW_GATEWAY_PORT => ${PORT}" "OPENCLAW_GATEWAY_PORT"
}

identity_field() {
  local line="$1"
  local key="$2"
  local value=""

  value="$(printf '%s\n' "${line}" | sed -E "s/^.*(^|[[:space:]])${key}=//")"
  [[ "${value}" != "${line}" ]] || return 1
  # Values can include spaces, so the next " key=" marks the end of this
  # identity field more reliably than shell word splitting.
  printf '%s\n' "${value}" | sed -E 's/[[:space:]][[:alpha:]_][[:alnum:]_]*=.*$//'
}

prove_live_runtime_commit() {
  local log_file="${JARVIS_LOG_DIR}/gateway.log"
  local line=""
  local service_label=""
  local runtime_source=""
  local live_commit=""
  local state_dir=""
  local config_path=""

  [[ -r "${log_file}" ]] || die "Jarvis gateway log is not readable: ${log_file}"
  line="$(grep -F "[gateway] runtime identity:" "${log_file}" | tail -n 1 || true)"
  [[ -n "${line}" ]] || die "Jarvis gateway log has no live runtime identity line"

  service_label="$(identity_field "${line}" "serviceLabel" || true)"
  runtime_source="$(identity_field "${line}" "runtimeSource" || true)"
  live_commit="$(identity_field "${line}" "runtimeCommit" || true)"
  state_dir="$(identity_field "${line}" "stateDir" || true)"
  config_path="$(identity_field "${line}" "configPath" || true)"

  [[ "${service_label}" == "${JARVIS_LABEL}" ]] || die "live serviceLabel=${service_label:-missing}, expected ${JARVIS_LABEL}"
  [[ "${runtime_source}" == "jarvis-managed-bundle" ]] || die "live runtimeSource=${runtime_source:-missing}, expected jarvis-managed-bundle"
  [[ "${state_dir}" == "${JARVIS_STATE_DIR}" ]] || die "live stateDir=${state_dir:-missing}, expected ${JARVIS_STATE_DIR}"
  [[ "${config_path}" == "${JARVIS_CONFIG_PATH}" ]] || die "live configPath=${config_path:-missing}, expected ${JARVIS_CONFIG_PATH}"
  [[ -n "${live_commit}" ]] || die "Jarvis gateway log did not print runtimeCommit"

  printf '%s\n' "${live_commit}"
}

prove_status_health() {
  local expected_commit="$1"
  local status_stdout=""
  local status_stderr=""
  local status_json=""
  local service_label=""
  local runtime_source=""
  local status_commit=""
  local state_dir=""
  local config_path=""
  local health=""

  status_stdout="$(mktemp "${TMPDIR:-/tmp}/jarvis-protect-status.XXXXXX")"
  status_stderr="$(mktemp "${TMPDIR:-/tmp}/jarvis-protect-status.err.XXXXXX")"
  status_json="$(mktemp "${TMPDIR:-/tmp}/jarvis-protect-status.json.XXXXXX")"
  cleanup_status() {
    rm -f "${status_stdout}" "${status_stderr}" "${status_json}"
  }

  # This command reads the installed Jarvis runtime's live launchd status and
  # runtime fingerprint. It intentionally does not require the RPC probe:
  # protection only needs to prove the active ai.jarvis.gateway daemon before
  # mutating manifests, and RPC can be busy while launchd/runtime health is OK.
  if ! OPENCLAW_HOME="${JARVIS_HOME}" \
      OPENCLAW_STATE_DIR="${JARVIS_STATE_DIR}" \
      OPENCLAW_CONFIG_PATH="${JARVIS_CONFIG_PATH}" \
      OPENCLAW_LOG_DIR="${JARVIS_LOG_DIR}" \
      OPENCLAW_PROFILE=consumer \
      OPENCLAW_LAUNCHD_LABEL="${JARVIS_LABEL}" \
      "${JARVIS_NODE}" "${JARVIS_ENTRYPOINT}" gateway status --json \
      >"${status_stdout}" 2>"${status_stderr}"; then
    cat "${status_stderr}" >&2 || true
    cleanup_status
    die "Jarvis status proof failed; refusing to rewrite compatibility manifest"
  fi

  if jq -e . "${status_stdout}" >/dev/null 2>&1; then
    cp "${status_stdout}" "${status_json}"
  else
    awk 'found || /^[[:space:]]*\{/ { found = 1; print }' "${status_stdout}" >"${status_json}"
    if ! jq -e . "${status_json}" >/dev/null 2>&1; then
      cleanup_status
      die "Jarvis status proof did not emit parseable JSON"
    fi
  fi

  service_label="$(jq -r '.runtimeFingerprint.serviceLabel // empty' "${status_json}")"
  runtime_source="$(jq -r '.runtimeFingerprint.runtimeSource // empty' "${status_json}")"
  status_commit="$(jq -r '.runtimeFingerprint.runtimeCommit // empty' "${status_json}")"
  state_dir="$(jq -r '.runtimeFingerprint.stateDir // empty' "${status_json}")"
  config_path="$(jq -r '.runtimeFingerprint.configPath // empty' "${status_json}")"
  health="$(
    jq -r --arg probe_url "ws://127.0.0.1:${PORT}" '
      .health.healthy // (
        [
          .targets[]?
          | select(.id == "localLoopback" or .kind == "localLoopback" or .url == $probe_url)
          | .health as $health
          | select(($health == true) or (($health | type) == "object" and (($health.healthy // $health.ok) == true)))
        ] | length > 0
      )
    ' "${status_json}"
  )"

  [[ "${service_label}" == "ai.jarvis.gateway" ]] || die "live serviceLabel=${service_label:-missing}, expected ai.jarvis.gateway"
  [[ "${runtime_source}" == "jarvis-managed-bundle" ]] || die "live runtimeSource=${runtime_source:-missing}, expected jarvis-managed-bundle"
  [[ -n "${status_commit}" ]] || die "Jarvis status proof did not print runtimeCommit"
  commit_matches "${expected_commit}" "${status_commit}" || \
    die "Jarvis status runtimeCommit=${status_commit:-missing}, expected ${expected_commit}"
  [[ "${state_dir}" == "${JARVIS_STATE_DIR}" ]] || die "live stateDir=${state_dir:-missing}, expected ${JARVIS_STATE_DIR}"
  [[ "${config_path}" == "${JARVIS_CONFIG_PATH}" ]] || die "live configPath=${config_path:-missing}, expected ${JARVIS_CONFIG_PATH}"
  [[ "${health}" == "true" ]] || die "live Jarvis health=${health}, expected true"
  cleanup_status
}

write_marker() {
  local marker_path="$1"
  local protected_commit="$2"
  local compatibility_commit="$3"
  local compatibility_version="$4"
  local backup_path="$5"

  jq -n \
    --arg protectedRuntimeGitCommit "${protected_commit}" \
    --arg compatibilityManifestGitCommit "${compatibility_commit}" \
    --arg compatibilityManifestBundleVersion "${compatibility_version}" \
    --arg compatibilityManifestSource "${APP_PATH}" \
    --arg backupPath "${backup_path}" \
    --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      format: 1,
      protectedRuntimeGitCommit: $protectedRuntimeGitCommit,
      compatibilityManifestGitCommit: $compatibilityManifestGitCommit,
      compatibilityManifestBundleVersion: $compatibilityManifestBundleVersion,
      compatibilityManifestSource: $compatibilityManifestSource,
      backupPath: $backupPath,
      createdAt: $createdAt
    }' >"${marker_path}.tmp"
  mv "${marker_path}.tmp" "${marker_path}"
}

main() {
  parse_args "$@"
  require_tools

  local app_manifest="${APP_PATH}/Contents/Resources/OpenClawRuntime/manifest.json"
  local installed_manifest="${JARVIS_STATE_DIR}/.consumer-bundled-runtime.json"
  local marker_path="${JARVIS_STATE_DIR}/.consumer-bundled-runtime.protection.json"
  local app_commit=""
  local app_version=""
  local live_commit=""
  local backup_path=""
  local labels=""
  local jarvis_pid=""
  local listener_output=""

  [[ -r "${app_manifest}" ]] || die "Jarvis app manifest is not readable: ${app_manifest}"
  [[ -r "${installed_manifest}" ]] || die "installed Jarvis runtime manifest is not readable: ${installed_manifest}"

  labels="$("${LAUNCHCTL_BIN}" list 2>/dev/null || true)"
  jarvis_pid="$(require_single_jarvis_gateway_owner "${labels}")"
  require_live_launchctl_runtime "${jarvis_pid}"
  listener_output="$("${LSOF_BIN}" -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  require_jarvis_listener_owner "${jarvis_pid}" "${listener_output}"
  require_live_gateway_log_owner "${jarvis_pid}"

  app_commit="$(json_field "${app_manifest}" "gitCommit")"
  app_version="$(json_field "${app_manifest}" "bundleVersion")"
  [[ -n "${app_commit}" ]] || die "app manifest is missing gitCommit"
  [[ -n "${app_version}" ]] || die "app manifest is missing bundleVersion"

  live_commit="$(prove_live_runtime_commit)"
  commit_matches "${EXPECTED_LIVE_COMMIT}" "${live_commit}" || \
    die "live runtime commit ${live_commit:-missing} does not match expected ${EXPECTED_LIVE_COMMIT}"
  prove_status_health "${live_commit}"

  log "app_path=${APP_PATH}"
  log "state_dir=${JARVIS_STATE_DIR}"
  log "live_runtime_commit=${live_commit}"
  log "compatibility_manifest_commit=${app_commit}"
  log "compatibility_manifest_bundle_version=${app_version}"

  if commit_matches "${app_commit}" "${live_commit}"; then
    log "installed app manifest already matches live runtime; no protection shim needed"
    return 0
  fi

  if (( APPLY != 1 )); then
    log "dry_run=true"
    log "rerun with --apply to write the compatibility manifest and protection marker"
    return 0
  fi

  backup_path="${installed_manifest}.backup.$(date -u +%Y%m%dT%H%M%SZ)"
  cp "${installed_manifest}" "${backup_path}"
  cp "${app_manifest}" "${installed_manifest}.tmp"
  mv "${installed_manifest}.tmp" "${installed_manifest}"
  write_marker "${marker_path}" "${live_commit}" "${app_commit}" "${app_version}" "${backup_path}"

  log "protected=true"
  log "backup=${backup_path}"
  log "manifest=${installed_manifest}"
  log "marker=${marker_path}"
}

main "$@"
