#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"

# Agent tool calls often run from the ephemeral OpenClaw workspace, not from the
# repo checkout. Resolve runtime dependencies from the checkout so `tsx` does not
# get looked up relative to that workspace and fail before this script starts.
if [[ -f "$REPO_ROOT/dist/index.js" ]]; then
  cd "$REPO_ROOT"
  export OPENCLAW_GOPLACES_RUNTIME_ROOT="$REPO_ROOT"
  exec node "$SCRIPT_DIR/goplaces-search.mjs" "$@"
fi

if [[ -d "$REPO_ROOT/node_modules/tsx" ]]; then
  cd "$REPO_ROOT"
  export OPENCLAW_GOPLACES_RUNTIME_ROOT="$REPO_ROOT"
  exec node --import tsx "$SCRIPT_DIR/goplaces-search.mjs" "$@"
fi

# Packaged and shared skill mirrors do not live inside the runtime checkout.
# Jarvis keeps the matching built runtime under its state directory instead. A
# shared personal mirror may run without the service-injected state variable, so
# also try the standard packaged Jarvis state location under the current home.
EXPLICIT_STATE_DIR="${OPENCLAW_STATE_DIR:-}"
# Match core state resolution: blank modern values do not suppress a real
# legacy override, and whitespace-only values are not meaningful paths.
if [[ -z "$EXPLICIT_STATE_DIR" || "$EXPLICIT_STATE_DIR" =~ ^[[:space:]]*$ ]]; then
  EXPLICIT_STATE_DIR="${CLAWDBOT_STATE_DIR:-}"
fi
if [[ "$EXPLICIT_STATE_DIR" =~ ^[[:space:]]*$ ]]; then
  EXPLICIT_STATE_DIR=""
fi
if [[ -n "$EXPLICIT_STATE_DIR" ]]; then
  STATE_DIR="$EXPLICIT_STATE_DIR"
  # Environment variables keep a literal tilde. Expand the supported home form
  # against OpenClaw's effective home before probing and config discovery.
  if [[ "$STATE_DIR" == "~" || "$STATE_DIR" == "~/"* ]]; then
    EFFECTIVE_HOME="${OPENCLAW_HOME:-${HOME:-}}"
    if [[ "$EFFECTIVE_HOME" == "~" || "$EFFECTIVE_HOME" == "~/"* ]]; then
      EFFECTIVE_HOME="${HOME:-}${EFFECTIVE_HOME:1}"
    fi
    if [[ -z "$EFFECTIVE_HOME" ]]; then
      echo "ERROR: HOME is required to expand OPENCLAW_STATE_DIR: $STATE_DIR" >&2
      exit 1
    fi
    STATE_DIR="$EFFECTIVE_HOME${STATE_DIR:1}"
  fi
  BUNDLED_RUNTIME_ROOT="$STATE_DIR/lib/openclaw-bundled"
  if [[ ! -f "$BUNDLED_RUNTIME_ROOT/dist/index.js" && -n "${HOME:-}" ]]; then
    # Custom/profile states may intentionally reuse the standard packaged code.
    # Keep their state authoritative while falling back only for runtime code.
    BUNDLED_RUNTIME_ROOT="$HOME/Library/Application Support/Jarvis/.jarvis/lib/openclaw-bundled"
  fi
  if [[ ! -f "$BUNDLED_RUNTIME_ROOT/dist/index.js" ]]; then
    echo "ERROR: could not locate a packaged OpenClaw runtime for explicit state: $STATE_DIR" >&2
    exit 1
  fi
  cd "$BUNDLED_RUNTIME_ROOT"
  export OPENCLAW_STATE_DIR="$STATE_DIR"
  export OPENCLAW_GOPLACES_RUNTIME_ROOT="$BUNDLED_RUNTIME_ROOT"
  exec node "$SCRIPT_DIR/goplaces-search.mjs" "$@"
fi

if [[ -n "${HOME:-}" ]]; then
  STATE_DIR="$HOME/Library/Application Support/Jarvis/.jarvis"
  BUNDLED_RUNTIME_ROOT="$STATE_DIR/lib/openclaw-bundled"
  if [[ -f "$BUNDLED_RUNTIME_ROOT/dist/index.js" ]]; then
    cd "$BUNDLED_RUNTIME_ROOT"
    export OPENCLAW_GOPLACES_RUNTIME_ROOT="$BUNDLED_RUNTIME_ROOT"
    exec node "$SCRIPT_DIR/goplaces-search.mjs" "$@"
  fi
fi

echo "ERROR: could not locate built OpenClaw runtime or repo-local node_modules/tsx for goplaces-search." >&2
echo "Run pnpm build or pnpm install in $REPO_ROOT, or set OPENCLAW_STATE_DIR to a packaged Jarvis runtime." >&2
exit 1
