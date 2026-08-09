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

if [[ "$MODE" == "clean" ]]; then
  BUILD_INFO_PATH="$ROOT/dist/build-info.json"
  BUILD_STATE_PATH="$ROOT/dist/.openclaw-worktree-build-state.json"
  [[ -f "$BUILD_INFO_PATH" ]] || fail "clean lanes require build metadata at $BUILD_INFO_PATH"
  [[ -f "$BUILD_STATE_PATH" ]] || fail "clean lanes require tracked-source build state at $BUILD_STATE_PATH"

  # Artifact presence alone is not readiness. A prior branch or commit can
  # leave a perfectly executable dist/ tree behind. HEAD alone is insufficient:
  # staged or unstaged tracked source can also advance without a commit. Bind
  # clean readiness to both identities and let bootstrap own recovery.
  BUILD_STATE_STATUS="$(
    ROOT_PATH="$ROOT" BUILD_INFO_PATH="$BUILD_INFO_PATH" BUILD_STATE_PATH="$BUILD_STATE_PATH" \
      "$OPENCLAW_NODE_BIN" --input-type=module - <<'NODE'
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

try {
  const root = process.env.ROOT_PATH;
  const buildInfo = JSON.parse(fs.readFileSync(process.env.BUILD_INFO_PATH, "utf8"));
  const buildState = JSON.parse(fs.readFileSync(process.env.BUILD_STATE_PATH, "utf8"));
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const trackedDiff = execFileSync("git", ["-C", root, "diff", "--binary", "HEAD", "--"], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  const trackedDiffHash = crypto.createHash("sha256").update(trackedDiff).digest("hex");
  if (buildInfo?.commit !== commit || buildState?.commit !== commit) {
    process.stdout.write("commit_mismatch");
  } else if (buildState?.version !== 1 || buildState?.trackedDiffHash !== trackedDiffHash) {
    process.stdout.write("tracked_source_mismatch");
  } else {
    process.stdout.write("current");
  }
} catch {
  process.stdout.write("invalid_metadata");
}
NODE
  )"
  [[ "$BUILD_STATE_STATUS" == "current" ]] ||
    fail "clean lane build is stale (${BUILD_STATE_STATUS}): rebuild tracked source state in $ROOT"
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
