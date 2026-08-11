#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/heavy-local-slot.sh
source "$ROOT_DIR/scripts/lib/heavy-local-slot.sh"

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/with-heavy-local-slot.sh [--policy <policy>] --label <text> --check
  scripts/with-heavy-local-slot.sh [--policy <policy>] --label <text> [--wait-seconds <seconds>] -- <command> [args...]

Compatibility frontend for the named, kernel-owned shared-resource locks.
Ordinary builds and tests must run directly without this wrapper.
EOF
  exit 2
}

policy="standard"
label=""
wait_seconds="0"
check_only=0
command=()

while (($#)); do
  case "$1" in
    --policy | --cpu-policy)
      (($# >= 2)) || usage
      if [[ "$1" == "--policy" ]]; then
        policy="$2"
      fi
      shift 2
      ;;
    --label)
      (($# >= 2)) || usage
      label="$2"
      shift 2
      ;;
    --wait-seconds)
      (($# >= 2)) || usage
      wait_seconds="$2"
      shift 2
      ;;
    --check)
      check_only=1
      shift
      ;;
    --require-jarvis-health | --allow-jarvis-replacement | --allow-jarvis-remediation)
      shift
      ;;
    --)
      shift
      command=("$@")
      break
      ;;
    *) usage ;;
  esac
done

[[ -n "$label" ]] || usage
resource="$(openclaw_heavy_local_slot_resource_for "$policy" "$label")" || exit $?

primary_resource="${resource%%,*}"
args=(--resource "$primary_resource")
if [[ "$resource" == *,* ]]; then
  args+=(--also-resource "${resource#*,}")
fi
args+=(--label "$label")
if ((check_only)); then
  ((${#command[@]} == 0)) || usage
  args+=(--check)
else
  ((${#command[@]} > 0)) || usage
  args+=(--wait-seconds "$wait_seconds" -- "${command[@]}")
fi

exec "$ROOT_DIR/scripts/with-shared-resource-lock.pl" "${args[@]}"
