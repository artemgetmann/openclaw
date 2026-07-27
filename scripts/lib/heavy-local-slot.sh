#!/usr/bin/env bash

# Machine-wide, per-user lease support for expensive local work.
#
# The wrapper owns the lease for the lifetime of its guarded child tree.
# Canonical entrypoints source this helper and accept inheritance only when the
# exported capability token matches live owner metadata at the canonical lock
# path. A boolean "already guarded" flag would let any caller bypass admission,
# so this helper deliberately has no such sentinel.

OPENCLAW_HEAVY_LOCAL_SLOT_HELD=0
OPENCLAW_HEAVY_LOCAL_SLOT_CLAIMED_DIR=0
OPENCLAW_HEAVY_LOCAL_SLOT_PATH=""
OPENCLAW_HEAVY_LOCAL_SLOT_TOKEN=""

openclaw_heavy_local_slot_value() {
  local metadata_path="$1"
  local key="$2"
  /usr/bin/sed -n "s/^${key}=//p" "$metadata_path" 2>/dev/null | /usr/bin/head -n 1
}

openclaw_heavy_local_slot_safe_text() {
  # Lease metadata is operator diagnostics, not an environment dump. Keep each
  # field single-line and bounded so labels cannot smuggle terminal control
  # characters or secrets into a contention report.
  printf '%s' "$1" |
    LC_ALL=C /usr/bin/tr -cd 'A-Za-z0-9._:/@+ -' |
    /usr/bin/cut -c1-240
}

openclaw_heavy_local_slot_process_start() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1

  # PID alone is unsafe after process reuse. Pin locale and timezone so every
  # clone derives the same stable start-time fingerprint for the live owner.
  LC_ALL=C TZ=UTC /bin/ps -p "$pid" -o lstart= 2>/dev/null |
    /usr/bin/awk '{$1=$1; if (length($0)) print}' |
    /usr/bin/head -n 1
}

openclaw_heavy_local_slot_owner_is_live() {
  local pid="$1"
  local expected_start="$2"
  local current_start=""

  # Missing identity is unknown, not stale. Callers distinguish status 2 from
  # a proven-dead owner and refuse unsafe recovery.
  [[ "$pid" =~ ^[0-9]+$ && -n "$expected_start" ]] || return 2
  current_start="$(openclaw_heavy_local_slot_process_start "$pid" || true)"
  [[ -n "$current_start" ]] || return 1
  [[ "$current_start" == "$expected_start" ]]
}

openclaw_heavy_local_slot_default_path() {
  # Git common-dir is clone-local. A UID-scoped path under /tmp is shared by
  # worktrees, independent clones, launchd jobs, and interactive shells while
  # still isolating different local users.
  printf '/tmp/openclaw-heavy-local-slots-%s/machine-wide.lock\n' "$(id -u)"
}

