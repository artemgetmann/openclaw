#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Run directly on Node's native TypeScript stripping so the helper does not
# depend on a separate tsx install being globally resolvable on the host.
exec node --experimental-strip-types "$SCRIPT_DIR/wacli-live.ts" "$@"
