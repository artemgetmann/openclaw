#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/jarvis-release-intent.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-checkpoint.sh"

TMP_DIR="$(mktemp -d)"
PACKAGE_MUTATION_SENTINEL=""

cleanup() {
  if [[ -n "$PACKAGE_MUTATION_SENTINEL" ]]; then
    rm -f "$PACKAGE_MUTATION_SENTINEL"
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

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
  "Print OpenClawGitCommit")
    if [[ -n "${STUB_APP_COMMIT:-}" ]]; then
      printf "%s\n" "$STUB_APP_COMMIT"
    else
      git -C "${STUB_GIT_ROOT:?}" rev-parse HEAD
    fi
    ;;
  *) exit 1 ;;
esac'
  apply_stub "$bin_dir/codesign" '#!/usr/bin/env bash
if [[ "$1" == "-dv" ]]; then
  printf "CDHash=%s\n" "${STUB_APP_CDHASH:-1111111111111111111111111111111111111111}" >&2
  exit 0
fi
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

make_clean_intent_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.name "Release Control Test"
  git -C "$repo" config user.email "release-control-test@example.invalid"
  printf '#!/usr/bin/env bash\necho release\n' >"$repo/release.sh"
  printf 'release.sh diff=unstable\n' >"$repo/.gitattributes"
  chmod +x "$repo/release.sh"
  git -C "$repo" add .gitattributes release.sh
  git -C "$repo" commit -q -m "test: seed release fixture"
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

test_intent_default_and_maximum_ttl() {
  local intent_path="$TMP_DIR/ttl.intent"
  local expires
  export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$intent_path"
  export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=3000
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=default-ttl

  openclaw_jarvis_release_intent_authorize "$ROOT_DIR" >/dev/null
  expires="$(openclaw_jarvis_release_intent_value "$intent_path" JARVIS_RELEASE_INTENT_EXPIRES_AT_EPOCH)"
  [[ "$expires" == "10200" ]] || fail "default intent TTL was not 7200 seconds"

  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=max-ttl
  openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 14400 >/dev/null \
    || fail "maximum documented intent TTL was rejected"
  if openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 14401 >/dev/null 2>&1; then
    fail "intent TTL above 14400 seconds was accepted"
  fi
  pass "intent lease defaults to two hours and is capped at four hours"
}

