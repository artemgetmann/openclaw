#!/usr/bin/env bash

# Machine-wide, per-user lease support for expensive local work.
#
# The wrapper owns the lease for the lifetime of its guarded child tree.
# Canonical entrypoints source this helper and accept inheritance only when the
# exported capability token matches live owner metadata and the caller is an
# actual descendant of that wrapper. A boolean "already guarded" flag or token
# alone would let a same-user sibling bypass admission, so neither is trusted.

OPENCLAW_HEAVY_LOCAL_SLOT_HELD=0
OPENCLAW_HEAVY_LOCAL_SLOT_CLAIMED_DIR=0
OPENCLAW_HEAVY_LOCAL_SLOT_PATH=""
OPENCLAW_HEAVY_LOCAL_SLOT_TOKEN=""
OPENCLAW_HEAVY_LOCAL_SLOT_REFUSAL_CLASS=""
OPENCLAW_HEAVY_LOCAL_SLOT_REFUSAL_CODE=""
OPENCLAW_HEAVY_LOCAL_SLOT_REFUSAL_MESSAGE=""
OPENCLAW_HEAVY_LOCAL_SLOT_REFUSAL_DATA=""
OPENCLAW_HEAVY_LOCAL_SLOT_OWNER_PUBLISH_ERROR=""

openclaw_heavy_local_slot_set_refusal() {
  OPENCLAW_HEAVY_LOCAL_SLOT_REFUSAL_CLASS="$1"
  OPENCLAW_HEAVY_LOCAL_SLOT_REFUSAL_CODE="$2"
  OPENCLAW_HEAVY_LOCAL_SLOT_REFUSAL_MESSAGE="$3"
  OPENCLAW_HEAVY_LOCAL_SLOT_REFUSAL_DATA="${4:-}"
}

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

openclaw_heavy_local_slot_process_parent() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1

  LC_ALL=C /bin/ps -p "$pid" -o ppid= 2>/dev/null |
    /usr/bin/awk '{$1=$1; if ($0 ~ /^[1-9][0-9]*$/) print}' |
    /usr/bin/head -n 1
}

openclaw_heavy_local_slot_process_identity() {
  local pid="$1"
  local helper_dir="" runner="" perl_bin=""
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1

  # Query PGID and SID together through syscall-backed POSIX APIs. macOS
  # `ps -o sess=` is not a SID interface and commonly reports zero.
  helper_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || return 1
  runner="$helper_dir/heavy-local-slot-runner.pl"
  if [[ -x /usr/bin/perl ]]; then
    perl_bin=/usr/bin/perl
  else
    perl_bin="$(command -v perl 2>/dev/null || true)"
  fi
  [[ -n "$perl_bin" && -r "$runner" ]] || return 1
  "$perl_bin" "$runner" --inspect-process "$pid" 2>/dev/null
}

openclaw_heavy_local_slot_owner_is_live() {
  local pid="$1"
  local expected_start="$2"
  local current_start=""

  # The writer emits a positive decimal PID without padding. Reject zero and
  # malformed values before kill(2), because PID 0 addresses a process group.
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 2

  # Reclaim requires positive proof that the recorded PID no longer exists.
  # A missing or mismatched start fingerprint can mean transient ps failure or
  # PID reuse; both are ambiguous while the PID is live and must fail closed.
  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  [[ -n "$expected_start" ]] || return 2
  current_start="$(openclaw_heavy_local_slot_process_start "$pid" || true)"
  [[ -n "$current_start" ]] || return 2
  [[ "$current_start" == "$expected_start" ]] || return 2
  return 0
}

openclaw_heavy_local_slot_process_descends_from_owner() {
  local child_pid="$1"
  local owner_pid="$2"
  local owner_start="$3"
  local current_pid="$child_pid"
  local parent_pid=""
  local depth=0

  [[ "$child_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$owner_pid" =~ ^[1-9][0-9]*$ ]] || return 1

  # Validate the owner before and after walking. The bounded ancestry walk
  # fails closed on unreadable process state, cycles, or a concurrently reused
  # owner PID instead of treating a copied token as sufficient authority.
  openclaw_heavy_local_slot_owner_is_live "$owner_pid" "$owner_start" || return 1
  while [[ "$depth" -lt 256 ]]; do
    if [[ "$current_pid" == "$owner_pid" ]]; then
      openclaw_heavy_local_slot_owner_is_live "$owner_pid" "$owner_start"
      return
    fi

    parent_pid="$(openclaw_heavy_local_slot_process_parent "$current_pid" || true)"
    [[ "$parent_pid" =~ ^[1-9][0-9]*$ ]] || return 1
    [[ "$parent_pid" != "$current_pid" ]] || return 1
    current_pid="$parent_pid"
    depth=$((depth + 1))
  done
  return 1
}

