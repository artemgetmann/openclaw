#!/usr/bin/env bash

# Process mutex for the canonical Jarvis release lane. mkdir is the atomic
# primitive because macOS ships Bash 3.2 and does not guarantee flock(1).
# This helper never discovers, stops, or kills processes.

OPENCLAW_JARVIS_RELEASE_LOCK_HELD=0
OPENCLAW_JARVIS_RELEASE_LOCK_CLAIMED_DIR=0
OPENCLAW_JARVIS_RELEASE_LOCK_DELEGATED=0
OPENCLAW_JARVIS_RELEASE_LOCK_PATH=""
OPENCLAW_JARVIS_RELEASE_LOCK_TOKEN=""

openclaw_jarvis_release_lock_value() {
  local metadata_path="$1"
  local key="$2"
  /usr/bin/sed -n "s/^${key}=//p" "$metadata_path" 2>/dev/null | /usr/bin/head -n 1
}

openclaw_jarvis_release_lock_safe_text() {
  # Metadata is diagnostics, not an environment dump. Restrict it to a short
  # single line so credentials can never arrive through accidental expansion.
  printf '%s' "$1" | LC_ALL=C /usr/bin/tr -cd 'A-Za-z0-9._:/@+ -' | /usr/bin/cut -c1-240
}

openclaw_jarvis_release_lock_default_path() {
  local root="$1"
  local common_dir common_physical identity

  common_dir="$(git -C "$root" rev-parse --git-common-dir 2>/dev/null)" || return 1
  [[ "$common_dir" == /* ]] || common_dir="$root/$common_dir"
  common_physical="$(cd "$common_dir" && pwd -P)" || return 1
  identity="$(printf '%s' "$common_physical" | /usr/bin/cksum | /usr/bin/awk '{ print $1 "-" $2 }')"

  # Git common-dir makes worktrees of this repository contend together, while
  # unrelated clones get different paths. Use one fixed, user-specific base:
  # TMPDIR differs between launchd, automation, and interactive shells.
  printf '/tmp/openclaw-jarvis-release-locks-%s/%s.lock\n' "$(id -u)" "$identity"
}

openclaw_jarvis_release_lock_after_mkdir() {
  # Test seam for interruption precisely after atomic ownership. Production
  # callers leave this no-op unchanged.
  return 0
}

openclaw_jarvis_release_lock_write_owner() {
  local owner_path="$1"
  local token="$2"
  local context="$3"
  local root="$4"
  local owner_tmp="${owner_path}.tmp.$$"

  {
    printf 'pid=%s\n' "$$"
    printf 'token=%s\n' "$token"
    printf 'context=%s\n' "$(openclaw_jarvis_release_lock_safe_text "$context")"
    printf 'repo=%s\n' "$(openclaw_jarvis_release_lock_safe_text "$root")"
    printf 'created_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    if [[ -n "${CODEX_THREAD_ID:-}" ]]; then
      printf 'thread_id=%s\n' "$(openclaw_jarvis_release_lock_safe_text "$CODEX_THREAD_ID")"
    fi
  } >"$owner_tmp"
  mv "$owner_tmp" "$owner_path"
}

openclaw_jarvis_release_lock_remove_reclaim_claim() {
  local reclaim_path="$1"
  local expected_token="$2"
  local metadata_path="$reclaim_path/owner"

  [[ -f "$metadata_path" ]] || return 1
  [[ "$(openclaw_jarvis_release_lock_value "$metadata_path" token)" == "$expected_token" ]] || return 1
  rm -f "$metadata_path"
  rmdir "$reclaim_path" 2>/dev/null
}

openclaw_jarvis_release_lock_reclaim_dead_owner() {
  local lock_path="$1"
  local expected_owner_token="$2"
  local expected_owner_pid="$3"
  local reclaim_path="$lock_path/reclaim"
  local reclaim_token="reclaim-$$-$(date +%s)-${RANDOM:-0}"
  local current_token current_pid reclaim_pid reclaim_token_found

  if ! mkdir "$reclaim_path" 2>/dev/null; then
    # A dead reclaimer must not wedge recovery. Remove only its initialized,
    # token-matched claim; never delete the enclosing release lock here.
    if [[ -f "$reclaim_path/owner" ]]; then
      reclaim_pid="$(openclaw_jarvis_release_lock_value "$reclaim_path/owner" pid)"
      reclaim_token_found="$(openclaw_jarvis_release_lock_value "$reclaim_path/owner" token)"
      if [[ "$reclaim_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$reclaim_pid" 2>/dev/null; then
        openclaw_jarvis_release_lock_remove_reclaim_claim "$reclaim_path" "$reclaim_token_found" || true
      fi
    fi
    return 1
  fi

  openclaw_jarvis_release_lock_write_owner "$reclaim_path/owner" "$reclaim_token" "stale-lock-recovery" "$lock_path"

  # Re-read under the recovery claim. Identity must still match the dead owner
  # we observed, otherwise this contender has no right to remove anything.
  current_token="$(openclaw_jarvis_release_lock_value "$lock_path/owner" token)"
  current_pid="$(openclaw_jarvis_release_lock_value "$lock_path/owner" pid)"
  if [[ "$current_token" != "$expected_owner_token" || "$current_pid" != "$expected_owner_pid" ]]; then
    openclaw_jarvis_release_lock_remove_reclaim_claim "$reclaim_path" "$reclaim_token" || true
    return 1
  fi
  if [[ "$current_pid" =~ ^[0-9]+$ ]] && kill -0 "$current_pid" 2>/dev/null; then
    openclaw_jarvis_release_lock_remove_reclaim_claim "$reclaim_path" "$reclaim_token" || true
    return 1
  fi

  rm -f "$lock_path/owner"
  openclaw_jarvis_release_lock_remove_reclaim_claim "$reclaim_path" "$reclaim_token" || return 1
  rmdir "$lock_path" 2>/dev/null
}

openclaw_jarvis_release_lock_release() {
  local owner_path owner_token
  [[ "$OPENCLAW_JARVIS_RELEASE_LOCK_DELEGATED" != "1" ]] || return 0
  [[ "$OPENCLAW_JARVIS_RELEASE_LOCK_CLAIMED_DIR" == "1" ]] || return 0

  owner_path="$OPENCLAW_JARVIS_RELEASE_LOCK_PATH/owner"
  if [[ ! -f "$owner_path" ]]; then
    # The caller has positive in-memory ownership from its successful mkdir.
    # This is the only safe case where an ownerless directory may be removed.
    rm -f "${owner_path}.tmp.$$"
    rmdir "$OPENCLAW_JARVIS_RELEASE_LOCK_PATH" 2>/dev/null || true
  else
    owner_token="$(openclaw_jarvis_release_lock_value "$owner_path" token)"
    if [[ "$owner_token" == "$OPENCLAW_JARVIS_RELEASE_LOCK_TOKEN" ]]; then
      # Remove only our token-matched record, then rmdir. The directory blocks
      # a replacement owner between those operations, so cleanup cannot steal it.
      rm -f "$owner_path"
      rmdir "$OPENCLAW_JARVIS_RELEASE_LOCK_PATH" 2>/dev/null || true
    fi
  fi
  OPENCLAW_JARVIS_RELEASE_LOCK_HELD=0
  OPENCLAW_JARVIS_RELEASE_LOCK_CLAIMED_DIR=0
}

openclaw_jarvis_release_lock_signal() {
  local status="$1"
  openclaw_jarvis_release_lock_release
  exit "$status"
}

openclaw_jarvis_release_lock_install_cleanup() {
  trap openclaw_jarvis_release_lock_release EXIT
  trap 'openclaw_jarvis_release_lock_signal 129' HUP
  trap 'openclaw_jarvis_release_lock_signal 130' INT
  trap 'openclaw_jarvis_release_lock_signal 143' TERM
}

openclaw_jarvis_release_lock_accept_parent() {
  local lock_path="$1"
  local owner_path="$lock_path/owner"
  local parent_pid="${OPENCLAW_JARVIS_RELEASE_LOCK_PARENT_PID:-}"
  local parent_token="${OPENCLAW_JARVIS_RELEASE_LOCK_PARENT_TOKEN:-}"
  local parent_path="${OPENCLAW_JARVIS_RELEASE_LOCK_PARENT_PATH:-}"
  local metadata_pid metadata_token

  [[ "$parent_pid" =~ ^[0-9]+$ ]] || return 1
  [[ "$parent_pid" == "$PPID" ]] || return 1
  [[ -n "$parent_token" && "$parent_path" == "$lock_path" ]] || return 1
  [[ -f "$owner_path" ]] || return 1
  metadata_pid="$(openclaw_jarvis_release_lock_value "$owner_path" pid)"
  metadata_token="$(openclaw_jarvis_release_lock_value "$owner_path" token)"
  [[ "$metadata_pid" == "$parent_pid" && "$metadata_token" == "$parent_token" ]] || return 1
  kill -0 "$parent_pid" 2>/dev/null || return 1

  # The child borrows the live direct parent's ownership. It must never install
  # cleanup or remove the parent's lock; the parent remains the sole owner.
  OPENCLAW_JARVIS_RELEASE_LOCK_DELEGATED=1
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH="$lock_path"
  OPENCLAW_JARVIS_RELEASE_LOCK_TOKEN="$parent_token"
  echo "jarvis_release_lock=delegated_parent"
  echo "jarvis_release_lock_owner_pid=$parent_pid"
  return 0
}

openclaw_jarvis_release_lock_acquire() {
  local root="$1"
  local context="${2:-release}"
  local lock_path lock_parent owner_path owner_pid owner_token owner_context owner_thread
  local token="owner-$$-$(date +%s)-${RANDOM:-0}"
  local metadata_wait

  lock_path="${OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE:-$(openclaw_jarvis_release_lock_default_path "$root")}" || {
    echo "ERROR: unable to derive the Jarvis release lock path." >&2
    return 1
  }
  lock_parent="$(dirname "$lock_path")"
  owner_path="$lock_path/owner"
  (umask 077 && mkdir -p "$lock_parent" && chmod 700 "$lock_parent")

  if openclaw_jarvis_release_lock_accept_parent "$lock_path"; then
    return 0
  fi

  # Cleanup must exist before mkdir. If this process is interrupted in the
  # mkdir-to-metadata window, positive in-memory ownership lets it remove only
  # its own ownerless directory instead of wedging the lane permanently.
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH="$lock_path"
  OPENCLAW_JARVIS_RELEASE_LOCK_TOKEN="$token"
  openclaw_jarvis_release_lock_install_cleanup

  while true; do
    if mkdir "$lock_path" 2>/dev/null; then
      OPENCLAW_JARVIS_RELEASE_LOCK_CLAIMED_DIR=1
      openclaw_jarvis_release_lock_after_mkdir
      openclaw_jarvis_release_lock_write_owner "$owner_path" "$token" "$context" "$root"
      OPENCLAW_JARVIS_RELEASE_LOCK_HELD=1
      OPENCLAW_JARVIS_RELEASE_LOCK_PARENT_PID="$$"
      OPENCLAW_JARVIS_RELEASE_LOCK_PARENT_TOKEN="$token"
      OPENCLAW_JARVIS_RELEASE_LOCK_PARENT_PATH="$lock_path"
      export OPENCLAW_JARVIS_RELEASE_LOCK_PARENT_PID
      export OPENCLAW_JARVIS_RELEASE_LOCK_PARENT_TOKEN
      export OPENCLAW_JARVIS_RELEASE_LOCK_PARENT_PATH
      echo "jarvis_release_lock=acquired"
      echo "jarvis_release_lock_path=$lock_path"
      return 0
    fi

    # mkdir wins before metadata is written. Wait briefly, but never interpret
    # missing metadata as permission to delete an unknown owner's directory.
    metadata_wait=0
    while [[ ! -f "$owner_path" && "$metadata_wait" -lt 20 ]]; do
      sleep 0.05
      metadata_wait=$((metadata_wait + 1))
    done
    if [[ ! -f "$owner_path" ]]; then
      echo "ERROR: Jarvis release lock has no readable owner metadata: $lock_path" >&2
      echo "Use explicit chat/session handoff; never use ad-hoc ps scanning, SIGSTOP, or SIGKILL guards." >&2
      return 1
    fi

    owner_pid="$(openclaw_jarvis_release_lock_value "$owner_path" pid)"
    owner_token="$(openclaw_jarvis_release_lock_value "$owner_path" token)"
    owner_context="$(openclaw_jarvis_release_lock_value "$owner_path" context)"
    owner_thread="$(openclaw_jarvis_release_lock_value "$owner_path" thread_id)"
    if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
      echo "ERROR: another Jarvis release owner is active; refusing concurrent release work." >&2
      echo "owner_pid=$owner_pid" >&2
      echo "owner_context=${owner_context:-unknown}" >&2
      [[ -z "$owner_thread" ]] || echo "owner_thread_id=$owner_thread" >&2
      echo "lock_path=$lock_path" >&2
      echo "Use explicit chat/session handoff; never use ad-hoc ps scanning, SIGSTOP, or SIGKILL guards." >&2
      return 1
    fi

    if [[ -z "$owner_token" ]] || ! openclaw_jarvis_release_lock_reclaim_dead_owner "$lock_path" "$owner_token" "$owner_pid"; then
      echo "ERROR: Jarvis release lock recovery is already in progress; retry after the operator handoff is clear." >&2
      return 1
    fi
    echo "jarvis_release_lock=reclaimed_stale" >&2
  done
}
