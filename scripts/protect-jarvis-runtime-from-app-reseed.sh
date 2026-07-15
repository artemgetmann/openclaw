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
OFFLINE_SEEDED_FALLBACK=0
VERIFY_ONLY=0

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
  --offline-seeded-fallback     Protect an exact on-disk seeded commit without
                                requiring a healthy live gateway. Recovery-only.
  --verify                      With --offline-seeded-fallback, require an
                                already-valid compatibility manifest and marker.
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
      --offline-seeded-fallback)
        OFFLINE_SEEDED_FALLBACK=1
        shift
        ;;
      --verify)
        VERIFY_ONLY=1
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

  [[ "${EXPECTED_LIVE_COMMIT}" =~ ^[0-9a-fA-F]{7,40}$ ]] || \
    die "--expected-live-commit must be a 7-40 character hexadecimal SHA"
  if (( VERIFY_ONLY == 1 && OFFLINE_SEEDED_FALLBACK != 1 )); then
    die "--verify requires --offline-seeded-fallback"
  fi
}

require_tools() {
  command -v jq >/dev/null 2>&1 || die "missing jq"
  command -v sed >/dev/null 2>&1 || die "missing sed"
  command -v awk >/dev/null 2>&1 || die "missing awk"
  [[ -x "${JARVIS_NODE}" ]] || die "Jarvis node runtime is missing or not executable: ${JARVIS_NODE}"
  [[ -r "${JARVIS_ENTRYPOINT}" ]] || die "Jarvis bundled runtime entrypoint is missing: ${JARVIS_ENTRYPOINT}"
  if (( OFFLINE_SEEDED_FALLBACK == 1 )); then
    return 0
  fi
  command -v "${LAUNCHCTL_BIN}" >/dev/null 2>&1 || die "missing launchctl command"
  command -v "${LSOF_BIN}" >/dev/null 2>&1 || die "missing lsof command"
  command -v "${ID_BIN}" >/dev/null 2>&1 || die "missing id command"
}

json_field() {
  local file="$1"
  local field="$2"
  jq -r --arg field "${field}" '.[$field] // empty' "${file}"
}

commit_matches() {
  local expected="$1"
  local actual="$2"
  [[ "${expected}" =~ ^[0-9a-fA-F]{7,40}$ ]] || return 1
  [[ "${actual}" =~ ^[0-9a-fA-F]{7,40}$ ]] || return 1
  [[ "${expected}" == "${actual}"* || "${actual}" == "${expected}"* ]]
}

