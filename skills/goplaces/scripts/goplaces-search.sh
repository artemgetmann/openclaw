#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"

# Agent tool calls often run from the ephemeral OpenClaw workspace, not from the
# repo checkout. Resolve runtime dependencies from the checkout so `tsx` does not
# get looked up relative to that workspace and fail before this script starts.
if [[ -f "$REPO_ROOT/dist/index.js" ]]; then
  cd "$REPO_ROOT"
  export OPENCLAW_GOPLACES_RUNTIME_ROOT="$REPO_ROOT"
  exec node "$SCRIPT_DIR/goplaces-search.mjs" "$@"
fi

if [[ -d "$REPO_ROOT/node_modules/tsx" ]]; then
  cd "$REPO_ROOT"
  export OPENCLAW_GOPLACES_RUNTIME_ROOT="$REPO_ROOT"
  exec node --import tsx "$SCRIPT_DIR/goplaces-search.mjs" "$@"
fi

# Packaged and shared skill mirrors do not live inside the runtime checkout.
# Jarvis keeps the matching built runtime under its state directory instead. A
# shared personal mirror may run without the service-injected state variable, so
# also try the standard packaged Jarvis state location under the current home.
STATE_DIR_CANDIDATES=()
if [[ -n "${OPENCLAW_STATE_DIR:-}" ]]; then
  STATE_DIR_CANDIDATES+=("$OPENCLAW_STATE_DIR")
fi
if [[ -n "${HOME:-}" ]]; then
  STATE_DIR_CANDIDATES+=("$HOME/Library/Application Support/Jarvis/.jarvis")
fi

for STATE_DIR in "${STATE_DIR_CANDIDATES[@]}"; do
  BUNDLED_RUNTIME_ROOT="$STATE_DIR/lib/openclaw-bundled"
  if [[ -f "$BUNDLED_RUNTIME_ROOT/dist/index.js" ]]; then
    cd "$BUNDLED_RUNTIME_ROOT"
    # The JS launcher also resolves layouts for direct invocation. Pin the
    # runtime chosen here so it cannot reselect an unusable checkout source.
    export OPENCLAW_GOPLACES_RUNTIME_ROOT="$BUNDLED_RUNTIME_ROOT"
    exec node "$SCRIPT_DIR/goplaces-search.mjs" "$@"
  fi
done

echo "ERROR: could not locate built OpenClaw runtime or repo-local node_modules/tsx for goplaces-search." >&2
echo "Run pnpm build or pnpm install in $REPO_ROOT, or set OPENCLAW_STATE_DIR to a packaged Jarvis runtime." >&2
exit 1
