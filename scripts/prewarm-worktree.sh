#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/prewarm-worktree.sh [--root <path>] [--macos]

Prewarm a repo worktree without touching runtime/auth/browser/session state.

Defaults:
- runs `pnpm install --frozen-lockfile`
- `--macos` additionally runs `swift build --package-path apps/macos --product OpenClaw`
EOF
}

ROOT=""
PREWARM_MACOS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      if [[ $# -lt 2 ]]; then
        echo "Error: --root requires a value." >&2
        exit 1
      fi
      ROOT="$2"
      shift 2
      ;;
    --macos)
      PREWARM_MACOS=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Error: unexpected argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$ROOT" ]]; then
  if ! ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    echo "Error: run this script from inside a git worktree or pass --root." >&2
    exit 1
  fi
fi

ROOT="$(cd "$ROOT" && pwd -P)"

if [[ ! -f "$ROOT/package.json" ]]; then
  echo "Error: no package.json found under $ROOT" >&2
  exit 1
fi

source "$ROOT/scripts/lib/validated-node.sh"
openclaw_use_validated_node "$ROOT" >/dev/null

echo "prewarm_root=${ROOT}"
echo "prewarm_step=pnpm-install"
pnpm --dir "$ROOT" install --frozen-lockfile

if [[ "$PREWARM_MACOS" == "1" ]]; then
  echo "prewarm_step=swift-build-macos"
  swift build --package-path "$ROOT/apps/macos" --product OpenClaw
fi

echo "prewarm_status=ok"
