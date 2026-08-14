#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/github-auth-preflight.sh
source "${ROOT_DIR}/scripts/lib/github-auth-preflight.sh"

usage() {
  echo "Usage: scripts/github-auth-preflight.sh --context <restricted|host> [--transport <host-gh|connector> | --report] [--remote <name>]" >&2
}

context=""
transport="host-gh"
report=0
remote="origin"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --context)
      context="${2:-}"
      shift 2
      ;;
    --transport)
      transport="${2:-}"
      shift 2
      ;;
    --report)
      report=1
      shift
      ;;
    --remote)
      remote="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[[ -n "${context}" ]] || { usage; exit 2; }
if [[ "${report}" == "1" ]]; then
  openclaw_github_transport_report "${context}" "${remote}"
  exit $?
fi
openclaw_github_preflight "${context}" "${transport}"
