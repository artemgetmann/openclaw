#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LEASE_TOKEN="${OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN:-}"

# The fleet runner grants the lease to this exact descendant. Carry only that
# capability across the second clean environment; the canonical hotfix script
# still validates the live owner, token, policy, and process ancestry itself.
if [[ ! "${LEASE_TOKEN}" =~ ^[0-9a-fA-F]{64}$ ]]; then
  printf '%s\n' 'HEAVY_LOCAL_SLOT_REFUSAL class=guard_internal code=inherited_lease_missing' >&2
  exit 75
fi

exec /usr/bin/env -i \
  PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin \
  HOME=/Users/user \
  OPENCLAW_HOTFIX_CLEAN_ENTRY=1 \
  OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN="${LEASE_TOKEN}" \
  /bin/bash "${ROOT_DIR}/scripts/ship-jarvis-hotfix.sh" "$@"
