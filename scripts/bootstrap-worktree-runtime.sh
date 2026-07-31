#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ORIGINAL_ARGS=("$@")
ROOT=""
QUIET=0
SKIP_INSTALL=0
SKIP_BUILD=0
READY_MODE="clean"

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

# shellcheck source=scripts/lib/heavy-local-slot.sh
source "$SCRIPT_ROOT/scripts/lib/heavy-local-slot.sh"
openclaw_heavy_local_slot_require_or_reexec \
  "bootstrap-worktree-runtime:$(basename "$ROOT")" \
  "$SCRIPT_ROOT" \
  "$SCRIPT_ROOT/scripts/bootstrap-worktree-runtime.sh" \
  "${ORIGINAL_ARGS[@]}"

source "$ROOT/scripts/lib/validated-node.sh"

# Worktree bootstrap is the first dependency install/build a fresh lane sees.
# Pin the runtime here so pnpm scripts and shebangs do not inherit a random
# shell-default Node that differs from the consumer runtime we validate.
openclaw_use_validated_node "$ROOT" >/dev/null || exit 1
VALIDATED_NODE_BIN="$OPENCLAW_NODE_BIN"
READY_CHECK_SCRIPT="$ROOT/scripts/worktree-ready-check.sh"

did_work=0
build_skipped=0
install_attempted=0
build_attempted=0

if [[ -L "$ROOT/node_modules" ]]; then
  warn "node_modules must be installed in this worktree, not symlinked: $ROOT/node_modules"
  exit 2
fi

if [[ ! -d "$ROOT/node_modules" ]]; then
  if [[ "$SKIP_INSTALL" == "1" ]]; then
    warn "node_modules missing in $ROOT but install step was skipped."
    exit 2
  fi
  log "Bootstrapping worktree dependencies in $ROOT"
  openclaw_run_repo_pnpm "$ROOT" install --frozen-lockfile
  did_work=1
  install_attempted=1
fi

build_is_current() {
  local build_info_path="$ROOT/dist/build-info.json"
  local head_commit=""
  local build_commit=""

  [[ -f "$ROOT/dist/index.js" && -f "$build_info_path" ]] || return 1
  head_commit="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" || return 1
  build_commit="$(
    BUILD_INFO_PATH="$build_info_path" "$VALIDATED_NODE_BIN" --input-type=module - <<'NODE'
import fs from "node:fs";

try {
  const parsed = JSON.parse(fs.readFileSync(process.env.BUILD_INFO_PATH, "utf8"));
  if (typeof parsed?.commit === "string") {
    process.stdout.write(parsed.commit.trim());
  }
} catch {
  // Invalid metadata is stale and will be rebuilt below.
}
NODE
  )"
  [[ -n "$build_commit" && "$build_commit" == "$head_commit" ]]
}

if ! build_is_current; then
  if [[ "$SKIP_BUILD" == "1" ]]; then
    log "Skipping missing or stale build recovery in $ROOT because --skip-build was requested"
    build_skipped=1
    READY_MODE="warm"
  else
    log "Bootstrapping missing or stale worktree build artifacts in $ROOT"
    openclaw_run_repo_pnpm "$ROOT" build
    did_work=1
    build_attempted=1
  fi
fi

if [[ "$SKIP_BUILD" == "1" ]]; then
  READY_MODE="warm"
fi

run_ready_check() {
  local -a args=(--root "$ROOT" --mode "$READY_MODE")
  if [[ "$QUIET" == "1" ]]; then
    args+=(--quiet)
  fi
  bash "$READY_CHECK_SCRIPT" "${args[@]}"
}

if ! run_ready_check >/dev/null; then
  # Artifact presence is not enough. If the lane cannot resolve local tools
  # like Vitest, repair it before we tell the caller bootstrap is done.
  if [[ "$SKIP_INSTALL" != "1" && "$install_attempted" == "0" ]]; then
    log "Worktree readiness failed; reinstalling dependencies in $ROOT"
    openclaw_run_repo_pnpm "$ROOT" install --frozen-lockfile
    did_work=1
    install_attempted=1
  fi

  if [[ "$READY_MODE" == "clean" && "$SKIP_BUILD" != "1" && "$build_attempted" == "0" ]]; then
    log "Worktree readiness failed; rebuilding artifacts in $ROOT"
    openclaw_run_repo_pnpm "$ROOT" build
    did_work=1
    build_attempted=1
  fi

  run_ready_check >/dev/null
fi

if [[ "$did_work" == "0" ]]; then
  if [[ "$build_skipped" == "1" ]]; then
    log "Worktree runtime bootstrap dependency state already satisfied for $ROOT (build skipped)"
  else
    log "Worktree runtime bootstrap already satisfied for $ROOT"
  fi
  log "Validated node: $VALIDATED_NODE_BIN"
fi
