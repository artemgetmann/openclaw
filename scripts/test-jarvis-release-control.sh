#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/jarvis-release-intent.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-checkpoint.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

make_stub_tools() {
  local bin_dir="$TMP_DIR/bin"
  mkdir -p "$bin_dir"

  apply_stub "$bin_dir/plistbuddy" '#!/usr/bin/env bash
case "$2" in
  "Print CFBundleShortVersionString") printf "%s\n" "${STUB_APP_VERSION:-2026.7.15}" ;;
  "Print CFBundleVersion") printf "%s\n" "${STUB_APP_BUILD:-1179}" ;;
  "Print OpenClawGitCommit") git -C "${STUB_GIT_ROOT:?}" rev-parse HEAD ;;
  *) exit 1 ;;
esac'
  apply_stub "$bin_dir/codesign" '#!/usr/bin/env bash
[[ "${STUB_CODESIGN_FAIL:-0}" != "1" ]]'
  apply_stub "$bin_dir/xcrun" '#!/usr/bin/env bash
[[ "${STUB_STAPLER_FAIL:-0}" != "1" ]]'
  apply_stub "$bin_dir/spctl" '#!/usr/bin/env bash
[[ "${STUB_SPCTL_FAIL:-0}" != "1" ]]'

  export OPENCLAW_JARVIS_RELEASE_CHECKPOINT_PLISTBUDDY="$bin_dir/plistbuddy"
  export OPENCLAW_JARVIS_RELEASE_CHECKPOINT_CODESIGN_BIN="$bin_dir/codesign"
  export OPENCLAW_JARVIS_RELEASE_CHECKPOINT_XCRUN_BIN="$bin_dir/xcrun"
  export OPENCLAW_JARVIS_RELEASE_CHECKPOINT_SPCTL_BIN="$bin_dir/spctl"
  export STUB_GIT_ROOT="$ROOT_DIR"
}

apply_stub() {
  local path="$1"
  local content="$2"
  # Test fixtures are intentionally generated at runtime; production files are
  # still edited through apply_patch. printf avoids shell interpolation of the
  # stub bodies so the test controls every simulated Apple-tool outcome.
  printf '%s\n' "$content" >"$path"
  chmod +x "$path"
}

make_fake_app() {
  local app="$1"
  mkdir -p "$app/Contents/_CodeSignature"
  printf 'sealed-resource-map-v1\n' >"$app/Contents/_CodeSignature/CodeResources"
  printf 'fixture plist; values supplied by stub\n' >"$app/Contents/Info.plist"
}

write_notary_receipt() {
  local path="$1"
  local artifact="$2"
  local staple_app="$3"
  local status="$4"
  local submission_id="$5"
  {
    printf 'NOTARY_SUBMISSION_ID=%s\n' "$submission_id"
    printf 'NOTARY_ARTIFACT=%s\n' "$artifact"
    printf 'NOTARY_STAPLE_APP_PATH=%s\n' "$staple_app"
    printf 'NOTARY_STATUS=%s\n' "$status"
  } >"$path"
}

test_intent_latest_wins_and_expiry() {
  local intent_path="$TMP_DIR/release.intent"
  local first second
  export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$intent_path"
  export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=1000
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=first-authorized-run
  first="$(openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 60)"

  # The authorizer process is not the lease owner. Once its atomic write is
  # complete, process death does not erase or weaken the authorization.
  (
    openclaw_jarvis_release_intent_validate "$ROOT_DIR" "$first"
  )
  openclaw_jarvis_release_intent_validate "$ROOT_DIR" "$first" \
    || fail "completed intent did not survive authorizer owner death"

  export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=1001
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=latest-authorized-run
  second="$(openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 60)"
  if openclaw_jarvis_release_intent_validate "$ROOT_DIR" "$first"; then
    fail "replaced queued intent remained executable"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE" == "replaced" ]] \
    || fail "replaced intent reported wrong failure"
  openclaw_jarvis_release_intent_validate "$ROOT_DIR" "$second" \
    || fail "latest intent was not executable"

  export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=1061
  if openclaw_jarvis_release_intent_validate "$ROOT_DIR" "$second"; then
    fail "expired intent remained executable"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE" == "expired" ]] \
    || fail "expired intent reported wrong failure"
  pass "latest intent wins, stale queues fail, expiry is enforced, and owner death is harmless"
}

test_intent_path_stability() {
  local default_one default_two
  unset OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE
  default_one="$(TMPDIR="$TMP_DIR/one" openclaw_jarvis_release_intent_default_path "$ROOT_DIR")"
  default_two="$(TMPDIR="$TMP_DIR/two" LC_ALL=C TZ=UTC openclaw_jarvis_release_intent_default_path "$ROOT_DIR")"
  [[ "$default_one" == "$default_two" ]] || fail "intent path changed across TMPDIR/locale/timezone"
  pass "intent identity is stable across TMPDIR, locale, and timezone"
}

test_operator_authorization_interface() {
  local out="$TMP_DIR/authorize.out"
  export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$TMP_DIR/operator.intent"
  export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=1500
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=operator-authorized-run

  OPENCLAW_MAIN_HOME_CLONE="$(cd "$ROOT_DIR/../.." && pwd -P)" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$(basename "$ROOT_DIR")" \
    /bin/bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --authorize \
      --intent-ttl-seconds 60 \
      >"$out"

  grep -q '^jarvis_release_intent=authorized$' "$out" \
    || fail "operator authorization did not report success"
  grep -q '^next_command=bash scripts/jarvis-public-release.sh --release-intent operator-authorized-run$' "$out" \
    || fail "operator authorization did not print one exact execution command"
  pass "operator authorization prints the exact expiring-intent execution command"
}