test_intent_tracked_state_binding() {
  local repo="$TMP_DIR/tracked-state-repo"
  local intent_path="$TMP_DIR/tracked-state.intent"
  local err="$TMP_DIR/tracked-state.err"
  local driver="$TMP_DIR/unstable-diff-driver"
  local driver_marker="$TMP_DIR/unstable-diff-driver.called"
  local clean_one clean_two dirty_one dirty_two intent_id

  make_clean_intent_repo "$repo"
  export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$intent_path"
  export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=3500
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=tracked-state-intent

  clean_one="$(TMPDIR="$TMP_DIR/one" LC_ALL=C TZ=UTC openclaw_jarvis_release_intent_tracked_fingerprint "$repo")"
  clean_two="$(TMPDIR="$TMP_DIR/two" LC_ALL=C TZ=Asia/Makassar openclaw_jarvis_release_intent_tracked_fingerprint "$repo")"
  [[ "$clean_one" == "$clean_two" ]] \
    || fail "clean tracked fingerprint changed across TMPDIR/locale/timezone"
  [[ "${#clean_one}" == "64" ]] || fail "tracked fingerprint was not SHA-256"

  apply_stub "$driver" '#!/usr/bin/env bash
: >"${DIFF_DRIVER_MARKER:?}"
printf "unstable-%s-%s\n" "$$" "${RANDOM:-0}"'
  export DIFF_DRIVER_MARKER="$driver_marker"
  git -C "$repo" config diff.external "$driver"
  git -C "$repo" config diff.unstable.textconv "$driver"
  printf '#!/usr/bin/env bash\necho dirty-unstaged\n' >"$repo/release.sh"
  dirty_one="$(TMPDIR="$TMP_DIR/three" LC_ALL=C TZ=UTC openclaw_jarvis_release_intent_tracked_fingerprint "$repo")"
  dirty_two="$(TMPDIR="$TMP_DIR/four" LC_ALL=C TZ=Asia/Makassar openclaw_jarvis_release_intent_tracked_fingerprint "$repo")"
  [[ "$dirty_one" == "$dirty_two" ]] \
    || fail "dirty tracked fingerprint changed across process/environment state"
  [[ ! -e "$driver_marker" ]] \
    || fail "tracked fingerprint executed an external diff or textconv driver"
  if openclaw_jarvis_release_intent_authorize "$repo" 60 >/dev/null 2>"$err"; then
    fail "dirty unstaged release logic was authorized"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE" == "tracked-state-dirty" ]] \
    || fail "dirty authorization reported wrong failure"
  [[ ! -f "$intent_path" ]] || fail "dirty authorization persisted an intent"
  ! grep -q 'release.sh' "$err" || fail "dirty authorization leaked a tracked path"
  git -C "$repo" restore release.sh

  printf '#!/usr/bin/env bash\necho dirty-staged\n' >"$repo/release.sh"
  git -C "$repo" add release.sh
  if openclaw_jarvis_release_intent_authorize "$repo" 60 >/dev/null 2>"$err"; then
    fail "staged release logic was authorized"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE" == "tracked-state-dirty" ]] \
    || fail "staged tracked state reported wrong failure"
  git -C "$repo" restore --staged release.sh
  git -C "$repo" restore release.sh

  # A staged edit and an unstaged reversal have no combined HEAD-to-worktree
  # diff. They must still fail because the dirty index is an independent input.
  printf '#!/usr/bin/env bash\necho staged-but-reversed\n' >"$repo/release.sh"
  git -C "$repo" add release.sh
  git -C "$repo" restore --worktree release.sh
  if openclaw_jarvis_release_intent_authorize "$repo" 60 >/dev/null 2>"$err"; then
    fail "staged change canceled by worktree reversal was authorized"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE" == "tracked-state-dirty" ]] \
    || fail "staged-plus-reversed state reported wrong failure"
  git -C "$repo" restore --staged release.sh

  rm "$repo/release.sh"
  if openclaw_jarvis_release_intent_authorize "$repo" 60 >/dev/null 2>"$err"; then
    fail "tracked deletion was authorized"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE" == "tracked-state-dirty" ]] \
    || fail "tracked deletion reported wrong failure"
  git -C "$repo" restore release.sh

  chmod -x "$repo/release.sh"
  if openclaw_jarvis_release_intent_authorize "$repo" 60 >/dev/null 2>"$err"; then
    fail "tracked executable-mode change was authorized"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE" == "tracked-state-dirty" ]] \
    || fail "tracked mode change reported wrong failure"
  chmod +x "$repo/release.sh"

  intent_id="$(openclaw_jarvis_release_intent_authorize "$repo" 60)"
  [[ "$(openclaw_jarvis_release_intent_value "$intent_path" JARVIS_RELEASE_INTENT_TRACKED_FINGERPRINT)" == "$clean_one" ]] \
    || fail "clean tracked fingerprint was not persisted"
  printf '#!/usr/bin/env bash\necho drift-after-authorization\n' >"$repo/release.sh"
  if openclaw_jarvis_release_intent_validate "$repo" "$intent_id"; then
    fail "tracked state drift after authorization remained executable"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE" == "tracked-state-drift" ]] \
    || fail "tracked state drift reported wrong failure"
  pass "authorization rejects tracked dirt and later tracked-state drift"
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
  local zip="$TMP_DIR/dist/Jarvis.zip"
  local appcast="$TMP_DIR/dist/jarvis-appcast.xml"
  local checkpoint checkpoint_tmp artifact
  local app_absolute
  local dmg_absolute

  mkdir -p "$TMP_DIR/dist"
  make_fake_app "$app"
  printf 'signed dmg bytes\n' >"$dmg"
  printf 'sparkle zip bytes\n' >"$zip"
  printf '<rss/>\n' >"$appcast"
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
    "$ROOT_DIR" "$dmg" dmg dmg-notarized Accepted dmg-submission-1 "$app" >/dev/null
  openclaw_jarvis_release_checkpoint_write \
    "$ROOT_DIR" "$zip" zip sparkle-zip not-required "" "$app" >/dev/null
  openclaw_jarvis_release_checkpoint_write \
    "$ROOT_DIR" "$appcast" appcast sparkle-appcast not-required "" "$app" >/dev/null
  openclaw_jarvis_release_checkpoint_validate \
    "$ROOT_DIR" "$app" app app-notarized "$app_receipt" \
    || fail "valid notarized app checkpoint did not authorize resume"
  openclaw_jarvis_release_checkpoint_validate \
    "$ROOT_DIR" "$dmg" dmg dmg-notarized "$dmg_receipt" "$app" \
    || fail "valid notarized DMG checkpoint did not authorize resume"

  # Every distributable artifact must carry non-empty app identity metadata.
  # A DMG, ZIP, or appcast without this context can accidentally mix releases.
  for artifact in "$dmg" "$zip" "$appcast"; do
    checkpoint="$(openclaw_jarvis_release_checkpoint_path "$artifact")"
    [[ "$(openclaw_jarvis_release_checkpoint_value "$checkpoint" JARVIS_RELEASE_CHECKPOINT_APP_VERSION)" == "2026.7.15" ]] \
      || fail "artifact checkpoint omitted the exact app version"
    [[ "$(openclaw_jarvis_release_checkpoint_value "$checkpoint" JARVIS_RELEASE_CHECKPOINT_APP_BUILD)" == "1179" ]] \
      || fail "artifact checkpoint omitted the exact app build"
    [[ -n "$(openclaw_jarvis_release_checkpoint_value "$checkpoint" JARVIS_RELEASE_CHECKPOINT_APP_GIT_COMMIT)" ]] \
      || fail "artifact checkpoint omitted the embedded app commit"
  done

  # Signature verification still succeeds, but the signed-code identity is
  # different. This must invalidate every checkpoint inherited by that app.
  export STUB_APP_CDHASH=2222222222222222222222222222222222222222
  if openclaw_jarvis_release_checkpoint_validate "$ROOT_DIR" "$app" app app-notarized "$app_receipt"; then
    fail "different valid signed-code identity inherited an app checkpoint"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE" == "app-signed-code-identity" ]] \
    || fail "CDHash mismatch reported wrong checkpoint failure"
  unset STUB_APP_CDHASH

  # Tampering a non-app checkpoint's recorded app build is rejected even when
  # the artifact bytes and the current app are otherwise unchanged.
  checkpoint="$(openclaw_jarvis_release_checkpoint_path "$dmg")"
  checkpoint_tmp="${checkpoint}.tampered"
  /usr/bin/sed 's/^JARVIS_RELEASE_CHECKPOINT_APP_BUILD=1179$/JARVIS_RELEASE_CHECKPOINT_APP_BUILD=1180/' "$checkpoint" >"$checkpoint_tmp"
  mv -f "$checkpoint_tmp" "$checkpoint"
  if openclaw_jarvis_release_checkpoint_validate "$ROOT_DIR" "$dmg" dmg dmg-notarized "$dmg_receipt" "$app"; then
    fail "tampered DMG app-build binding passed checkpoint validation"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE" == "app-metadata" ]] \
    || fail "tampered DMG app-build binding reported wrong failure"
  openclaw_jarvis_release_checkpoint_write \
    "$ROOT_DIR" "$dmg" dmg dmg-notarized Accepted dmg-submission-1 "$app" >/dev/null

  export STUB_APP_VERSION=2026.7.16
  if openclaw_jarvis_release_checkpoint_validate "$ROOT_DIR" "$zip" zip sparkle-zip "" "$app"; then
    fail "ZIP checkpoint ignored a changed app version"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE" == "app-metadata" ]] \
    || fail "ZIP app-version mismatch reported wrong failure"
  unset STUB_APP_VERSION

  export STUB_APP_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  if openclaw_jarvis_release_checkpoint_validate "$ROOT_DIR" "$appcast" appcast sparkle-appcast "" "$app"; then
    fail "appcast checkpoint ignored a changed embedded app commit"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE" == "app-metadata" ]] \
    || fail "appcast embedded-commit mismatch reported wrong failure"
  unset STUB_APP_COMMIT

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

test_tracked_drift_stops_real_package_entrypoint() {
  local intent_path="$TMP_DIR/package-drift.intent"
  local intent_tmp="$TMP_DIR/package-drift.intent.tmp"
  local intent_id
  local err="$TMP_DIR/package-drift.err"
  local manifest="$TMP_DIR/package-drift-manifest.env"
  local probe="$TMP_DIR/package-drift-probe"
  local probe_marker="$TMP_DIR/package-drift-probe.called"
  local status=0
  export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$intent_path"
  export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=4000
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=package-drift-run
  intent_id="$(openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 60)"
  apply_stub "$probe" '#!/usr/bin/env bash
: >"${PACKAGE_DRIFT_PROBE_MARKER:?}"
printf "fs-drift\t/Volumes/drift\t99999999\t%s\n" "$1"'

  # Simulate the exact intent mismatch produced by a tracked edit after
  # authorization without dirtying this real checkout during the test.
  /usr/bin/sed \
    's/^JARVIS_RELEASE_INTENT_TRACKED_FINGERPRINT=.*/JARVIS_RELEASE_INTENT_TRACKED_FINGERPRINT=0000000000000000000000000000000000000000000000000000000000000000/' \
    "$intent_path" >"$intent_tmp"
  mv -f "$intent_tmp" "$intent_path"

  set +e
  OPENCLAW_MAIN_HOME_CLONE="$(cd "$ROOT_DIR/../.." && pwd -P)" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$(basename "$ROOT_DIR")" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/package-drift.lock" \
  OPENCLAW_JARVIS_RELEASE_MANIFEST="$manifest" \
  PACKAGE_DRIFT_PROBE_MARKER="$probe_marker" \
  JARVIS_RELEASE_DISK_PROBE_COMMAND="$probe" \
    /bin/bash "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" \
      --phase full \
      --release-intent "$intent_id" \
      >/dev/null 2>"$err"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "tracked-drift package intent unexpectedly executed"
  grep -q 'tracked-state-drift' "$err" \
    || fail "real package boundary did not report tracked-state drift"
  [[ "$(grep -c '^recovery_command=' "$err")" == "1" ]] \
    || fail "tracked drift did not print exactly one recovery command"
  grep -q '^recovery_command=bash scripts/jarvis-public-release.sh --authorize$' "$err" \
    || fail "tracked drift printed the wrong recovery command"
  [[ ! -e "$manifest" ]] || fail "package wrote release state after tracked-drift rejection"
  [[ ! -e "$probe_marker" ]] || fail "disk preflight ran before tracked-drift rejection"
  pass "real package entrypoint rejects tracked drift before release mutation"
}

test_package_disk_preflight_targets_and_boundaries() {
  local app_name="JarvisDiskGateTest-$$"
  local explicit_staging="$TMP_DIR/explicit-release-staging"
  local default_artifact_root="$TMP_DIR/default-build-artifacts"
  local default_staging="$default_artifact_root/runs"
  local probe="$TMP_DIR/package-disk-probe"
  local intent_path="$TMP_DIR/package-disk.intent"
  local intent_id
  local out="$TMP_DIR/package-disk.out"
  local err="$TMP_DIR/package-disk.err"
  local race_staging="$TMP_DIR/race-release-staging"
  local replacement_once="$TMP_DIR/package-disk-replacement.once"
  local replacement_marker="$TMP_DIR/package-disk-replacement.done"
  local release_home release_name status

  release_home="$(cd "$ROOT_DIR/../.." && pwd -P)"
  release_name="$(basename "$ROOT_DIR")"
  PACKAGE_MUTATION_SENTINEL="$ROOT_DIR/dist/${app_name}.zip"
  mkdir -p "$(dirname "$PACKAGE_MUTATION_SENTINEL")"
  printf 'must survive failed disk gate\n' >"$PACKAGE_MUTATION_SENTINEL"

  apply_stub "$probe" '#!/usr/bin/env bash
if [[ "${PACKAGE_DISK_PROBE_MODE:?}" == "race" ]]; then
  if mkdir "${PACKAGE_DISK_REPLACEMENT_ONCE:?}" 2>/dev/null; then
    source "${PACKAGE_DISK_INTENT_HELPER:?}"
    OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=replacement-during-disk-probe \
      openclaw_jarvis_release_intent_authorize "${PACKAGE_DISK_GIT_ROOT:?}" 60 >/dev/null
    : >"${PACKAGE_DISK_REPLACEMENT_MARKER:?}"
  fi
  printf "fs-race\t/Volumes/race\t4096\t%s\n" "$1"
  exit 0
fi
case "${PACKAGE_DISK_PROBE_MODE:?}:$1" in
  "cross:${PACKAGE_DISK_EXPECTED_OUTPUT:?}")
    printf "fs-output\t/Volumes/output\t4096\t%s\n" "$1"
    ;;
  "cross:${PACKAGE_DISK_EXPECTED_STAGING:?}")
    printf "fs-staging\t/Volumes/staging\t1024\t%s\n" "$1"
    ;;
  "same:${PACKAGE_DISK_EXPECTED_OUTPUT:?}"|"same:${PACKAGE_DISK_EXPECTED_STAGING:?}")
    printf "fs-shared\t/Volumes/shared\t1024\t%s\n" "$1"
    ;;
  *)
    exit 1
    ;;
