#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

init_checkout() {
  local path="$1"
  local branch="$2"

  mkdir -p "$path"
  git -C "$path" init -q -b "$branch"
}

MAIN_HOME="$TMP_DIR/openclaw"
LEGACY_CONSUMER_HOME="$TMP_DIR/openclaw-consumer"
RETIRED_CONSUMER_HOME="$TMP_DIR/openclaw-consumer-openclaw-project"
RANDOM_CHECKOUT="$TMP_DIR/random-worktree"

init_checkout "$MAIN_HOME" "main"
init_checkout "$LEGACY_CONSUMER_HOME" "codex/consumer-openclaw-project"
init_checkout "$RETIRED_CONSUMER_HOME" "main"
init_checkout "$RANDOM_CHECKOUT" "main"

export OPENCLAW_MAIN_HOME_CLONE="$MAIN_HOME"
export OPENCLAW_CONSUMER_HOME_CLONE="$LEGACY_CONSUMER_HOME"

if ! consumer_instance_default_checkout_allowed "$MAIN_HOME"; then
  fail "sacred main home clone should be allowed to use the default Jarvis identity"
fi
pass "allows sacred main home clone"

if ! consumer_instance_default_checkout_allowed "$LEGACY_CONSUMER_HOME"; then
  fail "legacy consumer fallback should stay allowed while migration is incomplete"
fi
pass "allows legacy consumer fallback"

git -C "$MAIN_HOME" checkout -q -b feature/off-base
if consumer_instance_default_checkout_allowed "$MAIN_HOME"; then
  fail "sacred main home clone must be rejected when it drifts off main"
fi
pass "rejects sacred main home clone branch drift"

if consumer_instance_default_checkout_allowed "$RETIRED_CONSUMER_HOME"; then
  fail "retired openclaw-consumer-openclaw-project path should not be a hard-coded default"
fi
pass "rejects retired consumer checkout name"

if consumer_instance_default_checkout_allowed "$RANDOM_CHECKOUT"; then
  fail "unrecognized checkouts must pass --instance instead of using the default Jarvis identity"
fi
pass "rejects unrecognized checkout"
