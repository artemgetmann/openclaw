#!/usr/bin/env bash
set -euo pipefail

MAIN_REPO="${OPENCLAW_MAIN_REPO:-/Users/user/Programming_Projects/openclaw}"
EXPECTED_MAIN_REPO="/Users/user/Programming_Projects/openclaw"
if [[ "${OPENCLAW_SHARED_MAIN_TEST_MODE:-0}" == "1" ]]; then
  EXPECTED_MAIN_REPO="${OPENCLAW_EXPECTED_MAIN_REPO:-${EXPECTED_MAIN_REPO}}"
fi
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
GATEWAY_LABEL="ai.openclaw.gateway"
DRY_RUN=0

log() {
  printf '[deploy-shared-main-runtime] %s\n' "$*"
}

run_or_print() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "dry-run: $*"
    return 0
  fi
  "$@"
}

usage() {
  cat <<EOF
usage: bash scripts/deploy-shared-main-runtime.sh [--dry-run]

Deploy merged main runtime code to the canonical shared gateway.
EOF
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --dry-run)
        DRY_RUN=1
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        printf '[deploy-shared-main-runtime] unknown argument: %s\n' "$1" >&2
        usage >&2
        exit 2
        ;;
    esac
    shift
  done
}

repo_root() {
  git -C "${MAIN_REPO}" rev-parse --show-toplevel 2>/dev/null || true
}

current_branch() {
  git -C "${MAIN_REPO}" branch --show-current 2>/dev/null || true
}

tracked_dirt() {
  git -C "${MAIN_REPO}" status --porcelain --untracked-files=no
}

require_sacred_main_checkout() {
  local root=""
  root="$(repo_root)"

  # This deploy path owns the real shared LaunchAgent. Dry-run may be invoked
  # from a feature checkout to preview the exact fence it would hit, but live
  # deploys must be physically rooted in the sacred main clone.
  if [[ -z "${root}" ]]; then
    printf '[deploy-shared-main-runtime] not a git checkout: %s\n' "${MAIN_REPO}" >&2
    exit 1
  fi
  if [[ "${root}" != "${EXPECTED_MAIN_REPO}" ]]; then
    printf '[deploy-shared-main-runtime] refusing non-canonical checkout: %s\n' "${root}" >&2
    printf '[deploy-shared-main-runtime] expected: %s\n' "${EXPECTED_MAIN_REPO}" >&2
    exit 1
  fi
  if [[ "$(pwd -P)" != "${EXPECTED_MAIN_REPO}" ]]; then
    printf '[deploy-shared-main-runtime] run from the sacred main clone: cd %s\n' "${EXPECTED_MAIN_REPO}" >&2
    exit 1
  fi
  if [[ "$(current_branch)" != "main" ]]; then
    printf '[deploy-shared-main-runtime] refusing branch %s; expected main\n' "$(current_branch)" >&2
    exit 1
  fi
  if [[ -n "$(tracked_dirt)" ]]; then
    printf '[deploy-shared-main-runtime] refusing tracked dirt in sacred main clone:\n' >&2
    tracked_dirt >&2
    exit 1
  fi
}

launchctl_target() {
  printf 'gui/%s/%s\n' "$(id -u)" "${GATEWAY_LABEL}"
}

launch_agent_loaded() {
  launchctl print "$(launchctl_target)" >/dev/null 2>&1
}

bootout_gateway() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "dry-run: launchctl bootout $(launchctl_target)"
    return 0
  fi
  if launch_agent_loaded; then
    launchctl bootout "$(launchctl_target)" || true
  else
    log "${GATEWAY_LABEL} not loaded; continuing"
  fi
}

gateway_pid() {
  launchctl print "$(launchctl_target)" 2>/dev/null | awk '/pid =/ { print $3; exit }'
}

node_version_for_pid() {
  local pid="$1"
  local exe=""
  exe="$(lsof -a -p "${pid}" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | rg '/node$' | sed -n '1p' || true)"
  if [[ -n "${exe}" && -x "${exe}" ]]; then
    "${exe}" -p "process.versions.node" 2>/dev/null || true
  fi
}

listener_ready() {
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { found = 1 } END { exit(found ? 0 : 1) }'
}

wait_for_listener() {
  local deadline=$((SECONDS + 120))
  until listener_ready; do
    if [[ "${SECONDS}" -ge "${deadline}" ]]; then
      printf '[deploy-shared-main-runtime] listener did not appear on 127.0.0.1:%s\n' "${PORT}" >&2
      exit 1
    fi
    sleep 2
  done
}

status_output() {
  pnpm openclaw:local gateway status --deep --require-rpc 2>&1
}

verify_runtime_identity() {
  local status="$1"
  printf '%s\n' "${status}" | grep -F -q 'branch=main' || {
    printf '[deploy-shared-main-runtime] runtime identity missing branch=main\n%s\n' "${status}" >&2
    exit 1
  }
  printf '%s\n' "${status}" | grep -F -q "worktree=${EXPECTED_MAIN_REPO}" || {
    printf '[deploy-shared-main-runtime] runtime identity missing canonical worktree\n%s\n' "${status}" >&2
    exit 1
  }
}

print_proof() {
  local status="$1"
  local pid=""
  local node_version=""
  pid="$(gateway_pid || true)"
  node_version="$(node_version_for_pid "${pid}" || true)"

  log "proof commit=$(git -C "${MAIN_REPO}" log --oneline -1)"
  log "proof pid=${pid:-unknown}"
  log "proof node=${node_version:-unknown}"
  log "proof listener=127.0.0.1:${PORT}"
  log "proof rpc=ok"
  printf '%s\n' "${status}" | sed -n '/Runtime ID:/p;/RPC probe:/p;/Listener:/p'
}

main() {
  parse_args "$@"

  if [[ "${DRY_RUN}" == "1" && "$(pwd -P)" != "${EXPECTED_MAIN_REPO}" ]]; then
    log "dry-run preview only; live deploy must run from ${EXPECTED_MAIN_REPO}"
  else
    require_sacred_main_checkout
  fi

  log "repo=${MAIN_REPO}"
  log "commit-before=$(git -C "${MAIN_REPO}" log --oneline -1 2>/dev/null || printf unknown)"
  run_or_print git -C "${MAIN_REPO}" pull --ff-only
  log "commit-after=$(git -C "${MAIN_REPO}" log --oneline -1 2>/dev/null || printf unknown)"
  bootout_gateway
  run_or_print bash "${MAIN_REPO}/scripts/build-shared-runtime.sh"
  run_or_print env OPENCLAW_MAIN_REPO="${MAIN_REPO}" bash "${MAIN_REPO}/scripts/gateway-recover-main.sh" --full

  if [[ "${DRY_RUN}" == "1" ]]; then
    log "dry-run: pnpm openclaw:local gateway status --deep --require-rpc"
    log "dry-run: lsof -nP -iTCP:${PORT} -sTCP:LISTEN"
    return 0
  fi

  local status=""
  status="$(status_output)"
  verify_runtime_identity "${status}"
  wait_for_listener
  print_proof "${status}"
}

if [[ "${OPENCLAW_SCRIPT_LIB_TEST:-0}" != "1" ]]; then
  main "$@"
fi
