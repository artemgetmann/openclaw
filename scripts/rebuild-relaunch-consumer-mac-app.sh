#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/consumer-instance.sh"

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

EFFECTIVE_INSTANCE_ID="$INSTANCE_ID"
if [[ -z "$EFFECTIVE_INSTANCE_ID" ]]; then
  # Match the lower-level packaging/open helpers before doing any expensive
  # package work. Worktrees become isolated instance lanes automatically; the
  # sacred home clone stays the empty/default Jarvis runtime and must not be
  # source-checkout refreshed by accident.
  EFFECTIVE_INSTANCE_ID="$(consumer_instance_default_id_for_checkout "$ROOT_DIR")"
fi

NORMALIZED_INSTANCE_ID="$(consumer_instance_normalize_id "$EFFECTIVE_INSTANCE_ID")"
if [[ -z "$NORMALIZED_INSTANCE_ID" && "${OPENCLAW_ALLOW_SOURCE_CHECKOUT_JARVIS_REFRESH:-0}" != "1" ]]; then
  echo "ERROR: refusing default Jarvis rebuild/relaunch with gateway refresh." >&2
  echo "  This wrapper would package first, then ask open-consumer-mac-app.sh to install" >&2
  echo "  ai.jarvis.gateway from the source checkout. That is not jarvis-managed-bundle proof." >&2
  echo "" >&2
  echo "Use one of these explicit paths instead:" >&2
  echo "  - Isolated debug lane: bash scripts/rebuild-relaunch-consumer-mac-app.sh --instance <id>" >&2
  echo "  - Read-only managed-bundle proof: bash scripts/prove-jarvis-runtime.sh --expected-commit <sha>" >&2
  echo "  - Break-glass default refresh: OPENCLAW_ALLOW_SOURCE_CHECKOUT_JARVIS_REFRESH=1 ..." >&2
  exit 1
fi

PACKAGE_ARGS=()
OPEN_ARGS=()
DEFAULT_SKIP_PNPM_INSTALL="${SKIP_PNPM_INSTALL:-1}"
DEFAULT_SKIP_TSC="${SKIP_TSC:-1}"

if [[ -n "$NORMALIZED_INSTANCE_ID" ]]; then
  PACKAGE_ARGS+=(--instance "$NORMALIZED_INSTANCE_ID")
  OPEN_ARGS+=(--instance "$NORMALIZED_INSTANCE_ID")
fi

if [[ "$REPLACE" == "1" ]]; then
  OPEN_ARGS+=(--replace)
fi

# This wrapper is an explicit rebuild/relaunch loop, so it owns the persistent
# per-instance gateway refresh. The lower-level open helper stays read-only by
# default to avoid stale test gateways being recreated on casual app opens.
OPEN_ARGS+=(--refresh-gateway)

# A fresh worktree may not have node_modules yet. Keep the warm-path default,
# but automatically allow one dependency install when the checkout is obviously
# not bootstrapped so the helper can succeed end-to-end on first run.
if [[ "${SKIP_PNPM_INSTALL+x}" != x && ! -d "$ROOT_DIR/node_modules" ]]; then
  DEFAULT_SKIP_PNPM_INSTALL=0
  echo "📦 node_modules missing; allowing pnpm install once so the fast path can bootstrap itself"
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
SKIP_PNPM_INSTALL="$DEFAULT_SKIP_PNPM_INSTALL" \
SKIP_TSC="$DEFAULT_SKIP_TSC" \
SKIP_UI_BUILD="${SKIP_UI_BUILD:-1}" \
BUILD_CONFIG="${BUILD_CONFIG:-debug}" \
  "$ROOT_DIR/scripts/package-consumer-mac-app.sh" "${PACKAGE_ARGS[@]}"

"$ROOT_DIR/scripts/open-consumer-mac-app.sh" "${OPEN_ARGS[@]}"
