#!/usr/bin/env bash
set -euo pipefail

SOURCE="${HOME}/.openclaw"
DEST="${HOME}/Library/Application Support/OpenClaw/.openclaw"
DRY_RUN=0
FORCE=0

usage() {
  cat <<'EOF'
Usage: scripts/migrate-openclaw-runtime-to-app-support.sh [--dry-run] [--force] [--source <path>] [--dest <path>]

Copy the legacy OpenClaw runtime into the macOS app-owned runtime root.

Defaults:
  source: ~/.openclaw
  dest:   ~/Library/Application Support/OpenClaw/.openclaw

This script copies only. It never deletes or moves the source runtime.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --source)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --source requires a path" >&2
        exit 1
      fi
      SOURCE="$2"
      shift 2
      ;;
    --dest)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --dest requires a path" >&2
        exit 1
      fi
      DEST="$2"
      shift 2
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

if [[ ! -d "$SOURCE" ]]; then
  echo "ERROR: source runtime does not exist: $SOURCE" >&2
  exit 1
fi

if [[ ! -f "$SOURCE/openclaw.json" ]]; then
  echo "ERROR: source runtime is missing openclaw.json: $SOURCE" >&2
  exit 1
fi

if [[ -f "$DEST/openclaw.json" && "$FORCE" != "1" ]]; then
  echo "ERROR: destination already has openclaw.json: $DEST" >&2
  echo "Refusing to overwrite existing app-owned runtime. Re-run with --force to copy missing files only." >&2
  exit 1
fi

mkdir -p "$DEST"

RSYNC_ARGS=(-aE --ignore-existing)
if [[ "$DRY_RUN" == "1" ]]; then
  RSYNC_ARGS+=(--dry-run --itemize-changes)
fi

echo "Source:      $SOURCE"
echo "Destination: $DEST"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "Mode:        dry run"
else
  echo "Mode:        copy missing files"
fi

rsync "${RSYNC_ARGS[@]}" "$SOURCE/" "$DEST/"

if [[ "$DRY_RUN" != "1" ]]; then
  if [[ ! -f "$DEST/openclaw.json" ]]; then
    echo "ERROR: migration finished but destination config is missing: $DEST/openclaw.json" >&2
    exit 1
  fi
  echo "Migration copy complete."
  echo "Old runtime left untouched: $SOURCE"
fi
