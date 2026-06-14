#!/usr/bin/env bash
set -euo pipefail

# Read-only Jarvis release size inventory. This intentionally reports bloat
# without deleting or pruning anything; bundle diet needs separate proof.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/jarvis-release-orchestration.sh"

APP_PATH="$ROOT_DIR/dist/Jarvis.app"
OUTPUT_PATH="$ROOT_DIR/dist/jarvis-release-size-report.env"
TOP_OUTPUT_PATH="$ROOT_DIR/dist/jarvis-release-size-top.txt"

usage() {
  cat <<'EOF'
Usage: scripts/report-jarvis-release-size.sh [options]

Options:
  --app <path>       App bundle to inspect. Default: dist/Jarvis.app
  --output <path>    Env-style report path. Default: dist/jarvis-release-size-report.env
  --top-output <path>
                    Largest-entry text report. Default: dist/jarvis-release-size-top.txt

This script is read-only. It never deletes or modifies release artifacts.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --app requires a path." >&2
        exit 1
      fi
      APP_PATH="$2"
      shift 2
      ;;
    --output)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --output requires a path." >&2
        exit 1
      fi
      OUTPUT_PATH="$2"
      shift 2
      ;;
    --top-output)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --top-output requires a path." >&2
        exit 1
      fi
      TOP_OUTPUT_PATH="$2"
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

if [[ ! -d "$APP_PATH" ]]; then
  echo "ERROR: app bundle not found: $APP_PATH" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "$APP_PATH")" && pwd -P)/$(basename "$APP_PATH")"
DIST_DIR="$(cd "$ROOT_DIR/dist" 2>/dev/null && pwd -P || printf '%s\n' "$ROOT_DIR/dist")"
RUNTIME_DIR="$APP_DIR/Contents/Resources/OpenClawRuntime"
RUNTIME_OPENCLAW_DIR="$RUNTIME_DIR/openclaw"
RUNTIME_DIST_DIR="$RUNTIME_OPENCLAW_DIR/dist"
RUNTIME_NODE_MODULES_DIR="$RUNTIME_OPENCLAW_DIR/node_modules"
RUNTIME_NODE_DIR="$RUNTIME_DIR/node"
RUNTIME_UV_DIR="$RUNTIME_DIR/uv"
RUNTIME_EXTENSIONS_DIR="$RUNTIME_OPENCLAW_DIR/extensions"
RUNTIME_SKILLS_DIR="$RUNTIME_OPENCLAW_DIR/skills"
RUNTIME_TEMPLATES_DIR="$RUNTIME_OPENCLAW_DIR/docs/reference/templates"
DMG_PATH="$DIST_DIR/Jarvis.dmg"
ZIP_PATH="$DIST_DIR/Jarvis.zip"
APPCAST_PATH="$DIST_DIR/jarvis-appcast.xml"

write_size_line() {
  local key="$1"
  local path="$2"
  printf '%s=%q\n' "$key" "$(jarvis_release_size_bytes "$path")"
}

mkdir -p "$(dirname "$OUTPUT_PATH")" "$(dirname "$TOP_OUTPUT_PATH")"

{
  printf 'JARVIS_RELEASE_SIZE_REPORT_VERSION=%q\n' "1"
  printf 'JARVIS_RELEASE_SIZE_REPORT_CREATED_AT=%q\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'JARVIS_RELEASE_SIZE_APP_PATH=%q\n' "$APP_DIR"
  write_size_line "JARVIS_RELEASE_SIZE_APP_BYTES" "$APP_DIR"
  write_size_line "JARVIS_RELEASE_SIZE_RUNTIME_BYTES" "$RUNTIME_DIR"
  write_size_line "JARVIS_RELEASE_SIZE_RUNTIME_OPENCLAW_BYTES" "$RUNTIME_OPENCLAW_DIR"
  write_size_line "JARVIS_RELEASE_SIZE_RUNTIME_DIST_BYTES" "$RUNTIME_DIST_DIR"
  write_size_line "JARVIS_RELEASE_SIZE_RUNTIME_NODE_MODULES_BYTES" "$RUNTIME_NODE_MODULES_DIR"
  write_size_line "JARVIS_RELEASE_SIZE_RUNTIME_NODE_BYTES" "$RUNTIME_NODE_DIR"
  write_size_line "JARVIS_RELEASE_SIZE_RUNTIME_UV_BYTES" "$RUNTIME_UV_DIR"
  write_size_line "JARVIS_RELEASE_SIZE_RUNTIME_EXTENSIONS_BYTES" "$RUNTIME_EXTENSIONS_DIR"
  write_size_line "JARVIS_RELEASE_SIZE_RUNTIME_SKILLS_BYTES" "$RUNTIME_SKILLS_DIR"
  write_size_line "JARVIS_RELEASE_SIZE_RUNTIME_TEMPLATES_BYTES" "$RUNTIME_TEMPLATES_DIR"
  write_size_line "JARVIS_RELEASE_SIZE_DMG_BYTES" "$DMG_PATH"
  write_size_line "JARVIS_RELEASE_SIZE_ZIP_BYTES" "$ZIP_PATH"
  write_size_line "JARVIS_RELEASE_SIZE_APPCAST_BYTES" "$APPCAST_PATH"
  printf 'JARVIS_RELEASE_SIZE_TOP_ENTRIES=%q\n' "$TOP_OUTPUT_PATH"
} >"$OUTPUT_PATH"

if [[ -d "$RUNTIME_DIR" ]]; then
  TOP_SORTED_PATH="$(mktemp "${TMPDIR:-/tmp}/jarvis-release-size-top.XXXXXX")"
  trap 'rm -f "${TOP_SORTED_PATH:-}"' EXIT
  while IFS= read -r -d '' entry; do
    bytes="$(jarvis_release_size_bytes "$entry")"
    [[ -n "$bytes" ]] || continue
    printf '%s\t%s\n' "$bytes" "$entry"
  done < <(find "$RUNTIME_DIR" -mindepth 1 -maxdepth 4 -print0 2>/dev/null) \
    | sort -nr >"$TOP_SORTED_PATH"

  {
    printf 'Largest Jarvis runtime entries for %s\n' "$APP_DIR"
    printf 'bytes\tpath\n'
    head -50 "$TOP_SORTED_PATH"
  } >"$TOP_OUTPUT_PATH"
else
  {
    printf 'Largest Jarvis runtime entries for %s\n' "$APP_DIR"
    printf 'bytes\tpath\n'
    printf 'missing\t%s\n' "$RUNTIME_DIR"
  } >"$TOP_OUTPUT_PATH"
fi

echo "Jarvis release size report:"
echo "  app=$APP_DIR"
echo "  app_bytes=$(jarvis_release_size_bytes "$APP_DIR")"
echo "  runtime_bytes=$(jarvis_release_size_bytes "$RUNTIME_DIR")"
echo "  node_modules_bytes=$(jarvis_release_size_bytes "$RUNTIME_NODE_MODULES_DIR")"
echo "  report=$OUTPUT_PATH"
echo "  top_entries=$TOP_OUTPUT_PATH"
