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

write_fake_latest_release_gh() {
  local fake_bin="$1"
  local mode="$2"
  local tag="${3:-v-current}"
  mkdir -p "$fake_bin"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'if [[ "$1" == "release" && "$2" == "view" ]]; then\n'
    case "$mode" in
      success)
        printf '  printf '"'"'{"tagName":"%s"}\\n'"'"'\n' "$tag"
        printf '  exit 0\n'
        ;;
      empty)
        printf '  printf '"'"'{}\\n'"'"'\n'
        printf '  exit 0\n'
        ;;
      fail)
        printf '  echo "HTTP 404 release not found" >&2\n'
        printf '  exit 4\n'
        ;;
      *)
        fail "unknown fake gh mode: $mode"
        ;;
    esac
    printf 'fi\n'
    printf 'echo "unexpected gh invocation: $*" >&2\n'
    printf 'exit 99\n'
  } >"$fake_bin/gh"
  chmod +x "$fake_bin/gh"
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
  assert_eq "p2 dmg submission without local assets selects local assets" "$(jarvis_release_next_phase "$root" 0 0 "Jarvis" 1)" "create-local-release-assets-only"

  root="$(make_state_root dmg-submitted-assets-ready)"
  mkdir -p "$root/dist/Jarvis.app"
  : >"$root/dist/Jarvis.dmg"
  : >"$root/dist/Jarvis.zip"
  : >"$root/dist/jarvis-appcast.xml"
  write_manifest_status "$root" "Accepted" ""
  write_receipt "$(jarvis_release_dmg_notary_receipt_path "$root")" "dmg-submission"
  assert_eq "p2 dmg submission with local assets selects poll dmg" "$(jarvis_release_next_phase "$root" 0 0 "Jarvis" 1)" "poll-dmg-notarization"

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
  local verify_root="$TMP_DIR/wrapper-verify-assets"
  local verify_out="$TMP_DIR/wrapper-verify-assets.out"
  local verify_err="$TMP_DIR/wrapper-verify-assets.err"
  local verify_summary="$TMP_DIR/wrapper-verify-summary.env"
  local verify_timing="$TMP_DIR/wrapper-verify-timing.tsv"
  local stale_publish_root="$TMP_DIR/wrapper-stale-publish-assets"
  local stale_publish_out="$TMP_DIR/wrapper-stale-publish-assets.out"
  local latest_publish_root="$TMP_DIR/wrapper-latest-publish-assets"
  local latest_publish_out="$TMP_DIR/wrapper-latest-publish-assets.out"
  local latest_verify_root="$TMP_DIR/wrapper-latest-verify-assets"
  local latest_verify_out="$TMP_DIR/wrapper-latest-verify-assets.out"
  local latest_fake_bin="$TMP_DIR/fake-latest-gh"
  local latest_conflict_err="$TMP_DIR/wrapper-latest-conflict.err"
  local missing_gh_err="$TMP_DIR/wrapper-missing-gh.err"
  local lookup_fail_err="$TMP_DIR/wrapper-latest-lookup-fail.err"
  local empty_tag_err="$TMP_DIR/wrapper-latest-empty-tag.err"
  local p2_asset_root="$TMP_DIR/wrapper-p2-local-assets"
  local p2_asset_out="$TMP_DIR/wrapper-p2-local-assets.out"
  local p2_poll_root="$TMP_DIR/wrapper-p2-poll-dmg"
  local p2_poll_out="$TMP_DIR/wrapper-p2-poll-dmg.out"
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

  mkdir -p "$p2_asset_root/dist/Jarvis.app"
  : >"$p2_asset_root/dist/Jarvis.dmg"
  write_manifest_status "$p2_asset_root" "Accepted" ""
  write_receipt "$(jarvis_release_dmg_notary_receipt_path "$p2_asset_root")" "dmg-submission"

  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$p2_asset_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --dry-run \
      --parallel-safe-local-assets \
      >"$p2_asset_out"
  if ! grep -q 'selected_phase=create-local-release-assets-only' "$p2_asset_out"; then
    cat "$p2_asset_out" >&2
    fail "wrapper p2 dry run did not choose local assets while dmg is pending"
  fi
  if ! grep -q 'parallel_safe_local_assets=1' "$p2_asset_out"; then
    cat "$p2_asset_out" >&2
    fail "wrapper p2 dry run did not report enabled safe local assets mode"
  fi
  if ! grep -q -- 'required_before_execute=--github-release-tag <latest-tag>' "$p2_asset_out"; then
    cat "$p2_asset_out" >&2
    fail "wrapper p2 local asset dry run did not report required github release tag"
  fi
  pass "wrapper p2 local assets dry run"

  mkdir -p "$p2_poll_root/dist/Jarvis.app"
  : >"$p2_poll_root/dist/Jarvis.dmg"
  : >"$p2_poll_root/dist/Jarvis.zip"
  : >"$p2_poll_root/dist/jarvis-appcast.xml"
  write_manifest_status "$p2_poll_root" "Accepted" ""
  write_receipt "$(jarvis_release_dmg_notary_receipt_path "$p2_poll_root")" "dmg-submission"

  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$p2_poll_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --dry-run \
      --parallel-safe-local-assets \
      >"$p2_poll_out"
  if ! grep -q 'selected_phase=poll-dmg-notarization' "$p2_poll_out"; then
    cat "$p2_poll_out" >&2
    fail "wrapper p2 dry run did not return to dmg polling after local assets existed"
  fi
  pass "wrapper p2 resumes dmg polling after local assets"

  mkdir -p "$asset_root/dist/Jarvis.app"
  : >"$asset_root/dist/Jarvis.dmg"
  write_manifest_status "$asset_root" "Accepted" "Accepted"

  set +e
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$asset_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" --dry-run >"$asset_out" 2>"$asset_err"
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    cat "$asset_err" >&2
    fail "wrapper local asset dry run should inspect state without github release tag"
  fi
  if ! grep -q -- 'required_before_execute=--github-release-tag <latest-tag>' "$asset_out"; then
    cat "$asset_out" >&2
    fail "wrapper local asset dry run did not report required github release tag"
  fi
  pass "wrapper local assets dry run reports required tag"

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

  mkdir -p "$verify_root/dist/Jarvis.app"
  : >"$verify_root/dist/Jarvis.dmg"
  : >"$verify_root/dist/Jarvis.zip"
  : >"$verify_root/dist/jarvis-appcast.xml"
  write_manifest_status "$verify_root" "Accepted" "Accepted"

  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$verify_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" --dry-run --verify-public-assets >"$verify_out"
  if ! grep -q 'selected_phase=verify-public-assets-only' "$verify_out"; then
    cat "$verify_out" >&2
    fail "wrapper verify dry run selected wrong phase"
  fi
  if ! grep -q -- 'required_before_execute=--github-release-tag <latest-tag>' "$verify_out"; then
    cat "$verify_out" >&2
    fail "wrapper verify dry run did not report required github release tag"
  fi
  pass "wrapper verify dry run reports required tag"

  set +e
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$verify_root" \
  OPENCLAW_JARVIS_PUBLIC_RELEASE_SUMMARY="$verify_summary" \
  OPENCLAW_JARVIS_RELEASE_TIMING_REPORT="$verify_timing" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" --verify-public-assets >"$verify_out" 2>"$verify_err"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    cat "$verify_out" >&2
    fail "wrapper public verification should require github release tag"
  fi
  if ! grep -q -- 'verify-public-assets-only requires --github-release-tag' "$verify_err"; then
    cat "$verify_err" >&2
    fail "wrapper verify tag failure did not mention --github-release-tag"
  fi
  if ! grep -q 'JARVIS_PUBLIC_RELEASE_STATUS=2' "$verify_summary"; then
    cat "$verify_summary" >&2
    fail "wrapper verify tag failure did not write durable failure summary"
  fi
  if [[ ! -f "$verify_timing" ]] \
    || ! grep -q $'phase\tlabel\tstatus\tstarted_ms\tfinished_ms\telapsed_ms' "$verify_timing"; then
    [[ -f "$verify_timing" ]] && cat "$verify_timing" >&2
    fail "wrapper verify tag failure did not initialize timing report"
  fi
  pass "wrapper verify execution requires tag"

  mkdir -p "$stale_publish_root/dist/Jarvis.app"
  : >"$stale_publish_root/dist/Jarvis.dmg"
  : >"$stale_publish_root/dist/Jarvis.zip"
  printf '<rss><channel><item><enclosure url="https://github.com/artemgetmann/openclaw/releases/latest/download/Jarvis.zip"/></item></channel></rss>\n' \
    >"$stale_publish_root/dist/jarvis-appcast.xml"
  write_manifest_status "$stale_publish_root" "Accepted" "Accepted"

  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$stale_publish_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --dry-run \
      --publish-release-assets \
      --github-release-tag v-current \
      >"$stale_publish_out"
  if ! grep -q 'selected_phase=create-local-release-assets-only' "$stale_publish_out"; then
    cat "$stale_publish_out" >&2
    fail "wrapper stale appcast publish dry run did not choose local asset regeneration"
  fi
  pass "wrapper stale publish appcast regenerates local assets first"

  mkdir -p "$latest_publish_root/dist/Jarvis.app"
  : >"$latest_publish_root/dist/Jarvis.dmg"
  : >"$latest_publish_root/dist/Jarvis.zip"
  printf '<rss><channel><item><enclosure url="https://github.com/artemgetmann/openclaw/releases/download/v-current/Jarvis.zip"/></item></channel></rss>\n' \
    >"$latest_publish_root/dist/jarvis-appcast.xml"
  write_manifest_status "$latest_publish_root" "Accepted" "Accepted"
  write_fake_latest_release_gh "$latest_fake_bin" success v-current

  PATH="$latest_fake_bin:$PATH" \
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$latest_publish_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --dry-run \
      --publish-release-assets \
      --latest-release-tag \
      >"$latest_publish_out"
  if ! grep -q 'selected_phase=publish-assets-only' "$latest_publish_out"; then
    cat "$latest_publish_out" >&2
    fail "wrapper latest publish dry run selected wrong phase"
  fi
  if ! grep -q 'resolved_github_release_tag=v-current' "$latest_publish_out"; then
    cat "$latest_publish_out" >&2
    fail "wrapper latest publish dry run did not print resolved tag"
  fi
  if ! grep -q -- '--github-release-tag v-current' "$latest_publish_out"; then
    cat "$latest_publish_out" >&2
    fail "wrapper latest publish dry run did not forward resolved tag"
  fi
  pass "wrapper latest publish dry run resolves tag"

  mkdir -p "$latest_verify_root/dist/Jarvis.app"
  : >"$latest_verify_root/dist/Jarvis.dmg"
  : >"$latest_verify_root/dist/Jarvis.zip"
  : >"$latest_verify_root/dist/jarvis-appcast.xml"
  write_manifest_status "$latest_verify_root" "Accepted" "Accepted"

  PATH="$latest_fake_bin:$PATH" \
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$latest_verify_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --dry-run \
      --verify-public-assets \
      --latest-release-tag \
      >"$latest_verify_out"
  if ! grep -q 'selected_phase=verify-public-assets-only' "$latest_verify_out"; then
    cat "$latest_verify_out" >&2
    fail "wrapper latest verify dry run selected wrong phase"
  fi
  if ! grep -q -- '--github-release-tag v-current' "$latest_verify_out"; then
    cat "$latest_verify_out" >&2
    fail "wrapper latest verify dry run did not forward resolved tag"
  fi
  pass "wrapper latest verify dry run resolves tag"

  set +e
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$latest_verify_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --dry-run \
      --latest-release-tag \
      --github-release-tag v-manual \
      >"$verify_out" 2>"$latest_conflict_err"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    cat "$verify_out" >&2
    fail "wrapper should reject latest tag plus explicit github release tag"
  fi
  if ! grep -q 'choose --latest-release-tag or --github-release-tag' "$latest_conflict_err"; then
    cat "$latest_conflict_err" >&2
    fail "wrapper latest conflict failure did not explain ambiguity"
  fi
  pass "wrapper latest tag rejects explicit tag conflict"

  set +e
  PATH="$TMP_DIR/no-gh:/usr/bin:/bin" \
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$latest_verify_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --dry-run \
      --latest-release-tag \
      >"$verify_out" 2>"$missing_gh_err"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    cat "$verify_out" >&2
    fail "wrapper latest tag should fail when gh is missing"
  fi
  if ! grep -q 'requires the GitHub CLI (gh)' "$missing_gh_err"; then
    cat "$missing_gh_err" >&2
    fail "wrapper missing gh failure did not explain dependency"
  fi
  pass "wrapper latest tag requires gh"

  write_fake_latest_release_gh "$TMP_DIR/fake-failing-gh" fail
  set +e
  PATH="$TMP_DIR/fake-failing-gh:$PATH" \
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$latest_verify_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --dry-run \
      --latest-release-tag \
      >"$verify_out" 2>"$lookup_fail_err"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    cat "$verify_out" >&2
    fail "wrapper latest tag should fail when gh lookup fails"
  fi
  if ! grep -q 'could not resolve the latest GitHub release tag' "$lookup_fail_err"; then
    cat "$lookup_fail_err" >&2
    fail "wrapper gh lookup failure did not explain tag resolution failure"
  fi
  pass "wrapper latest tag reports gh lookup failure"

  write_fake_latest_release_gh "$TMP_DIR/fake-empty-gh" empty
  set +e
  PATH="$TMP_DIR/fake-empty-gh:$PATH" \
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$latest_verify_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --dry-run \
      --latest-release-tag \
      >"$verify_out" 2>"$empty_tag_err"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    cat "$verify_out" >&2
    fail "wrapper latest tag should fail when gh returns no tag"
  fi
  if ! grep -q 'no latest GitHub release tag found' "$empty_tag_err"; then
    cat "$empty_tag_err" >&2
    fail "wrapper empty tag failure did not mention missing release tag"
  fi
  pass "wrapper latest tag reports empty tag"
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
