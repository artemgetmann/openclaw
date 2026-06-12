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

make_app() {
  local app_path="$1"
  local build="$2"
  local plist="$app_path/Contents/Info.plist"

  rm -rf "$app_path"
  mkdir -p "$(dirname "$plist")"
  /usr/bin/plutil -create xml1 "$plist"
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

  make_app "$built" "200"
  run_expect "sparkle-missing-installed" pass \
    openclaw_require_incremental_sparkle_build "$built" "$TMP_DIR/no-app/Jarvis.app"

  make_app "$installed" "199"
  run_expect "sparkle-older-installed" pass \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  make_app "$installed" "200"
  run_expect "sparkle-equal-installed" fail \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  make_app "$installed" "201"
  run_expect "sparkle-newer-installed" fail \
    openclaw_require_incremental_sparkle_build "$built" "$installed"

  make_app "$installed" "200"
  run_expect "sparkle-override-equal" pass env ALLOW_NON_INCREMENTAL_SPARKLE_BUILD=1 \
    bash -c 'source "$1"; openclaw_require_incremental_sparkle_build "$2" "$3"' \
    _ "$ROOT_DIR/scripts/lib/macos-release-gates.sh" "$built" "$installed"
}

test_prewarm_proof_validation
test_sparkle_build_predicate
