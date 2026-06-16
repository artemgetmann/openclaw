#!/usr/bin/env bash

# Shared helpers for the Jarvis public release wrapper and release script.
# Keep this file side-effect free: callers source it in real release lanes, so
# helper functions must inspect receipts, classify failures, or wrap commands
# without mutating artifacts unless the caller explicitly asks.

jarvis_release_receipt_value() {
  local receipt_path="$1"
  local key="$2"

  if [[ ! -f "$receipt_path" ]]; then
    printf '%s\n' ""
    return 0
  fi

  # Receipts and manifests are operator metadata, not trusted shell input.
  # Parse just the requested key instead of sourcing the file.
  /usr/bin/sed -n "s/^${key}=//p" "$receipt_path" | /usr/bin/head -n 1
}

jarvis_release_manifest_path() {
  local root_dir="$1"
  printf '%s\n' "${OPENCLAW_JARVIS_RELEASE_MANIFEST:-$root_dir/dist/jarvis-release-manifest.env}"
}

jarvis_release_app_build_receipt_path() {
  local root_dir="$1"
  local app_name="${2:-Jarvis}"
  printf '%s\n' "${OPENCLAW_CONSUMER_APP_BUILD_RECEIPT:-$root_dir/dist/${app_name}.app.release.env}"
}

jarvis_release_app_notary_receipt_path() {
  local root_dir="$1"
  local app_name="${2:-Jarvis}"
  printf '%s\n' "$root_dir/dist/${app_name}.app.notary.env"
}

jarvis_release_dmg_notary_receipt_path() {
  local root_dir="$1"
  local app_name="${2:-Jarvis}"
  printf '%s\n' "$root_dir/dist/${app_name}.dmg.notary.env"
}

jarvis_release_status_from_receipt_or_manifest() {
  local receipt_path="$1"
  local manifest_path="$2"
  local manifest_key="$3"
  local status

  status="$(jarvis_release_receipt_value "$receipt_path" "NOTARY_STATUS")"
  if [[ -n "$status" ]]; then
    printf '%s\n' "$status"
    return 0
  fi

  jarvis_release_receipt_value "$manifest_path" "$manifest_key"
}

jarvis_release_submission_from_receipt_or_manifest() {
  local receipt_path="$1"
  local manifest_path="$2"
  local manifest_key="$3"
  local submission_id

  submission_id="$(jarvis_release_receipt_value "$receipt_path" "NOTARY_SUBMISSION_ID")"
  if [[ -n "$submission_id" ]]; then
    printf '%s\n' "$submission_id"
    return 0
  fi

  jarvis_release_receipt_value "$manifest_path" "$manifest_key"
}

jarvis_release_next_phase() {
  local root_dir="$1"
  local publish_requested="${2:-0}"
  local verify_public_requested="${3:-0}"
  local app_name="${4:-Jarvis}"
  local parallel_safe_local_assets="${5:-0}"
  local app_path="$root_dir/dist/${app_name}.app"
  local dmg_path="$root_dir/dist/${app_name}.dmg"
  local zip_path="$root_dir/dist/${app_name}.zip"
  local appcast_path="$root_dir/dist/jarvis-appcast.xml"
  local manifest_path
  local app_notary_receipt
  local dmg_notary_receipt
  local app_notary_status
  local dmg_notary_status
  local app_submission_id
  local dmg_submission_id

  manifest_path="$(jarvis_release_manifest_path "$root_dir")"
  app_notary_receipt="$(jarvis_release_app_notary_receipt_path "$root_dir" "$app_name")"
  dmg_notary_receipt="$(jarvis_release_dmg_notary_receipt_path "$root_dir" "$app_name")"

  if [[ ! -d "$app_path" ]]; then
    printf '%s\n' "full"
    return 0
  fi

  app_notary_status="$(
    jarvis_release_status_from_receipt_or_manifest \
      "$app_notary_receipt" "$manifest_path" "JARVIS_APP_NOTARY_STATUS"
  )"
  app_submission_id="$(
    jarvis_release_submission_from_receipt_or_manifest \
      "$app_notary_receipt" "$manifest_path" "JARVIS_APP_NOTARY_SUBMISSION_ID"
  )"
  if [[ "$app_notary_status" != "Accepted" ]]; then
    if [[ -n "$app_submission_id" ]]; then
      printf '%s\n' "poll-app-notarization"
    else
      printf '%s\n' "submit-app-notarization"
    fi
    return 0
  fi

  dmg_notary_status="$(
    jarvis_release_status_from_receipt_or_manifest \
      "$dmg_notary_receipt" "$manifest_path" "JARVIS_DMG_NOTARY_STATUS"
  )"
  dmg_submission_id="$(
    jarvis_release_submission_from_receipt_or_manifest \
      "$dmg_notary_receipt" "$manifest_path" "JARVIS_DMG_NOTARY_SUBMISSION_ID"
  )"
  if [[ "$dmg_notary_status" != "Accepted" ]]; then
    if [[ -n "$dmg_submission_id" && -f "$dmg_path" ]]; then
      # P2 only overlaps independent local work. The submitted DMG keeps its
      # own resumable polling path, while the Sparkle ZIP/appcast can be
      # generated from the already accepted app bundle without weakening the
      # later publish gate.
      if [[ "$parallel_safe_local_assets" == "1" && ( ! -f "$zip_path" || ! -f "$appcast_path" ) ]]; then
        printf '%s\n' "create-local-release-assets-only"
        return 0
      fi
      printf '%s\n' "poll-dmg-notarization"
    else
      printf '%s\n' "submit-dmg-notarization"
    fi
    return 0
  fi

  if [[ ! -f "$dmg_path" ]]; then
    printf '%s\n' "submit-dmg-notarization"
    return 0
  fi

  if [[ ! -f "$zip_path" || ! -f "$appcast_path" ]]; then
    printf '%s\n' "create-local-release-assets-only"
    return 0
  fi

  if [[ "$verify_public_requested" == "1" ]]; then
    printf '%s\n' "verify-public-assets-only"
    return 0
  fi

  if [[ "$publish_requested" == "1" ]]; then
    printf '%s\n' "publish-assets-only"
    return 0
  fi

  printf '%s\n' "ready-local-assets"
}

