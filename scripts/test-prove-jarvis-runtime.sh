#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Source only the resolver so this regression stays read-only and does not need
# a running gateway. The restricted PATH mirrors the hotfix proof wrapper.
resolved="$({
  export OPENCLAW_PROVE_JARVIS_RUNTIME_LIB_ONLY=1
  export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
  unset OPENCLAW_LSOF_BIN
  # shellcheck source=scripts/prove-jarvis-runtime.sh
  source "${ROOT_DIR}/scripts/prove-jarvis-runtime.sh"
  resolve_lsof_bin
  printf '%s\n' "${LSOF_BIN}"
})"

[[ "${resolved}" == "/usr/sbin/lsof" ]] || {
  printf 'FAIL: sanitized PATH resolved lsof=%s, expected /usr/sbin/lsof\n' "${resolved}" >&2
  exit 1
}
printf 'PASS: prove-jarvis-runtime resolves /usr/sbin/lsof outside sanitized PATH\n'
