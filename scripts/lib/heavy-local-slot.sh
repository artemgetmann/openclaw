#!/usr/bin/env bash

# Compatibility API while canonical entrypoints move from the former global
# global lease to small kernel-owned resource locks. No PID file, child
# handshake, environment value alone, or native chat identity grants ownership.

# shellcheck source=scripts/lib/shared-resource-lock.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/shared-resource-lock.sh"

openclaw_heavy_local_slot_safe_text() {
  printf '%s' "$1" | LC_ALL=C /usr/bin/tr -cd 'A-Za-z0-9._:/@+ -' | /usr/bin/cut -c1-240
}

openclaw_heavy_local_slot_process_start() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  LC_ALL=C TZ=UTC /bin/ps -p "$pid" -o lstart= 2>/dev/null \
    | /usr/bin/awk '{$1=$1; if (length($0)) print}' \
    | /usr/bin/head -n 1
}

openclaw_heavy_local_slot_owner_is_live() {
  local pid="$1"
  local expected_start="$2"
  local current_start=""

  [[ "$pid" =~ ^[0-9]+$ && -n "$expected_start" ]] || return 2
  current_start="$(openclaw_heavy_local_slot_process_start "$pid" || true)"
  [[ -n "$current_start" ]] || return 1
  [[ "$current_start" == "$expected_start" ]]
}

openclaw_heavy_local_slot_inherited_lease_is_valid() {
  local required_policy="${1:-standard}"
  local required_resource="${2:-}"

  case "$required_policy" in
    gateway-lifecycle) openclaw_shared_resource_lock_is_held gateway-main ;;
    jarvis-remediation)
      openclaw_shared_resource_lock_is_held gateway-main &&
        openclaw_shared_resource_lock_is_held release-jarvis
      ;;
    standard) [[ -n "$required_resource" ]] && openclaw_shared_resource_lock_is_held "$required_resource" ;;
    *) return 1 ;;
  esac
}

openclaw_heavy_local_slot_resource_for() {
  local policy="$1"
  local label="$2"

  case "$policy" in
    gateway-lifecycle) printf '%s\n' gateway-main ;;
    jarvis-remediation) printf '%s\n' 'gateway-main,release-jarvis' ;;
    standard)
      case "$label" in
        *telegram* | prove-main-telegram-runtime*) printf '%s\n' live-telegram-main ;;
        *gateway* | deploy-shared-main-runtime* | restart-mac* | ship-main-gateway-fix*) printf '%s\n' gateway-main ;;
        *release* | package-* | jarvis-sparkle-update-e2e*) printf '%s\n' release-jarvis ;;
        *consumer-mac* | build-and-run-mac* | bootstrap-open-computer-use-runtime*) printf '%s\n' app-install ;;
        *)
          printf 'SHARED_RESOURCE_LOCK_ERROR label=%s reason=unclassified_canonical_operation\n' \
            "$(openclaw_heavy_local_slot_safe_text "$label")" >&2
          return 75
          ;;
      esac
      ;;
    *) return 75 ;;
  esac
}

openclaw_heavy_local_slot_require_or_reexec_with_policy() {
  local policy="$1"
  local label="$2"
  local root="$3"
  local entrypoint="$4"
  local resource=""
  shift 4

  resource="$(openclaw_heavy_local_slot_resource_for "$policy" "$label")" || return $?
  if openclaw_heavy_local_slot_inherited_lease_is_valid "$policy" "$resource"; then
    return 0
  fi
  openclaw_shared_resource_lock_require_or_reexec "$resource" "$label" "$root" "$entrypoint" "$@"
}

openclaw_heavy_local_slot_require_or_reexec() {
  openclaw_heavy_local_slot_require_or_reexec_with_policy standard "$@"
}
