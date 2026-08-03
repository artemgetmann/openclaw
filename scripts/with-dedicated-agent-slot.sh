#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# This named entrypoint is the durable declaration that the transaction is
# dedicated-agent work. Keep policy ownership here: accepting a second CPU
# policy would let a copied command silently restore the standard idle floors.
arguments=("$@")
argument_index=0
while [ "$argument_index" -lt "${#arguments[@]}" ]; do
  argument="${arguments[$argument_index]}"

  # The lower wrapper accepts several options whose values may themselves be
  # the literal string `--`. Consume those values before recognizing the real
  # command delimiter so a later CPU override cannot hide behind such a value.
  case "$argument" in
    --label|--policy|--wait-seconds)
      argument_index=$((argument_index + 2))
      continue
      ;;
    --)
      break
      ;;
  esac

  if [ "$argument" = "--cpu-policy" ]; then
    printf '%s\n' \
      'HEAVY_LOCAL_SLOT_REFUSAL class=guard_internal code=wrong_cpu_policy declared=dedicated-agent observed=caller_override phase=admission outcome=refused next_action=remove_cpu_policy_override_and_use_dedicated_agent_entrypoint' >&2
    printf '%s\n' \
      'Refusing heavy work: the dedicated-agent entrypoint owns CPU policy and does not accept a caller override. Next safe action: remove_cpu_policy_override_and_use_dedicated_agent_entrypoint.' >&2
    exit 75
  fi
  argument_index=$((argument_index + 1))
done

exec "$ROOT_DIR/scripts/with-heavy-local-slot.sh" \
  --cpu-policy dedicated-agent \
  "$@"