openclaw_heavy_local_slot_default_path() {
  # Git common-dir is clone-local. A UID-scoped path under /tmp is shared by
  # worktrees, independent clones, launchd jobs, and interactive shells while
  # still isolating different local users.
  printf '/tmp/openclaw-heavy-local-slots-%s/machine-wide.lock\n' "$(id -u)"
}

openclaw_heavy_local_slot_resolve_path() {
  # Production has exactly one identity. Tests that need a private lock copy
  # this helper into a disposable fixture and override the function there.
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
  local policy="${4:-standard}"
  local owner_tmp="${owner_path}.tmp.$$"
  local process_start=""

  OPENCLAW_HEAVY_LOCAL_SLOT_OWNER_PUBLISH_ERROR=""
  if ! process_start="$(openclaw_heavy_local_slot_process_start "$$")" ||
    [[ -z "$process_start" ]]; then
    OPENCLAW_HEAVY_LOCAL_SLOT_OWNER_PUBLISH_ERROR="process_start_unavailable"
    return 1
  fi

  if ! {
    printf 'pid=%s\n' "$$"
    printf 'token=%s\n' "$token"
    printf 'process_start=%s\n' "$process_start"
    printf 'label=%s\n' "$(openclaw_heavy_local_slot_safe_text "$label")"
    printf 'policy=%s\n' "$(openclaw_heavy_local_slot_safe_text "$policy")"
    printf 'created_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    if [[ -n "${CODEX_THREAD_ID:-}" ]]; then
      printf 'thread_id=%s\n' "$(openclaw_heavy_local_slot_safe_text "$CODEX_THREAD_ID")"
    fi
  } >"$owner_tmp"; then
    OPENCLAW_HEAVY_LOCAL_SLOT_OWNER_PUBLISH_ERROR="owner_tmp_write_failed"
    /bin/rm -f "$owner_tmp"
    return 1
  fi
  if ! /bin/chmod 600 "$owner_tmp"; then
    OPENCLAW_HEAVY_LOCAL_SLOT_OWNER_PUBLISH_ERROR="owner_tmp_chmod_failed"
    /bin/rm -f "$owner_tmp"
    return 1
  fi
  if ! /bin/mv "$owner_tmp" "$owner_path"; then
    OPENCLAW_HEAVY_LOCAL_SLOT_OWNER_PUBLISH_ERROR="owner_atomic_rename_failed"
    /bin/rm -f "$owner_tmp"
    return 1
  fi
}

