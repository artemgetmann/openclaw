#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

exec node --import tsx "$SCRIPT_DIR/wacli-auth-local.ts" "$@"
