#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
readonly DEFAULT_WAIT_SECONDS=86400

# This named entrypoint is the durable declaration that the transaction is
# dedicated-agent work. Keep policy ownership here: accepting a second CPU
# policy would let a copied command silently restore the standard idle floors.
arguments=("$@")
argument_index=0
has_explicit_wait=false
is_check_only=false
while [ "$argument_index" -lt "${#arguments[@]}" ]; do
  argument="${arguments[$argument_index]}"

  # Parse only enough of the lower wrapper's option grammar to enforce this
  # entrypoint's two owned defaults. Option values are deliberately consumed as
  # opaque data: a label named `--check` must not disable waiting, and a label
  # named `--wait-seconds` must not masquerade as an explicit override. The
  # lower wrapper remains the authority that rejects missing or malformed
  # values before admission.
  case "$argument" in
    --label|--policy)
      argument_index=$((argument_index + 2))
      continue
      ;;
    --wait-seconds)
      has_explicit_wait=true
      argument_index=$((argument_index + 2))
      continue
      ;;
    --check)
      is_check_only=true
      argument_index=$((argument_index + 1))
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

# Ordinary dedicated-agent work is a same-turn bounded transaction: retryable
# occupancy or measured host pressure waits for the lower guard's existing safe
# maximum, then the guarded command can launch exactly once. Check-only calls
# stay immediate, and an explicit caller deadline wins unchanged. Keeping the
# retry loop in the lower wrapper preserves its lease-release, cancellation,
# timeout, and fail-closed guard-internal semantics.
wait_arguments=()
if [ "$has_explicit_wait" = false ] && [ "$is_check_only" = false ]; then
  wait_arguments=(--wait-seconds "$DEFAULT_WAIT_SECONDS")
fi

exec "$ROOT_DIR/scripts/with-heavy-local-slot.sh" \
  --cpu-policy dedicated-agent \
  "${wait_arguments[@]}" \
  "$@"
