#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

# The historical command remains as a compatibility frontend, but ownership is
# now a kernel lock scoped to the actual shared resource.
"$ROOT_DIR/scripts/test-shared-resource-lock.sh"

for script in \
  scripts/bundle-a2ui.sh \
  scripts/prewarm-worktree.sh \
  scripts/bootstrap-worktree-runtime.sh \
  scripts/new-worktree.sh \
  scripts/build-shared-runtime.sh \
  scripts/jarvis-release-worktree.sh; do
  if grep -Fq 'openclaw_heavy_local_slot_require_or_reexec' "$ROOT_DIR/$script"; then
    fail "$script still serializes ordinary isolated work"
  fi
done

check_mapping() {
  local policy="$1"
  local label="$2"
  local expected="$3"
  local actual=""
  actual="$(
    bash -c 'source "$1/scripts/lib/heavy-local-slot.sh"; openclaw_heavy_local_slot_resource_for "$2" "$3"' \
      _ "$ROOT_DIR" "$policy" "$label"
  )"
  [[ "$actual" == "$expected" ]] || fail "$label mapped to $actual instead of $expected"
}

check_mapping standard jarvis-public-release:full release-jarvis
check_mapping standard package-mac-app:consumer release-jarvis
check_mapping standard package-consumer-mac-app:auto release-jarvis
check_mapping gateway-lifecycle gateway-restart:ai.jarvis.gateway gateway-main
check_mapping jarvis-remediation ship-jarvis-hotfix:pr-1 gateway-main,release-jarvis
check_mapping standard prove-main-telegram-runtime live-telegram-main
check_mapping standard open-consumer-mac-app:test app-install

# Holding one resource must never authorize a nested operation mapped to a
# different resource. This was the critical bypass caught during code review.
wrong_resource_output="$($ROOT_DIR/scripts/with-shared-resource-lock.pl \
  --resource gateway-main --label wrong-resource-parent -- \
  bash -c 'source "$1/scripts/lib/heavy-local-slot.sh"; if openclaw_heavy_local_slot_inherited_lease_is_valid standard release-jarvis; then printf accepted; else printf rejected; fi' \
  _ "$ROOT_DIR")"
[[ "$wrong_resource_output" == rejected ]] || fail "gateway-main authorized a release-jarvis operation"

# Separate resources must remain concurrently available; this is the contract
# the old machine-wide lock violated.
for resource in release-jarvis gateway-main app-install live-telegram-main; do
  "$ROOT_DIR/scripts/with-shared-resource-lock.pl" --resource "$resource" --label wiring --check >/dev/null
done

printf 'PASS: narrow shared-resource wiring tests\n'
