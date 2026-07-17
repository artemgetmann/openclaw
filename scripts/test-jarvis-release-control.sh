#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/jarvis-release-intent.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-checkpoint.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-orchestration.sh"

TMP_DIR="$(mktemp -d)"
PACKAGE_MUTATION_SENTINEL=""
TEST_APPCAST_PATH=""
TEST_APPCAST_BACKUP=""
TEST_APPCAST_HAD_ORIGINAL=0

cleanup() {
  if [[ -n "$PACKAGE_MUTATION_SENTINEL" ]]; then
    rm -f "$PACKAGE_MUTATION_SENTINEL"
  fi
  if [[ -n "$TEST_APPCAST_PATH" ]]; then
    if [[ "$TEST_APPCAST_HAD_ORIGINAL" == "1" ]]; then
      cp "$TEST_APPCAST_BACKUP" "$TEST_APPCAST_PATH"
    else
      rm -f "$TEST_APPCAST_PATH"
    fi
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
  export OPENCLAW_RELEASE_ENV_FILE=0
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

test_operator_authorization_preserves_inert_future_flags() {
  local out="$TMP_DIR/authorize-future.out"
  local err="$TMP_DIR/authorize-future.err"
  local intent_path="$TMP_DIR/operator-future.intent"
  local intent_before="$TMP_DIR/operator-future.intent.before"
  local fake_bin="$TMP_DIR/operator-future-bin"
  local gh_sentinel="$TMP_DIR/operator-future-gh.called"
  local misuse_state="$TMP_DIR/operator-future-misuse-state"
  local misuse_summary="$TMP_DIR/operator-future-misuse-summary.env"
  local status

  mkdir -p "$fake_bin"
  apply_stub "$fake_bin/gh" '#!/usr/bin/env bash
: >"${AUTHORIZATION_GH_SENTINEL:?}"
exit 99'
  export AUTHORIZATION_GH_SENTINEL="$gh_sentinel"
  export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$intent_path"
  export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=1550
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=operator-future-run

  PATH="$fake_bin:$PATH" \
  OPENCLAW_MAIN_HOME_CLONE="$(cd "$ROOT_DIR/../.." && pwd -P)" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$(basename "$ROOT_DIR")" \
    /bin/bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --authorize \
      --intent-ttl-seconds 60 \
      --verify-public-assets \
      --latest-release-tag \
      --parallel-safe-local-assets \
      --urgent-sparkle \
      --phase verify-sparkle-assets-only \
      --size-report \
      >"$out"

  [[ ! -e "$gh_sentinel" ]] \
    || fail "authorization resolved --latest-release-tag instead of preserving it inertly"
  grep -Fqx \
    'next_command=bash scripts/jarvis-public-release.sh --release-intent operator-future-run --verify-public-assets --latest-release-tag --parallel-safe-local-assets --urgent-sparkle --phase verify-sparkle-assets-only --size-report' \
    "$out" \
    || fail "future authorization did not print the complete executable wrapper command"
  grep -Fqx \
    'persistent_command=bash scripts/jarvis-public-release-session.sh start -- --release-intent operator-future-run --verify-public-assets --latest-release-tag --parallel-safe-local-assets --urgent-sparkle --phase verify-sparkle-assets-only --size-report' \
    "$out" \
    || fail "future authorization did not print the matching durable transport command"
  [[ -n "$(openclaw_jarvis_release_intent_value "$intent_path" JARVIS_RELEASE_INTENT_ACTION_FINGERPRINT)" ]] \
    || fail "future authorization did not bind its execution-shaping action"

  # A wrapper-bound intent is not a second package authority. Direct package
  # validation has no wrapper action context and must fail closed; only the
  # matching wrapper can propagate the recomputed digest to package boundaries.
  unset OPENCLAW_JARVIS_RELEASE_INTENT_ACTION_FINGERPRINT
  if openclaw_jarvis_release_intent_validate "$ROOT_DIR" operator-future-run; then
    fail "direct package-style validation bypassed a wrapper action binding"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_INTENT_FAILURE" == "action" ]] \
    || fail "missing wrapper action context reported the wrong intent failure"
  export OPENCLAW_JARVIS_RELEASE_INTENT_ACTION_FINGERPRINT
  OPENCLAW_JARVIS_RELEASE_INTENT_ACTION_FINGERPRINT="$(
    openclaw_jarvis_release_intent_value "$intent_path" JARVIS_RELEASE_INTENT_ACTION_FINGERPRINT
  )"
  openclaw_jarvis_release_intent_validate "$ROOT_DIR" operator-future-run \
    || fail "matching wrapper action context did not validate its bound intent"
  unset OPENCLAW_JARVIS_RELEASE_INTENT_ACTION_FINGERPRINT

  # Reusing a verify authorization for publication must fail before locks,
  # reports, state inspection, GitHub lookup, or delegated package mutation.
  set +e
  OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$misuse_state" \
  OPENCLAW_JARVIS_PUBLIC_RELEASE_SUMMARY="$misuse_summary" \
  OPENCLAW_MAIN_HOME_CLONE="$(cd "$ROOT_DIR/../.." && pwd -P)" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$(basename "$ROOT_DIR")" \
    /bin/bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --release-intent operator-future-run \
      --publish-release-assets \
      --github-release-tag v-misuse \
      --phase publish-assets-only \
      >"$out" 2>"$err"
  status=$?
  set -e
  [[ "$status" -eq 2 ]] || fail "verify intent reused for publish returned $status instead of 2"
  grep -q 'intent action does not match' "$err" \
    || fail "verify-to-publish misuse did not report the action binding"
  [[ ! -e "$misuse_state" && ! -e "$misuse_summary" ]] \
    || fail "verify-to-publish misuse mutated release state before rejection"
  [[ ! -e "$gh_sentinel" ]] \
    || fail "verify-to-publish misuse reached GitHub before rejection"

  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=operator-publish-run
  OPENCLAW_MAIN_HOME_CLONE="$(cd "$ROOT_DIR/../.." && pwd -P)" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$(basename "$ROOT_DIR")" \
    /bin/bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --authorize \
      --intent-ttl-seconds 60 \
      --publish-release-assets \
      --github-release-tag v-current \
      --phase publish-assets-only \
      >"$out"
  grep -Fqx \
    'next_command=bash scripts/jarvis-public-release.sh --release-intent operator-publish-run --publish-release-assets --github-release-tag v-current --phase publish-assets-only' \
    "$out" \
    || fail "publish authorization did not preserve its explicit tag and publication intent"

  cp "$intent_path" "$intent_before"
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=must-not-replace
  set +e
  OPENCLAW_MAIN_HOME_CLONE="$(cd "$ROOT_DIR/../.." && pwd -P)" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$(basename "$ROOT_DIR")" \
    /bin/bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --authorize \
      --publish-release-assets \
      --verify-public-assets \
      >"$out" 2>"$err"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "authorization accepted conflicting publish and verify flags"
  cmp -s "$intent_before" "$intent_path" \
    || fail "publish/verify conflict replaced the durable release intent"

  set +e
  OPENCLAW_MAIN_HOME_CLONE="$(cd "$ROOT_DIR/../.." && pwd -P)" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$(basename "$ROOT_DIR")" \
    /bin/bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --authorize \
      --latest-release-tag \
      --github-release-tag v-conflict \
      >"$out" 2>"$err"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "authorization accepted conflicting tag selectors"
  cmp -s "$intent_before" "$intent_path" \
    || fail "tag-selector conflict replaced the durable release intent"
  pass "authorization preserves validated future flags and rejects conflicts before intent creation"
}

