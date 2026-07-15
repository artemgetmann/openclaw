#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/macos-release-gates.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

run_expect() {
  local name="$1"
  local expect="$2"
  shift 2

  set +e
  ( "$@" ) >"$TMP_DIR/${name}.out" 2>"$TMP_DIR/${name}.err"
  local status=$?
  set -e

  if [[ "$expect" == "pass" && "$status" -ne 0 ]]; then
    cat "$TMP_DIR/${name}.err" >&2
    fail "$name expected pass, got status $status"
  fi
  if [[ "$expect" == "fail" && "$status" -eq 0 ]]; then
    cat "$TMP_DIR/${name}.out" >&2
    fail "$name expected fail, got pass"
  fi

  pass "$name"
}

make_git_release_repo() {
  local repo="$1"

  mkdir -p "$repo/apps/macos"
  (
    cd "$repo"
    git init -q
    git config user.email "release-test@example.invalid"
    git config user.name "Release Gate Test"
    printf '%s\n' '{"packageManager":"pnpm@10.23.0"}' >package.json
    printf '%s\n' "lockfileVersion: '9.0'" >pnpm-lock.yaml
    printf '%s\n' '{"pins":[]}' >apps/macos/Package.resolved
    git add package.json pnpm-lock.yaml apps/macos/Package.resolved
    git commit -q -m "test fixture"
  )
}

test_release_worktree_guard() {
  local home="$TMP_DIR/home"
  local release_name="jarvis-release-current"
  local release_branch="codex/${release_name}"
  local release_repo="$home/.worktrees/$release_name"
  local random_repo="$TMP_DIR/random-release-repo"

  make_git_release_repo "$release_repo"
  git -C "$release_repo" checkout -qb "$release_branch"
  run_expect "release-worktree-guard-valid" pass \
    openclaw_require_jarvis_release_worktree "$release_repo" "$release_repo" "$release_branch"
  run_expect "release-worktree-guard-env-home-valid" pass \
    env OPENCLAW_MAIN_HOME_CLONE="$home" \
      bash -c 'source "$1"; openclaw_require_jarvis_release_worktree "$2"' \
      _ "$ROOT_DIR/scripts/lib/macos-release-gates.sh" "$release_repo"

  make_git_release_repo "$random_repo"
  git -C "$random_repo" checkout -qb "$release_branch"
  run_expect "release-worktree-guard-wrong-path" fail \
    openclaw_require_jarvis_release_worktree "$random_repo" "$release_repo" "$release_branch"

  git -C "$release_repo" checkout -qb "codex/not-the-release-lane"
  run_expect "release-worktree-guard-wrong-branch" fail \
    openclaw_require_jarvis_release_worktree "$release_repo" "$release_repo" "$release_branch"

  local custom_name="jarvis-release-custom"
  local custom_branch="codex/${custom_name}"
  local custom_repo="$home/.worktrees/$custom_name"
  make_git_release_repo "$custom_repo"
  git -C "$custom_repo" checkout -qb "$custom_branch"
  run_expect "release-worktree-guard-env-name-valid" pass \
    env OPENCLAW_MAIN_HOME_CLONE="$home" OPENCLAW_JARVIS_RELEASE_WORKTREE_NAME="$custom_name" \
      bash -c 'source "$1"; openclaw_require_jarvis_release_worktree "$2"' \
      _ "$ROOT_DIR/scripts/lib/macos-release-gates.sh" "$custom_repo"
}

make_app() {
  local app_path="$1"
  local version="$2"
  local build="$3"
  local plist="$app_path/Contents/Info.plist"

  rm -rf "$app_path"
  mkdir -p "$(dirname "$plist")"
  /usr/bin/plutil -create xml1 "$plist"
  /usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $version" "$plist"
  /usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $build" "$plist"
}

test_prewarm_proof_validation() {
  local repo="$TMP_DIR/release-repo"

  make_git_release_repo "$repo"
  openclaw_write_macos_prewarm_proof "$repo" >/dev/null
  run_expect "prewarm-proof-valid" pass openclaw_validate_macos_prewarm_proof "$repo"

  printf '%s\n' "changed lock" >"$repo/pnpm-lock.yaml"
  run_expect "prewarm-proof-stale-lock" fail openclaw_validate_macos_prewarm_proof "$repo"
  git -C "$repo" checkout -- pnpm-lock.yaml

  (
    cd "$repo"
    printf '%s\n' "new head" >README.md
    git add README.md
    git commit -q -m "advance head"
  )
  run_expect "prewarm-proof-stale-head" fail openclaw_validate_macos_prewarm_proof "$repo"
}

