#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
NODE="${OPENCLAW_NODE_BIN:-$(command -v node)}"
QUIET="${1:-}"
PKG_JSON="$ROOT/package.json"
CLI="$ROOT/openclaw.mjs"
DIST_ENTRY="$ROOT/dist/index.js"
NODE_MODULES="$ROOT/node_modules"

log() {
  if [[ "$QUIET" != "--quiet" ]]; then
    printf '%s\n' "$1"
  fi
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

if [[ ! -x "$NODE" ]]; then
  fail "node runtime not found. Install Node 22+ or set OPENCLAW_NODE_BIN."
fi

if [[ ! -f "$PKG_JSON" || ! -f "$CLI" ]]; then
  fail "not a valid OpenClaw repo root: $ROOT"
fi

if [[ ! -d "$NODE_MODULES" ]]; then
  fail "missing node_modules in $ROOT. Run: pnpm install"
fi

if [[ ! -f "$DIST_ENTRY" ]]; then
  fail "missing dist/index.js in $ROOT. Run: pnpm build"
fi

EXPECTED_VERSION="$("$NODE" -e "console.log(JSON.parse(require('node:fs').readFileSync('$PKG_JSON','utf8')).version)")"
LOCAL_VERSION_RAW="$("$NODE" "$CLI" --version 2>/dev/null | tail -n 1 | tr -d '\r')"
LOCAL_VERSION="$(
  printf '%s\n' "$LOCAL_VERSION_RAW" |
    sed -nE 's/.*([0-9]{4}\.[0-9]+\.[0-9]+([-+.A-Za-z0-9]+)?).*/\1/p' |
    head -n 1
)"

if [[ "$LOCAL_VERSION" != "$EXPECTED_VERSION" ]]; then
  fail "local CLI version mismatch in $ROOT (expected $EXPECTED_VERSION, got ${LOCAL_VERSION_RAW:-unknown}). Rebuild with: pnpm build"
fi

if [[ "$QUIET" != "--quiet" ]]; then
  log "OK: local OpenClaw preflight passed."
  log "repo=$ROOT"
  log "version=$LOCAL_VERSION"
  log "node=$NODE"
fi