test_authorization_persistence_failure_is_fatal() {
  local blocked_parent="$TMP_DIR/intent-parent-blocker"
  local out="$TMP_DIR/authorize-persistence.out"
  local err="$TMP_DIR/authorize-persistence.err"
  local status=0

  # A regular file where the intent directory must exist deterministically
  # exercises the same failure contract as a full or unwritable filesystem.
  printf 'not a directory\n' >"$blocked_parent"
  export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$blocked_parent/release.intent"
  export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=1600
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=persistence-must-fail

  set +e
  OPENCLAW_MAIN_HOME_CLONE="$(cd "$ROOT_DIR/../.." && pwd -P)" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$(basename "$ROOT_DIR")" \
    /bin/bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --authorize \
      --intent-ttl-seconds 60 \
      >"$out" 2>"$err"
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || fail "authorization succeeded without durable intent storage"
  ! grep -q '^jarvis_release_intent=authorized$' "$out" \
    || fail "failed intent persistence reported authorization success"
  ! grep -q '^next_command=' "$out" \
    || fail "failed intent persistence printed an unusable next command"
  [[ "$(grep -c '^recovery_command=' "$err")" == "1" ]] \
    || fail "failed intent persistence did not print exactly one recovery command"
  pass "authorization fails closed when its durable intent cannot be persisted"
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

  # Stapling is necessary but not sufficient: current Gatekeeper policy must
  # still accept the notarized app every time its checkpoint is resumed.
  export STUB_SPCTL_FAIL=1
  if openclaw_jarvis_release_checkpoint_validate "$ROOT_DIR" "$app" app app-notarized "$app_receipt"; then
    fail "notarized app checkpoint bypassed live Gatekeeper validation"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE" == "gatekeeper" ]] \
    || fail "app Gatekeeper failure reported wrong checkpoint failure"
  unset STUB_SPCTL_FAIL

  # Apple acceptance must survive local staple/Gatekeeper trouble without
  # weakening the artifact, app-identity, or receipt bindings used on retry.
  export STUB_SPCTL_FAIL=1
  openclaw_jarvis_release_checkpoint_write \
    "$ROOT_DIR" "$app" app app-notary-accepted Accepted app-submission-1 >/dev/null
  openclaw_jarvis_release_checkpoint_validate \
    "$ROOT_DIR" "$app" app app-notary-accepted "$app_receipt" \
    || fail "accepted app proof was lost when Gatekeeper remained unavailable"
  openclaw_jarvis_release_checkpoint_write \
    "$ROOT_DIR" "$dmg" dmg dmg-notary-accepted Accepted dmg-submission-1 "$app" >/dev/null
  openclaw_jarvis_release_checkpoint_validate \
    "$ROOT_DIR" "$dmg" dmg dmg-notary-accepted "$dmg_receipt" "$app" \
    || fail "accepted DMG proof was lost when Gatekeeper remained unavailable"
  printf 'changed accepted dmg bytes\n' >>"$dmg"
  if openclaw_jarvis_release_checkpoint_validate \
    "$ROOT_DIR" "$dmg" dmg dmg-notary-accepted "$dmg_receipt" "$app"; then
    fail "accepted DMG retry proof ignored changed artifact bytes"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE" == "checksum" ]] \
    || fail "accepted DMG byte drift reported wrong checkpoint failure"
  unset STUB_SPCTL_FAIL
  pass "invalid checkpoints fail and valid artifact-bound notarized resume passes"
}

