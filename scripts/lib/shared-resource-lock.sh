#!/usr/bin/env bash

# Small compatibility helper for canonical shell entrypoints. Ownership is the
# inherited kernel-locked descriptor created by with-shared-resource-lock.pl;
# labels and native chat IDs are never authority.

openclaw_shared_resource_lock_is_held() {
  local resource="$1"
  local inherited_resources="${OPENCLAW_SHARED_RESOURCE_LOCK:-}"
  local inherited_fds="${OPENCLAW_SHARED_RESOURCE_LOCK_FD:-}"
  local inherited_capabilities="${OPENCLAW_SHARED_RESOURCE_LOCK_CAPABILITY:-}"
  local fd=""
  local capability=""
  local index=0
  local lock_resources=()
  local lock_fds=()
  local lock_capabilities=()

  [[ ",$inherited_resources," == *",$resource,"* ]] || return 1
  IFS=',' read -r -a lock_resources <<<"$inherited_resources"
  IFS=',' read -r -a lock_fds <<<"$inherited_fds"
  IFS=',' read -r -a lock_capabilities <<<"$inherited_capabilities"
  ((${#lock_resources[@]} == ${#lock_fds[@]} && ${#lock_fds[@]} == ${#lock_capabilities[@]})) || return 1
  for index in "${!lock_resources[@]}"; do
    [[ "${lock_resources[$index]}" == "$resource" ]] || continue
    fd="${lock_fds[$index]}"
    capability="${lock_capabilities[$index]}"
    [[ "$fd" =~ ^[0-9]+$ && -e "/dev/fd/$fd" ]] || return 1
    "${OPENCLAW_SHARED_RESOURCE_LOCK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/scripts/with-shared-resource-lock.pl" \
      --resource "$resource" --verify-inherited "$fd" "$capability" 2>/dev/null
    return $?
  done
  return 1
}

openclaw_shared_resource_lock_canonical_wait_seconds() {
  # Canonical protected entrypoints already own an authorized end-to-end task.
  # Give a normal package, install, runtime, or live-proof owner time to finish
  # without turning temporary contention into another user approval request.
  # The bound stays below the default two-hour Jarvis release-intent lifetime,
  # so admission cannot consume the entire authorization window.
  printf '%s\n' 3600
}

openclaw_shared_resource_lock_require_or_reexec() {
  local resource="$1"
  local label="$2"
  local root="$3"
  local entrypoint="$4"
  shift 4

  if openclaw_shared_resource_lock_is_held "$resource"; then
    return 0
  fi

  local primary="${resource%%,*}"
  local secondary=""
  local wait_seconds=""
  local args=(--resource "$primary")
  if [[ "$resource" == *,* ]]; then
    secondary="${resource#*,}"
    args+=(--also-resource "$secondary")
  fi
  wait_seconds="$(openclaw_shared_resource_lock_canonical_wait_seconds)" || return 75
  exec "$root/scripts/with-shared-resource-lock.pl" "${args[@]}" \
    --label "$label" \
    --wait-seconds "$wait_seconds" \
    -- "$entrypoint" "$@"
}
