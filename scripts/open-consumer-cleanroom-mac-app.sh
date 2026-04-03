#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTANCE_ID="${OPENCLAW_CONSUMER_INSTANCE_ID:-}"
REPLACE=1
PACKAGE_FIRST=1
CLEANROOM_ROOT=""

usage() {
  cat <<'EOF'
Usage: scripts/open-consumer-cleanroom-mac-app.sh --instance <id> [--root <dir>] [--no-package] [--no-replace]

Packages and opens a consumer app instance while forcing setup-sensitive
skills onto disposable local state on this Mac:
  - himalaya via HIMALAYA_CONFIG
  - himalaya via a clean-room wrapper on OPENCLAW_SERVICE_PATH_PREFIX
  - wacli via a wrapper on OPENCLAW_SERVICE_PATH_PREFIX
  - wacli auth helper via the same cleanroom bin path
  - gog via XDG_CONFIG_HOME/XDG_DATA_HOME + file keyring + clean-room wrapper
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
    --root)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --root requires a value" >&2
        exit 1
      fi
      CLEANROOM_ROOT="$2"
      shift 2
      ;;
    --no-package)
      PACKAGE_FIRST=0
      shift
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

if [[ -z "$INSTANCE_ID" ]]; then
  echo "ERROR: --instance is required" >&2
  usage >&2
  exit 1
fi

if [[ -z "$CLEANROOM_ROOT" ]]; then
  CLEANROOM_ROOT="/tmp/openclaw-consumer-cleanroom/${INSTANCE_ID}"
fi

BIN_DIR="$CLEANROOM_ROOT/bin"
HIMALAYA_DIR="$CLEANROOM_ROOT/himalaya"
HIMALAYA_CONFIG_PATH="$HIMALAYA_DIR/config.toml"
WACLI_STORE="$CLEANROOM_ROOT/wacli-store"
XDG_CONFIG_DIR="$CLEANROOM_ROOT/xdg-config"
XDG_DATA_DIR="$CLEANROOM_ROOT/xdg-data"

mkdir -p "$BIN_DIR" "$HIMALAYA_DIR" "$WACLI_STORE" "$XDG_CONFIG_DIR" "$XDG_DATA_DIR"

# Resolve host binaries before we prepend the clean-room bin to PATH. Once the
# wrappers exist, `command -v gog` / `command -v himalaya` would just point back
# at the wrappers themselves and recurse forever.
HOST_GOG_BIN="$(command -v gog || true)"
HOST_HIMALAYA_BIN="$(command -v himalaya || true)"

if [[ -z "$HOST_GOG_BIN" ]]; then
  HOST_GOG_BIN="/opt/homebrew/bin/gog"
fi
if [[ -z "$HOST_HIMALAYA_BIN" ]]; then
  HOST_HIMALAYA_BIN="/opt/homebrew/bin/himalaya"
fi

cat > "$HIMALAYA_CONFIG_PATH" <<'EOF'
accounts = {}
EOF

cat > "$BIN_DIR/gog" <<EOF
#!/bin/sh
if [ ! -x "$HOST_GOG_BIN" ]; then
  echo "gog missing at $HOST_GOG_BIN" >&2
  exit 127
fi
exec "$HOST_GOG_BIN" "\$@"
EOF
chmod +x "$BIN_DIR/gog"

cat > "$BIN_DIR/himalaya" <<EOF
#!/bin/sh
if [ ! -x "$HOST_HIMALAYA_BIN" ]; then
  echo "himalaya missing at $HOST_HIMALAYA_BIN" >&2
  exit 127
fi
exec "$HOST_HIMALAYA_BIN" "\$@"
EOF
chmod +x "$BIN_DIR/himalaya"

cat > "$BIN_DIR/wacli" <<EOF
#!/bin/sh
exec /opt/homebrew/bin/wacli --store "$WACLI_STORE" "\$@"
EOF
chmod +x "$BIN_DIR/wacli"

cat > "$BIN_DIR/wacli-auth-local.sh" <<EOF
#!/bin/sh
exec "$ROOT_DIR/skills/wacli/scripts/wacli-auth-local.sh" "\$@"
EOF
chmod +x "$BIN_DIR/wacli-auth-local.sh"

export HIMALAYA_CONFIG="$HIMALAYA_CONFIG_PATH"
export XDG_CONFIG_HOME="$XDG_CONFIG_DIR"
export XDG_DATA_HOME="$XDG_DATA_DIR"
export GOG_KEYRING_PASSWORD="${GOG_KEYRING_PASSWORD:-openclaw-consumer-cleanroom}"
export OPENCLAW_SERVICE_PATH_PREFIX="$BIN_DIR"

# Force gog away from the login keychain so the clean-room behaves like a new
# user instead of silently succeeding via the founder account.
env \
  HOME="${HOME}" \
  XDG_CONFIG_HOME="$XDG_CONFIG_HOME" \
  XDG_DATA_HOME="$XDG_DATA_HOME" \
  GOG_KEYRING_PASSWORD="$GOG_KEYRING_PASSWORD" \
  /opt/homebrew/bin/gog auth keyring file >/dev/null 2>&1 || true

if [[ "$PACKAGE_FIRST" == "1" ]]; then
  CI="${CI:-true}" \
  SKIP_TSC="${SKIP_TSC:-1}" \
  SKIP_UI_BUILD="${SKIP_UI_BUILD:-1}" \
    bash "$ROOT_DIR/scripts/package-consumer-mac-app.sh" --instance "$INSTANCE_ID"
fi

OPEN_ARGS=(--instance "$INSTANCE_ID")
if [[ "$REPLACE" == "1" ]]; then
  OPEN_ARGS+=(--replace)
fi

bash "$ROOT_DIR/scripts/open-consumer-mac-app.sh" "${OPEN_ARGS[@]}"

cat <<EOF
Clean-room runtime prepared:
  instance_id=$INSTANCE_ID
  cleanroom_root=$CLEANROOM_ROOT
  himalaya_config=$HIMALAYA_CONFIG
  wacli_store=$WACLI_STORE
  xdg_config_home=$XDG_CONFIG_HOME
  xdg_data_home=$XDG_DATA_HOME
  service_path_prefix=$OPENCLAW_SERVICE_PATH_PREFIX
EOF