openclaw_heavy_local_slot_child_group_status() {
  local lock_path="$1"
  local pending_path="$lock_path/child_pending"
  local committed_path="$lock_path/child_committed"
  local metadata_path="$lock_path/child_pid"
  local child_pid="" child_start="" child_pgid="" child_session=""
  local current_start="" current_identity="" current_pgid="" current_session=""

  # The runner publishes metadata first, then atomically renames pending to
  # committed. Only that exact committed state is signal/recovery authority.
  # Pending or metadata without its commit marker can be a crash in the publish
  # window, so stale recovery must stop for operator review.
  [[ ! -e "$pending_path" ]] || return 2
  if [[ ! -e "$committed_path" ]]; then
    [[ ! -e "$metadata_path" ]] || return 2
    return 1
  fi
  [[ -f "$committed_path" ]] || return 2
  [[ -f "$metadata_path" ]] || return 2

  child_pid="$(openclaw_heavy_local_slot_value "$metadata_path" pid)"
  child_start="$(openclaw_heavy_local_slot_value "$metadata_path" process_start)"
  child_pgid="$(openclaw_heavy_local_slot_value "$metadata_path" pgid)"
  child_session="$(openclaw_heavy_local_slot_value "$metadata_path" session)"
  [[ "$child_pid" =~ ^[1-9][0-9]*$ ]] || return 2
  [[ -n "$child_start" ]] || return 2
  [[ "$child_pgid" == "$child_pid" ]] || return 2
  [[ "$child_session" == "$child_pid" ]] || return 2

  # When the leader PID still exists, every recorded identity component must
  # match. A reused PID, process group, or session is ambiguous and must never
  # become a signal or stale-recovery target.
  if kill -0 "$child_pid" 2>/dev/null; then
    current_start="$(openclaw_heavy_local_slot_process_start "$child_pid" || true)"
    current_identity="$(openclaw_heavy_local_slot_process_identity "$child_pid" || true)"
    current_pgid="$(
      printf '%s\n' "$current_identity" |
        /usr/bin/sed -n 's/^pgid=//p' |
        /usr/bin/head -n 1
    )"
    current_session="$(
      printf '%s\n' "$current_identity" |
        /usr/bin/sed -n 's/^session=//p' |
        /usr/bin/head -n 1
    )"
    [[ "$current_start" == "$child_start" ]] || return 2
    [[ "$current_pgid" == "$child_pgid" ]] || return 2
    [[ "$current_session" == "$child_session" ]] || return 2
  fi

  # The session runner is both leader and process-group leader. Negative-PGID
  # probing remains true after the root command exits while stubborn children
  # stay behind, which prevents stale recovery from overlapping their work.
  if kill -0 -- "-$child_pgid" 2>/dev/null; then
    return 0
  fi
  return 1
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
    "heavy-local-stale-recovery" \
    "standard"; then
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

  if openclaw_heavy_local_slot_child_group_status "$lock_path"; then
    live_status=0
  else
    live_status=$?
  fi
  if [[ "$live_status" -ne 1 ]]; then
    openclaw_heavy_local_slot_remove_reclaim_claim "$reclaim_path" "$reclaim_token" || true
    return 1
  fi

  /bin/rm -f \
    "$lock_path/child_pid" \
    "$lock_path/child_pending" \
    "$lock_path/child_committed" \
    "$lock_path/child_authorized" \
    "$lock_path/child_authorized.tmp.${expected_owner_pid}"
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
        "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_pending" \
        "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_committed" \
        "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_authorized" \
        "$OPENCLAW_HEAVY_LOCAL_SLOT_PATH/child_authorized.tmp.$$" \
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
  local policy="${2:-standard}"
  local lock_path="" lock_parent="" owner_path=""
  local token="" owner_pid="" owner_token="" owner_start="" owner_label=""
  local metadata_wait=0 live_status=0 child_status=0

  openclaw_heavy_local_slot_set_refusal "" "" "" ""
  lock_path="$(openclaw_heavy_local_slot_resolve_path)" || {
    openclaw_heavy_local_slot_set_refusal \
      "guard_internal" \
      "lease_path_unavailable" \
      "could not resolve the machine-wide lease path"
    return 75
  }
  token="$(openclaw_heavy_local_slot_generate_token)" || {
    openclaw_heavy_local_slot_set_refusal \
      "guard_internal" \
      "lease_token_unavailable" \
      "could not create a secure lease token"
    return 75
  }
  lock_parent="$(dirname "$lock_path")"
  owner_path="$lock_path/owner"
  if ! (umask 077 && /bin/mkdir -p "$lock_parent" && /bin/chmod 700 "$lock_parent"); then
    openclaw_heavy_local_slot_set_refusal \
      "guard_internal" \
      "lease_parent_unavailable" \
      "could not create or protect the lease parent directory"
    return 75
  fi

  # Publish intended ownership before mkdir so the wrapper's already-installed
  # EXIT trap can clean only its own ownerless directory after an interruption.
  OPENCLAW_HEAVY_LOCAL_SLOT_PATH="$lock_path"
  OPENCLAW_HEAVY_LOCAL_SLOT_TOKEN="$token"

  while true; do
    if (umask 077 && /bin/mkdir "$lock_path") 2>/dev/null; then
      OPENCLAW_HEAVY_LOCAL_SLOT_CLAIMED_DIR=1
      if ! openclaw_heavy_local_slot_after_mkdir ||
        ! openclaw_heavy_local_slot_write_owner "$owner_path" "$token" "$label" "$policy"; then
        openclaw_heavy_local_slot_release
        openclaw_heavy_local_slot_set_refusal \
          "guard_internal" \
          "owner_publish_failed" \
          "could not publish lease owner metadata" \
          "stage=${OPENCLAW_HEAVY_LOCAL_SLOT_OWNER_PUBLISH_ERROR:-unknown} owner_path=${owner_path}"
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
      openclaw_heavy_local_slot_set_refusal \
        "guard_internal" \
        "owner_metadata_unreadable" \
        "slot has no readable owner metadata at $lock_path"
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
      openclaw_heavy_local_slot_set_refusal \
        "occupied" \
        "live_owner" \
        "slot held by \"${owner_label:-unknown}\" (PID ${owner_pid:-unknown})"
      return 75
    fi
    if [[ "$live_status" -eq 2 || -z "$owner_token" ]]; then
      openclaw_heavy_local_slot_set_refusal \
        "guard_internal" \
        "owner_identity_ambiguous" \
        "slot owner identity is incomplete; refusing unsafe recovery"
      return 75
    fi

    if openclaw_heavy_local_slot_child_group_status "$lock_path"; then
      child_status=0
    else
      child_status=$?
    fi
    if [[ "$child_status" -eq 0 ]]; then
      openclaw_heavy_local_slot_set_refusal \
        "occupied" \
        "orphan_group_live" \
        "dead slot owner still has a live guarded process group"
      return 75
    fi
    if [[ "$child_status" -eq 2 ]]; then
      openclaw_heavy_local_slot_set_refusal \
        "guard_internal" \
        "child_identity_ambiguous" \
        "guarded child identity is incomplete; refusing unsafe recovery"
      return 75
    fi

    if ! openclaw_heavy_local_slot_reclaim_dead_owner \
      "$lock_path" \
      "$owner_token" \
      "$owner_pid" \
      "$owner_start"; then
      openclaw_heavy_local_slot_set_refusal \
        "occupied" \
        "recovery_in_progress" \
        "stale-slot recovery is already active or ownership changed"
      return 75
    fi
  done
}

