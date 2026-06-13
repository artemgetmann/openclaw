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
  local asset_root="$TMP_DIR/wrapper-local-assets"
  local asset_out="$TMP_DIR/wrapper-local-assets.out"
  local asset_err="$TMP_DIR/wrapper-local-assets.err"
  local status

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

  mkdir -p "$asset_root/dist/Jarvis.app"
  : >"$asset_root/dist/Jarvis.dmg"
  write_manifest_status "$asset_root" "Accepted" "Accepted"

  set +e
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$asset_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" --dry-run >"$asset_out" 2>"$asset_err"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    cat "$asset_out" >&2
    fail "wrapper local asset dry run should require github release tag"
  fi
  if ! grep -q -- '--github-release-tag' "$asset_err"; then
    cat "$asset_err" >&2
    fail "wrapper local asset tag failure did not mention --github-release-tag"
  fi
  pass "wrapper local assets require tag"

  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$asset_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" --dry-run --github-release-tag v-test >"$asset_out"
  if ! grep -q 'selected_phase=create-local-release-assets-only' "$asset_out"; then
    cat "$asset_out" >&2
    fail "wrapper tagged local asset dry run selected wrong phase"
  fi
  if ! grep -q -- '--github-release-tag v-test' "$asset_out"; then
    cat "$asset_out" >&2
    fail "wrapper tagged local asset command did not forward github release tag"
  fi
  pass "wrapper local assets forward tag"
}

test_package_create_assets_rejects_stale_tag() {
  local app_name="JarvisTagGuardTest-$$"
  local app_path="$ROOT_DIR/dist/${app_name}.app"
  local fake_bin="$TMP_DIR/fake-bin"
  local manifest="$TMP_DIR/package-tag-guard-manifest.env"
  local out="$TMP_DIR/package-tag-guard.out"
  local err="$TMP_DIR/package-tag-guard.err"
  local status

  mkdir -p "$app_path" "$fake_bin"
  {
    printf 'JARVIS_APP_NOTARY_STATUS=%q\n' "Accepted"
  } >"$manifest"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'if [[ "$1" == "release" && "$2" == "view" ]]; then\n'
    printf '  printf '"'"'{"tagName":"v-current","url":"https://github.com/artemgetmann/openclaw/releases/tag/v-current"}\\n'"'"'\n'
    printf '  exit 0\n'
    printf 'fi\n'
    printf 'echo "unexpected gh invocation: $*" >&2\n'
    printf 'exit 99\n'
  } >"$fake_bin/gh"
  chmod +x "$fake_bin/gh"

  set +e
  PATH="$fake_bin:$PATH" \
  APP_NAME="$app_name" \
  OPENCLAW_JARVIS_RELEASE_MANIFEST="$manifest" \
    bash "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" \
      --phase create-local-release-assets-only \
      --github-release-tag v-stale \
      >"$out" 2>"$err"
  status=$?
  set -e
  rm -rf "$app_path"

  if [[ "$status" -eq 0 ]]; then
    cat "$out" >&2
    fail "package create-local-release-assets-only should reject stale github release tag"
  fi
  if ! grep -q -- '--github-release-tag must match the latest release' "$err"; then
    cat "$err" >&2
    fail "package stale tag failure did not mention latest release requirement"
  fi
  pass "package local appcast assets reject stale tag"
}

test_phase_selection
test_retry_classification
test_wrapper_dry_run
test_package_create_assets_rejects_stale_tag