test_checkpoint_invalid_and_valid_resume() {
  local app="$TMP_DIR/dist/Jarvis.app"
  local app_receipt="$TMP_DIR/dist/Jarvis.app.notary.env"
  local dmg="$TMP_DIR/dist/Jarvis.dmg"
  local dmg_receipt="$TMP_DIR/dist/Jarvis.dmg.notary.env"
  local app_absolute
  local dmg_absolute

  mkdir -p "$TMP_DIR/dist"
  make_fake_app "$app"
  printf 'signed dmg bytes\n' >"$dmg"
  app_absolute="$(openclaw_jarvis_release_checkpoint_absolute_path "$app")"
  dmg_absolute="$(openclaw_jarvis_release_checkpoint_absolute_path "$dmg")"
  write_notary_receipt "$app_receipt" "$TMP_DIR/app-upload.zip" "$app_absolute" Accepted app-submission-1
  write_notary_receipt "$dmg_receipt" "$dmg_absolute" "" Accepted dmg-submission-1

  openclaw_jarvis_release_checkpoint_write \
    "$ROOT_DIR" "$app" app app-local-proof >/dev/null
  if openclaw_jarvis_release_checkpoint_validate "$ROOT_DIR" "$app" app app-signed; then
    fail "local-proof checkpoint was promoted into a public signed-app resume"
  fi

  openclaw_jarvis_release_checkpoint_write \
    "$ROOT_DIR" "$app" app app-notarized Accepted app-submission-1 >/dev/null
  openclaw_jarvis_release_checkpoint_write \
    "$ROOT_DIR" "$dmg" dmg dmg-notarized Accepted dmg-submission-1 >/dev/null
  openclaw_jarvis_release_checkpoint_validate \
    "$ROOT_DIR" "$app" app app-notarized "$app_receipt" \
    || fail "valid notarized app checkpoint did not authorize resume"
  openclaw_jarvis_release_checkpoint_validate \
    "$ROOT_DIR" "$dmg" dmg dmg-notarized "$dmg_receipt" \
    || fail "valid notarized DMG checkpoint did not authorize resume"

  APP_BUILD=9999
  export APP_BUILD
  if openclaw_jarvis_release_checkpoint_validate "$ROOT_DIR" "$app" app app-notarized "$app_receipt"; then
    fail "checkpoint ignored the operator's mismatched intended app build"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE" == "app-build-intent" ]] \
    || fail "intended build mismatch reported wrong checkpoint failure"
  unset APP_BUILD

  printf 'tampered sealed-resource-map\n' >>"$app/Contents/_CodeSignature/CodeResources"
  if openclaw_jarvis_release_checkpoint_validate "$ROOT_DIR" "$app" app app-notarized "$app_receipt"; then
    fail "tampered app passed checkpoint validation"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE" == "checksum" ]] \
    || fail "tampered app reported wrong checkpoint failure"

  # Restore a valid checkpoint, then prove live staple validation is still a
  # gate rather than a boolean trusted from the checkpoint text.
  printf 'sealed-resource-map-v2\n' >"$app/Contents/_CodeSignature/CodeResources"
  openclaw_jarvis_release_checkpoint_write \
    "$ROOT_DIR" "$app" app app-notarized Accepted app-submission-1 >/dev/null
  export STUB_STAPLER_FAIL=1
  if openclaw_jarvis_release_checkpoint_validate "$ROOT_DIR" "$app" app app-notarized "$app_receipt"; then
    fail "checkpoint text bypassed live staple validation"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE" == "staple" ]] \
    || fail "staple failure reported wrong checkpoint failure"
  unset STUB_STAPLER_FAIL
  pass "invalid checkpoints fail and valid artifact-bound notarized resume passes"
}

test_expired_intent_prints_one_recovery_command() {
  local intent_path="$TMP_DIR/package.intent"
  local intent_id="$TMP_DIR/intent-id"
  local err="$TMP_DIR/package.err"
  local status=0
  export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$intent_path"
  export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=2000
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=expired-package-run
  intent_id="$(openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 1)"
  export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=2001

  set +e
  OPENCLAW_MAIN_HOME_CLONE="$(cd "$ROOT_DIR/../.." && pwd -P)" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$(basename "$ROOT_DIR")" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/package.lock" \
    /bin/bash "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" \
      --phase create-local-release-assets-only \
      --release-intent "$intent_id" \
      >/dev/null 2>"$err"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "expired package intent unexpectedly executed"
  [[ "$(grep -c '^recovery_command=' "$err")" == "1" ]] \
    || fail "expired package failure did not print exactly one recovery command"
  grep -q '^recovery_command=bash scripts/jarvis-public-release.sh --authorize$' "$err" \
    || fail "expired package failure printed the wrong recovery command"
  pass "expired execution prints exactly one actionable recovery command"
}

make_stub_tools
test_intent_latest_wins_and_expiry
test_intent_path_stability
test_operator_authorization_interface
test_checkpoint_invalid_and_valid_resume
test_expired_intent_prints_one_recovery_command

echo "All Jarvis release control tests passed."
