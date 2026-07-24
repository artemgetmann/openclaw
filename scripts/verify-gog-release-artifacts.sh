#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/openclaw-runtime-payloads.sh"
source "$ROOT_DIR/scripts/lib/consumer-gog-runtime.sh"

cache_root="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-gog-release-proof.XXXXXX")"
trap 'rm -rf "$cache_root"' EXIT

# A clean materialization proves the pinned archive hashes, both architecture
# signatures, the reviewed identifier/Team ID, license, and executable version.
OPENCLAW_CONSUMER_GOG_CACHE_ROOT="$cache_root" \
  openclaw_ensure_consumer_gog_runtime "0.33.0" >/dev/null

echo "Gog v0.33.0 release artifacts verified"
