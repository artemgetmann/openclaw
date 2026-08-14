#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/jarvis-release-orchestration.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-checkpoint.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-intent.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-assets.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

write_release_control_stub() {
  local path="$1"
  local content="$2"
  printf '%s\n' "$content" >"$path"
  chmod +x "$path"
}

setup_checkpoint_stubs() {
  local bin_dir="$TMP_DIR/checkpoint-bin"
  mkdir -p "$bin_dir"
  write_release_control_stub "$bin_dir/plistbuddy" '#!/usr/bin/env bash
case "$2" in
  "Print CFBundleShortVersionString") echo 2026.7.15 ;;
  "Print CFBundleVersion") echo 1179 ;;
  "Print OpenClawGitCommit") git -C "${CHECKPOINT_TEST_GIT_ROOT:?}" rev-parse HEAD ;;
  *) exit 1 ;;
esac'
  write_release_control_stub "$bin_dir/codesign" '#!/usr/bin/env bash
if [[ "$1" == "-dv" ]]; then
  echo "CDHash=1111111111111111111111111111111111111111" >&2
fi
exit 0'
  write_release_control_stub "$bin_dir/success" '#!/usr/bin/env bash
exit 0'
  export CHECKPOINT_TEST_GIT_ROOT="$ROOT_DIR"
  export OPENCLAW_JARVIS_RELEASE_CHECKPOINT_PLISTBUDDY="$bin_dir/plistbuddy"
  export OPENCLAW_JARVIS_RELEASE_CHECKPOINT_CODESIGN_BIN="$bin_dir/codesign"
  export OPENCLAW_JARVIS_RELEASE_CHECKPOINT_XCRUN_BIN="$bin_dir/success"
  export OPENCLAW_JARVIS_RELEASE_CHECKPOINT_SPCTL_BIN="$bin_dir/success"
  export OPENCLAW_RELEASE_ENV_FILE=0
}

setup_release_intent() {
  export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$TMP_DIR/orchestration.intent"
  TEST_RELEASE_INTENT_ID="$(openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 3600)"
  export TEST_RELEASE_INTENT_ID
}

seed_wrapper_checkpoints() {
  local root="$1"
  local app_state="$2"
  local dmg_state="${3:-none}"
  local assets="${4:-0}"
  local app="$root/dist/Jarvis.app"
  local dmg="$root/dist/Jarvis.dmg"
  local app_receipt="$root/dist/Jarvis.app.notary.env"
  local dmg_receipt="$root/dist/Jarvis.dmg.notary.env"
  local app_absolute dmg_absolute

  mkdir -p "$app/Contents/_CodeSignature"
  printf 'sealed app fixture\n' >"$app/Contents/_CodeSignature/CodeResources"
  printf 'stub plist\n' >"$app/Contents/Info.plist"
  app_absolute="$(openclaw_jarvis_release_checkpoint_absolute_path "$app")"
  case "$app_state" in
    signed)
      openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$app" app app-signed >/dev/null
      ;;
    submitted|accepted|notarized)
      {
        printf 'NOTARY_SUBMISSION_ID=app-submission\n'
        printf 'NOTARY_ARTIFACT=%s/app-upload.zip\n' "$root"
        printf 'NOTARY_STAPLE_APP_PATH=%s\n' "$app_absolute"
        if [[ "$app_state" == "submitted" ]]; then
          printf 'NOTARY_STATUS=submitted\n'
        else
          printf 'NOTARY_STATUS=Accepted\n'
        fi
      } >"$app_receipt"
      if [[ "$app_state" == "submitted" ]]; then
        openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$app" app app-notary-submitted submitted app-submission >/dev/null
      elif [[ "$app_state" == "accepted" ]]; then
        openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$app" app app-notary-accepted Accepted app-submission >/dev/null
      else
        openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$app" app app-notarized Accepted app-submission >/dev/null
      fi
      ;;
  esac

  if [[ "$dmg_state" != "none" ]]; then
    [[ -f "$dmg" ]] || printf 'signed dmg fixture\n' >"$dmg"
    dmg_absolute="$(openclaw_jarvis_release_checkpoint_absolute_path "$dmg")"
    {
      printf 'NOTARY_SUBMISSION_ID=dmg-submission\n'
      printf 'NOTARY_ARTIFACT=%s\n' "$dmg_absolute"
      printf 'NOTARY_STAPLE_APP_PATH=\n'
      if [[ "$dmg_state" == "submitted" ]]; then
        printf 'NOTARY_STATUS=submitted\n'
      else
        printf 'NOTARY_STATUS=Accepted\n'
      fi
    } >"$dmg_receipt"
    if [[ "$dmg_state" == "submitted" ]]; then
      openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$dmg" dmg dmg-notary-submitted submitted dmg-submission "$app" >/dev/null
    elif [[ "$dmg_state" == "accepted" ]]; then
      openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$dmg" dmg dmg-notary-accepted Accepted dmg-submission "$app" >/dev/null
    else
      openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$dmg" dmg dmg-notarized Accepted dmg-submission "$app" >/dev/null
    fi
  fi

  if [[ "$assets" == "1" ]]; then
    [[ -f "$root/dist/Jarvis.zip" ]] || printf 'zip fixture\n' >"$root/dist/Jarvis.zip"
    [[ -f "$root/dist/jarvis-appcast.xml" ]] || printf '<rss/>\n' >"$root/dist/jarvis-appcast.xml"
    openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$root/dist/Jarvis.zip" zip sparkle-zip not-required "" "$app" >/dev/null
    openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$root/dist/jarvis-appcast.xml" appcast sparkle-appcast not-required "" "$app" >/dev/null
  fi
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

