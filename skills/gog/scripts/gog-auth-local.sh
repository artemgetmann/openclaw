#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Packaged Jarvis intentionally omits development dependencies such as `tsx`.
# The managed runtime is Node 22+, whose built-in type stripping can execute
# this erasable TypeScript helper without resolving anything from node_modules.
exec node --experimental-strip-types "$SCRIPT_DIR/gog-auth-local.ts" "$@"
