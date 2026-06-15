#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"

# Agent tool calls often run from the ephemeral OpenClaw workspace, not from the
# repo checkout. Resolve runtime dependencies from the checkout so `tsx` does not
# get looked up relative to that workspace and fail before this script starts.
cd "$REPO_ROOT"

if [[ -f "$REPO_ROOT/dist/index.js" ]]; then
  exec node "$SCRIPT_DIR/goplaces-search.mjs" "$@"
fi

if [[ -d "$REPO_ROOT/node_modules/tsx" ]]; then
  exec node --import tsx "$SCRIPT_DIR/goplaces-search.mjs" "$@"
fi

echo "ERROR: could not locate built OpenClaw runtime or repo-local node_modules/tsx for goplaces-search." >&2
echo "Run pnpm build or pnpm install in $REPO_ROOT." >&2
exit 1