write_fake_tagged_appcast() {
  local root="$1"
  local tag="$2"
  mkdir -p "$root/dist"
  printf '<rss><channel><item><enclosure url="https://github.com/artemgetmann/openclaw/releases/download/%s/Jarvis.zip"/></item></channel></rss>\n' \
    "$tag" \
    >"$root/dist/jarvis-appcast.xml"
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
      transient-once)
        printf '  state_file="${0}.state"\n'
        printf '  if [[ ! -f "$state_file" ]]; then\n'
        printf '    : >"$state_file"\n'
        printf '    echo "net/http: TLS handshake timeout" >&2\n'
        printf '    exit 1\n'
        printf '  fi\n'
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
  seed_wrapper_checkpoints "$root" submitted
  assert_eq "app submission selects poll app" "$(jarvis_release_next_phase "$root" 0 0)" "poll-app-notarization"

  root="$(make_state_root app-submitted-manifest-only)"
  mkdir -p "$root/dist/Jarvis.app"
  mkdir -p "$root/dist"
  {
    printf 'JARVIS_APP_NOTARY_SUBMISSION_ID=%q\n' "app-submission"
    printf 'JARVIS_APP_NOTARY_STATUS=%q\n' "submitted"
  } >"$(jarvis_release_manifest_path "$root")"
  assert_eq "manifest-only app submission selects poll app" "$(jarvis_release_next_phase "$root" 0 0)" "poll-app-notarization"

  local encoded_empty
  for encoded_empty in "''" "\\'\\'" "\\\\\\'\\\\\\'"; do
    root="$(make_state_root "app-empty-submission-${RANDOM}")"
    mkdir -p "$root/dist/Jarvis.app"
    {
      printf 'JARVIS_APP_NOTARY_SUBMISSION_ID=%s\n' "$encoded_empty"
      printf 'JARVIS_APP_NOTARY_STATUS=%s\n' "$encoded_empty"
    } >"$(jarvis_release_manifest_path "$root")"
    assert_eq \
      "encoded empty app submission selects submit app ($encoded_empty)" \
      "$(jarvis_release_next_phase "$root" 0 0)" \
      "submit-app-notarization"
  done

  root="$(make_state_root app-accepted)"
  mkdir -p "$root/dist/Jarvis.app"
  write_manifest_status "$root" "Accepted" ""
  assert_eq "accepted app selects submit dmg" "$(jarvis_release_next_phase "$root" 0 0)" "submit-dmg-notarization"

  root="$(make_state_root urgent-sparkle-assets-missing)"
  mkdir -p "$root/dist/Jarvis.app"
  write_manifest_status "$root" "Accepted" ""
  assert_eq "urgent sparkle missing assets selects local assets" "$(jarvis_release_next_phase "$root" 0 0 "Jarvis" 0 1)" "create-local-release-assets-only"

  root="$(make_state_root urgent-sparkle-assets-ready)"
  mkdir -p "$root/dist/Jarvis.app"
  : >"$root/dist/Jarvis.zip"
  : >"$root/dist/jarvis-appcast.xml"
  write_manifest_status "$root" "Accepted" ""
  assert_eq "urgent sparkle assets without public action stops" "$(jarvis_release_next_phase "$root" 0 0 "Jarvis" 0 1)" "ready-sparkle-local-assets"
  assert_eq "urgent sparkle assets with publish selects sparkle publish" "$(jarvis_release_next_phase "$root" 1 0 "Jarvis" 0 1)" "publish-sparkle-assets-only"
  assert_eq "urgent sparkle assets with public verify selects sparkle verify" "$(jarvis_release_next_phase "$root" 0 1 "Jarvis" 0 1)" "verify-sparkle-assets-only"

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
  local asset_ready_out="$TMP_DIR/wrapper-local-assets-ready.out"
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
  local urgent_root="$TMP_DIR/wrapper-urgent-sparkle"
  local urgent_out="$TMP_DIR/wrapper-urgent-sparkle.out"
  local urgent_ready_root="$TMP_DIR/wrapper-urgent-sparkle-ready"
  local urgent_ready_out="$TMP_DIR/wrapper-urgent-sparkle-ready.out"
  local urgent_ready_live_out="$TMP_DIR/wrapper-urgent-sparkle-ready-live.out"
  local latest_fake_bin="$TMP_DIR/fake-latest-gh"
  local latest_retry_fake_bin="$TMP_DIR/fake-latest-retry-gh"
  local latest_retry_out="$TMP_DIR/wrapper-latest-retry.out"
  local missing_gh_bin="$TMP_DIR/no-gh-bin"
  local latest_conflict_err="$TMP_DIR/wrapper-latest-conflict.err"
  local missing_gh_err="$TMP_DIR/wrapper-missing-gh.err"
  local lookup_fail_err="$TMP_DIR/wrapper-latest-lookup-fail.err"
  local empty_tag_err="$TMP_DIR/wrapper-latest-empty-tag.err"
  local p2_asset_root="$TMP_DIR/wrapper-p2-local-assets"
  local p2_asset_out="$TMP_DIR/wrapper-p2-local-assets.out"
  local p2_poll_root="$TMP_DIR/wrapper-p2-poll-dmg"
  local p2_poll_out="$TMP_DIR/wrapper-p2-poll-dmg.out"
  local pending_dmg_root="$TMP_DIR/wrapper-pending-dmg"
  local pending_dmg_out="$TMP_DIR/wrapper-pending-dmg.out"
  local accepted_app_root="$TMP_DIR/wrapper-accepted-app"
  local accepted_app_out="$TMP_DIR/wrapper-accepted-app.out"
  local accepted_dmg_root="$TMP_DIR/wrapper-accepted-dmg"
  local accepted_dmg_out="$TMP_DIR/wrapper-accepted-dmg.out"
  local stale_build_env="$TMP_DIR/wrapper-stale-build.env"
  local explicit_build_out="$TMP_DIR/wrapper-explicit-build.out"
  local release_home release_name
  local status

  release_home="$(cd "$ROOT_DIR/../.." && pwd)"
  release_name="$(basename "$ROOT_DIR")"

  mkdir -p "$root/dist/Jarvis.app"
  write_receipt "$(jarvis_release_app_notary_receipt_path "$root")" "app-submission"
  seed_wrapper_checkpoints "$root" submitted

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

  printf 'export APP_BUILD=1178\n' >"$stale_build_env"
  OPENCLAW_RELEASE_ENV_FILE="$stale_build_env" \
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --dry-run \
      --app-build 1179 \
      >"$explicit_build_out"
  grep -q '^  app_build=1179$' "$explicit_build_out" \
    || fail "explicit --app-build did not override stale release.env APP_BUILD"
  grep -q '^  selected_phase=poll-app-notarization$' "$explicit_build_out" \
    || fail "explicit --app-build was applied after resumable checkpoint selection"
  pass "wrapper explicit app build overrides stale release env"

  seed_wrapper_checkpoints "$accepted_app_root" accepted
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$accepted_app_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" --dry-run >"$accepted_app_out"
  grep -q 'selected_phase=poll-app-notarization' "$accepted_app_out" \
    || fail "accepted app proof rebuilt or resubmitted instead of retrying staple verification"
  pass "accepted app proof retries polling without rebuild or resubmit"

  mkdir -p "$p2_asset_root/dist/Jarvis.app"
  : >"$p2_asset_root/dist/Jarvis.dmg"
  write_manifest_status "$p2_asset_root" "Accepted" ""
  write_receipt "$(jarvis_release_dmg_notary_receipt_path "$p2_asset_root")" "dmg-submission"
  seed_wrapper_checkpoints "$p2_asset_root" notarized submitted

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
  seed_wrapper_checkpoints "$p2_poll_root" notarized submitted 1

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

  seed_wrapper_checkpoints "$pending_dmg_root" notarized submitted
  /usr/bin/sed 's/^NOTARY_STATUS=submitted$/NOTARY_STATUS=In\\ Progress/' \
    "$pending_dmg_root/dist/Jarvis.dmg.notary.env" \
    >"$pending_dmg_root/dist/Jarvis.dmg.notary.env.pending"
  mv -f \
    "$pending_dmg_root/dist/Jarvis.dmg.notary.env.pending" \
    "$pending_dmg_root/dist/Jarvis.dmg.notary.env"
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$pending_dmg_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" --dry-run >"$pending_dmg_out"
  grep -q 'selected_phase=poll-dmg-notarization' "$pending_dmg_out" \
    || fail "In Progress receipt selected DMG resubmission instead of same-ID polling"
  pass "wrapper keeps In Progress DMG submission on the poll path"
  seed_wrapper_checkpoints "$accepted_dmg_root" notarized accepted
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$accepted_dmg_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" --dry-run >"$accepted_dmg_out"
  grep -q 'selected_phase=poll-dmg-notarization' "$accepted_dmg_out" \
    || fail "accepted DMG proof rebuilt or resubmitted instead of retrying staple verification"
  pass "accepted DMG proof retries polling without rebuild or resubmit"

  mkdir -p "$urgent_ready_root/dist/Jarvis.app"
  : >"$urgent_ready_root/dist/Jarvis.zip"
  write_fake_tagged_appcast "$urgent_ready_root" v-current
  write_manifest_status "$urgent_ready_root" "Accepted" ""
  seed_wrapper_checkpoints "$urgent_ready_root" notarized none 1

  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$urgent_ready_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --dry-run \
      --urgent-sparkle \
      >"$urgent_ready_out"
  if ! grep -q 'selected_phase=ready-sparkle-local-assets' "$urgent_ready_out"; then
    cat "$urgent_ready_out" >&2
    fail "wrapper urgent sparkle dry run did not stop at ready-sparkle-local-assets without publish intent"
  fi
  if ! grep -q 'fresh_install_sendable=false' "$urgent_ready_out"; then
    cat "$urgent_ready_out" >&2
    fail "wrapper urgent sparkle ready output did not keep fresh-install truth false"
  fi
  if ! grep -q '^  next_publish_command=bash scripts/jarvis-public-release.sh --authorize$' "$urgent_ready_out"; then
    cat "$urgent_ready_out" >&2
    fail "wrapper urgent sparkle dry run printed a publish command without executable authorization"
  fi
  pass "wrapper urgent sparkle ready dry run keeps public action explicit"

  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/urgent-ready-live.lock" \
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$urgent_ready_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --release-intent "$TEST_RELEASE_INTENT_ID" \
      --urgent-sparkle \
      >"$urgent_ready_live_out"
  if ! grep -Fq "next_publish_command=bash scripts/jarvis-public-release.sh --release-intent $TEST_RELEASE_INTENT_ID --urgent-sparkle --publish-release-assets --latest-release-tag" "$urgent_ready_live_out"; then
    cat "$urgent_ready_live_out" >&2
    fail "wrapper urgent sparkle ready output did not preserve the active release intent"
  fi
  pass "wrapper urgent sparkle next command preserves active intent"

  mkdir -p "$asset_root/dist/Jarvis.app"
  : >"$asset_root/dist/Jarvis.dmg"
  write_manifest_status "$asset_root" "Accepted" "Accepted"
  seed_wrapper_checkpoints "$asset_root" notarized notarized

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

  # The ready state exits before package execution, so this live authorized
  # invocation safely proves the printed follow-up remains executable under the
  # latest-intent gate.
  seed_wrapper_checkpoints "$asset_root" notarized notarized 1
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/local-ready-live.lock" \
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$asset_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --release-intent "$TEST_RELEASE_INTENT_ID" \
      >"$asset_ready_out"
  if ! grep -Fq "next_publish_command=bash scripts/jarvis-public-release.sh --release-intent $TEST_RELEASE_INTENT_ID --publish-release-assets --latest-release-tag" "$asset_ready_out"; then
    cat "$asset_ready_out" >&2
    fail "wrapper local ready output did not preserve the active release intent"
  fi
  pass "wrapper local next command preserves active intent"

  mkdir -p "$verify_root/dist/Jarvis.app"
  : >"$verify_root/dist/Jarvis.dmg"
  : >"$verify_root/dist/Jarvis.zip"
  : >"$verify_root/dist/jarvis-appcast.xml"
  write_manifest_status "$verify_root" "Accepted" "Accepted"
  seed_wrapper_checkpoints "$verify_root" notarized notarized 1

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
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/verify-tag-required.lock" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --verify-public-assets \
      --release-intent "$TEST_RELEASE_INTENT_ID" \
      >"$verify_out" 2>"$verify_err"
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
  seed_wrapper_checkpoints "$stale_publish_root" notarized notarized 1

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
  seed_wrapper_checkpoints "$latest_publish_root" notarized notarized 1
  write_fake_latest_release_gh "$latest_fake_bin" success v-current

  mkdir -p "$urgent_root/dist/Jarvis.app"
  : >"$urgent_root/dist/Jarvis.zip"
  write_fake_tagged_appcast "$urgent_root" v-current
  write_manifest_status "$urgent_root" "Accepted" ""
  seed_wrapper_checkpoints "$urgent_root" notarized none 1

  PATH="$latest_fake_bin:$PATH" \
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$urgent_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --dry-run \
      --urgent-sparkle \
      --publish-release-assets \
      --latest-release-tag \
      >"$urgent_out"
  if ! grep -q 'selected_phase=publish-sparkle-assets-only' "$urgent_out"; then
    cat "$urgent_out" >&2
    fail "wrapper urgent sparkle publish dry run selected wrong phase"
  fi
  if grep -q -- '--phase publish-assets-only' "$urgent_out"; then
    cat "$urgent_out" >&2
    fail "wrapper urgent sparkle publish dry run selected the full DMG publish phase"
  fi
  if ! grep -q 'dmg_update_live=false' "$urgent_out"; then
    cat "$urgent_out" >&2
    fail "wrapper urgent sparkle publish dry run did not keep DMG truth false"
  fi
  pass "wrapper urgent sparkle publish dry run resolves sparkle-only phase"

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
  seed_wrapper_checkpoints "$latest_verify_root" notarized notarized 1

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

  write_fake_latest_release_gh "$latest_retry_fake_bin" transient-once v-retry
  PATH="$latest_retry_fake_bin:$PATH" \
  OPENCLAW_GITHUB_RELEASE_RETRY_ATTEMPTS=2 \
  OPENCLAW_GITHUB_RELEASE_RETRY_SLEEP_SECS=0 \
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$latest_verify_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --dry-run \
      --verify-public-assets \
      --latest-release-tag \
      >"$latest_retry_out"
  if ! grep -q 'resolved_github_release_tag=v-retry' "$latest_retry_out"; then
    cat "$latest_retry_out" >&2
    fail "wrapper latest tag did not retry a transient gh lookup failure"
  fi
  pass "wrapper latest tag retries transient gh lookup"

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

  mkdir -p "$missing_gh_bin"
  ln -s "$(command -v dirname)" "$missing_gh_bin/dirname"
  set +e
  PATH="$missing_gh_bin" \
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$latest_verify_root" \
    "$BASH" "$ROOT_DIR/scripts/jarvis-public-release.sh" \
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

