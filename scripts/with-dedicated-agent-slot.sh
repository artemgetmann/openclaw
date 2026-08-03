#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# This named entrypoint is the durable declaration that the transaction is
# dedicated-agent work. Keep policy ownership here: accepting a second CPU
# policy would let a copied command silently restore the standard idle floors.
for argument in "$@"; do
  # Everything after the delimiter belongs to the guarded command. Its own
  # arguments are data and must never be interpreted as guard policy.
  [ "$argument" = "--" ] && break
  if [ "$argument" = "--cpu-policy" ]; then
    printf '%s\n' \
      'HEAVY_LOCAL_SLOT_REFUSAL class=guard_internal code=wrong_cpu_policy declared=dedicated-agent observed=caller_override phase=admission outcome=refused next_action=remove_cpu_policy_override_and_use_dedicated_agent_entrypoint' >&2
    printf '%s\n' \
      'Refusing heavy work: the dedicated-agent entrypoint owns CPU policy and does not accept a caller override. Next safe action: remove_cpu_policy_override_and_use_dedicated_agent_entrypoint.' >&2
    exit 75
  fi
done

exec "$ROOT_DIR/scripts/with-heavy-local-slot.sh" \
  --cpu-policy dedicated-agent \
  "$@"
