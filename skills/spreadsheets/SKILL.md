---
name: spreadsheets
description: Create, edit, analyze, export, and verify spreadsheet artifacts including XLSX, XLS, CSV, TSV, and Google Sheets-targeted workbooks. Use for Excel files, formulas, tables, charts, financial models, and sheet deliverables.
metadata:
  {
    "openclaw":
      {
        "emoji": "📈",
        "displayName": "Spreadsheets",
        "install":
          [
            {
              "id": "libreoffice-brew",
              "kind": "brew",
              "formula": "libreoffice",
              "bins": ["soffice"],
              "label": "Install LibreOffice (brew)",
            },
          ],
      },
  }
---

# Spreadsheets

Use this skill for spreadsheet creation, editing, analysis, and delivery.

## Default route

1. Preserve spreadsheet semantics: numbers are numbers, dates are dates, formulas are formulas.
2. Use a workbook library when the runtime provides it, or a bundled artifact runtime for `.xlsx` creation and edits.
3. Put assumptions and raw data in clear input areas. Keep derived outputs formula-driven when the sheet is meant to be editable.
4. Check formulas for bad references, circular references, and off-by-one ranges.
5. Export/render important sheets before delivery when visual layout matters; use `openclaw artifacts render-pdf workbook.pdf --out-dir rendered` after any PDF export.

## Stop rules

- Do not hardcode formula outputs unless the user explicitly asks for static values.
- Do not use CSV when the user asked for Excel formatting, formulas, charts, or multiple sheets.
- If the workbook runtime is missing, report the missing dependency instead of fabricating a partial spreadsheet.