test_package_script_rejects_noncanonical_release_worktree() {
  local app_name="JarvisTagGuardTest-$$"
  local app_path="$ROOT_DIR/dist/${app_name}.app"
  local manifest="$TMP_DIR/package-tag-guard-manifest.env"
  local out="$TMP_DIR/package-tag-guard.out"
  local err="$TMP_DIR/package-tag-guard.err"
  local status

  mkdir -p "$app_path"
  {
    printf 'JARVIS_APP_NOTARY_STATUS=%q\n' "Accepted"
  } >"$manifest"

  set +e
  APP_NAME="$app_name" \
  OPENCLAW_JARVIS_RELEASE_MANIFEST="$manifest" \
    bash "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" \
      --phase create-local-release-assets-only \
      --release-intent "$TEST_RELEASE_INTENT_ID" \
      --github-release-tag v-stale \
      >"$out" 2>"$err"
  status=$?
  set -e
  rm -rf "$app_path"

  if [[ "$status" -eq 0 ]]; then
    cat "$out" >&2
    fail "package script should reject noncanonical release worktree"
  fi
  if ! grep -q -- 'Jarvis public release packaging must run from the blessed warmed release worktree' "$err"; then
    cat "$err" >&2
    fail "package noncanonical worktree failure did not mention blessed release worktree"
  fi
  pass "package script rejects noncanonical release worktree"
}