openclaw_heavy_local_slot_inherited_lease_is_valid() {
  local required_policy="${1:-standard}"
  local inherited_token="${OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN:-}"
  local lock_path="" owner_path=""
  local owner_pid="" owner_token="" owner_start="" owner_policy=""

  [[ "$inherited_token" =~ ^[0-9a-fA-F]{64}$ ]] || return 1
  lock_path="$(openclaw_heavy_local_slot_resolve_path)" || return 1
  owner_path="$lock_path/owner"
  [[ -f "$owner_path" ]] || return 1

  owner_pid="$(openclaw_heavy_local_slot_value "$owner_path" pid)"
  owner_token="$(openclaw_heavy_local_slot_value "$owner_path" token)"
  owner_start="$(openclaw_heavy_local_slot_value "$owner_path" process_start)"
  owner_policy="$(openclaw_heavy_local_slot_value "$owner_path" policy)"
  [[ "$owner_token" == "$inherited_token" ]] || return 1

  # Standard nested work can safely run inside either stricter transaction.
  # Lifecycle and remediation work cannot inherit a standard lease: its health
  # monitor is allowed to kill the tree while the protected listener is being
  # replaced. They also cannot inherit one another because each policy admits
  # a different, narrowly validated mutation command.
  if [[ "$required_policy" != "standard" && "$owner_policy" != "$required_policy" ]]; then
    return 1
  fi
  openclaw_heavy_local_slot_process_descends_from_owner "$$" "$owner_pid" "$owner_start"
}

openclaw_heavy_local_slot_require_or_reexec_with_policy() {
  local policy="$1"
  local label="$2"
  local root="$3"
  local entrypoint="$4"
  shift 4

  case "$policy" in
    standard | gateway-lifecycle | jarvis-remediation)
      ;;
    *)
      printf 'HEAVY_LOCAL_SLOT_REFUSAL class=guard_internal code=unknown_policy\n' >&2
      echo "Refusing heavy work: unknown admission policy '$policy'." >&2
      return 75
      ;;
  esac

  if openclaw_heavy_local_slot_inherited_lease_is_valid "$policy"; then
    return 0
  fi

  # exec keeps one supervision boundary and preserves the eventual child exit
  # status. The wrapper replaces any forged/stale token with a fresh capability;
  # the re-executed entrypoint then validates that live metadata and proceeds.
  if [[ "$policy" == "standard" ]]; then
    exec "$root/scripts/with-heavy-local-slot.sh" \
      --label "$label" \
      -- \
      "$entrypoint" "$@"
  fi

  exec "$root/scripts/with-heavy-local-slot.sh" \
    --policy "$policy" \
    --label "$label" \
    -- \
    "$entrypoint" "$@"
}

openclaw_heavy_local_slot_require_or_reexec() {
  openclaw_heavy_local_slot_require_or_reexec_with_policy "standard" "$@"
}
