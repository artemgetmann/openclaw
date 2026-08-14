#!/usr/bin/env bash
set -euo pipefail

# Standalone, read-only multi-filesystem gate. Future release wrappers must pass
# both their final output target and actual heavy-staging target to the same
# sourceable library interface before their first packaging mutation.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/build-artifacts.sh"
source "$ROOT_DIR/scripts/lib/jarvis-release-disk-preflight.sh"

REQUIRED_KIB="${JARVIS_RELEASE_DISK_REQUIRED_KIB:-$(jarvis_release_disk_default_required_kib)}"
EXPLICIT_TARGETS=0
TARGET_LABELS=()
TARGET_PATHS=()

usage() {
  cat <<'EOF'
Usage: scripts/preflight-jarvis-release-disk.sh [options]

Read-only Jarvis release disk-capacity gate. It performs no packaging action.
By default it checks repo dist/ output plus the build-artifact runs staging root.

Options:
  --target <label> <path>  Add a target. Repeat for every release filesystem.
  --output-path <path>     Add the release-output target.
  --staging-path <path>    Add the release-staging target.
  --path <path>            Compatibility: check one target named "target".
  --required-kib <kib>     Override the conservative 45 GiB full-release admission threshold.
  --help                   Show this help.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 2
}

add_target() {
  local label="$1"
  local path="$2"
  TARGET_LABELS[${#TARGET_LABELS[@]}]="$label"
  TARGET_PATHS[${#TARGET_PATHS[@]}]="$path"
  EXPLICIT_TARGETS=1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ $# -ge 3 ]] || die "--target requires a label and path"
      add_target "$2" "$3"
      shift 3
      ;;
    --output-path)
      [[ $# -ge 2 ]] || die "--output-path requires a value"
      add_target release-output "$2"
      shift 2
      ;;
    --staging-path)
      [[ $# -ge 2 ]] || die "--staging-path requires a value"
      add_target release-staging "$2"
      shift 2
      ;;
    --path)
      [[ $# -ge 2 ]] || die "--path requires a value"
      add_target target "$2"
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

if [[ "$EXPLICIT_TARGETS" == "0" ]]; then
  if [[ -n "${JARVIS_RELEASE_DISK_TARGET:-}" ]]; then
    add_target target "$JARVIS_RELEASE_DISK_TARGET"
  else
    add_target release-output "${JARVIS_RELEASE_OUTPUT_TARGET:-$ROOT_DIR/dist}"
    add_target release-staging "${JARVIS_RELEASE_STAGING_TARGET:-$(openclaw_build_artifact_root)/runs}"
  fi
fi

PREFLIGHT_ARGS=("$REQUIRED_KIB")
i=0
while ((i < ${#TARGET_LABELS[@]})); do
  PREFLIGHT_ARGS[${#PREFLIGHT_ARGS[@]}]="${TARGET_LABELS[$i]}"
  PREFLIGHT_ARGS[${#PREFLIGHT_ARGS[@]}]="${TARGET_PATHS[$i]}"
  i=$((i + 1))
done

printf 'Jarvis release disk preflight\n'
jarvis_release_disk_preflight_targets "${PREFLIGHT_ARGS[@]}"
