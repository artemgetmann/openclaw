#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  spreadsheet-convert.sh <input> <output>

Converts spreadsheet files with local open tools.
Examples:
  spreadsheet-convert.sh data.csv data.xlsx
  spreadsheet-convert.sh workbook.xlsx workbook.pdf
  spreadsheet-convert.sh workbook.ods workbook.xlsx
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "$#" -ne 2 ]]; then
  usage >&2
  exit 2
fi

input="$1"
output="$2"

if [[ ! -f "$input" ]]; then
  printf 'ERROR: input file not found: %s\n' "$input" >&2
  exit 1
fi

mkdir -p "$(dirname "$output")"

output_ext="${output##*.}"
output_ext="$(printf '%s' "$output_ext" | tr '[:upper:]' '[:lower:]')"

office_bin() {
  if command -v soffice >/dev/null 2>&1; then
    printf 'soffice'
    return 0
  fi
  if command -v libreoffice >/dev/null 2>&1; then
    printf 'libreoffice'
    return 0
  fi
  return 1
}

office="$(office_bin)" || {
  printf 'ERROR: missing LibreOffice. Connect Jarvis spreadsheet conversion tools first.\n' >&2
  exit 127
}

out_dir="$(cd "$(dirname "$output")" && pwd -P)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-spreadsheet-convert.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

# LibreOffice owns the messy office-format details. The wrapper only normalizes
# paths and verifies output so agents do not pretend a conversion succeeded.
"$office" --headless --convert-to "$output_ext" --outdir "$tmp_dir" "$input" >/dev/null
converted="$(find "$tmp_dir" -maxdepth 1 -type f | head -n 1)"
if [[ -z "$converted" || ! -f "$converted" ]]; then
  printf 'ERROR: LibreOffice did not produce a converted file.\n' >&2
  exit 1
fi

mv "$converted" "$out_dir/$(basename "$output")"

if [[ ! -s "$output" ]]; then
  printf 'ERROR: output file is missing or empty: %s\n' "$output" >&2
  exit 1
fi

printf '%s\n' "$output"
