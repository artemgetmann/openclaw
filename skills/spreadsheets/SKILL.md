---
name: spreadsheets
description: Create, clean, inspect, convert, and export spreadsheet files with open local tools.
homepage: https://www.libreoffice.org
metadata:
  {
    "openclaw":
      {
        "emoji": "📈",
        "displayName": "Spreadsheets",
        "requires": { "anyBins": ["soffice", "libreoffice", "python3"] },
      },
  }
---

# Spreadsheets

Use this skill for spreadsheet work: inspect CSV/TSV data, clean tabular files,
convert between `.csv`, `.xlsx`, `.ods`, and PDF, create simple spreadsheets,
or prepare formulas and summaries before exporting.

## Routing

- Use Python standard-library CSV handling for deterministic cleaning,
  filtering, merging, and validation.
- Use LibreOffice headless (`soffice` or `libreoffice`) for `.xlsx`, `.ods`,
  and PDF conversion.
- Use `skills/spreadsheets/scripts/spreadsheet-convert.sh` for common
  conversion jobs.
- For advanced workbook creation that requires charts, formulas, styles, or
  multi-sheet authoring, use an open library such as `openpyxl`, `xlsxwriter`,
  or `exceljs` only when it is available in the runtime or after the user
  approves setup.
- If local tools are missing, route through `consumer-setup` in product
  language. Do not run Homebrew or mutate global user tools unless explicitly
  asked.

## Common Jobs

```bash
skills/spreadsheets/scripts/spreadsheet-convert.sh data.csv data.xlsx
skills/spreadsheets/scripts/spreadsheet-convert.sh workbook.xlsx workbook.pdf
```

For quick CSV inspection:

```bash
python3 - <<'PY' data.csv
import csv, sys
with open(sys.argv[1], newline="") as f:
    rows = list(csv.reader(f))
print({"rows": len(rows), "columns": len(rows[0]) if rows else 0, "header": rows[0] if rows else []})
PY
```

## Quality Bar

- Never overwrite the original unless the user explicitly asks.
- Validate row counts, column counts, and key totals before claiming a cleaned
  file is ready.
- For financial or operational data, show the checks you ran and ask before
  making irreversible transformations.
