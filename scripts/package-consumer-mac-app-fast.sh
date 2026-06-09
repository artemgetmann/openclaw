#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
DEFAULT_SKIP_TSC="${SKIP_TSC:-1}"
REUSE_RUNTIME=0

usage() {
  cat <<'EOF'
Usage: scripts/package-consumer-mac-app-fast.sh [--instance <id>] [--reuse-runtime]
Fast packaged-smoke path for local consumer iteration.

This keeps the app bundle in the worktree dist/ directory, skips the canonical
consumer-home mirror/zip, skips the CLI tarball packaging step, and skips the
duplicate Team ID audit in codesign. The verifier still runs.

  --reuse-runtime  Smoke-only: reuse the previous app bundle's
                   Contents/Resources/OpenClawRuntime instead of redeploying
                   runtime node_modules/Node/uv payloads. Use only when runtime
                   inputs have not changed.
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
    --reuse-runtime|--skip-runtime-deploy)
      REUSE_RUNTIME=1
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
if [[ -n "$INSTANCE_ID" ]]; then
  PACKAGE_ARGS+=(--instance "$INSTANCE_ID")
fi

runtime_js_ready() {
  # A packaged app needs both entrypoints: launchd ownership still points at
  # dist/index.*, while openclaw.mjs boots through dist/entry.* for user-facing
  # CLI commands. Shipping only the app shell strands onboarding at startup.
  [[ -f "$ROOT_DIR/dist/index.js" || -f "$ROOT_DIR/dist/index.mjs" ]] || return 1
  [[ -f "$ROOT_DIR/dist/entry.js" || -f "$ROOT_DIR/dist/entry.mjs" ]] || return 1
}

# Fresh or partially bootstrapped lanes may not have a built runtime yet. Fall
# back to one JS build instead of claiming a fast smoke path that cannot verify.
if [[ "$REUSE_RUNTIME" == "1" ]] && ! runtime_js_ready; then
  echo "ERROR: runtime JS missing; --reuse-runtime is unsafe. Rerun once without --reuse-runtime to rebuild runtime JS." >&2
  exit 1
fi
if [[ "$REUSE_RUNTIME" != "1" ]] && ! runtime_js_ready; then
  DEFAULT_SKIP_TSC=0
  echo "📦 runtime JS missing; forcing JS build once so fast packaging has a real runtime payload"
fi

OPENCLAW_CONSUMER_FAST_PACKAGING=1 \
SKIP_TEAM_ID_CHECK=1 \
SKIP_PNPM_INSTALL="${SKIP_PNPM_INSTALL:-1}" \
SKIP_TSC="$DEFAULT_SKIP_TSC" \
SKIP_UI_BUILD="${SKIP_UI_BUILD:-1}" \
BUILD_CONFIG="${BUILD_CONFIG:-debug}" \
CI="${CI:-true}" \
OPENCLAW_CONSUMER_REUSE_RUNTIME="$REUSE_RUNTIME" \
SKIP_RUNTIME_PAYLOAD_CODESIGN="${SKIP_RUNTIME_PAYLOAD_CODESIGN:-$REUSE_RUNTIME}" \
OPENCLAW_CONSUMER_INSTANCE_ID="$INSTANCE_ID" \
  "$ROOT_DIR/scripts/package-consumer-mac-app.sh" "${PACKAGE_ARGS[@]}"
