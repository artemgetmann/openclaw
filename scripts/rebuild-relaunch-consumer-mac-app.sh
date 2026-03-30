#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
REPLACE=1

usage() {
  cat <<'EOF'
Usage: scripts/rebuild-relaunch-consumer-mac-app.sh [--instance <id>] [--no-replace]

Fast founder/tester loop:
  - skips dependency reinstall
  - skips JS build
  - skips Control UI build
  - rebuilds the macOS app bundle in place
  - reopens the packaged consumer app from dist/

Override any default via env, for example:
  SKIP_TSC=0 SKIP_UI_BUILD=0 scripts/rebuild-relaunch-consumer-mac-app.sh
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --instance requires a value" >&2
        exit 1
      fi
      INSTANCE_ID="$2"
      shift 2
      ;;
    --no-replace)
      REPLACE=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

PACKAGE_ARGS=()
OPEN_ARGS=()
DEFAULT_SKIP_TSC="${SKIP_TSC:-1}"

if [[ -n "$INSTANCE_ID" ]]; then
  PACKAGE_ARGS+=(--instance "$INSTANCE_ID")
  OPEN_ARGS+=(--instance "$INSTANCE_ID")
fi

if [[ "$REPLACE" == "1" ]]; then
  OPEN_ARGS+=(--replace)
fi

# The relaunch path eventually runs the worktree doctor, which expects the
# gateway entrypoint to exist. Fresh or partially-bootstrapped lanes may still
# be missing dist/index.js, so fall back to a full JS build once instead of
# failing after the native bundle already finished packaging.
if [[ "${SKIP_TSC+x}" != x && ! -f "$ROOT_DIR/dist/index.js" ]]; then
  DEFAULT_SKIP_TSC=0
  echo "📦 dist/index.js missing; forcing JS build once so relaunch can pass the worktree guard"
fi

# This wrapper is intentionally biased toward warm local iteration. The full
# artifact still lands in dist/, but we stop pretending every relaunch needs
# dependency resolution and unrelated frontend rebuilds.
CI="${CI:-true}" \
SKIP_PNPM_INSTALL="${SKIP_PNPM_INSTALL:-1}" \
SKIP_TSC="$DEFAULT_SKIP_TSC" \
SKIP_UI_BUILD="${SKIP_UI_BUILD:-1}" \
BUILD_CONFIG="${BUILD_CONFIG:-debug}" \
  "$ROOT_DIR/scripts/package-consumer-mac-app.sh" "${PACKAGE_ARGS[@]}"

"$ROOT_DIR/scripts/open-consumer-mac-app.sh" "${OPEN_ARGS[@]}"