jarvis_release_failure_is_transient() {
  local output
  output="$(printf '%s\n' "$*" | /usr/bin/tr '[:upper:]' '[:lower:]')"

  case "$output" in
    *"not authenticated"*|*"authentication failed"*|*"unauthorized"*|*"http 401"*|*"permission denied"*|*"forbidden"*|*"http 403"*|*"not found"*|*"http 404"*|*"release not found"*|*"could not resolve to a repository"*|*"must match the latest release"*|*"validation failed"*)
      return 1
      ;;
  esac

  case "$output" in
    *"timeout"*|*"timed out"*|*"deadline exceeded"*|*"connection reset"*|*"connection refused"*|*"connection timed out"*|*"temporary failure"*|*"temporarily unavailable"*|*"unexpected eof"*|*" eof"*|*"http 500"*|*"http 502"*|*"http 503"*|*"http 504"*|*"502 bad gateway"*|*"503 service unavailable"*|*"504 gateway timeout"*|*"service unavailable"*|*"gateway timeout"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

jarvis_release_retry_attempts() {
  local attempts="${OPENCLAW_GITHUB_RELEASE_RETRY_ATTEMPTS:-3}"
  case "$attempts" in
    ''|*[!0-9]*) attempts=3 ;;
  esac
  if [[ "$attempts" -lt 1 ]]; then
    attempts=1
  fi
  printf '%s\n' "$attempts"
}

jarvis_release_retry_sleep_seconds() {
  local attempt="$1"
  local base_sleep="${OPENCLAW_GITHUB_RELEASE_RETRY_SLEEP_SECS:-5}"
  case "$base_sleep" in
    ''|*[!0-9]*) base_sleep=5 ;;
  esac
  printf '%s\n' "$((base_sleep * attempt))"
}

jarvis_release_retry() {
  local label="$1"
  shift

  local max_attempts
  local attempt=1
  local status=0
  local output=""
  local sleep_secs
  max_attempts="$(jarvis_release_retry_attempts)"

  while true; do
    set +e
    output="$("$@" 2>&1)"
    status=$?
    set -e

    if [[ "$status" -eq 0 ]]; then
      printf '%s\n' "$output"
      return 0
    fi

    printf '%s\n' "$output" >&2
    if [[ "$attempt" -ge "$max_attempts" ]] || ! jarvis_release_failure_is_transient "$output"; then
      echo "ERROR: $label failed without a retryable GitHub/public-release error (attempt $attempt/$max_attempts)." >&2
      return "$status"
    fi

    sleep_secs="$(jarvis_release_retry_sleep_seconds "$attempt")"
    echo "WARN: $label hit a transient release error; retrying attempt $((attempt + 1))/$max_attempts after ${sleep_secs}s." >&2
    sleep "$sleep_secs"
    attempt=$((attempt + 1))
  done
}

jarvis_release_size_bytes() {
  local path="$1"

  if [[ ! -e "$path" ]]; then
    printf '%s\n' ""
    return 0
  fi

  if [[ -f "$path" ]]; then
    /usr/bin/stat -f%z "$path" 2>/dev/null || /usr/bin/stat -c%s "$path" 2>/dev/null || printf '%s\n' ""
    return 0
  fi

  local kib
  kib="$(du -sk "$path" 2>/dev/null | /usr/bin/awk '{ print $1 }')"
  if [[ -z "$kib" ]]; then
    printf '%s\n' ""
    return 0
  fi
  printf '%s\n' "$((kib * 1024))"
}
