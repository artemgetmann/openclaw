#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
source "${ROOT}/scripts/lib/validated-node.sh"
source "${ROOT}/scripts/lib/worktree-guards.sh"

log() {
  printf '[build-shared-runtime] %s\n' "$*"
}

describe_node() {
  local node_bin="$1"
  local version=""

  if [[ -z "${node_bin}" || ! -x "${node_bin}" ]]; then
    printf 'missing'
    return 0
  fi

  version="$("${node_bin}" -p "process.versions.node" 2>/dev/null | tr -d '\r' || true)"
  if [[ -z "${version}" ]]; then
    version="unknown"
  fi

  printf '%s (%s)\n' "${version}" "${node_bin}"
}

print_shell_node_warning() {
  local expected_version="$1"
  local shell_node_bin="$2"

  # Shared-main runtime incidents keep starting with "I ran pnpm build from the
  # shell and forgot that shell was on Node 25". Spell out the mismatch here so
  # operators get the failure mode and the blessed command in one place.
  cat >&2 <<EOF
[build-shared-runtime] shell-default node does not match the shared runtime requirement.
[build-shared-runtime] shell node:     $(describe_node "${shell_node_bin}")
[build-shared-runtime] validated node: $(describe_node "${OPENCLAW_NODE_BIN:-}")
[build-shared-runtime] required node:  ${expected_version}
[build-shared-runtime] raw 'pnpm build' in the canonical runtime checkout is forbidden.
[build-shared-runtime] continuing with the validated toolchain instead.
EOF
}

main() {
  local expected_version=""
  local shell_node_bin=""

  # The long-lived shared gateway must only be rebuilt from the canonical main
  # checkout. Let worktrees keep their own build habits; this wrapper exists to
  # remove ambiguity from shared-runtime operations.
  worktree_guard_require_shared_root_main_branch "${ROOT}"
  worktree_guard_reject_shared_root_main_edits \
    "${ROOT}" \
    worktree \
    --context "scripts/build-shared-runtime.sh"

  expected_version="$(openclaw_validated_node_version "${ROOT}")"
  shell_node_bin="$(command -v node 2>/dev/null || true)"
  openclaw_use_validated_node "${ROOT}" >/dev/null

  if ! openclaw_node_version_matches "${shell_node_bin}" "${expected_version}"; then
    print_shell_node_warning "${expected_version}" "${shell_node_bin}"
  fi

  log "repo=${ROOT}"
  log "validated node=$(describe_node "${OPENCLAW_NODE_BIN}")"
  log "running pnpm ${*:-build}"

  if [[ "$#" -eq 0 ]]; then
    openclaw_run_repo_pnpm "${ROOT}" build
    return 0
  fi

  openclaw_run_repo_pnpm "${ROOT}" "$@"
}

main "$@"