runtime_source_is_protectable() {
  local runtime_source="$1"
  [[ "${runtime_source}" == "jarvis-managed-bundle" || \
    "${runtime_source}" == "jarvis-break-glass-hotfix" ]]
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
  runtime_source_is_protectable "${runtime_source}" || \
    die "live runtimeSource=${runtime_source:-missing}, expected jarvis-managed-bundle or jarvis-break-glass-hotfix"
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
  runtime_source_is_protectable "${runtime_source}" || \
    die "live runtimeSource=${runtime_source:-missing}, expected jarvis-managed-bundle or jarvis-break-glass-hotfix"
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

offline_protection_is_valid() {
  local installed_manifest="$1"
  local marker_path="$2"
  local app_commit="$3"
  local app_version="$4"
  local installed_commit=""
  local installed_version=""
  local protected_commit=""
  local compatibility_commit=""
  local compatibility_version=""
  local backup_path=""
  local backup_commit=""

  [[ -r "${installed_manifest}" && -r "${marker_path}" ]] || return 1
  installed_commit="$(json_field "${installed_manifest}" "gitCommit")"
  installed_version="$(json_field "${installed_manifest}" "bundleVersion")"
  protected_commit="$(json_field "${marker_path}" "protectedRuntimeGitCommit")"
  compatibility_commit="$(json_field "${marker_path}" "compatibilityManifestGitCommit")"
  compatibility_version="$(json_field "${marker_path}" "compatibilityManifestBundleVersion")"
  backup_path="$(json_field "${marker_path}" "backupPath")"

  commit_matches "${app_commit}" "${installed_commit}" || return 1
  [[ "${installed_version}" == "${app_version}" ]] || return 1
  commit_matches "${EXPECTED_LIVE_COMMIT}" "${protected_commit}" || return 1
  commit_matches "${app_commit}" "${compatibility_commit}" || return 1
  [[ "${compatibility_version}" == "${app_version}" ]] || return 1
  [[ -r "${backup_path}" ]] || return 1
  backup_commit="$(json_field "${backup_path}" "gitCommit")"
  commit_matches "${EXPECTED_LIVE_COMMIT}" "${backup_commit}"
}

seeded_backup_for() {
  local installed_manifest="$1"
  local marker_path="$2"
  local candidate=""
  local candidate_commit=""
  local selected=""

  # Prefer the marker's explicit receipt even when another marker field is
  # invalid. If interruption happened before marker publication, discover only
  # backups whose manifest commit matches the exact expected seed.
  if [[ -r "${marker_path}" ]]; then
    candidate="$(json_field "${marker_path}" "backupPath" 2>/dev/null || true)"
    if [[ -r "${candidate}" ]]; then
      candidate_commit="$(json_field "${candidate}" "gitCommit" 2>/dev/null || true)"
      if commit_matches "${EXPECTED_LIVE_COMMIT}" "${candidate_commit}"; then
        printf '%s\n' "${candidate}"
        return 0
      fi
    fi
  fi

  for candidate in "${installed_manifest}".backup.*; do
    [[ -r "${candidate}" ]] || continue
    candidate_commit="$(json_field "${candidate}" "gitCommit" 2>/dev/null || true)"
    if commit_matches "${EXPECTED_LIVE_COMMIT}" "${candidate_commit}"; then
      selected="${candidate}"
    fi
  done
  [[ -n "${selected}" ]] || return 1
  printf '%s\n' "${selected}"
}

protect_offline_seeded_payload() {
  local app_manifest="$1"
  local installed_manifest="$2"
  local marker_path="$3"
  local app_commit="$4"
  local app_version="$5"
  local installed_commit=""
  local installed_version=""
  local backup_path=""

  if offline_protection_is_valid \
      "${installed_manifest}" "${marker_path}" "${app_commit}" "${app_version}"; then
    log "offline_seeded_fallback_verified=true"
    log "protected=true"
    return 0
  fi
  if (( VERIFY_ONLY == 1 )); then
    die "offline seeded fallback protection proof failed"
  fi
  (( APPLY == 1 )) || die "--offline-seeded-fallback requires --apply or --verify"

  # The app seed is atomic and writes its manifest last. Bind fallback
  # protection to that exact manifest plus the required runtime executables;
  # never infer payload identity from the checkout that launched the app.
  installed_commit="$(json_field "${installed_manifest}" "gitCommit")"
  installed_version="$(json_field "${installed_manifest}" "bundleVersion")"
  if commit_matches "${EXPECTED_LIVE_COMMIT}" "${installed_commit}"; then
    backup_path="${installed_manifest}.backup.$(date -u +%Y%m%dT%H%M%SZ)"
    cp "${installed_manifest}" "${backup_path}"
  elif commit_matches "${app_commit}" "${installed_commit}" && \
      [[ "${installed_version}" == "${app_version}" ]]; then
    # The compatibility manifest may already have landed before interruption.
    # Reuse only a backup receipt bound to the expected seed; this repairs a
    # missing/corrupt marker without trusting arbitrary neighboring files.
    backup_path="$(seeded_backup_for "${installed_manifest}" "${marker_path}" || true)"
    [[ -n "${backup_path}" ]] || \
      die "compatibility manifest exists without a verified backup for expected seed ${EXPECTED_LIVE_COMMIT}"
    installed_commit="$(json_field "${backup_path}" "gitCommit")"
  else
    die "seeded manifest commit ${installed_commit:-missing} does not match expected ${EXPECTED_LIVE_COMMIT} or installed-app compatibility"
  fi

  # Publish the marker before replacing the installed manifest. If the process
  # is interrupted between these atomic writes, the still-seeded manifest lets
  # the wrapper retry this recovery. The reverse order would briefly leave an
  # older compatibility manifest with no marker proving the newer payload.
  write_marker \
    "${marker_path}" "${installed_commit}" "${app_commit}" "${app_version}" "${backup_path}"
  cp "${app_manifest}" "${installed_manifest}.tmp"
  mv "${installed_manifest}.tmp" "${installed_manifest}"
  offline_protection_is_valid \
    "${installed_manifest}" "${marker_path}" "${app_commit}" "${app_version}" || \
    die "offline seeded fallback write did not pass protection proof"

  log "offline_seeded_fallback_applied=true"
  log "offline_seeded_fallback_verified=true"
  log "protected=true"
  log "backup=${backup_path}"
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

  app_commit="$(json_field "${app_manifest}" "gitCommit")"
  app_version="$(json_field "${app_manifest}" "bundleVersion")"
  [[ "${app_commit}" =~ ^[0-9a-fA-F]{7,40}$ ]] || \
    die "app manifest gitCommit is missing or invalid"
  [[ -n "${app_version}" ]] || die "app manifest is missing bundleVersion"

  if (( OFFLINE_SEEDED_FALLBACK == 1 )); then
    protect_offline_seeded_payload \
      "${app_manifest}" "${installed_manifest}" "${marker_path}" "${app_commit}" "${app_version}"
    return 0
  fi

  labels="$("${LAUNCHCTL_BIN}" list 2>/dev/null || true)"
  jarvis_pid="$(require_single_jarvis_gateway_owner "${labels}")"
  require_live_launchctl_runtime "${jarvis_pid}"
  listener_output="$("${LSOF_BIN}" -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  require_jarvis_listener_owner "${jarvis_pid}" "${listener_output}"
  require_live_gateway_log_owner "${jarvis_pid}"

  live_commit="$(prove_live_runtime_commit)"
  commit_matches "${EXPECTED_LIVE_COMMIT}" "${live_commit}" || \
    die "live runtime commit ${live_commit:-missing} does not match expected ${EXPECTED_LIVE_COMMIT}"
  prove_status_health "${live_commit}"

  log "app_path=${APP_PATH}"
  log "state_dir=${JARVIS_STATE_DIR}"
  log "live_runtime_commit=${live_commit}"
  log "compatibility_manifest_commit=${app_commit}"
  log "compatibility_manifest_bundle_version=${app_version}"

  if offline_protection_is_valid \
      "${installed_manifest}" "${marker_path}" "${app_commit}" "${app_version}"; then
    log "protection already installed and verified"
    log "protected=true"
    return 0
  fi

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
