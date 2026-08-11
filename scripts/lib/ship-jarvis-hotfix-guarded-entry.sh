#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOCK_RESOURCES="${OPENCLAW_SHARED_RESOURCE_LOCK:-}"
LOCK_FDS="${OPENCLAW_SHARED_RESOURCE_LOCK_FD:-}"
LOCK_CAPABILITIES="${OPENCLAW_SHARED_RESOURCE_LOCK_CAPABILITY:-}"

# Preserve only the inherited kernel-lock proof across the second clean
# environment. The canonical hotfix script validates both required resources,
# their exact descriptors, and their per-acquisition capabilities.
if [[ "${LOCK_RESOURCES}" != "gateway-main,release-jarvis" ]] ||
  [[ ! "${LOCK_FDS}" =~ ^[0-9]+,[0-9]+$ ]] ||
  [[ ! "${LOCK_CAPABILITIES}" =~ ^[0-9a-f]{64},[0-9a-f]{64}$ ]]; then
  printf '%s\n' 'HEAVY_LOCAL_SLOT_REFUSAL class=guard_internal code=inherited_lease_missing' >&2
  exit 75
fi

exec /usr/bin/env -i \
  PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin \
  HOME=/Users/user \
  OPENCLAW_HOTFIX_CLEAN_ENTRY=1 \
  OPENCLAW_SHARED_RESOURCE_LOCK="${LOCK_RESOURCES}" \
  OPENCLAW_SHARED_RESOURCE_LOCK_FD="${LOCK_FDS}" \
  OPENCLAW_SHARED_RESOURCE_LOCK_CAPABILITY="${LOCK_CAPABILITIES}" \
  /bin/bash "${ROOT_DIR}/scripts/ship-jarvis-hotfix.sh" "$@"
