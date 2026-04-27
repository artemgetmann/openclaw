#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: run-node-tool.sh <tool> [args...]" >&2
  exit 2
fi

tool="$1"
shift

if [[ -f "$ROOT_DIR/pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then
  if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
    echo "Skipping pre-commit $tool: dependencies are not installed. Run pnpm install to enable this check." >&2
    exit 0
  fi

  if [[ ! -x "$ROOT_DIR/node_modules/.bin/$tool" ]]; then
    echo "Missing pre-commit tool: $tool. Run pnpm install to restore local tool links." >&2
    exit 1
  fi

  exec pnpm exec "$tool" "$@"
fi

if { [[ -f "$ROOT_DIR/bun.lockb" ]] || [[ -f "$ROOT_DIR/bun.lock" ]]; } && command -v bun >/dev/null 2>&1; then
  exec bunx --bun "$tool" "$@"
fi

if command -v npm >/dev/null 2>&1; then
  exec npm exec -- "$tool" "$@"
fi

if command -v npx >/dev/null 2>&1; then
  exec npx "$tool" "$@"
fi

echo "Missing package manager: pnpm, bun, or npm required." >&2
exit 1