test_in_progress_receipt_preserves_submitted_checkpoint() {
  local root="$TMP_DIR/in-progress-submission"
  local app="$root/Jarvis.app"
  local dmg="$root/Jarvis.dmg"
  local receipt="$root/Jarvis.dmg.notary.env"
  local dmg_absolute

  mkdir -p "$root"
  make_fake_app "$app"
  printf 'signed submitted dmg bytes\n' >"$dmg"
  dmg_absolute="$(openclaw_jarvis_release_checkpoint_absolute_path "$dmg")"
  write_notary_receipt "$receipt" "$dmg_absolute" "" submitted dmg-pending-id
  openclaw_jarvis_release_checkpoint_write \
    "$ROOT_DIR" "$dmg" dmg dmg-notary-submitted submitted dmg-pending-id "$app" >/dev/null

  # The canonical helper writes receipt values with printf %q, so Apple's
  # two-word status is persisted with a literal backslash before the space.
  write_notary_receipt "$receipt" "$dmg_absolute" "" "In\\ Progress" dmg-pending-id
  openclaw_jarvis_release_checkpoint_validate \
    "$ROOT_DIR" "$dmg" dmg dmg-notary-submitted "$receipt" "$app" \
    || fail "In Progress receipt invalidated the submitted DMG checkpoint"

  write_notary_receipt "$receipt" "$dmg_absolute" "" "In\\ Progress" wrong-pending-id
  if openclaw_jarvis_release_checkpoint_validate "$ROOT_DIR" "$dmg" dmg dmg-notary-submitted "$receipt" "$app"; then
    fail "In Progress receipt with a different submission ID inherited the checkpoint"
  fi
  [[ "$OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE" == "notary-receipt" ]] \
    || fail "pending submission mismatch reported the wrong failure"

  write_notary_receipt "$receipt" "$dmg_absolute" "" Rejected dmg-pending-id
  if openclaw_jarvis_release_checkpoint_validate "$ROOT_DIR" "$dmg" dmg dmg-notary-submitted "$receipt" "$app"; then
    fail "terminal rejected receipt inherited a submitted poll checkpoint"
  fi
  pass "In Progress preserves same-ID polling while mismatched and terminal receipts fail closed"
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

test_final_submit_and_upload_guards_reject_replacement() {
  local intent_path="$TMP_DIR/final-seams.intent"
  local intent_id
  local fake_bin="$TMP_DIR/final-seams-bin"
  local route_stub="$TMP_DIR/final-seams-route"
  local curl_stub="$TMP_DIR/final-seams-curl"
  local artifact="$TMP_DIR/final-seams.zip"
  local replace_once="$TMP_DIR/final-seams-replace.once"
  local replacement_marker="$TMP_DIR/final-seams-replaced"
  local submit_sentinel="$TMP_DIR/final-seams-submit.called"
  local upload_sentinel="$TMP_DIR/final-seams-upload.called"
  local appcast="$ROOT_DIR/dist/jarvis-appcast.xml"
  local appcast_backup="$TMP_DIR/original-jarvis-appcast.xml"
  local had_appcast=0
  local out="$TMP_DIR/final-seams.out"
  local err="$TMP_DIR/final-seams.err"
  local status=0
  local publish_kind

  mkdir -p "$fake_bin"
  printf 'notary upload bytes\n' >"$artifact"
  apply_stub "$fake_bin/xcrun" '#!/usr/bin/env bash
: >"${FINAL_SEAM_SUBMIT_SENTINEL:?}"
printf "{\"id\":\"must-not-submit\"}\n"'
  apply_stub "$route_stub" '#!/usr/bin/env bash
if mkdir "${FINAL_SEAM_REPLACE_ONCE:?}" 2>/dev/null; then
  source "${FINAL_SEAM_INTENT_HELPER:?}"
  OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=replacement-at-final-seam \
    openclaw_jarvis_release_intent_authorize "${FINAL_SEAM_GIT_ROOT:?}" 60 >/dev/null
  : >"${FINAL_SEAM_REPLACEMENT_MARKER:?}"
fi
printf "interface: en0\n"'
  apply_stub "$curl_stub" '#!/usr/bin/env bash
printf "200\n"'

  export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$intent_path"
  export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=5500
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=original-final-seam
  intent_id="$(openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 60)"
  export FINAL_SEAM_REPLACE_ONCE="$replace_once"
  export FINAL_SEAM_INTENT_HELPER="$ROOT_DIR/scripts/lib/jarvis-release-intent.sh"
  export FINAL_SEAM_GIT_ROOT="$ROOT_DIR"
  export FINAL_SEAM_REPLACEMENT_MARKER="$replacement_marker"
  export FINAL_SEAM_SUBMIT_SENTINEL="$submit_sentinel"

  set +e
  PATH="$fake_bin:$PATH" \
  NOTARYTOOL_PROFILE=test-profile \
  OPENCLAW_NOTARY_PREFLIGHT_ROUTE_STUB="$route_stub" \
  OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ROOT="$ROOT_DIR" \
  OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ID="$intent_id" \
    /bin/bash "$ROOT_DIR/scripts/notarize-mac-artifact.sh" \
      --submit-only "$artifact" >"$out" 2>"$err"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "replaced intent reached Apple submit"
  [[ -f "$replacement_marker" ]] || fail "Apple route preflight did not replace intent"
  [[ ! -e "$submit_sentinel" ]] || fail "Apple submit ran after intent replacement"

  # Exercise the exact production upload functions while replacing the intent
  # from their real route preflight. Both upload variants must stop before gh.
  source "$ROOT_DIR/scripts/lib/github-release-upload-preflight.sh"
  source "$ROOT_DIR/scripts/lib/jarvis-release-orchestration.sh"
  eval "$(/usr/bin/sed -n '/^publish_release_assets() {/,/^}/p' "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh")"
  eval "$(/usr/bin/sed -n '/^publish_sparkle_release_assets() {/,/^}/p' "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh")"
  require_latest_release_tag() { return 0; }
  require_local_appcast_targets_current_tag() { return 0; }
  verify_public_release_assets() { return 0; }
  verify_sparkle_public_release_assets() { return 0; }
  gh() { : >"$upload_sentinel"; return 0; }
  PUBLISH_RELEASE_ASSETS=1
  GITHUB_RELEASE_REPO=artemgetmann/openclaw
  GITHUB_RELEASE_TAG=v-test
  DMG="$TMP_DIR/final-seams.dmg"
  ZIP="$TMP_DIR/final-seams-release.zip"
  APP_PATH="$TMP_DIR/final-seams.app"
  printf 'dmg\n' >"$DMG"
  printf 'zip\n' >"$ZIP"
  mkdir -p "$APP_PATH" "$ROOT_DIR/dist"
  if [[ -f "$appcast" ]]; then
    cp "$appcast" "$appcast_backup"
    had_appcast=1
  fi
  TEST_APPCAST_PATH="$appcast"
  TEST_APPCAST_BACKUP="$appcast_backup"
  TEST_APPCAST_HAD_ORIGINAL="$had_appcast"
  printf '<rss/>\n' >"$appcast"
  export OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_ROUTE_STUB="$route_stub"
  export OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_CURL_STUB="$curl_stub"

  for publish_kind in full sparkle; do
    rm -rf "$replace_once" "$replacement_marker" "$upload_sentinel"
    export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE="original-${publish_kind}-upload"
    RELEASE_INTENT_ID="$(openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 60)"
    set +e
    if [[ "$publish_kind" == "full" ]]; then
      (set -e; publish_release_assets) >"$out" 2>"$err"
    else
      (set -e; publish_sparkle_release_assets) >"$out" 2>"$err"
    fi
    status=$?
    set -e
    [[ "$status" -ne 0 ]] || fail "$publish_kind upload accepted a replaced intent"
    [[ -f "$replacement_marker" ]] || fail "$publish_kind upload preflight did not replace intent"
    [[ ! -e "$upload_sentinel" ]] || fail "$publish_kind gh upload ran after intent replacement"
  done

  if [[ "$had_appcast" == "1" ]]; then
    cp "$appcast_backup" "$appcast"
  else
    rm -f "$appcast"
  fi
  TEST_APPCAST_PATH=""
  TEST_APPCAST_BACKUP=""
  TEST_APPCAST_HAD_ORIGINAL=0
  pass "final Apple and GitHub submission seams reject atomic intent replacement"
}

test_retry_upload_guards_reject_replacement_before_second_gh() {
  local intent_path="$TMP_DIR/retry-upload.intent"
  local route_stub="$TMP_DIR/retry-upload-route"
  local curl_stub="$TMP_DIR/retry-upload-curl"
  local first_gh_marker="$TMP_DIR/retry-upload-first-gh"
  local second_gh_marker="$TMP_DIR/retry-upload-second-gh"
  local args_log="$TMP_DIR/retry-upload-args"
  local expected_args="$TMP_DIR/retry-upload-expected"
  local appcast="$ROOT_DIR/dist/jarvis-appcast.xml"
  local appcast_backup="$TMP_DIR/retry-upload-appcast.xml"
  local had_appcast=0
  local out="$TMP_DIR/retry-upload.out"
  local err="$TMP_DIR/retry-upload.err"
  local status=0
  local publish_kind

  # Keep preflight successful so the race occurs at the mutating boundary:
  # attempt one reaches gh, gh transiently fails while replacing the intent,
  # and attempt two must reject before invoking gh again.
  apply_stub "$route_stub" '#!/usr/bin/env bash
printf "interface: en0\n"'
  apply_stub "$curl_stub" '#!/usr/bin/env bash
printf "200\n"'

  source "$ROOT_DIR/scripts/lib/github-release-upload-preflight.sh"
  source "$ROOT_DIR/scripts/lib/jarvis-release-orchestration.sh"
  eval "$(/usr/bin/sed -n '/^jarvis_release_upload_full_assets_attempt() {/,/^}/p' "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh")"
  eval "$(/usr/bin/sed -n '/^jarvis_release_upload_sparkle_assets_attempt() {/,/^}/p' "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh")"
  eval "$(/usr/bin/sed -n '/^publish_release_assets() {/,/^}/p' "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh")"
  eval "$(/usr/bin/sed -n '/^publish_sparkle_release_assets() {/,/^}/p' "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh")"
  require_latest_release_tag() { return 0; }
  require_local_appcast_targets_current_tag() { return 0; }
  verify_public_release_assets() { return 0; }
  verify_sparkle_public_release_assets() { return 0; }

  gh() {
    local arg
    for arg in "$@"; do
      printf '%s\n' "$arg" >>"${RETRY_UPLOAD_ARGS_LOG:?}"
    done
    if [[ ! -e "${RETRY_UPLOAD_FIRST_GH_MARKER:?}" ]]; then
      : >"$RETRY_UPLOAD_FIRST_GH_MARKER"
      OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE="replacement-${RETRY_UPLOAD_KIND:?}" \
        openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 60 >/dev/null
      echo "connection reset" >&2
      return 1
    fi
    : >"${RETRY_UPLOAD_SECOND_GH_MARKER:?}"
    return 0
  }

  PUBLISH_RELEASE_ASSETS=1
  GITHUB_RELEASE_REPO=artemgetmann/openclaw
  GITHUB_RELEASE_TAG=v-test
  DMG="$TMP_DIR/retry-upload.dmg"
  ZIP="$TMP_DIR/retry-upload-release.zip"
  APP_PATH="$TMP_DIR/retry-upload.app"
  printf 'dmg\n' >"$DMG"
  printf 'zip\n' >"$ZIP"
  mkdir -p "$APP_PATH" "$ROOT_DIR/dist"
  if [[ -f "$appcast" ]]; then
    cp "$appcast" "$appcast_backup"
    had_appcast=1
  fi
  TEST_APPCAST_PATH="$appcast"
  TEST_APPCAST_BACKUP="$appcast_backup"
  TEST_APPCAST_HAD_ORIGINAL="$had_appcast"
  printf '<rss/>\n' >"$appcast"

  export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$intent_path"
  export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=5600
  export OPENCLAW_GITHUB_RELEASE_RETRY_ATTEMPTS=2
  export OPENCLAW_GITHUB_RELEASE_RETRY_SLEEP_SECS=0
  export OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_ROUTE_STUB="$route_stub"
  export OPENCLAW_GITHUB_UPLOAD_PREFLIGHT_CURL_STUB="$curl_stub"
  export RETRY_UPLOAD_FIRST_GH_MARKER="$first_gh_marker"
  export RETRY_UPLOAD_SECOND_GH_MARKER="$second_gh_marker"
  export RETRY_UPLOAD_ARGS_LOG="$args_log"

  for publish_kind in full sparkle; do
    rm -f "$first_gh_marker" "$second_gh_marker" "$args_log" "$expected_args"
    export RETRY_UPLOAD_KIND="$publish_kind"
    export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE="original-${publish_kind}-upload"
    RELEASE_INTENT_ID="$(openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 60)"
    if [[ "$publish_kind" == "full" ]]; then
      printf '%s\n' release upload "$GITHUB_RELEASE_TAG" "$DMG" "$ZIP" "$appcast" \
        --repo "$GITHUB_RELEASE_REPO" --clobber >"$expected_args"
    else
      printf '%s\n' release upload "$GITHUB_RELEASE_TAG" "$ZIP" "$appcast" \
        --repo "$GITHUB_RELEASE_REPO" --clobber >"$expected_args"
    fi

    set +e
    if [[ "$publish_kind" == "full" ]]; then
      (set -e; publish_release_assets) >"$out" 2>"$err"
    else
      (set -e; publish_sparkle_release_assets) >"$out" 2>"$err"
    fi
    status=$?
    set -e
    [[ "$status" -ne 0 ]] || fail "$publish_kind retry accepted a replaced intent"
    [[ -f "$first_gh_marker" ]] || fail "$publish_kind retry never reached gh attempt one"
    [[ ! -e "$second_gh_marker" ]] || fail "$publish_kind retry invoked gh after intent replacement"
    cmp -s "$expected_args" "$args_log" \
      || fail "$publish_kind retry changed the exact gh upload argument set"
    grep -q 'retrying attempt 2/2' "$err" \
      || fail "$publish_kind retry did not preserve transient retry diagnostics"
    grep -q 'release intent is replaced' "$err" \
      || fail "$publish_kind retry did not validate the replaced intent before gh"
  done

  if [[ "$had_appcast" == "1" ]]; then
    cp "$appcast_backup" "$appcast"
  else
    rm -f "$appcast"
  fi
  TEST_APPCAST_PATH=""
  TEST_APPCAST_BACKUP=""
  TEST_APPCAST_HAD_ORIGINAL=0
  pass "full and Sparkle retries validate replacement before a second gh upload and preserve arguments"
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
  local package_temp="$TMP_DIR"
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
  "cross:${PACKAGE_DISK_EXPECTED_PACKAGE_TEMP:?}")
    printf "fs-package-temp\t/Volumes/package-temp\t4096\t%s\n" "$1"
    ;;
  "cross:/tmp")
    printf "fs-dmg-temp\t/Volumes/dmg-temp\t4096\t%s\n" "$1"
    ;;
  "same:${PACKAGE_DISK_EXPECTED_OUTPUT:?}"|"same:${PACKAGE_DISK_EXPECTED_STAGING:?}"|"same:${PACKAGE_DISK_EXPECTED_PACKAGE_TEMP:?}"|"same:/tmp")
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
  PACKAGE_DISK_EXPECTED_PACKAGE_TEMP="$package_temp" \
  TMPDIR="$package_temp" \
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
  grep -Fq "target[3].label=package-temp" "$out" || fail "package disk gate omitted package-mac-app temp label"
  grep -Fq "target[3].path=$package_temp" "$out" || fail "package disk gate changed TMPDIR staging path"
  grep -Fq "target[4].label=dmg-temp" "$out" || fail "package disk gate omitted create-dmg temp label"
  grep -Fq "target[4].path=/tmp" "$out" || fail "package disk gate changed create-dmg hardcoded temp path"
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
  PACKAGE_DISK_EXPECTED_PACKAGE_TEMP="$package_temp" \
  TMPDIR="$package_temp" \
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
  grep -Fq "target[3].deduplicated=true" "$out" || fail "package temp target lost same-filesystem deduplication"
  grep -Fq "target[4].deduplicated=true" "$out" || fail "DMG temp target lost same-filesystem deduplication"
  grep -Fq "filesystem[1].labels=release-output,release-staging,package-temp,dmg-temp" "$out" || fail "deduplicated output lost one or more target labels"
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
  TMPDIR="$package_temp" \
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
  grep -Fq "targets_checked=4" "$out" || fail "replacement fixture did not complete all disk probes"
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

