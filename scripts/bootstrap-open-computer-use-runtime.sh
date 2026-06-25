#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

OCU_REPO_URL="${OPENCLAW_OPEN_COMPUTER_USE_REPO:-https://github.com/artemgetmann/open-codex-computer-use.git}"
OCU_REF="${OPENCLAW_OPEN_COMPUTER_USE_REF:-a8ad90ed703fbdc2095e900c2b2574bfa4d60f36}"
OCU_WORKDIR="${OPENCLAW_OPEN_COMPUTER_USE_WORKDIR:-/tmp/jarvis-ocu-pinned-runtime/open-codex-computer-use}"
OCU_APP_PATH="${OPENCLAW_OPEN_COMPUTER_USE_APP_PATH:-${HOME}/Applications/Open Computer Use (Dev).app}"
OCU_BIN_PATH_FILE="${OPENCLAW_OPEN_COMPUTER_USE_BIN_PATH_FILE:-/tmp/jarvis-ocu-stability-bin-path.txt}"
OCU_BUILD_CONFIGURATION="${OPENCLAW_OPEN_COMPUTER_USE_CONFIGURATION:-debug}"

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-open-computer-use-runtime.sh

Build the pinned OpenComputerUse runtime used by Jarvis GUI-control parity runs.

Environment overrides:
  OPENCLAW_OPEN_COMPUTER_USE_REPO             Git repository to clone/fetch
  OPENCLAW_OPEN_COMPUTER_USE_REF              Commit, tag, or branch to checkout
  OPENCLAW_OPEN_COMPUTER_USE_WORKDIR          Local checkout path
  OPENCLAW_OPEN_COMPUTER_USE_APP_PATH         Stable dev app destination
  OPENCLAW_OPEN_COMPUTER_USE_BIN_PATH_FILE    File to receive the executable path
  OPENCLAW_OPEN_COMPUTER_USE_CONFIGURATION    debug or release
  OPEN_COMPUTER_USE_CODESIGN_MODE             Passed through to OCU's app build
EOF
}

log() {
  printf '[open-computer-use-bootstrap] %s\n' "$*"
}

ensure_clean_checkout() {
  local repo_dir="$1"
  local status=""

  status="$(git -C "${repo_dir}" status --porcelain)"
  if [[ -n "${status}" ]]; then
    cat >&2 <<EOF
[open-computer-use-bootstrap] refusing to overwrite a dirty OCU checkout:
${repo_dir}

${status}
EOF
    exit 1
  fi
}

clone_or_update_checkout() {
  if [[ -d "${OCU_WORKDIR}/.git" ]]; then
    ensure_clean_checkout "${OCU_WORKDIR}"
    log "fetching ${OCU_REPO_URL} in ${OCU_WORKDIR}"
    git -C "${OCU_WORKDIR}" remote set-url origin "${OCU_REPO_URL}"
    git -C "${OCU_WORKDIR}" fetch --prune origin
  else
    log "cloning ${OCU_REPO_URL} into ${OCU_WORKDIR}"
    mkdir -p "$(dirname "${OCU_WORKDIR}")"
    git clone "${OCU_REPO_URL}" "${OCU_WORKDIR}"
  fi

  ensure_clean_checkout "${OCU_WORKDIR}"
  log "checking out ${OCU_REF}"
  git -C "${OCU_WORKDIR}" checkout --detach "${OCU_REF}"
}

build_runtime_app() {
  log "running OCU tests"
  swift test --package-path "${OCU_WORKDIR}"

  log "building OCU ${OCU_BUILD_CONFIGURATION} app"
  (
    cd "${OCU_WORKDIR}"
    ./scripts/build-open-computer-use-app.sh "${OCU_BUILD_CONFIGURATION}"
  )
}

install_runtime_app() {
  local built_app="${OCU_WORKDIR}/dist/Open Computer Use (Dev).app"
  local bin_path="${OCU_APP_PATH}/Contents/MacOS/OpenComputerUse"

  if [[ "${OCU_BUILD_CONFIGURATION}" != "debug" ]]; then
    built_app="${OCU_WORKDIR}/dist/Open Computer Use.app"
    bin_path="${OCU_APP_PATH}/Contents/MacOS/OpenComputerUse"
  fi

  if [[ ! -x "${built_app}/Contents/MacOS/OpenComputerUse" ]]; then
    echo "[open-computer-use-bootstrap] built app executable missing: ${built_app}" >&2
    exit 1
  fi

  log "installing app at ${OCU_APP_PATH}"
  mkdir -p "$(dirname "${OCU_APP_PATH}")"
  rm -rf "${OCU_APP_PATH}"
  /usr/bin/ditto "${built_app}" "${OCU_APP_PATH}"

  if [[ ! -x "${bin_path}" ]]; then
    echo "[open-computer-use-bootstrap] installed executable missing: ${bin_path}" >&2
    exit 1
  fi

  log "writing binary pointer ${OCU_BIN_PATH_FILE}"
  printf '%s\n' "${bin_path}" > "${OCU_BIN_PATH_FILE}"

  log "checking permission status"
  "${bin_path}" doctor || true

  log "ready"
  printf 'OPENCLAW_OPEN_COMPUTER_USE_BIN=%s\n' "${bin_path}"
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  "")
    ;;
  *)
    echo "Error: unknown argument: $1" >&2
    usage >&2
    exit 1
    ;;
esac

if [[ "${OCU_BUILD_CONFIGURATION}" != "debug" && "${OCU_BUILD_CONFIGURATION}" != "release" ]]; then
  echo "Error: unsupported OPENCLAW_OPEN_COMPUTER_USE_CONFIGURATION=${OCU_BUILD_CONFIGURATION}" >&2
  exit 1
fi

log "openclaw=${ROOT_DIR}"
log "ocu_repo=${OCU_REPO_URL}"
log "ocu_ref=${OCU_REF}"
clone_or_update_checkout
build_runtime_app
install_runtime_app