esac'

  export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$intent_path"
  export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=4500
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=package-disk-run
  intent_id="$(openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 60)"

  set +e
  APP_NAME="$app_name" \
  SKIP_NOTARIZE=1 \
  ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE=1 \
  ALLOW_COLD_RELEASE_LANE=1 \
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/package-disk-cross.lock" \
  OPENCLAW_RELEASE_ARTIFACT_RUN_ROOT="$explicit_staging" \
  PACKAGE_DISK_PROBE_MODE=cross \
  PACKAGE_DISK_EXPECTED_OUTPUT="$ROOT_DIR/dist" \
  PACKAGE_DISK_EXPECTED_STAGING="$explicit_staging" \
  JARVIS_RELEASE_DISK_REQUIRED_KIB=2048 \
  JARVIS_RELEASE_DISK_PROBE_COMMAND="$probe" \
    /bin/bash "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" \
      --phase build-app-only \
      --release-intent "$intent_id" \
      >"$out" 2>"$err"
  status=$?
  set -e
  [[ "$status" -eq 1 ]] || fail "cross-filesystem package disk gate expected status 1, got $status"
  grep -Fq "target[1].label=release-output" "$out" || fail "package disk gate omitted release-output label"
  grep -Fq "target[1].path=$ROOT_DIR/dist" "$out" || fail "package disk gate used the wrong release output path"
  grep -Fq "target[2].label=release-staging" "$out" || fail "package disk gate omitted release-staging label"
  grep -Fq "target[2].path=$explicit_staging" "$out" || fail "package disk gate changed explicit staging path"
  grep -Fq "filesystem[2].shortfall_kib=1024" "$out" || fail "package disk gate omitted staging shortfall"
  grep -Fq "status=fail" "$out" || fail "package disk gate did not preserve final failure status"
  [[ -f "$PACKAGE_MUTATION_SENTINEL" ]] || fail "cross-filesystem failure deleted the mutation sentinel"
  [[ ! -e "$explicit_staging" ]] || fail "cross-filesystem preflight created explicit staging"

  set +e
  APP_NAME="$app_name" \
  SKIP_NOTARIZE=1 \
  ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE=1 \
  ALLOW_COLD_RELEASE_LANE=1 \
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/package-disk-shared.lock" \
  OPENCLAW_RELEASE_ARTIFACT_RUN_ROOT= \
  OPENCLAW_BUILD_ARTIFACT_ROOT="$default_artifact_root" \
  PACKAGE_DISK_PROBE_MODE=same \
  PACKAGE_DISK_EXPECTED_OUTPUT="$ROOT_DIR/dist" \
  PACKAGE_DISK_EXPECTED_STAGING="$default_staging" \
  JARVIS_RELEASE_DISK_REQUIRED_KIB=2048 \
  JARVIS_RELEASE_DISK_PROBE_COMMAND="$probe" \
    /bin/bash "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" \
      --phase build-app-only \
      --release-intent "$intent_id" \
      >"$out" 2>"$err"
  status=$?
  set -e
  [[ "$status" -eq 1 ]] || fail "same-filesystem package disk gate expected status 1, got $status"
  grep -Fq "target[2].path=$default_staging" "$out" || fail "package disk gate used the wrong default staging parent"
  grep -Fq "target[2].deduplicated=true" "$out" || fail "package disk gate lost same-filesystem deduplication"
  grep -Fq "filesystem[1].labels=release-output,release-staging" "$out" || fail "deduplicated output lost both target labels"
  grep -Fq "filesystems_checked=1" "$out" || fail "same-filesystem package gate checked duplicate filesystems"
  [[ -f "$PACKAGE_MUTATION_SENTINEL" ]] || fail "same-filesystem failure deleted the mutation sentinel"
  [[ ! -e "$default_artifact_root" ]] || fail "default package preflight created staging before capacity pass"

  # Replace the latest intent during the first successful filesystem probe.
  # The second validation must reject the original queued process before its
  # stale-output cleanup glob or release-run-root creation can execute.
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=package-disk-race-original
  intent_id="$(openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 60)"
  set +e
  APP_NAME="$app_name" \
  SKIP_NOTARIZE=1 \
  ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE=1 \
  ALLOW_COLD_RELEASE_LANE=1 \
  OPENCLAW_MAIN_HOME_CLONE="$release_home" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$release_name" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/package-disk-race.lock" \
  OPENCLAW_RELEASE_ARTIFACT_RUN_ROOT="$race_staging" \
  PACKAGE_DISK_PROBE_MODE=race \
  PACKAGE_DISK_REPLACEMENT_ONCE="$replacement_once" \
  PACKAGE_DISK_REPLACEMENT_MARKER="$replacement_marker" \
  PACKAGE_DISK_INTENT_HELPER="$ROOT_DIR/scripts/lib/jarvis-release-intent.sh" \
  PACKAGE_DISK_GIT_ROOT="$ROOT_DIR" \
  JARVIS_RELEASE_DISK_REQUIRED_KIB=2048 \
  JARVIS_RELEASE_DISK_PROBE_COMMAND="$probe" \
    /bin/bash "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" \
      --phase build-app-only \
      --release-intent "$intent_id" \
      >"$out" 2>"$err"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "intent replacement during disk probe unexpectedly reached mutation"
  [[ -d "$replacement_once" && -f "$replacement_marker" ]] \
    || fail "disk probe did not atomically replace the release intent"
  grep -Fq "targets_checked=2" "$out" || fail "replacement fixture did not complete both disk probes"
  grep -Fq "status=pass" "$out" || fail "replacement fixture did not return passing disk data"
  grep -q 'release intent is replaced' "$err" || fail "post-probe boundary did not reject the replaced intent"
  [[ "$(grep -c '^recovery_command=' "$err")" == "1" ]] \
    || fail "post-probe replacement did not print exactly one recovery command"
  grep -q '^recovery_command=bash scripts/jarvis-public-release.sh --authorize$' "$err" \
    || fail "post-probe replacement printed the wrong recovery command"
  [[ -f "$PACKAGE_MUTATION_SENTINEL" ]] || fail "post-probe replacement deleted the mutation sentinel"
  [[ ! -e "$race_staging" ]] || fail "post-probe replacement created release staging"

  rm -f "$PACKAGE_MUTATION_SENTINEL"
  PACKAGE_MUTATION_SENTINEL=""
  pass "package disk gate preserves exact targets, dedup output, and mutation ordering"
}

make_stub_tools
test_intent_latest_wins_and_expiry
test_intent_path_stability
test_intent_default_and_maximum_ttl
test_intent_tracked_state_binding
test_operator_authorization_interface
test_checkpoint_invalid_and_valid_resume
test_expired_intent_prints_one_recovery_command
test_tracked_drift_stops_real_package_entrypoint
test_package_disk_preflight_targets_and_boundaries

echo "All Jarvis release control tests passed."