test_package_sparkle_publish_gate_does_not_require_dmg() {
  local app_name="JarvisSparkleGateTest-$$"
  local app_path="$ROOT_DIR/dist/${app_name}.app"
  local manifest="$TMP_DIR/package-sparkle-gate-manifest.env"
  local out="$TMP_DIR/package-sparkle-gate.out"
  local err="$TMP_DIR/package-sparkle-gate.err"
  local release_home
  local release_name
  local status

  release_home="$(cd "$ROOT_DIR/../.." && pwd)"
  release_name="$(basename "$ROOT_DIR")"

  mkdir -p "$app_path"
  {
    printf 'JARVIS_APP_NOTARY_STATUS=%q\n' "Accepted"
    printf 'JARVIS_DMG_NOTARY_STATUS=%q\n' ""
  } >"$manifest"

  set +e
  APP_NAME="$app_name" \
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/sparkle-publish-gate.lock" \
  OPENCLAW_JARVIS_RELEASE_MANIFEST="$manifest" \
    bash "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" \
      --phase publish-sparkle-assets-only \
      --release-intent "$TEST_RELEASE_INTENT_ID" \
      --github-release-tag v-current \
      >"$out" 2>"$err"
  status=$?
  set -e
  rm -rf "$app_path"

  if [[ "$status" -eq 0 ]]; then
    cat "$out" >&2
    fail "package publish-sparkle-assets-only should require explicit publish intent"
  fi
  if grep -q 'DMG notarization' "$err"; then
    cat "$err" >&2
    fail "package sparkle-only publish gate should not require accepted DMG notarization"
  fi
  if ! grep -q -- '--phase publish-sparkle-assets-only requires --publish-release-assets' "$err"; then
    cat "$err" >&2
    fail "package sparkle-only publish gate did not stop on explicit publish intent"
  fi
  pass "package sparkle-only publish gate does not require dmg notarization"
}

