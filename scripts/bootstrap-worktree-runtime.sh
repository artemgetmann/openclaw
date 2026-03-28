#!/usr/bin/env bash
set -euo pipefail

ROOT=""
QUIET=0
SKIP_INSTALL=0
SKIP_BUILD=0

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-worktree-runtime.sh [--root <worktree-path>] [--quiet] [--skip-install] [--skip-build]
EOF
}

log() {
  if [[ "$QUIET" != "1" ]]; then
    printf '%s\n' "$1"
  fi
}

warn() {
  printf 'Warning: %s\n' "$1" >&2
}

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
    --quiet)
      QUIET=1
      shift
      ;;
    --skip-install)
      SKIP_INSTALL=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
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
  ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
else
  ROOT="$(cd -- "$ROOT" && pwd -P)"
fi

if [[ ! -f "$ROOT/package.json" ]]; then
  echo "Error: not a repo root: $ROOT" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm is not available; skipping worktree runtime bootstrap."
  exit 2
fi

did_work=0

if [[ ! -d "$ROOT/node_modules" ]]; then
  if [[ "$SKIP_INSTALL" == "1" ]]; then
    warn "node_modules missing in $ROOT but install step was skipped."
    exit 2
  fi
  log "Bootstrapping worktree dependencies in $ROOT"
  (cd "$ROOT" && pnpm install --frozen-lockfile)
  did_work=1
fi

if [[ ! -f "$ROOT/dist/index.js" ]]; then
  if [[ "$SKIP_BUILD" == "1" ]]; then
    warn "dist/index.js missing in $ROOT but build step was skipped."
    exit 2
  fi
  log "Bootstrapping worktree build artifacts in $ROOT"
  (cd "$ROOT" && pnpm build)
  did_work=1
fi

if [[ "$did_work" == "0" ]]; then
  log "Worktree runtime bootstrap already satisfied for $ROOT"
fi
