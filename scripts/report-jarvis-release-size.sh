#!/usr/bin/env bash
set -euo pipefail

# Read-only Jarvis release size inventory. This intentionally reports bloat
# without deleting or pruning anything; bundle diet needs separate proof.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/jarvis-release-orchestration.sh"

APP_PATH="$ROOT_DIR/dist/Jarvis.app"
OUTPUT_PATH="$ROOT_DIR/dist/jarvis-release-size-report.env"
TOP_OUTPUT_PATH="$ROOT_DIR/dist/jarvis-release-size-top.txt"
DETAIL_OUTPUT_PATH="$ROOT_DIR/dist/jarvis-release-size-details.txt"

usage() {
  cat <<'EOF'
Usage: scripts/report-jarvis-release-size.sh [options]

Options:
  --app <path>       App bundle to inspect. Default: dist/Jarvis.app
  --output <path>    Env-style report path. Default: dist/jarvis-release-size-report.env
  --top-output <path>
                    Largest-entry text report. Default: dist/jarvis-release-size-top.txt
  --detail-output <path>
                    Focused bundle-diet report. Default: dist/jarvis-release-size-details.txt

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
    --detail-output)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --detail-output requires a path." >&2
        exit 1
      fi
      DETAIL_OUTPUT_PATH="$2"
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
RUNTIME_DIST_ASSETS_DIR="$RUNTIME_DIST_DIR/assets"
RUNTIME_DIST_PLUGIN_SDK_ASSETS_DIR="$RUNTIME_DIST_DIR/plugin-sdk/assets"
DMG_PATH="$DIST_DIR/Jarvis.dmg"
ZIP_PATH="$DIST_DIR/Jarvis.zip"
APPCAST_PATH="$DIST_DIR/jarvis-appcast.xml"

write_size_line() {
  local key="$1"
  local path="$2"
  printf '%s=%q\n' "$key" "$(jarvis_release_size_bytes "$path")"
}

min_nonempty_size() {
  local left="$1"
  local right="$2"

  if [[ -z "$left" || -z "$right" ]]; then
    printf '%s\n' ""
    return 0
  fi
  if [[ "$left" -lt "$right" ]]; then
    printf '%s\n' "$left"
  else
    printf '%s\n' "$right"
  fi
}

write_sorted_children() {
  local root="$1"
  local depth="$2"
  local limit="$3"

  if [[ ! -d "$root" ]]; then
    printf 'missing\t%s\n' "$root"
    return 0
  fi

  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/jarvis-size-children.XXXXXX")"
  while IFS= read -r -d '' entry; do
    local bytes
    bytes="$(jarvis_release_size_bytes "$entry")"
    [[ -n "$bytes" ]] || continue
    printf '%s\t%s\n' "$bytes" "$entry"
  done < <(find "$root" -mindepth 1 -maxdepth "$depth" -print0 2>/dev/null) \
    | sort -nr >"$tmp"
  head -"$limit" "$tmp"
  rm -f "$tmp"
}

write_matching_dirs() {
  local root="$1"
  local limit="$2"

  if [[ ! -d "$root" ]]; then
    printf 'missing\t%s\n' "$root"
    return 0
  fi

  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/jarvis-size-dirs.XXXXXX")"
  while IFS= read -r -d '' entry; do
    local bytes
    bytes="$(jarvis_release_size_bytes "$entry")"
    [[ -n "$bytes" ]] || continue
    printf '%s\t%s\n' "$bytes" "$entry"
  done < <(
    find "$root" -type d \( \
      -name '__tests__' -o \
      -name 'test' -o \
      -name 'tests' -o \
      -name 'docs' -o \
      -name 'doc' -o \
      -name 'examples' -o \
      -name 'example' -o \
      -name 'benchmark' -o \
      -name 'benchmarks' -o \
      -name 'coverage' -o \
      -name '.cache' \
    \) -print0 2>/dev/null
  ) | sort -nr >"$tmp"
  head -"$limit" "$tmp"
  rm -f "$tmp"
}

write_matching_files() {
  local root="$1"
  local limit="$2"

  if [[ ! -d "$root" ]]; then
    printf 'missing\t%s\n' "$root"
    return 0
  fi

  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/jarvis-size-files.XXXXXX")"
  while IFS= read -r -d '' entry; do
    local bytes
    bytes="$(jarvis_release_size_bytes "$entry")"
    [[ -n "$bytes" ]] || continue
    printf '%s\t%s\n' "$bytes" "$entry"
  done < <(
    find "$root" -type f \( \
      -name '*.node' -o \
      -name '*.dylib' -o \
      -name '*.so' -o \
      -name '*.a' \
    \) -print0 2>/dev/null
  ) | sort -nr >"$tmp"
  head -"$limit" "$tmp"
  rm -f "$tmp"
}

mkdir -p "$(dirname "$OUTPUT_PATH")" "$(dirname "$TOP_OUTPUT_PATH")" "$(dirname "$DETAIL_OUTPUT_PATH")"