test_package_sparkle_publish_only_ignores_skip_notarize() {
  local app_name="JarvisSparkleSkipNotarizeTest-$$"
  local app_path="$ROOT_DIR/dist/${app_name}.app"
  local fake_bin="$TMP_DIR/fake-bin-sparkle-skip"
  local manifest="$TMP_DIR/package-sparkle-skip-notarize-manifest.env"
  local out="$TMP_DIR/package-sparkle-skip-notarize.out"
  local err="$TMP_DIR/package-sparkle-skip-notarize.err"
  local release_home
  local release_name
  local status

  release_home="$(cd "$ROOT_DIR/../.." && pwd)"
  release_name="$(basename "$ROOT_DIR")"

  mkdir -p "$app_path" "$fake_bin"
  {
    printf 'JARVIS_APP_NOTARY_STATUS=%q\n' "Accepted"
  } >"$manifest"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'if [[ "$1" == "auth" && "$2" == "status" ]]; then exit 0; fi\n'
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
  SKIP_NOTARIZE=1 \
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/sparkle-skip-notarize.lock" \
  OPENCLAW_JARVIS_RELEASE_MANIFEST="$manifest" \
    bash "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" \
      --phase publish-sparkle-assets-only \
      --release-intent "$TEST_RELEASE_INTENT_ID" \
      --publish-release-assets \
      --github-release-tag v-current \
      >"$out" 2>"$err"
  status=$?
  set -e
  rm -rf "$app_path"

  if [[ "$status" -eq 0 ]]; then
    cat "$out" >&2
    fail "package publish-sparkle-assets-only should still require local Sparkle assets"
  fi
  if grep -q -- '--publish-release-assets requires notarization' "$err"; then
    cat "$err" >&2
    fail "package sparkle-only publish should not be blocked by SKIP_NOTARIZE"
  fi
  if ! grep -q 'release checkpoint is checkpoint-missing' "$err"; then
    cat "$err" >&2
    fail "package sparkle-only publish did not reach the strict resume checkpoint gate"
  fi
  pass "package sparkle-only publish ignores skip notarize"
}