openclaw_heavy_local_slot_resolve_path() {
  local override="${OPENCLAW_HEAVY_LOCAL_SLOT_TEST_LOCK_PATH:-}"

  if [[ -n "$override" ]]; then
    # The override exists only for hermetic contention tests. Requiring a
    # second explicit test marker prevents ordinary callers from redirecting a
    # canonical entrypoint to a private lock and silently bypassing the fleet.
    if [[ "${OPENCLAW_HEAVY_LOCAL_SLOT_TESTING:-0}" != "1" ]]; then
      echo "ERROR: OPENCLAW_HEAVY_LOCAL_SLOT_TEST_LOCK_PATH is test-only." >&2
      return 1
    fi
    if [[ "$override" != /* || "$override" == *$'\n'* ]]; then
      echo "ERROR: heavy-local test lock path must be absolute and single-line." >&2
      return 1
    fi
    printf '%s\n' "$override"
    return 0
  fi

  openclaw_heavy_local_slot_default_path
}

openclaw_heavy_local_slot_generate_token() {
  local token=""

  # Lease inheritance is a capability: use OS entropy, never PID/time/RANDOM.
  # openssl is present on supported Macs; /dev/urandom keeps the helper usable
  # in minimal CI shells without weakening production tokens.
  if [[ -x /usr/bin/openssl ]]; then
    token="$(/usr/bin/openssl rand -hex 32 2>/dev/null || true)"
  elif command -v openssl >/dev/null 2>&1; then
    token="$(openssl rand -hex 32 2>/dev/null || true)"
  fi
  if [[ ! "$token" =~ ^[0-9a-fA-F]{64}$ ]]; then
    token="$(
      /usr/bin/od -An -N32 -tx1 /dev/urandom 2>/dev/null |
        /usr/bin/tr -d ' \n'
    )"
  fi
  [[ "$token" =~ ^[0-9a-fA-F]{64}$ ]] || return 1
  printf '%s\n' "$token"
}

openclaw_heavy_local_slot_write_owner() {
  local owner_path="$1"
  local token="$2"
  local label="$3"
  local owner_tmp="${owner_path}.tmp.$$"
  local process_start=""

  process_start="$(openclaw_heavy_local_slot_process_start "$$")" || return 1
  [[ -n "$process_start" ]] || return 1

  {
    printf 'pid=%s\n' "$$"
    printf 'token=%s\n' "$token"
    printf 'process_start=%s\n' "$process_start"
    printf 'label=%s\n' "$(openclaw_heavy_local_slot_safe_text "$label")"
    printf 'created_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    if [[ -n "${CODEX_THREAD_ID:-}" ]]; then
      printf 'thread_id=%s\n' "$(openclaw_heavy_local_slot_safe_text "$CODEX_THREAD_ID")"
    fi
  } >"$owner_tmp"
  /bin/chmod 600 "$owner_tmp"
  /bin/mv "$owner_tmp" "$owner_path"
}

openclaw_heavy_local_slot_after_mkdir() {
  # Test seam for interruption in the atomic mkdir-to-metadata window.
  # Production callers leave this no-op unchanged.
  return 0
}

openclaw_heavy_local_slot_remove_reclaim_claim() {
  local reclaim_path="$1"
  local expected_token="$2"
  local metadata_path="$reclaim_path/owner"

  [[ -f "$metadata_path" ]] || return 1
  [[ "$(openclaw_heavy_local_slot_value "$metadata_path" token)" == "$expected_token" ]] || return 1
  /bin/rm -f "$metadata_path"
  /bin/rmdir "$reclaim_path" 2>/dev/null
}

openclaw_heavy_local_slot_reclaim_dead_owner() {
  local lock_path="$1"
  local expected_owner_token="$2"
  local expected_owner_pid="$3"
  local expected_owner_start="$4"
  local reclaim_path="$lock_path/reclaim"
  local reclaim_token=""
  local current_token="" current_pid="" current_start=""
  local live_status=0

  reclaim_token="$(openclaw_heavy_local_slot_generate_token)" || return 1
  if ! (umask 077 && /bin/mkdir "$reclaim_path") 2>/dev/null; then
    return 1
  fi
  if ! openclaw_heavy_local_slot_write_owner \
    "$reclaim_path/owner" \
    "$reclaim_token" \
    "heavy-local-stale-recovery"; then
    /bin/rmdir "$reclaim_path" 2>/dev/null || true
    return 1
  fi

  # The dead identity observed by the contender must remain byte-for-byte the
  # same under the recovery claim. Otherwise cleanup could steal a replacement
  # owner's lease after a concurrent transition.
  current_token="$(openclaw_heavy_local_slot_value "$lock_path/owner" token)"
  current_pid="$(openclaw_heavy_local_slot_value "$lock_path/owner" pid)"
  current_start="$(openclaw_heavy_local_slot_value "$lock_path/owner" process_start)"
  if [[ "$current_token" != "$expected_owner_token" ||
    "$current_pid" != "$expected_owner_pid" ||
    "$current_start" != "$expected_owner_start" ]]; then
    openclaw_heavy_local_slot_remove_reclaim_claim "$reclaim_path" "$reclaim_token" || true
    return 1
  fi

  if openclaw_heavy_local_slot_owner_is_live "$current_pid" "$current_start"; then
    live_status=0
  else
    live_status=$?
  fi
  if [[ "$live_status" -ne 1 ]]; then
    openclaw_heavy_local_slot_remove_reclaim_claim "$reclaim_path" "$reclaim_token" || true
    return 1
  fi

  /bin/rm -f "$lock_path/owner"
  openclaw_heavy_local_slot_remove_reclaim_claim "$reclaim_path" "$reclaim_token" || return 1
  /bin/rmdir "$lock_path" 2>/dev/null
}

openclaw_heavy_local_slot_release() {
  local owner_path="" owner_token=""

  [[ "$OPENCLAW_HEAVY_LOCAL_SLOT_CLAIMED_DIR" == "1" ]] || return 0
  owner_path="$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/owner"

  if [[ ! -f "$owner_path" ]]; then
    # Positive in-memory mkdir ownership is the only safe basis for removing
    # an ownerless directory after interruption before metadata publication.
    /bin/rm -f "${owner_path}.tmp.$$"
    /bin/rmdir "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH" 2>/dev/null || true
  else
    owner_token="$(openclaw_heavy_local_slot_value "$owner_path" token)"
    if [[ "$owner_token" == "$OPENCLAW_HEAVY_LOCAL_SLOT_TOKEN" ]]; then
      # Runtime files are meaningful only inside our still-token-matched lease.
      # The enclosing directory prevents a replacement mkdir until rmdir.
      /bin/rm -f \
        "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_pid" \
        "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/health_stop_reason" \
        "$owner_path"
      /bin/rmdir "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH" 2>/dev/null || true
    fi
  fi

  OPENCLAW_HEAVY_LOCAL_SLOT_HELD=0
  OPENCLAW_HEAVY_LOCAL_SLOT_CLAIMED_DIR=0
}

openclaw_heavy_local_slot_acquire() {
  local label="$1"
  local lock_path="" lock_parent="" owner_path=""
  local token="" owner_pid="" owner_token="" owner_start="" owner_label=""
  local metadata_wait=0 live_status=0

  lock_path="$(openclaw_heavy_local_slot_resolve_path)" || return 1
  token="$(openclaw_heavy_local_slot_generate_token)" || {
    echo "Refusing heavy work: could not create a secure lease token." >&2
    return 75
  }
  lock_parent="$(dirname "$lock_path")"
  owner_path="$lock_path/owner"
  (umask 077 && /bin/mkdir -p "$lock_parent" && /bin/chmod 700 "$lock_parent") || return 1

  # Publish intended ownership before mkdir so the wrapper's already-installed
  # EXIT trap can clean only its own ownerless directory after an interruption.
  OPENCLAW_HEAVY_LOCAL_SLOT_PATH="$lock_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_TOKEN="$token"

  while true; do
    if (umask 077 && /bin/mkdir "$lock_path") 2>/dev/null; then
      OPENCLAW_HEAVY_LOCAL_SLOT_CLAIMED_DIR=1
      if ! openclaw_heavy_local_slot_after_mkdir ||
        ! openclaw_heavy_local_slot_write_owner "$owner_path" "$token" "$label"; then
        openclaw_heavy_local_slot_release
        echo "Refusing heavy work: could not publish lease owner metadata." >&2
        return 75
      fi
      OPENCLAW_HEAVY_LOCAL_SLOT_HELD=1
      OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN="$token"
      export OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN
      return 0
    fi

    # mkdir becomes visible before the atomic owner record. Wait a bounded
    # moment, but never interpret missing metadata as permission to delete.
    metadata_wait=0
    while [[ ! -f "$owner_path" && "$metadata_wait" -lt 20 ]]; do
      sleep 0.05
      metadata_wait=$((metadata_wait + 1))
    done
    if [[ ! -f "$owner_path" ]]; then
      echo "Refusing heavy work: slot has no readable owner metadata at $lock_path." >&2
      return 75
    fi

    owner_pid="$(openclaw_heavy_local_slot_value "$owner_path" pid)"
    owner_token="$(openclaw_heavy_local_slot_value "$owner_path" token)"
    owner_start="$(openclaw_heavy_local_slot_value "$owner_path" process_start)"
    owner_label="$(openclaw_heavy_local_slot_value "$owner_path" label)"
    if openclaw_heavy_local_slot_owner_is_live "$owner_pid" "$owner_start"; then
      live_status=0
    else
      live_status=$?
    fi
    if [[ "$live_status" -eq 0 ]]; then
      printf 'Refusing heavy work: slot held by "%s" (PID %s).\n' \
        "${owner_label:-unknown}" \
        "${owner_pid:-unknown}" >&2
      return 75
    fi
    if [[ "$live_status" -eq 2 || -z "$owner_token" ]]; then
      echo "Refusing heavy work: slot owner identity is incomplete; refusing unsafe recovery." >&2
      return 75
    fi

    if ! openclaw_heavy_local_slot_reclaim_dead_owner \
      "$lock_path" \
      "$owner_token" \
      "$owner_pid" \
      "$owner_start"; then
      echo "Refusing heavy work: stale-slot recovery is already active or ownership changed." >&2
      return 75
    fi
  done
}

openclaw_heavy_local_slot_inherited_lease_is_valid() {
  local inherited_token="${OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN:-}"
  local lock_path="" owner_path=""
  local owner_pid="" owner_token="" owner_start=""

  [[ "$inherited_token" =~ ^[0-9a-fA-F]{64}$ ]] || return 1
  lock_path="$(openclaw_heavy_local_slot_resolve_path)" || return 1
  owner_path="$lock_path/owner"
  [[ -f "$owner_path" ]] || return 1

  owner_pid="$(openclaw_heavy_local_slot_value "$owner_path" pid)"
  owner_token="$(openclaw_heavy_local_slot_value "$owner_path" token)"
  owner_start="$(openclaw_heavy_local_slot_value "$owner_path" process_start)"
  [[ "$owner_token" == "$inherited_token" ]] || return 1
  openclaw_heavy_local_slot_owner_is_live "$owner_pid" "$owner_start"
}

openclaw_heavy_local_slot_require_or_reexec() {
  local label="$1"
  local root="$2"
  local entrypoint="$3"
  shift 3

  if openclaw_heavy_local_slot_inherited_lease_is_valid; then
    return 0
  fi

  # exec keeps one supervision boundary and preserves the eventual child exit
  # status. The wrapper replaces any forged/stale token with a fresh capability;
  # the re-executed entrypoint then validates that live metadata and proceeds.
  exec "$root/scripts/with-heavy-local-slot.sh" \
    --label "$label" \
    -- \
    "$entrypoint" "$@"
}
