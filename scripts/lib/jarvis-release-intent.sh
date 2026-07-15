#!/usr/bin/env bash

# Short-lived operator authorization for public Jarvis release work. The
# durable record is independent of the invoking shell process: authorizer
# death cannot invalidate a completed authorization or make a queued stale
# process current again.

OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE=""

openclaw_jarvis_release_intent_value() {
  local metadata_path="$1"
  local key="$2"
  /usr/bin/sed -n "s/^${key}=//p" "$metadata_path" 2>/dev/null | /usr/bin/head -n 1
}

openclaw_jarvis_release_intent_repo_identity() {
  local root="$1"
  local common_dir common_physical

  common_dir="$(git -C "$root" rev-parse --git-common-dir 2>/dev/null)" || return 1
  [[ "$common_dir" == /* ]] || common_dir="$root/$common_dir"
  common_physical="$(cd "$common_dir" && pwd -P)" || return 1
  printf '%s' "$common_physical" | /usr/bin/cksum | /usr/bin/awk '{ print $1 "-" $2 }'
}

openclaw_jarvis_release_intent_default_path() {
  local root="$1"
  local identity
  identity="$(openclaw_jarvis_release_intent_repo_identity "$root")" || return 1

  # Use a fixed user-specific base. TMPDIR differs across launchd, automation,
  # and interactive shells, while all worktrees of one repository must observe
  # the same latest authorization.
  printf '/tmp/openclaw-jarvis-release-intents-%s/%s.intent\n' "$(id -u)" "$identity"
}

openclaw_jarvis_release_intent_path() {
  local root="$1"
  printf '%s\n' "${OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE:-$(openclaw_jarvis_release_intent_default_path "$root")}"
}

openclaw_jarvis_release_intent_now_epoch() {
  if [[ -n "${OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH:-}" ]]; then
    printf '%s\n' "$OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH"
    return 0
  fi
  date -u '+%s'
}

openclaw_jarvis_release_intent_new_id() {
  if [[ -n "${OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE:-}" ]]; then
    printf '%s\n' "$OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE"
    return 0
  fi
  /usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]'
}

openclaw_jarvis_release_intent_authorize() {
  local root="$1"
  local ttl_seconds="${2:-900}"
  local intent_path intent_parent intent_tmp intent_id repo_identity commit now expires

  case "$ttl_seconds" in
    ''|*[!0-9]*)
      echo "ERROR: release intent TTL must be a positive integer number of seconds." >&2
      return 1
      ;;
  esac
  if [[ "$ttl_seconds" -lt 1 || "$ttl_seconds" -gt 3600 ]]; then
    echo "ERROR: release intent TTL must be between 1 and 3600 seconds." >&2
    return 1
  fi

  intent_path="$(openclaw_jarvis_release_intent_path "$root")" || return 1
  intent_parent="$(dirname "$intent_path")"
  intent_id="$(openclaw_jarvis_release_intent_new_id)" || return 1
  repo_identity="$(openclaw_jarvis_release_intent_repo_identity "$root")" || return 1
  commit="$(git -C "$root" rev-parse HEAD 2>/dev/null)" || return 1
  now="$(openclaw_jarvis_release_intent_now_epoch)"
  expires=$((now + ttl_seconds))
  intent_tmp="${intent_path}.tmp.${intent_id}"

  # Each authorizer writes a private complete record and atomically replaces
  # the public record. Concurrent authorizers therefore have a single winner:
  # whichever completed replacement last is the only executable intent.
  (umask 077 && mkdir -p "$intent_parent" && chmod 700 "$intent_parent")
  {
    printf 'JARVIS_RELEASE_INTENT_VERSION=1\n'
    printf 'JARVIS_RELEASE_INTENT_ID=%s\n' "$intent_id"
    printf 'JARVIS_RELEASE_INTENT_REPO_IDENTITY=%s\n' "$repo_identity"
    printf 'JARVIS_RELEASE_INTENT_GIT_COMMIT=%s\n' "$commit"
    printf 'JARVIS_RELEASE_INTENT_AUTHORIZED_AT_EPOCH=%s\n' "$now"
    printf 'JARVIS_RELEASE_INTENT_EXPIRES_AT_EPOCH=%s\n' "$expires"
  } >"$intent_tmp"
  chmod 600 "$intent_tmp"
  mv -f "$intent_tmp" "$intent_path"

  printf '%s\n' "$intent_id"
}

openclaw_jarvis_release_intent_validate() {
  local root="$1"
  local expected_intent_id="$2"
  local intent_path version actual_intent_id actual_identity expected_identity
  local actual_commit expected_commit authorized_at expires now

  OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE=""
  if [[ -z "$expected_intent_id" ]]; then
    OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE="missing"
    return 1
  fi

  intent_path="$(openclaw_jarvis_release_intent_path "$root")" || {
    OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE="path"
    return 1
  }
  if [[ ! -f "$intent_path" ]]; then
    OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE="missing"
    return 1
  fi

  version="$(openclaw_jarvis_release_intent_value "$intent_path" JARVIS_RELEASE_INTENT_VERSION)"
  actual_intent_id="$(openclaw_jarvis_release_intent_value "$intent_path" JARVIS_RELEASE_INTENT_ID)"
  actual_identity="$(openclaw_jarvis_release_intent_value "$intent_path" JARVIS_RELEASE_INTENT_REPO_IDENTITY)"
  actual_commit="$(openclaw_jarvis_release_intent_value "$intent_path" JARVIS_RELEASE_INTENT_GIT_COMMIT)"
  authorized_at="$(openclaw_jarvis_release_intent_value "$intent_path" JARVIS_RELEASE_INTENT_AUTHORIZED_AT_EPOCH)"
  expires="$(openclaw_jarvis_release_intent_value "$intent_path" JARVIS_RELEASE_INTENT_EXPIRES_AT_EPOCH)"

  if [[ "$version" != "1" ]]; then
    OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE="schema"
    return 1
  fi
  if [[ "$actual_intent_id" != "$expected_intent_id" ]]; then
    OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE="replaced"
    return 1
  fi
  case "$authorized_at:$expires" in
    *[!0-9:]*|:*|*:)
      OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE="schema"
      return 1
      ;;
  esac

  expected_identity="$(openclaw_jarvis_release_intent_repo_identity "$root")" || {
    OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE="identity"
    return 1
  }
  expected_commit="$(git -C "$root" rev-parse HEAD 2>/dev/null)" || {
    OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE="commit"
    return 1
  }
  if [[ "$actual_identity" != "$expected_identity" ]]; then
    OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE="identity"
    return 1
  fi
  if [[ "$actual_commit" != "$expected_commit" ]]; then
    OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE="commit"
    return 1
  fi

  now="$(openclaw_jarvis_release_intent_now_epoch)"
  case "$now" in
    ''|*[!0-9]*)
      OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE="clock"
      return 1
      ;;
  esac
  if [[ "$now" -lt "$authorized_at" || "$now" -ge "$expires" ]]; then
    OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE="expired"
    return 1
  fi

  return 0
}

openclaw_require_jarvis_release_intent() {
  local root="$1"
  local intent_id="$2"
  local boundary="${3:-release mutation}"

  if openclaw_jarvis_release_intent_validate "$root" "$intent_id"; then
    echo "jarvis_release_intent=valid"
    echo "jarvis_release_intent_boundary=$boundary"
    return 0
  fi

  echo "ERROR: Jarvis release intent is ${OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE:-invalid}; refusing $boundary." >&2
  echo "Only the latest unexpired authorization for the current commit may mutate release state." >&2
  return 1
}