dist_assets_bytes="$(jarvis_release_size_bytes "$RUNTIME_DIST_ASSETS_DIR")"
plugin_sdk_assets_bytes="$(jarvis_release_size_bytes "$RUNTIME_DIST_PLUGIN_SDK_ASSETS_DIR")"
duplicate_asset_candidate_bytes="$(min_nonempty_size "$dist_assets_bytes" "$plugin_sdk_assets_bytes")"

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
  write_size_line "JARVIS_RELEASE_SIZE_RUNTIME_DIST_ASSETS_BYTES" "$RUNTIME_DIST_ASSETS_DIR"
  write_size_line "JARVIS_RELEASE_SIZE_RUNTIME_DIST_PLUGIN_SDK_ASSETS_BYTES" "$RUNTIME_DIST_PLUGIN_SDK_ASSETS_DIR"
  printf 'JARVIS_RELEASE_SIZE_DUPLICATE_DIST_ASSETS_CANDIDATE_BYTES=%q\n' "$duplicate_asset_candidate_bytes"
  write_size_line "JARVIS_RELEASE_SIZE_DMG_BYTES" "$DMG_PATH"
  write_size_line "JARVIS_RELEASE_SIZE_ZIP_BYTES" "$ZIP_PATH"
  write_size_line "JARVIS_RELEASE_SIZE_APPCAST_BYTES" "$APPCAST_PATH"
  printf 'JARVIS_RELEASE_SIZE_TOP_ENTRIES=%q\n' "$TOP_OUTPUT_PATH"
  printf 'JARVIS_RELEASE_SIZE_DETAILS=%q\n' "$DETAIL_OUTPUT_PATH"
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

{
  printf 'Jarvis bundle diet detail report for %s\n' "$APP_DIR"
  printf 'This report is read-only. Treat entries as candidates, not deletion approval.\n\n'

  printf 'Top pnpm package store entries\n'
  printf 'bytes\tpath\n'
  if [[ -d "$RUNTIME_NODE_MODULES_DIR/.pnpm" ]]; then
    write_sorted_children "$RUNTIME_NODE_MODULES_DIR/.pnpm" 1 50
  else
    write_sorted_children "$RUNTIME_NODE_MODULES_DIR" 1 50
  fi
  printf '\n'

  printf 'Top direct node_modules entries\n'
  printf 'bytes\tpath\n'
  write_sorted_children "$RUNTIME_NODE_MODULES_DIR" 1 50
  printf '\n'

  printf 'Top bundled extensions\n'
  printf 'bytes\tpath\n'
  write_sorted_children "$RUNTIME_EXTENSIONS_DIR" 1 50
  printf '\n'

  printf 'Runtime dist asset buckets\n'
  printf 'bytes\tpath\n'
  printf '%s\t%s\n' "${dist_assets_bytes:-missing}" "$RUNTIME_DIST_ASSETS_DIR"
  printf '%s\t%s\n' "${plugin_sdk_assets_bytes:-missing}" "$RUNTIME_DIST_PLUGIN_SDK_ASSETS_DIR"
  printf '%s\t%s\n' "${duplicate_asset_candidate_bytes:-missing}" "duplicate-assets-candidate-lower-bound"
  printf '\n'

  printf 'Top runtime dist entries\n'
  printf 'bytes\tpath\n'
  write_sorted_children "$RUNTIME_DIST_DIR" 2 50
  printf '\n'

  printf 'Top bundled Node payload entries\n'
  printf 'bytes\tpath\n'
  write_sorted_children "$RUNTIME_NODE_DIR" 2 50
  printf '\n'

  printf 'Top bundled uv payload entries\n'
  printf 'bytes\tpath\n'
  write_sorted_children "$RUNTIME_UV_DIR" 2 50
  printf '\n'

  printf 'Top native binary files under node_modules\n'
  printf 'bytes\tpath\n'
  write_matching_files "$RUNTIME_NODE_MODULES_DIR" 50
  printf '\n'

  printf 'Likely dev/docs/test payload directories\n'
  printf 'bytes\tpath\n'
  write_matching_dirs "$RUNTIME_OPENCLAW_DIR" 75
} >"$DETAIL_OUTPUT_PATH"

echo "Jarvis release size report:"
echo "  app=$APP_DIR"
echo "  app_bytes=$(jarvis_release_size_bytes "$APP_DIR")"
echo "  runtime_bytes=$(jarvis_release_size_bytes "$RUNTIME_DIR")"
echo "  node_modules_bytes=$(jarvis_release_size_bytes "$RUNTIME_NODE_MODULES_DIR")"
echo "  duplicate_asset_candidate_bytes=$duplicate_asset_candidate_bytes"
echo "  report=$OUTPUT_PATH"
echo "  top_entries=$TOP_OUTPUT_PATH"
echo "  details=$DETAIL_OUTPUT_PATH"