test_forced_invalid_checkpoint_recovers_automatically() {
  local out="$TMP_DIR/forced-invalid-checkpoint.out"
  local err="$TMP_DIR/forced-invalid-checkpoint.err"
  local combined="$TMP_DIR/forced-invalid-checkpoint.combined"
  local release_home release_name status

  release_home="$(cd "$ROOT_DIR/../.." && pwd)"
  release_name="$(basename "$ROOT_DIR")"
  set +e
  APP_NAME="JarvisMissingCheckpoint-$$" \
  SPARKLE_FEED_URL="https://github.com/artemgetmann/openclaw/releases/latest/download/jarvis-appcast.xml" \
  SPARKLE_PUBLIC_ED_KEY="fixture-consumer-key" \
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/forced-invalid-checkpoint.lock" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --phase poll-app-notarization \
      --release-intent "$TEST_RELEASE_INTENT_ID" \
      >"$out" 2>"$err"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "forced invalid checkpoint unexpectedly executed"
  { /bin/cat "$out"; /bin/cat "$err"; } >"$combined"
  [[ "$(grep -c '^recovery_command=' "$combined")" == "1" ]] \
    || fail "forced invalid checkpoint did not emit exactly one recovery command"
  grep -Fq "recovery_command=bash scripts/jarvis-public-release.sh --release-intent $TEST_RELEASE_INTENT_ID " "$combined" \
    || fail "forced invalid checkpoint did not return to automatic phase selection"
  ! grep -q '^recovery_command=.*--phase poll-app-notarization' "$combined" \
    || fail "forced invalid checkpoint repeated the rejected forced phase"
  pass "forced invalid checkpoint recovers through automatic phase selection"
}

test_bound_ready_advice_requires_fresh_authorization() {
  local ready_root="$TMP_DIR/bound-ready"
  local sparkle_root="$TMP_DIR/bound-sparkle-ready"
  local out="$TMP_DIR/bound-ready.out"
  local release_home release_name

  release_home="$(cd "$ROOT_DIR/../.." && pwd)"
  release_name="$(basename "$ROOT_DIR")"
  seed_wrapper_checkpoints "$ready_root" notarized notarized 1
  seed_wrapper_checkpoints "$sparkle_root" notarized none 1

  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=bound-ready-advice
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --authorize \
      --size-report \
      >/dev/null
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/bound-ready.lock" \
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$ready_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --release-intent bound-ready-advice \
      --size-report \
      >"$out"
  grep -Fxq '  next_publish_command=bash scripts/jarvis-public-release.sh --authorize' "$out" \
    || fail "bound ready-local-assets advice reused an intent while adding publish flags"
  ! grep -q '^  next_publish_command=.*--release-intent bound-ready-advice' "$out" \
    || fail "bound ready-local-assets advice printed a doomed stale-intent command"

  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=bound-sparkle-ready-advice
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --authorize \
      --urgent-sparkle \
      --size-report \
      >/dev/null
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/bound-sparkle-ready.lock" \
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$sparkle_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --release-intent bound-sparkle-ready-advice \
      --urgent-sparkle \
      --size-report \
      >"$out"
  grep -Fxq '  next_publish_command=bash scripts/jarvis-public-release.sh --authorize' "$out" \
    || fail "bound ready-sparkle-local-assets advice reused an intent while adding publish flags"
  ! grep -q '^  next_publish_command=.*--release-intent bound-sparkle-ready-advice' "$out" \
    || fail "bound ready-sparkle-local-assets advice printed a doomed stale-intent command"
  pass "bound ready-state advice requires fresh authorization before adding public action"
}

