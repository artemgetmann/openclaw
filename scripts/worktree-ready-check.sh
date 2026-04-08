#!/usr/bin/env bash
set -euo pipefail

ROOT=""
MODE="clean"
QUIET=0

usage() {
  cat <<'EOF'
Usage: scripts/worktree-ready-check.sh [--root <worktree-path>] [--mode <clean|warm>] [--quiet]
EOF
}

emit() {
  if [[ "$QUIET" != "1" ]]; then
    printf '%s\n' "$1"
  fi
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      if [[ $# -lt 2 ]]; then
        fail "--root requires a value."
      fi
      ROOT="$2"
      shift 2
      ;;
    --mode)
      if [[ $# -lt 2 ]]; then
        fail "--mode requires a value."
      fi
      MODE="$2"
      shift 2
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unexpected argument: $1"
      ;;
  esac
done

if [[ -z "$ROOT" ]]; then
  ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
else
  ROOT="$(cd -- "$ROOT" && pwd -P)"
fi

if [[ "$MODE" != "clean" && "$MODE" != "warm" ]]; then
  fail "--mode must be one of: clean, warm."
fi

if [[ ! -f "$ROOT/package.json" ]]; then
  fail "not a repo root: $ROOT"
fi

source "$ROOT/scripts/lib/validated-node.sh"

# Readiness checks must use the same validated runtime as the lane bootstrap.
# Otherwise a shell with the wrong Node can declare the lane healthy while the
# actual agent/runtime later resolves a different toolchain.
openclaw_use_validated_node "$ROOT" >/dev/null || exit 1

if [[ ! -d "$ROOT/node_modules" ]]; then
  fail "node_modules missing in $ROOT"
fi

# Cross-worktree node_modules sharing is explicitly forbidden for isolation.
# Reject symlinked dependency roots so a "ready" lane cannot secretly depend
# on another checkout's filesystem state.
if [[ -L "$ROOT/node_modules" ]]; then
  fail "node_modules must be a real directory, not a symlink: $ROOT/node_modules"
fi

if [[ -e "$ROOT/ui/node_modules" ]] && [[ -L "$ROOT/ui/node_modules" ]]; then
  fail "ui/node_modules must be a real directory, not a symlink: $ROOT/ui/node_modules"
fi

if [[ "$MODE" == "clean" && ! -f "$ROOT/dist/index.js" ]]; then
  fail "clean lanes require build output at $ROOT/dist/index.js"
fi

# The specific failure we are closing is "pnpm exec vitest" resolving to
# nothing in a supposedly ready lane. Prove the local tool is executable from
# this worktree before handing it to an agent.
VITEST_VERSION="$(openclaw_run_repo_pnpm "$ROOT" exec vitest --version 2>/dev/null | head -n 1 | tr -d '\r')"
if [[ -z "$VITEST_VERSION" ]]; then
  fail "local Vitest resolution failed in $ROOT"
fi

emit "ready_root=${ROOT}"
emit "ready_mode=${MODE}"
emit "ready_vitest=${VITEST_VERSION}"
emit "ready_proof=pnpm exec vitest --version"
emit "lane_ready=yes"