test_package_release_mutation_guards_are_wired() {
  local package_script="$ROOT_DIR/scripts/package-openclaw-mac-dist.sh"

  # This is a narrow source-order contract because running the real branches
  # would create/sign distribution artifacts or call Apple's notary service.
  # The assertions still inspect the executable production function and case
  # bodies, not duplicated fixture logic.
  /usr/bin/awk '
    /^create_signed_dmg\(\)/ { in_dmg = 1 }
    in_dmg && /if \[\[ -n "\$SIGNING_AUTHORITY" \]\]/ { signed_guard = 1 }
    in_dmg && /dmg dmg-signed/ {
      if (!signed_guard) exit 1
      signed_checkpoint = 1
    }
    in_dmg && /^}/ {
      if (!signed_checkpoint) exit 1
      in_dmg = 0
    }
    /poll-app-notarization\)/ { app_poll_intent = 0 }
    /openclaw_require_jarvis_release_intent .*app notarization poll/ { app_poll_intent = 1 }
    /^[[:space:]]*poll_app_notarization_only$/ {
      if (!app_poll_intent) exit 1
      app_poll_guarded = 1
    }
    /poll-dmg-notarization\)/ { dmg_poll_intent = 0 }
    /openclaw_require_jarvis_release_intent .*DMG notarization poll/ { dmg_poll_intent = 1 }
    /^[[:space:]]*poll_dmg_notarization_only$/ {
      if (!dmg_poll_intent) exit 1
      dmg_poll_guarded = 1
    }
    /^  echo "📦 Notary zip: \$NOTARY_ZIP"/ { full_app_notary = 1 }
    full_app_notary && /^[[:space:]]*verify_app_bundle$/ { release_app_verified = 1 }
    full_app_notary && /write_app_checkpoint_from_receipt app-notarized/ {
      if (!release_app_verified) exit 1
      verified_app_checkpoint = 1
    }
    /^appcast_started_ms=/ { final_asset_path = 1 }
    final_asset_path && /appcast sparkle-appcast/ {
      if (notarize_guard) {
        smoke_appcast_guarded = 1
      }
    }
    /if \[\[ "\$NOTARIZE" == "1" \]\]/ { notarize_guard = 1 }
    /^fi$/ { notarize_guard = 0 }
    /openclaw_require_jarvis_release_intent .*handoff artifact copy/ { handoff_intent = 1 }
    /^copy_handoff_artifacts$/ {
      if (!handoff_intent) exit 1
      handoff_guarded = 1
    }
    END {
      if (!signed_checkpoint || !app_poll_guarded || !dmg_poll_guarded || !smoke_appcast_guarded || !verified_app_checkpoint || !handoff_guarded) exit 1
    }
  ' "$package_script" \
    || fail "package script lost a signature, appcast, poll, or handoff intent mutation guard"

  pass "package signature, appcast, notary-poll, and handoff mutation guards are wired"
}

