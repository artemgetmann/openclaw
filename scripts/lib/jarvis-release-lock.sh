#!/usr/bin/env bash

# Compatibility API for canonical release scripts. The authoritative mutex is
# the inherited OS-owned `release-jarvis` resource lock. Release functions no
# longer create PID metadata, transfer ownership, or require stale cleanup.

# shellcheck source=scripts/lib/shared-resource-lock.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/shared-resource-lock.sh"

OPENCLAW_JARVIS_RELEASE_LOCK_HELD=0

openclaw_jarvis_release_lock_acquire() {
  local _root="$1"
  local context="$2"

  if ! openclaw_shared_resource_lock_is_held release-jarvis; then
    printf 'jarvis_release_lock=refused context=%s reason=release_resource_not_held\n' "$context" >&2
    return 75
  fi
  OPENCLAW_JARVIS_RELEASE_LOCK_HELD=1
  printf 'jarvis_release_lock=held resource=release-jarvis context=%s\n' "$context"
}

openclaw_jarvis_release_lock_release() {
  # The kernel releases the inherited descriptor when the transaction exits.
  # A nested helper must never unlock its parent's complete release transaction.
  OPENCLAW_JARVIS_RELEASE_LOCK_HELD=0
}