test_bound_package_failure_recovers_through_wrapper() {
  local authorize_out="$TMP_DIR/bound-package-authorize.out"
  local out="$TMP_DIR/bound-package.out"
  local err="$TMP_DIR/bound-package.err"
  local combined="$TMP_DIR/bound-package.combined"
  local disk_probe="$TMP_DIR/bound-package-disk-probe"
  local release_home release_name status

  release_home="$(cd "$ROOT_DIR/../.." && pwd)"
  release_name="$(basename "$ROOT_DIR")"
  write_release_control_stub "$disk_probe" '#!/usr/bin/env bash
printf "bound-package-fs\t/Volumes/bound-package\t0\t%s\n" "$1"'

  # --size-report makes this a bound action without forcing phase selection.
  # The deterministic disk failure occurs inside the delegated package before
  # build/sign/notary work and exercises the wrapper's post-child recovery.
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=bound-package-recovery
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --authorize \
      --size-report \
      >"$authorize_out"

  set +e
  APP_NAME="JarvisBoundPackageFailure-$$" \
  ALLOW_COLD_RELEASE_LANE=1 \
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/bound-package.lock" \
  OPENCLAW_JARVIS_PUBLIC_RELEASE_SUMMARY="$TMP_DIR/bound-package-summary.env" \
  OPENCLAW_JARVIS_RELEASE_TIMING_REPORT="$TMP_DIR/bound-package-timing.tsv" \
  OPENCLAW_RELEASE_ARTIFACT_RUN_ROOT="$TMP_DIR/bound-package-artifacts" \
  JARVIS_RELEASE_DISK_POST_WRITE_FLOOR_KIB=1 \
  JARVIS_RELEASE_DISK_EXPECTED_WRITE_RESERVE_KIB=0 \
  JARVIS_RELEASE_DISK_PROBE_COMMAND="$disk_probe" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --release-intent bound-package-recovery \
      --size-report \
      >"$out" 2>"$err"
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || fail "bound delegated package failure unexpectedly succeeded"
  { /bin/cat "$out"; /bin/cat "$err"; } >"$combined"
  [[ "$(grep -c '^recovery_command=' "$combined")" == "1" ]] \
    || fail "bound delegated package failure did not emit exactly one recovery command"
  grep -Fq \
    'recovery_command=bash scripts/jarvis-public-release.sh --release-intent bound-package-recovery --size-report' \
    "$combined" \
    || fail "bound delegated package failure did not return through its executable wrapper action"
  ! grep -q '^recovery_command=bash .*package-openclaw-mac-dist.sh' "$combined" \
    || fail "bound delegated package failure printed a fresh-shell-invalid direct package command"
  pass "bound delegated package failure recovers through its fingerprinted wrapper action"
}

test_bound_forced_recovery_requires_fresh_authorization() {
  local authorize_out="$TMP_DIR/bound-forced-authorize.out"
  local out="$TMP_DIR/bound-forced.out"
  local err="$TMP_DIR/bound-forced.err"
  local combined="$TMP_DIR/bound-forced.combined"
  local fake_bin="$TMP_DIR/bound-forced-bin"
  local release_home release_name status

  release_home="$(cd "$ROOT_DIR/../.." && pwd)"
  release_name="$(basename "$ROOT_DIR")"
  mkdir -p "$fake_bin"
  write_release_control_stub "$fake_bin/gh" '#!/usr/bin/env bash
printf "%s\n" "{\"tagName\":\"v-bound-current\"}"'

  # Authorize the exact forced verify action without resolving GitHub. The
  # later execution resolves --latest-release-tag, then intentionally fails its
  # missing checkpoint. Automatic recovery would both remove --phase and turn
  # latest into an explicit tag, so it must receive a new lease.
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=bound-forced-recovery
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --authorize \
      --verify-public-assets \
      --latest-release-tag \
      --phase verify-public-assets-only \
      >"$authorize_out"

  set +e
  PATH="$fake_bin:$PATH" \
  APP_NAME="JarvisMissingBoundCheckpoint-$$" \
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/bound-forced.lock" \
  OPENCLAW_JARVIS_PUBLIC_RELEASE_SUMMARY="$TMP_DIR/bound-forced-summary.env" \
  OPENCLAW_JARVIS_RELEASE_TIMING_REPORT="$TMP_DIR/bound-forced-timing.tsv" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --release-intent bound-forced-recovery \
      --verify-public-assets \
      --latest-release-tag \
      --phase verify-public-assets-only \
      >"$out" 2>"$err"
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || fail "bound forced checkpoint failure unexpectedly succeeded"
  { /bin/cat "$out"; /bin/cat "$err"; } >"$combined"
  [[ "$(grep -c '^recovery_command=' "$combined")" == "1" ]] \
    || fail "bound forced failure did not emit exactly one recovery command"
  grep -Fxq 'recovery_command=bash scripts/jarvis-public-release.sh --authorize' "$combined" \
    || fail "bound forced recovery reused a fingerprint after changing phase/tag action"
  ! grep -q '^recovery_command=.*--release-intent bound-forced-recovery' "$combined" \
    || fail "bound forced recovery printed a non-executable stale-intent command"
  pass "bound forced recovery requires fresh authorization before changing phase or tag action"
}