extract_package_release_function() {
  local function_name="$1"
  local next_function="$2"

  # Extract executable production bodies without running package setup/build.
  /usr/bin/sed -n \
    "/^${function_name}() {/,/^${next_function}() {/ { /^${next_function}() {/!p; }" \
    "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh"
}

make_notary_adversarial_xcrun() {
  local path="$1"
  apply_stub "$path" '#!/usr/bin/env bash
case "${1:-}:${2:-}" in
  notarytool:submit)
    if [[ -n "${NOTARY_WAIT_REPLACE_ONCE:-}" ]] && mkdir "$NOTARY_WAIT_REPLACE_ONCE" 2>/dev/null; then
      source "${NOTARY_INTENT_HELPER:?}"
      OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE="${NOTARY_REPLACEMENT_INTENT_ID:?}" \
        openclaw_jarvis_release_intent_authorize "${NOTARY_INTENT_ROOT:?}" 3600 >/dev/null
      : >"${NOTARY_WAIT_REPLACEMENT_MARKER:?}"
      printf "{\"id\":\"%s\",\"status\":\"Accepted\"}\n" "${NOTARY_SUBMISSION_ID:?}"
      exit 0
    fi
    if [[ -n "${NOTARY_SUBMIT_COUNT_FILE:-}" && -f "$NOTARY_SUBMIT_COUNT_FILE" ]]; then
      : >"${NOTARY_RESUBMIT_SENTINEL:?}"
    fi
    if [[ -n "${NOTARY_SUBMIT_COUNT_FILE:-}" ]]; then
      : >"$NOTARY_SUBMIT_COUNT_FILE"
    fi
    printf "{\"id\":\"%s\"}\n" "${NOTARY_SUBMISSION_ID:?}"
    exit "${NOTARY_SUBMIT_STATUS:-23}"
    ;;
  notarytool:info)
    if [[ -n "${NOTARY_POLL_REPLACE_ONCE:-}" ]] && mkdir "$NOTARY_POLL_REPLACE_ONCE" 2>/dev/null; then
      source "${NOTARY_INTENT_HELPER:?}"
      OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE="${NOTARY_REPLACEMENT_INTENT_ID:?}" \
        openclaw_jarvis_release_intent_authorize "${NOTARY_INTENT_ROOT:?}" 3600 >/dev/null
      : >"${NOTARY_POLL_REPLACEMENT_MARKER:?}"
    fi
    printf "{\"id\":\"%s\",\"status\":\"Accepted\"}\n" "${NOTARY_SUBMISSION_ID:?}"
    ;;
  stapler:staple)
    : >"${NOTARY_STAPLER_SENTINEL:?}"
    ;;
  *)
    exit 0
    ;;
esac'
}

seed_notary_fixture_app() {
  local root="$1"
  mkdir -p "$root/dist"
  make_fake_app "$root/dist/Jarvis.app"
  printf 'signed dmg bytes\n' >"$root/dist/Jarvis.dmg"
}

