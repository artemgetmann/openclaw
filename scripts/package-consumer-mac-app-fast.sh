#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
DEFAULT_SKIP_TSC="${SKIP_TSC:-1}"

usage() {
  cat <<'EOF'
Usage: scripts/package-consumer-mac-app-fast.sh [--instance <id>]
Fast packaged-smoke path for local consumer iteration.

This keeps the app bundle in the worktree dist/ directory, skips the canonical
consumer-home mirror/zip, skips the CLI tarball packaging step, and skips the
duplicate Team ID audit in codesign. The verifier still runs.
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
if [[ -n "$INSTANCE_ID" ]]; then
  PACKAGE_ARGS+=(--instance "$INSTANCE_ID")
fi

# Fresh or partially bootstrapped lanes may not have a built runtime yet. Fall
# back to one JS build instead of claiming a fast smoke path that cannot verify.
if [[ "${SKIP_TSC+x}" != x && ! -f "$ROOT_DIR/dist/index.js" ]]; then
  DEFAULT_SKIP_TSC=0
  echo "📦 dist/index.js missing; forcing JS build once so fast packaging has a real runtime payload"
fi

OPENCLAW_CONSUMER_FAST_PACKAGING=1 \
SKIP_TEAM_ID_CHECK=1 \
SKIP_PNPM_INSTALL="${SKIP_PNPM_INSTALL:-1}" \
SKIP_TSC="$DEFAULT_SKIP_TSC" \
SKIP_UI_BUILD="${SKIP_UI_BUILD:-1}" \
BUILD_CONFIG="${BUILD_CONFIG:-debug}" \
CI="${CI:-true}" \
OPENCLAW_CONSUMER_INSTANCE_ID="$INSTANCE_ID" \
  "$ROOT_DIR/scripts/package-consumer-mac-app.sh" "${PACKAGE_ARGS[@]}"