test_release_class_defaults_and_fresh_installer_gate() {
  local state_root="$TMP_DIR/release-class-state"
  local out="$TMP_DIR/release-class.out"
  local err="$TMP_DIR/release-class.err"
  local status
  mkdir -p "$state_root/dist"

  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$state_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" --dry-run >"$out"
  grep -q '^  selected_phase=sparkle-update$' "$out" \
    || fail "routine release did not default to the Sparkle-only package phase"
  grep -q '^  release_class=sparkle-update$' "$out" \
    || fail "routine release did not report its release class"
  ! grep -q -- '--phase submit-dmg-notarization' "$out" \
    || fail "routine release selected DMG work"

  set +e
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$state_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --dry-run --release-class fresh-installer >"$out" 2>"$err"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "fresh-installer succeeded without a classification reason"
  grep -q 'fresh-installer requires --release-class-reason' "$err" \
    || fail "fresh-installer failure did not explain the required receipt"

  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$state_root" \
    bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --dry-run --release-class fresh-installer \
      --release-class-reason recovery >"$out"
  grep -q '^  selected_phase=full$' "$out" \
    || fail "classified fresh installer did not select the full package phase"
  grep -q '^  release_class_reason=recovery$' "$out" \
    || fail "fresh installer did not report its classification reason"
  pass "release classes default to Sparkle and gate fresh installers"
}

test_tagged_asset_immutability() {
  local fake_bin="$TMP_DIR/immutable-fake-bin"
  local artifact="$TMP_DIR/Jarvis.zip"
  local digest out err status
  mkdir -p "$fake_bin"
  printf 'immutable fixture\n' >"$artifact"
  digest="sha256:$(/usr/bin/shasum -a 256 "$artifact" | /usr/bin/awk '{ print $1 }')"
  write_release_control_stub "$fake_bin/gh" '#!/usr/bin/env bash
printf "%s\n" "${REMOTE_DIGEST:-}"'

  out="$(PATH="$fake_bin:$PATH" REMOTE_DIGEST="" \
    openclaw_jarvis_release_require_immutable_asset_compatible repo v1 "$artifact")"
  [[ "$out" == "upload" ]] || fail "missing tagged asset was not classified for first upload"

  out="$(PATH="$fake_bin:$PATH" REMOTE_DIGEST="$digest" \
    openclaw_jarvis_release_require_immutable_asset_compatible repo v1 "$artifact")"
  [[ "$out" == "identical" ]] || fail "identical tagged asset was not classified as an idempotent retry"

  set +e
  PATH="$fake_bin:$PATH" REMOTE_DIGEST="sha256:deadbeef" \
    openclaw_jarvis_release_require_immutable_asset_compatible repo v1 "$artifact" \
      >"$TMP_DIR/immutable.out" 2>"$TMP_DIR/immutable.err"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "different bytes were allowed to replace a tagged asset"
  grep -q 'Create a new release tag' "$TMP_DIR/immutable.err" \
    || fail "immutable conflict did not give the safe recovery action"
  pass "tagged ZIP and DMG bytes are immutable"
}

setup_checkpoint_stubs
setup_release_intent
test_release_class_defaults_and_fresh_installer_gate
test_tagged_asset_immutability
test_phase_selection
test_retry_classification
test_wrapper_dry_run
test_package_sparkle_publish_gate_does_not_require_dmg
test_package_sparkle_publish_only_ignores_skip_notarize
test_package_script_rejects_noncanonical_release_worktree
test_forced_invalid_checkpoint_recovers_automatically
test_bound_ready_advice_requires_fresh_authorization
test_bound_package_failure_recovers_through_wrapper
test_bound_forced_recovery_requires_fresh_authorization
