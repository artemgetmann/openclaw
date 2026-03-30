#!/usr/bin/env bash
set -euo pipefail

# Lightweight proof harness for comparing the managed cloned signed-in lane
# against the clean openclaw lane from the terminal before any UI demos.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPENCLAW_BIN="${OPENCLAW_BIN:-node}"
OPENCLAW_ENTRY="${OPENCLAW_ENTRY:-$ROOT_DIR/dist/entry.js}"
OPENCLAW_GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-ws://127.0.0.1:19111}"
OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
OPENCLAW_COMPARE_URL="${OPENCLAW_COMPARE_URL:-https://www.emirates.com/}"

run_step() {
  local profile="$1"
  local action="$2"
  shift 2
  local start_ts end_ts elapsed_ms
  start_ts="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
  local cmd=("$OPENCLAW_BIN" "$OPENCLAW_ENTRY" browser --url "$OPENCLAW_GATEWAY_URL")
  if [[ -n "$OPENCLAW_GATEWAY_TOKEN" ]]; then
    cmd+=(--token "$OPENCLAW_GATEWAY_TOKEN")
  fi
  cmd+=(--browser-profile "$profile" "$action" "$@")
  "${cmd[@]}" >/tmp/openclaw-browser-compare-"$profile"-"$action".log
  end_ts="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
  elapsed_ms="$((end_ts - start_ts))"
  printf '%s\t%s\t%s ms\n' "$profile" "$action" "$elapsed_ms"
}

compare_profile() {
  local profile="$1"
  run_step "$profile" status --json
  run_step "$profile" start --json
  run_step "$profile" open "$OPENCLAW_COMPARE_URL" --json
  run_step "$profile" snapshot --json --timeout 60000
}

case "${1:-compare}" in
  compare)
    compare_profile signed-in
    compare_profile openclaw
    ;;
  *)
    echo "usage: $0 [compare]" >&2
    exit 1
    ;;
esac
