#!/usr/bin/env bash
set -euo pipefail

# Compatibility wrapper kept for older agents and release notes that still call
# the consumer-named command. The canonical main-built product distribution
# command is scripts/package-openclaw-mac-dist.sh.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage: scripts/package-consumer-mac-dist.sh

Compatibility wrapper for:
  scripts/package-openclaw-mac-dist.sh

Use scripts/package-openclaw-mac-dist.sh for new main-built OpenClaw release
packaging. This wrapper is kept so old automation continues to work.
EOF
  exit 0
fi

exec "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" "$@"