test_nonzero_notary_submit_preserves_submitted_checkpoint_and_poll_selection() {
  local kind root app dmg artifact receipt checkpoint submit_out wrapper_out status
  local fake_bin count_file resubmit_sentinel intent_id

  for kind in app dmg; do
    root="$TMP_DIR/nonzero-submit-$kind"
    fake_bin="$root/bin"
    count_file="$root/submit.count"
    resubmit_sentinel="$root/resubmit.sentinel"
    submit_out="$root/submit.out"
    wrapper_out="$root/wrapper.out"
    mkdir -p "$fake_bin"
    root="$(cd "$root" && pwd -P)"
    fake_bin="$root/bin"
    count_file="$root/submit.count"
    resubmit_sentinel="$root/resubmit.sentinel"
    submit_out="$root/submit.out"
    wrapper_out="$root/wrapper.out"
    seed_notary_fixture_app "$root"
    app="$root/dist/Jarvis.app"
    dmg="$root/dist/Jarvis.dmg"
    artifact="$root/dist/${kind}-upload.zip"
    receipt="$root/dist/Jarvis.${kind}.notary.env"
    [[ "$kind" == "app" ]] && receipt="$root/dist/Jarvis.app.notary.env"
    [[ "$kind" == "dmg" ]] && receipt="$root/dist/Jarvis.dmg.notary.env"
    printf 'notary artifact bytes\n' >"$artifact"
    make_notary_adversarial_xcrun "$fake_bin/xcrun"

    export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$root/release.intent"
    export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=6000
    export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE="nonzero-submit-$kind"
    intent_id="$(openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 3600)"
    export NOTARY_SUBMISSION_ID="${kind}-durable-submission"
    export NOTARY_SUBMIT_STATUS=23
    export NOTARY_SUBMIT_COUNT_FILE="$count_file"
    export NOTARY_RESUBMIT_SENTINEL="$resubmit_sentinel"
    export NOTARYTOOL_PROFILE=test-profile

    eval "$(extract_package_release_function submit_app_notarization_only poll_app_notarization_only)"
    eval "$(extract_package_release_function submit_dmg_notarization_only poll_dmg_notarization_only)"
    eval "$(extract_package_release_function write_app_checkpoint_from_receipt write_dmg_checkpoint_from_receipt)"
    eval "$(extract_package_release_function write_dmg_checkpoint_from_receipt require_resume_checkpoints_for_phase)"
    eval "$(extract_package_release_function notary_receipt_submission_id notary_receipt_has_submitted_submission_id)"
    eval "$(extract_package_release_function notary_receipt_has_submitted_submission_id write_release_manifest)"
    app_notary_receipt_path() { printf '%s\n' "$root/dist/Jarvis.app.notary.env"; }
    dmg_notary_receipt_path() { printf '%s\n' "$root/dist/Jarvis.dmg.notary.env"; }
    notary_receipt_status() { receipt_value "$1" NOTARY_STATUS; }
    release_checkpoint_receipt_submission_id() { receipt_value "$1" NOTARY_SUBMISSION_ID; }
    receipt_value() { /usr/bin/sed -n "s/^$2=//p" "$1" | /usr/bin/head -n 1; }
    write_release_manifest() { :; }
    require_app_notarized_manifest() { :; }
    create_signed_dmg() { :; }

    APP_PATH="$app"
    DMG="$dmg"
    NOTARY_ZIP="$artifact"
    RELEASE_INTENT_ID="$intent_id"
    set +e
    if [[ "$kind" == "app" ]]; then
      (PATH="$fake_bin:$PATH" submit_app_notarization_only) >"$submit_out" 2>&1
    else
      (PATH="$fake_bin:$PATH" submit_dmg_notarization_only) >"$submit_out" 2>&1
    fi
    status=$?
    set -e
    if [[ "$status" -ne 23 ]]; then
      cat "$submit_out" >&2
      fail "$kind nonzero submit did not preserve helper status (got $status)"
    fi
    [[ -f "$receipt" ]] || fail "$kind nonzero submit did not write a durable receipt"
    [[ "$(receipt_value "$receipt" NOTARY_STATUS)" == submitted ]] || fail "$kind receipt was not strict submitted"
    if [[ "$kind" == "app" ]]; then
      checkpoint="$(openclaw_jarvis_release_checkpoint_path "$app")"
    else
      checkpoint="$(openclaw_jarvis_release_checkpoint_path "$dmg")"
    fi
    [[ -f "$checkpoint" ]] || fail "$kind nonzero submit did not write a strict submitted checkpoint"
    grep -q 'JARVIS_RELEASE_CHECKPOINT_INTENDED_PHASE=app-notary-submitted\|JARVIS_RELEASE_CHECKPOINT_INTENDED_PHASE=dmg-notary-submitted' "$checkpoint" \
      || fail "$kind checkpoint was not strict submitted"

    if [[ "$kind" == "dmg" ]]; then
      write_notary_receipt "$root/dist/Jarvis.app.notary.env" "$artifact" "$app" Accepted app-prior-id
      openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$app" app app-notarized Accepted app-prior-id >/dev/null
    fi
    OPENCLAW_JARVIS_RELEASE_STATE_ROOT="$root" \
      bash "$ROOT_DIR/scripts/jarvis-public-release.sh" --dry-run >"$wrapper_out"
    if ! grep -q "selected_phase=poll-${kind}-notarization" "$wrapper_out"; then
      fail "$kind wrapper did not select poll-${kind}-notarization"
    fi
    [[ ! -e "$resubmit_sentinel" ]] || fail "$kind automatic recovery reached a resubmit sentinel"
    pass "$kind nonzero submit preserves strict submitted state and auto-selects poll"
  done
}

test_slow_notary_poll_revalidates_before_all_mutations() {
  local kind root app dmg artifact receipt checkpoint receipt_before checkpoint_before
  local fake_bin replace_once replacement_marker stapler_sentinel manifest_sentinel status
  local intent_id

  for kind in app dmg; do
    root="$TMP_DIR/slow-poll-$kind"
    fake_bin="$root/bin"
    replace_once="$root/replaced.once"
    replacement_marker="$root/replaced.marker"
    stapler_sentinel="$root/stapler.sentinel"
    manifest_sentinel="$root/manifest.sentinel"
    mkdir -p "$fake_bin"
    seed_notary_fixture_app "$root"
    app="$root/dist/Jarvis.app"
    dmg="$root/dist/Jarvis.dmg"
    artifact="$root/dist/${kind}-upload.zip"
    receipt="$root/dist/Jarvis.${kind}.notary.env"
    [[ "$kind" == "app" ]] && receipt="$root/dist/Jarvis.app.notary.env"
    [[ "$kind" == "dmg" ]] && receipt="$root/dist/Jarvis.dmg.notary.env"
    printf 'original upload bytes\n' >"$artifact"
    if [[ "$kind" == "app" ]]; then
      write_notary_receipt "$receipt" "$artifact" "$app" submitted app-slow-id
      openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$app" app app-notary-submitted submitted app-slow-id >/dev/null
      checkpoint="$(openclaw_jarvis_release_checkpoint_path "$app")"
    else
      write_notary_receipt "$receipt" "$dmg" "" submitted dmg-slow-id
      openclaw_jarvis_release_checkpoint_write "$ROOT_DIR" "$dmg" dmg dmg-notary-submitted submitted dmg-slow-id "$app" >/dev/null
      checkpoint="$(openclaw_jarvis_release_checkpoint_path "$dmg")"
    fi
    receipt_before="$root/receipt.before"
    checkpoint_before="$root/checkpoint.before"
    cp "$receipt" "$receipt_before"
    cp "$checkpoint" "$checkpoint_before"

    make_notary_adversarial_xcrun "$fake_bin/xcrun"
    export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$root/release.intent"
    export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=7000
    export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE="slow-poll-$kind"
    intent_id="$(openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 3600)"
    export NOTARY_SUBMISSION_ID="${kind}-slow-id"
    export NOTARY_POLL_REPLACE_ONCE="$replace_once"
    export NOTARY_POLL_REPLACEMENT_MARKER="$replacement_marker"
    export NOTARY_REPLACEMENT_INTENT_ID="slow-poll-$kind-replaced"
    export NOTARY_INTENT_HELPER="$ROOT_DIR/scripts/lib/jarvis-release-intent.sh"
    export NOTARY_INTENT_ROOT="$ROOT_DIR"
    export NOTARY_STAPLER_SENTINEL="$stapler_sentinel"
    export NOTARYTOOL_PROFILE=test-profile

    eval "$(extract_package_release_function poll_app_notarization_only poll_dmg_notarization_only)"
    eval "$(extract_package_release_function poll_dmg_notarization_only create_local_release_assets_only)"
    app_notary_receipt_path() { printf '%s\n' "$root/dist/Jarvis.app.notary.env"; }
    dmg_notary_receipt_path() { printf '%s\n' "$root/dist/Jarvis.dmg.notary.env"; }
    notary_receipt_status() { receipt_value "$1" NOTARY_STATUS; }
    receipt_value() { /usr/bin/sed -n "s/^$2=//p" "$1" | /usr/bin/head -n 1; }
    write_release_manifest() { : >"$manifest_sentinel"; }
    verify_app_bundle() { :; }
    verify_dmg_gatekeeper() { :; }

    APP_PATH="$app"
    DMG="$dmg"
    NOTARY_ZIP="$artifact"
    RELEASE_INTENT_ID="$intent_id"
    RELEASE_MANIFEST_PATH="$root/dist/jarvis-release-manifest.env"
    PACKAGE_PHASE="poll-${kind}-notarization"
    set +e
    if [[ "$kind" == "app" ]]; then
      (PATH="$fake_bin:$PATH" \
        OPENCLAW_NOTARY_FINAL_POLL_INTENT_ROOT="$ROOT_DIR" \
        OPENCLAW_NOTARY_FINAL_POLL_INTENT_ID="$intent_id" \
        poll_app_notarization_only) >/dev/null 2>&1
    else
      (PATH="$fake_bin:$PATH" \
        OPENCLAW_NOTARY_FINAL_POLL_INTENT_ROOT="$ROOT_DIR" \
        OPENCLAW_NOTARY_FINAL_POLL_INTENT_ID="$intent_id" \
        poll_dmg_notarization_only) >/dev/null 2>&1
    fi
    status=$?
    set -e
    [[ "$status" -ne 0 ]] || fail "$kind slow poll unexpectedly accepted replaced intent"
    [[ -f "$replacement_marker" ]] || fail "$kind slow poll did not replace intent from info stub"
    cmp -s "$receipt_before" "$receipt" || fail "$kind slow poll mutated the original receipt before revalidation"
    cmp -s "$checkpoint_before" "$checkpoint" || fail "$kind slow poll mutated the submitted checkpoint"
    [[ ! -e "$stapler_sentinel" ]] || fail "$kind slow poll called stapler before revalidation"
    [[ ! -e "$manifest_sentinel" ]] || fail "$kind slow poll reached package post-helper mutation"
    ! grep -q 'Accepted\|notarized' "$receipt" || fail "$kind slow poll recorded Accepted/notarized state"
    pass "$kind slow poll revalidates before receipt, staple, checkpoint, and manifest mutation"
  done
}

