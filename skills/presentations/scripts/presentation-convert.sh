#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  presentation-convert.sh <input> <output>

Converts slide sources/decks with local open tools.
Examples:
  presentation-convert.sh deck.md deck.pptx
  presentation-convert.sh deck.pptx deck.pdf
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

input_ext="${input##*.}"
output_ext="${output##*.}"
input_ext="$(printf '%s' "$input_ext" | tr '[:upper:]' '[:lower:]')"
output_ext="$(printf '%s' "$output_ext" | tr '[:upper:]' '[:lower:]')"

has_bin() {
  command -v "$1" >/dev/null 2>&1
}

office_bin() {
  if has_bin soffice; then
    printf 'soffice'
    return 0
  fi
  if has_bin libreoffice; then
    printf 'libreoffice'
    return 0
  fi
  return 1
}

# Keep new decks source-first: Markdown can be reviewed, revised, and regenerated
# without reverse-engineering a binary PowerPoint file.
if has_bin pandoc && [[ "$input_ext" =~ ^(md|markdown|html|htm)$ && "$output_ext" == "pptx" ]]; then
  pandoc "$input" -t pptx -o "$output"
elif office="$(office_bin)"; then
  out_dir="$(cd "$(dirname "$output")" && pwd -P)"
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-presentation-convert.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' EXIT

  "$office" --headless --convert-to "$output_ext" --outdir "$tmp_dir" "$input" >/dev/null
  converted="$(find "$tmp_dir" -maxdepth 1 -type f | head -n 1)"
  if [[ -z "$converted" || ! -f "$converted" ]]; then
    printf 'ERROR: LibreOffice did not produce a converted file.\n' >&2
    exit 1
  fi
  mv "$converted" "$out_dir/$(basename "$output")"
else
  printf 'ERROR: missing presentation conversion tools. Install or connect Pandoc/LibreOffice for Jarvis first.\n' >&2
  exit 127
fi

if [[ ! -s "$output" ]]; then
  printf 'ERROR: output file is missing or empty: %s\n' "$output" >&2
  exit 1
fi

printf '%s\n' "$output"
