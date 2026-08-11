#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RESOURCE="release-test-$$-${RANDOM:-0}"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

# The compatibility API refuses when the release resource is not held.
set +e
bash -c 'source "$1/scripts/lib/jarvis-release-lock.sh"; openclaw_jarvis_release_lock_acquire "$1" test' \
  _ "$ROOT_DIR" >/dev/null 2>&1
status=$?
set -e
[[ "$status" == 75 ]] || fail "release API admitted an unguarded caller"

# Exercise the production resource name; the test is non-mutating and exits
# immediately, so no release state or external artifact is touched.
"$ROOT_DIR/scripts/with-shared-resource-lock.pl" \
  --resource release-jarvis \
  --label release-lock-test \
  -- \
  bash -c '
    source "$1/scripts/lib/jarvis-release-lock.sh"
    openclaw_jarvis_release_lock_acquire "$1" test >/dev/null
    [[ "$OPENCLAW_JARVIS_RELEASE_LOCK_HELD" == 1 ]]
    openclaw_jarvis_release_lock_release
    [[ "$OPENCLAW_JARVIS_RELEASE_LOCK_HELD" == 0 ]]
  ' _ "$ROOT_DIR"

# The general kernel-lock suite proves contention and crash cleanup.
"$ROOT_DIR/scripts/test-shared-resource-lock.sh" >/dev/null
printf 'PASS: Jarvis release resource lock tests\n'
