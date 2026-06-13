#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/jarvis-release-orchestration.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

assert_eq() {
  local name="$1"
  local actual="$2"
  local expected="$3"

  if [[ "$actual" != "$expected" ]]; then
    fail "$name expected '$expected', got '$actual'"
  fi

  pass "$name"
}

write_manifest_status() {
  local root="$1"
  local app_status="$2"
  local dmg_status="$3"
  mkdir -p "$root/dist"
  {
    printf 'JARVIS_APP_NOTARY_STATUS=%q\n' "$app_status"
    printf 'JARVIS_DMG_NOTARY_STATUS=%q\n' "$dmg_status"
  } >"$(jarvis_release_manifest_path "$root")"
}

write_receipt() {
  local path="$1"
  local submission_id="$2"
  local status="${3:-}"
  mkdir -p "$(dirname "$path")"
  {
    printf 'NOTARY_SUBMISSION_ID=%q\n' "$submission_id"
    if [[ -n "$status" ]]; then
      printf 'NOTARY_STATUS=%q\n' "$status"
    fi
  } >"$path"
}

make_state_root() {
  local name="$1"
  local root="$TMP_DIR/$name"
  mkdir -p "$root/dist"
  printf '%s\n' "$root"
}

test_phase_selection() {
  local root

  root="$(make_state_root missing-app)"
  assert_eq "missing app selects full" "$(jarvis_release_next_phase "$root" 0 0)" "full"

  root="$(make_state_root app-no-notary)"
  mkdir -p "$root/dist/Jarvis.app"
  assert_eq "app without app notary selects submit app" "$(jarvis_release_next_phase "$root" 0 0)" "submit-app-notarization"

  root="$(make_state_root app-submitted)"
  mkdir -p "$root/dist/Jarvis.app"
  write_receipt "$(jarvis_release_app_notary_receipt_path "$root")" "app-submission"
  assert_eq "app submission selects poll app" "$(jarvis_release_next_phase "$root" 0 0)" "poll-app-notarization"

  root="$(make_state_root app-submitted-manifest-only)"
  mkdir -p "$root/dist/Jarvis.app"
  mkdir -p "$root/dist"
  {
    printf 'JARVIS_APP_NOTARY_SUBMISSION_ID=%q\n' "app-submission"
    printf 'JARVIS_APP_NOTARY_STATUS=%q\n' "submitted"
  } >"$(jarvis_release_manifest_path "$root")"
  assert_eq "manifest-only app submission selects poll app" "$(jarvis_release_next_phase "$root" 0 0)" "poll-app-notarization"

  root="$(make_state_root app-accepted)"
  mkdir -p "$root/dist/Jarvis.app"
  write_manifest_status "$root" "Accepted" ""
  assert_eq "accepted app selects submit dmg" "$(jarvis_release_next_phase "$root" 0 0)" "submit-dmg-notarization"

  root="$(make_state_root dmg-submitted)"
  mkdir -p "$root/dist/Jarvis.app"
  : >"$root/dist/Jarvis.dmg"
  write_manifest_status "$root" "Accepted" ""
  write_receipt "$(jarvis_release_dmg_notary_receipt_path "$root")" "dmg-submission"
  assert_eq "dmg submission selects poll dmg" "$(jarvis_release_next_phase "$root" 0 0)" "poll-dmg-notarization"

  root="$(make_state_root dmg-submitted-manifest-only)"
  mkdir -p "$root/dist/Jarvis.app"
  : >"$root/dist/Jarvis.dmg"
  {
    printf 'JARVIS_APP_NOTARY_STATUS=%q\n' "Accepted"
    printf 'JARVIS_DMG_NOTARY_SUBMISSION_ID=%q\n' "dmg-submission"
    printf 'JARVIS_DMG_NOTARY_STATUS=%q\n' "submitted"
  } >"$(jarvis_release_manifest_path "$root")"
  assert_eq "manifest-only dmg submission with dmg selects poll dmg" "$(jarvis_release_next_phase "$root" 0 0)" "poll-dmg-notarization"

  root="$(make_state_root dmg-submitted-manifest-only-missing-dmg)"
  mkdir -p "$root/dist/Jarvis.app"
  {
    printf 'JARVIS_APP_NOTARY_STATUS=%q\n' "Accepted"
    printf 'JARVIS_DMG_NOTARY_SUBMISSION_ID=%q\n' "dmg-submission"
    printf 'JARVIS_DMG_NOTARY_STATUS=%q\n' "submitted"
  } >"$(jarvis_release_manifest_path "$root")"
  assert_eq "manifest-only dmg submission without dmg selects submit dmg" "$(jarvis_release_next_phase "$root" 0 0)" "submit-dmg-notarization"

  root="$(make_state_root accepted-no-assets)"
  mkdir -p "$root/dist/Jarvis.app"
  : >"$root/dist/Jarvis.dmg"
  write_manifest_status "$root" "Accepted" "Accepted"
  assert_eq "accepted notarization without zip appcast selects local assets" "$(jarvis_release_next_phase "$root" 0 0)" "create-local-release-assets-only"

  root="$(make_state_root assets-ready)"
  mkdir -p "$root/dist/Jarvis.app"
  : >"$root/dist/Jarvis.dmg"
  : >"$root/dist/Jarvis.zip"
  : >"$root/dist/jarvis-appcast.xml"
  write_manifest_status "$root" "Accepted" "Accepted"
  assert_eq "ready assets without public action stops" "$(jarvis_release_next_phase "$root" 0 0)" "ready-local-assets"
  assert_eq "ready assets with publish selects publish" "$(jarvis_release_next_phase "$root" 1 0)" "publish-assets-only"
  assert_eq "ready assets with public verify selects verify" "$(jarvis_release_next_phase "$root" 0 1)" "verify-public-assets-only"
}

test_retry_classification() {
  jarvis_release_failure_is_transient "HTTP 503 Service Unavailable" || fail "503 should be retryable"
  jarvis_release_failure_is_transient "connection reset by peer" || fail "connection reset should be retryable"
  if jarvis_release_failure_is_transient "HTTP 404 release not found"; then
    fail "404 release not found should not retry"
  fi
  if jarvis_release_failure_is_transient "GitHub CLI is not authenticated"; then
    fail "auth failure should not retry"
  fi
  if jarvis_release_failure_is_transient "must match the latest release"; then
    fail "wrong latest tag should not retry"
  fi
  pass "retry classification"
}

test_wrapper_dry_run() {
  local root="$TMP_DIR/wrapper-dry-run"
  local out="$TMP_DIR/wrapper-dry-run.out"

  mkdir -p "$root/dist/Jarvis.app"
  write_receipt "$(jarvis_release_app_notary_receipt_path "$root")" "app-submission"

  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" --dry-run >"$out"

  if ! grep -q 'selected_phase=poll-app-notarization' "$out"; then
    cat "$out" >&2
    fail "wrapper dry run did not select poll-app-notarization"
  fi
  if ! grep -q 'dry_run=true' "$out"; then
    cat "$out" >&2
    fail "wrapper dry run did not stay dry"
  fi
  pass "wrapper dry run synthetic state"
}

test_phase_selection
test_retry_classification
test_wrapper_dry_run