test_notary_poll_guard_configuration_fails_closed_but_standalone_works() {
  local root="$TMP_DIR/poll-guard-configuration"
  local fake_bin="$root/bin"
  local artifact="$root/artifact.zip"
  local receipt="$root/receipt.env"
  local status

  mkdir -p "$fake_bin"
  printf 'poll artifact bytes\n' >"$artifact"
  make_notary_adversarial_xcrun "$fake_bin/xcrun"
  export NOTARY_SUBMISSION_ID=guard-submission
  export NOTARYTOOL_PROFILE=test-profile

  set +e
  PATH="$fake_bin:$PATH" \
    OPENCLAW_NOTARY_FINAL_POLL_INTENT_ROOT="$ROOT_DIR" \
    OPENCLAW_NOTARY_FINAL_POLL_INTENT_ID= \
    "$ROOT_DIR/scripts/notarize-mac-artifact.sh" \
      --poll guard-submission --artifact "$artifact" --receipt "$receipt" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "incomplete poll intent guard was accepted"
  [[ ! -f "$receipt" ]] || fail "incomplete poll guard wrote a receipt"

  set +e
  PATH="$fake_bin:$PATH" \
    "$ROOT_DIR/scripts/notarize-mac-artifact.sh" \
      --poll guard-submission --artifact "$artifact" --receipt "$receipt" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -eq 0 ]] || fail "standalone poll compatibility was lost (status $status)"
  [[ "$(/usr/bin/sed -n 's/^NOTARY_STATUS=//p' "$receipt")" == Accepted ]] \
    || fail "standalone poll did not persist Accepted status"
  pass "poll guard rejects incomplete configuration while standalone helper remains compatible"
}

test_blocking_notary_wait_revalidates_before_final_mutations() {
  local kind root fake_bin route_stub artifact app receipt intent_id status
  local replace_once replacement_marker staple_sentinel manifest_sentinel checkpoint_sentinel

  eval "$(extract_package_release_function require_blocking_notary_result_intent write_release_manifest)"
  for kind in app dmg; do
    root="$TMP_DIR/blocking-wait-$kind"
    fake_bin="$root/bin"
    route_stub="$root/route"
    app="$root/Jarvis.app"
    artifact="$root/Jarvis.$([[ "$kind" == "app" ]] && printf 'zip' || printf 'dmg')"
    receipt="$root/Jarvis.$kind.notary.env"
    replace_once="$root/replace.once"
    replacement_marker="$root/replaced.marker"
    staple_sentinel="$root/staple.sentinel"
    manifest_sentinel="$root/manifest.sentinel"
    checkpoint_sentinel="$root/checkpoint.sentinel"

    mkdir -p "$fake_bin"
    make_fake_app "$app"
    printf 'blocking notary bytes\n' >"$artifact"
    make_notary_adversarial_xcrun "$fake_bin/xcrun"
    apply_stub "$route_stub" '#!/usr/bin/env bash
printf "interface: en0\n"'

    export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$root/release.intent"
    export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=8000
    export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE="blocking-wait-$kind"
    intent_id="$(openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 3600)"
    export NOTARY_SUBMISSION_ID="$kind-blocking-id"
    export NOTARY_WAIT_REPLACE_ONCE="$replace_once"
    export NOTARY_WAIT_REPLACEMENT_MARKER="$replacement_marker"
    export NOTARY_REPLACEMENT_INTENT_ID="blocking-wait-$kind-replaced"
    export NOTARY_INTENT_HELPER="$ROOT_DIR/scripts/lib/jarvis-release-intent.sh"
    export NOTARY_INTENT_ROOT="$ROOT_DIR"
    export NOTARY_STAPLER_SENTINEL="$staple_sentinel"
    export NOTARYTOOL_PROFILE=test-profile
    RELEASE_INTENT_ID="$intent_id"

    set +e
    if [[ "$kind" == "app" ]]; then
      PATH="$fake_bin:$PATH" \
      OPENCLAW_NOTARY_PREFLIGHT_ROUTE_STUB="$route_stub" \
      OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ROOT="$ROOT_DIR" \
      OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ID="$intent_id" \
      OPENCLAW_NOTARY_FINAL_POLL_INTENT_ROOT="$ROOT_DIR" \
      OPENCLAW_NOTARY_FINAL_POLL_INTENT_ID="$intent_id" \
      STAPLE_APP_PATH="$app" \
        "$ROOT_DIR/scripts/notarize-mac-artifact.sh" \
          --receipt "$receipt" "$artifact" >/dev/null 2>&1
    else
      PATH="$fake_bin:$PATH" \
      OPENCLAW_NOTARY_PREFLIGHT_ROUTE_STUB="$route_stub" \
      OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ROOT="$ROOT_DIR" \
      OPENCLAW_NOTARY_FINAL_SUBMIT_INTENT_ID="$intent_id" \
      OPENCLAW_NOTARY_FINAL_POLL_INTENT_ROOT="$ROOT_DIR" \
      OPENCLAW_NOTARY_FINAL_POLL_INTENT_ID="$intent_id" \
        "$ROOT_DIR/scripts/notarize-mac-artifact.sh" \
          --receipt "$receipt" "$artifact" >/dev/null 2>&1
    fi
    status=$?
    set -e

    [[ "$status" -ne 0 ]] || fail "$kind blocking wait accepted a replaced intent"
    [[ -f "$replacement_marker" ]] || fail "$kind blocking wait did not replace intent"
    [[ ! -e "$receipt" ]] || fail "$kind blocking wait wrote a final Accepted receipt"
    [[ ! -e "$staple_sentinel" ]] || fail "$kind blocking wait reached stapler"

    # Exercise the exact package-side guard used after the blocking helper.
    if require_blocking_notary_result_intent "$kind" >/dev/null 2>&1; then
      : >"$manifest_sentinel"
      : >"$checkpoint_sentinel"
    fi
    [[ ! -e "$manifest_sentinel" ]] || fail "$kind blocking wait reached manifest mutation"
    [[ ! -e "$checkpoint_sentinel" ]] || fail "$kind blocking wait reached notarized checkpoint mutation"
    pass "$kind blocking wait revalidates before final receipt, staple, manifest, and checkpoint mutation"
  done
}