test_sparkle_build_predicate() {
  local built="$TMP_DIR/Built/Jarvis.app"
  local installed="$TMP_DIR/Installed/Jarvis.app"

  make_app "$built" "2026.7.14.1" "200"
  run_expect "sparkle-missing-installed" pass \
    openclaw_require_incremental_sparkle_build "$built" "$TMP_DIR/no-app/Jarvis.app"

  make_app "$installed" "2026.7.14.1" "199"
  run_expect "sparkle-older-installed" pass \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  make_app "$installed" "2026.7.14.1" "200"
  run_expect "sparkle-equal-installed" fail \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  make_app "$installed" "2026.7.14.1" "201"
  run_expect "sparkle-newer-installed" fail \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  # Regression shape: a higher build must not mask a visibly older version.
  make_app "$built" "2026.3.16" "2026071403"
  make_app "$installed" "2026.7.14.1" "2026071402"
  run_expect "sparkle-marketing-version-regression" fail \
    openclaw_require_incremental_sparkle_build "$built" "$installed"
  grep -Fq "CFBundleShortVersionString is older" "$TMP_DIR/sparkle-marketing-version-regression.err" || \
    fail "sparkle-marketing-version-regression should explain the marketing-version failure"
  run_expect "sparkle-override-marketing-version-regression" pass env ALLOW_NON_INCREMENTAL_SPARKLE_BUILD=1 \
    bash -c 'source "$1"; openclaw_require_incremental_sparkle_build "$2" "$3"' \
    _ "$ROOT_DIR/scripts/lib/macos-release-gates.sh" "$built" "$installed"

  make_app "$built" "2026.7.14.1" "2026071403"
  run_expect "sparkle-equal-marketing-version-newer-build" pass \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  make_app "$built" "2026.7.15" "2026071403"
  run_expect "sparkle-newer-marketing-version-newer-build" pass \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  # Same-base prereleases must follow release-channel order, not lexical token
  # order: stable > beta > alpha, then the numeric prerelease counter.
  make_app "$installed" "2026.7.1" "2026071402"
  make_app "$built" "2026.7.1-beta.1" "2026071403"
  run_expect "sparkle-stable-to-beta-regression" fail \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  make_app "$installed" "2026.7.1-beta.1" "2026071402"
  make_app "$built" "2026.7.1" "2026071403"
  run_expect "sparkle-beta-to-stable-upgrade" pass \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  make_app "$installed" "2026.7.1-alpha.2" "2026071402"
  make_app "$built" "2026.7.1-beta.1" "2026071403"
  run_expect "sparkle-alpha-to-beta-upgrade" pass \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  make_app "$installed" "2026.7.1-beta.1" "2026071402"
  make_app "$built" "2026.7.1-beta.2" "2026071403"
  run_expect "sparkle-beta-counter-upgrade" pass \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  make_app "$installed" "2026.7.1-beta.2" "2026071402"
  make_app "$built" "2026.7.1-beta.1" "2026071403"
  run_expect "sparkle-beta-counter-regression" fail \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  make_app "$installed" "2026.5.3" "2026071402"
  make_app "$built" "2026.5.3-1" "2026071403"
  run_expect "sparkle-stable-to-correction-upgrade" pass \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  make_app "$installed" "2026.5.3-1" "2026071402"
  make_app "$built" "2026.5.3" "2026071403"
  run_expect "sparkle-correction-to-stable-regression" fail \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  make_app "$installed" "2026.5.3-1" "2026071402"
  make_app "$built" "2026.5.3-2" "2026071403"
  run_expect "sparkle-correction-counter-upgrade" pass \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  make_app "$installed" "2026.5.3-2" "2026071402"
  make_app "$built" "2026.5.3-1" "2026071403"
  run_expect "sparkle-correction-counter-regression" fail \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  make_app "$installed" "2026.5.3-beta.9" "2026071402"
  make_app "$built" "2026.5.3-1" "2026071403"
  run_expect "sparkle-prerelease-to-correction-upgrade" pass \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  /usr/libexec/PlistBuddy -c "Delete :CFBundleShortVersionString" "$built/Contents/Info.plist"
  run_expect "sparkle-built-marketing-version-missing" fail \
    openclaw_require_incremental_sparkle_build "$built" "$installed"
  grep -Fq "built Jarvis app is missing CFBundleShortVersionString" "$TMP_DIR/sparkle-built-marketing-version-missing.err" || \
    fail "sparkle-built-marketing-version-missing should identify missing metadata"

  make_app "$built" "2026.7.15" "2026071403"
  /usr/libexec/PlistBuddy -c "Delete :CFBundleShortVersionString" "$installed/Contents/Info.plist"
  run_expect "sparkle-installed-marketing-version-missing" fail \
    openclaw_require_incremental_sparkle_build "$built" "$installed"
  grep -Fq "installed Jarvis app is missing CFBundleShortVersionString" "$TMP_DIR/sparkle-installed-marketing-version-missing.err" || \
    fail "sparkle-installed-marketing-version-missing should identify missing metadata"

  make_app "$installed" "2026.7.14.1" "2026071403"
  run_expect "sparkle-override-equal" pass env ALLOW_NON_INCREMENTAL_SPARKLE_BUILD=1 \
    bash -c 'source "$1"; openclaw_require_incremental_sparkle_build "$2" "$3"' \
    _ "$ROOT_DIR/scripts/lib/macos-release-gates.sh" "$built" "$installed"
}

test_sparkle_phase_gate_selection() {
  local phase

  for phase in \
    full \
    local-proof \
    post-app-build \
    build-app-only \
    trusted-ring-fast \
    submit-app-notarization \
    poll-app-notarization \
    submit-dmg-notarization \
    poll-dmg-notarization \
    create-local-release-assets-only \
    publish-assets-only \
    publish-sparkle-assets-only; do
    if ! openclaw_macos_release_phase_requires_version_gate "$phase"; then
      fail "$phase should require the installed Jarvis version/build gate"
    fi
  done

  for phase in verify-public-assets-only verify-sparkle-assets-only; do
    if openclaw_macos_release_phase_requires_version_gate "$phase"; then
      fail "$phase should not require the installed Jarvis version/build gate"
    fi
  done

  pass "sparkle phase gate selection"
}

test_prewarm_proof_validation
test_release_worktree_guard
test_sparkle_build_predicate
test_sparkle_phase_gate_selection
