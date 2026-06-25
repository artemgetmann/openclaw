#!/usr/bin/env bash
set -euo pipefail

# Resolve the repo root from the skill location so agents can call one stable
# helper path without depending on their current working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"

if [[ -x "$REPO_ROOT/scripts/openclaw-local.sh" && -f "$REPO_ROOT/package.json" ]]; then
  # Source checkout path: preserve the lane-local developer entrypoint.
  cd "$REPO_ROOT"
  exec pnpm openclaw:local telegram-user "$@"
fi

if [[ -f "$REPO_ROOT/openclaw.mjs" ]]; then
  INSTALLED_NODE="$REPO_ROOT/../../tools/node/bin/node"
  if [[ -x "$INSTALLED_NODE" ]]; then
    # Installed consumer runtime path:
    #   <prefix>/lib/openclaw-bundled/skills/.../telegram-user-cli.sh
    #   <prefix>/tools/node/bin/node
    exec "$INSTALLED_NODE" "$REPO_ROOT/openclaw.mjs" telegram-user "$@"
  fi

  case "$(uname -m)" in
    arm64) RESOURCE_ARCH="darwin-arm64" ;;
    x86_64) RESOURCE_ARCH="darwin-x64" ;;
    *) RESOURCE_ARCH="" ;;
  esac
  RESOURCE_NODE="$REPO_ROOT/../node/$RESOURCE_ARCH/bin/node"
  if [[ -n "$RESOURCE_ARCH" && -x "$RESOURCE_NODE" ]]; then
    # App resource staging path before the runtime is seeded into Application
    # Support:
    #   OpenClawRuntime/openclaw/skills/.../telegram-user-cli.sh
    #   OpenClawRuntime/node/<arch>/bin/node
    exec "$RESOURCE_NODE" "$REPO_ROOT/openclaw.mjs" telegram-user "$@"
  fi

  if command -v node >/dev/null 2>&1; then
    exec node "$REPO_ROOT/openclaw.mjs" telegram-user "$@"
  fi
fi

exec openclaw telegram-user "$@"
