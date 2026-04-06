#!/usr/bin/env bash

# Keep the legacy entrypoint alive, but make the TypeScript CLI the single
# orchestration owner so proof output and preflight behavior stop drifting.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${REPO_ROOT}"
exec pnpm openclaw:local telegram smoke dm-reply --json "$@"