test_local_assets_next_phase_uses_strict_dmg_checkpoint() {
  local state root app dmg dmg_absolute receipt expected actual

  eval "$(extract_package_release_function report_local_release_assets_next_phase release_checkpoint_receipt_submission_id)"
  for state in none submitted accepted notarized; do
    root="$TMP_DIR/local-assets-next-$state"
    app="$root/dist/Jarvis.app"
    dmg="$root/dist/Jarvis.dmg"
    receipt="$root/dist/Jarvis.dmg.notary.env"
    make_fake_app "$app"
    printf 'signed dmg bytes\n' >"$dmg"
    dmg_absolute="$(openclaw_jarvis_release_checkpoint_absolute_path "$dmg")"
    case "$state" in
      none)
        expected="submit-dmg-notarization"
        ;;
      submitted)
        write_notary_receipt "$receipt" "$dmg_absolute" "" submitted dmg-next-id
        openclaw_jarvis_release_checkpoint_write \
          "$ROOT_DIR" "$dmg" dmg dmg-notary-submitted submitted dmg-next-id "$app" >/dev/null
        openclaw_jarvis_release_checkpoint_validate \
          "$ROOT_DIR" "$dmg" dmg dmg-notary-submitted "$receipt" "$app" \
          || fail "submitted DMG checkpoint fixture is invalid: $OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE"
        expected="poll-dmg-notarization"
        ;;
      accepted)
        write_notary_receipt "$receipt" "$dmg_absolute" "" Accepted dmg-next-id
        openclaw_jarvis_release_checkpoint_write \
          "$ROOT_DIR" "$dmg" dmg dmg-notary-accepted Accepted dmg-next-id "$app" >/dev/null
        openclaw_jarvis_release_checkpoint_validate \
          "$ROOT_DIR" "$dmg" dmg dmg-notary-accepted "$receipt" "$app" \
          || fail "accepted DMG checkpoint fixture is invalid: $OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE"
        expected="poll-dmg-notarization"
        ;;
      notarized)
        write_notary_receipt "$receipt" "$dmg_absolute" "" Accepted dmg-next-id
        openclaw_jarvis_release_checkpoint_write \
          "$ROOT_DIR" "$dmg" dmg dmg-notarized Accepted dmg-next-id "$app" >/dev/null
        openclaw_jarvis_release_checkpoint_validate \
          "$ROOT_DIR" "$dmg" dmg dmg-notarized "$receipt" "$app" \
          || fail "notarized DMG checkpoint fixture is invalid: $OPENCLAW_JARVIS_RELEASE_CHECKPOINT_FAILURE"
        expected="publish-assets-only"
        ;;
    esac

    APP_PATH="$app"
    DMG="$dmg"
    dmg_notary_receipt_path() { printf '%s\n' "$receipt"; }
    actual="$(report_local_release_assets_next_phase)"
    [[ "$actual" == "next_phase=$expected" ]] \
      || fail "$state DMG proof printed $actual instead of next_phase=$expected"
    [[ "$actual" != *sparkle* ]] || fail "$state DMG proof collapsed Sparkle-only and full release truth"
    pass "$state strict DMG proof prints truthful local-assets continuation"
  done
}

test_wrapper_commit_mismatch_reauthorizes() {
  local intent_path="$TMP_DIR/wrapper-commit.intent"
  local intent_tmp="$TMP_DIR/wrapper-commit.intent.tmp"
  local intent_id
  local out="$TMP_DIR/wrapper-commit.out"
  local err="$TMP_DIR/wrapper-commit.err"
  local status=0

  export OPENCLAW_JARVIS_RELEASE_INTENT_PATH_OVERRIDE="$intent_path"
  export OPENCLAW_JARVIS_RELEASE_INTENT_NOW_EPOCH=5000
  export OPENCLAW_JARVIS_RELEASE_INTENT_ID_OVERRIDE=wrapper-commit-mismatch
  intent_id="$(openclaw_jarvis_release_intent_authorize "$ROOT_DIR" 60)"
  /usr/bin/sed \
    's/^JARVIS_RELEASE_INTENT_GIT_COMMIT=.*/JARVIS_RELEASE_INTENT_GIT_COMMIT=0000000000000000000000000000000000000000/' \
    "$intent_path" >"$intent_tmp"
  mv -f "$intent_tmp" "$intent_path"

  set +e
  OPENCLAW_MAIN_HOME_CLONE="$(cd "$ROOT_DIR/../.." && pwd -P)" \
  OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$(basename "$ROOT_DIR")" \
  OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE="$TMP_DIR/wrapper-commit.lock" \
  OPENCLAW_JARVIS_PUBLIC_RELEASE_SUMMARY="$TMP_DIR/wrapper-commit-summary.env" \
  OPENCLAW_JARVIS_RELEASE_TIMING_REPORT="$TMP_DIR/wrapper-commit-timing.tsv" \
    /bin/bash "$ROOT_DIR/scripts/jarvis-public-release.sh" \
      --phase full \
      --release-intent "$intent_id" \
      >"$out" 2>"$err"
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || fail "commit-mismatched wrapper intent unexpectedly executed"
  grep -q 'release intent is commit' "$err" \
    || fail "wrapper commit mismatch did not report the intent failure"
  [[ "$(grep -c '^recovery_command=' "$err")" == "1" ]] \
    || fail "wrapper commit mismatch did not print exactly one recovery command"
  grep -q '^recovery_command=bash scripts/jarvis-public-release.sh --authorize$' "$err" \
    || fail "wrapper commit mismatch printed an unusable stale-intent recovery command"
  pass "wrapper commit mismatch reauthorizes instead of replaying stale intent"
}

make_stub_tools
test_intent_latest_wins_and_expiry
test_intent_path_stability
test_intent_default_and_maximum_ttl
test_intent_tracked_state_binding
test_operator_authorization_interface
test_operator_authorization_preserves_inert_future_flags
test_authorization_persistence_failure_is_fatal
test_checkpoint_invalid_and_valid_resume
test_in_progress_receipt_preserves_submitted_checkpoint
test_final_submit_and_upload_guards_reject_replacement
test_retry_upload_guards_reject_replacement_before_second_gh
test_expired_intent_prints_one_recovery_command
test_tracked_drift_stops_real_package_entrypoint
test_package_disk_preflight_targets_and_boundaries
test_package_release_mutation_guards_are_wired
test_wrapper_commit_mismatch_reauthorizes
test_nonzero_notary_submit_preserves_submitted_checkpoint_and_poll_selection
test_slow_notary_poll_revalidates_before_all_mutations
test_notary_poll_guard_configuration_fails_closed_but_standalone_works
test_blocking_notary_wait_revalidates_before_final_mutations
test_local_assets_next_phase_uses_strict_dmg_checkpoint

echo "All Jarvis release control tests passed."
