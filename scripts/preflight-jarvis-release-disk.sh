#!/usr/bin/env bash
set -euo pipefail

# Standalone, read-only disk gate. Release wrappers can source the library and
# call the same function before their first packaging mutation in a later PR.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/jarvis-release-disk-preflight.sh"

TARGET_PATH="${JARVIS_RELEASE_DISK_TARGET:-$ROOT_DIR}"
REQUIRED_KIB="${JARVIS_RELEASE_DISK_REQUIRED_KIB:-$(jarvis_release_disk_default_required_kib)}"

usage() {
  cat <<'EOF'
Usage: scripts/preflight-jarvis-release-disk.sh [options]

Read-only Jarvis release disk-capacity gate. It performs no packaging action.

Options:
  --path <path>          Filesystem path to check. Default: repository root.
  --required-kib <kib>  Override the conservative 25 GiB capacity floor.
  --help                 Show this help.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path)
      [[ $# -ge 2 ]] || die "--path requires a value"
      TARGET_PATH="$2"
      shift 2
      ;;
    --required-kib)
      [[ $# -ge 2 ]] || die "--required-kib requires a value"
      REQUIRED_KIB="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

printf 'Jarvis release disk preflight\n'
jarvis_release_disk_preflight "$TARGET_PATH" "$REQUIRED_KIB"
