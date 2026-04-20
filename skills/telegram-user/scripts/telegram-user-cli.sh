#!/usr/bin/env bash
set -euo pipefail

# Resolve the repo root from the skill location so agents can call one stable
# helper path without depending on their current working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"

# Keep this wrapper thin on purpose: it is only a deterministic entrypoint to
# the existing in-repo telegram-user CLI, not a second Telegram backend.
cd "$REPO_ROOT"
exec pnpm openclaw:local telegram-user "$@"
