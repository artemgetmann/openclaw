#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

resolve_repo_root() {
  local candidate

  for candidate in \
    "${OPENCLAW_FORK_ROOT:-}" \
    "${OPENCLAW_REPO_ROOT:-}" \
    "$(cd "$SCRIPT_DIR/../../.." 2>/dev/null && pwd -P || true)" \
    "$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)" \
    "$(cd "$(dirname "$(command -v openclaw 2>/dev/null || printf /)")/.." 2>/dev/null && pwd -P || true)" \
    "$HOME/Programming_Projects/openclaw" \
    "$HOME/Programming_Projects/openclaw-consumer"; do
    if [[ -n "$candidate" && -f "$candidate/package.json" && -d "$candidate/node_modules/tsx" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

REPO_ROOT="$(resolve_repo_root)" || {
  echo "ERROR: could not locate an OpenClaw checkout with node_modules/tsx for wacli-auth-local." >&2
  echo "Set OPENCLAW_FORK_ROOT to your OpenClaw checkout and run pnpm install there." >&2
  exit 1
}

cd "$REPO_ROOT"
exec node --import tsx "$REPO_ROOT/skills/wacli/scripts/wacli-auth-local.ts" "$@"
