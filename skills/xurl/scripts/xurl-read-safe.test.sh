#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/xurl-read-safe.sh"

pass=0
fail=0

expect_ok() {
  local expected="$1"
  shift
  local output
  if ! output="$($GUARD --dry-run "$@" 2>&1)"; then
    echo "FAIL: expected success: $*" >&2
    fail=$((fail + 1))
    return
  fi
  if [[ "$output" != *"$expected"* ]]; then
    echo "FAIL: output did not contain '$expected': $output" >&2
    fail=$((fail + 1))
    return
  fi
  pass=$((pass + 1))
}

expect_fail() {
  local expected="$1"
  shift
  local output
  if output="$($GUARD --dry-run "$@" 2>&1)"; then
    echo "FAIL: expected refusal: $*" >&2
    fail=$((fail + 1))
    return
  fi
  if [[ "$output" != *"$expected"* ]]; then
    echo "FAIL: refusal did not contain '$expected': $output" >&2
    fail=$((fail + 1))
    return
  fi
  pass=$((pass + 1))
}

expect_ok 'up to 10 Post results; maximum estimated cost $0.050' -- search openclaw
expect_ok 'command: xurl timeline -n 10' -- timeline
expect_ok 'command: xurl posts openai -n 10' -- posts openai
expect_ok 'up to 1 User results; maximum estimated cost $0.010' -- user openai
expect_ok 'up to 1 Post results; maximum estimated cost $0.005' -- read https://x.com/openai/status/123
expect_ok 'up to 10 DM event results; maximum estimated cost $0.100' -- dms
expect_ok 'up to 10 Post results' -- search 'user timeline'
expect_ok 'command: xurl --app example search openclaw -n 10' -- --app example search openclaw
for collection in posts timeline mentions bookmarks likes following followers dms; do
  expect_ok "command: xurl $collection -n 10" -- "$collection"
done
expect_ok 'up to 25 Post results; maximum estimated cost $0.125' --approved-max 25 -- search openclaw -n 25
expect_ok 'up to 25 Post results; maximum estimated cost $0.125' --approved-max 25 -- search openclaw -n25
expect_fail 'Get fresh user confirmation' -- search openclaw -n 11
expect_fail 'Get fresh user confirmation' -- search openclaw -n25
expect_fail '--approved-max must exactly match' --approved-max 20 -- search openclaw -n 25
expect_fail 'hard limit is 100' --approved-max 101 -- search openclaw -n 101
expect_fail 'raw API reads are blocked' -- /2/tweets/search/recent
expect_fail 'pagination tokens are blocked' -- search openclaw --pagination-token secret
expect_fail 'result count may be specified only once' -- search openclaw -n 10 --max-results 10
expect_fail 'result count may be specified only once' -- search openclaw -n10 --max-results 10
expect_fail 'unsupported or mutating xurl command: post' -- post 'please read this'
expect_fail 'not allowed for guarded reads' -- search openclaw --verbose

echo "$pass passed; $fail failed"
((fail == 0))
