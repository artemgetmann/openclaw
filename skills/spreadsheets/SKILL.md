---
name: spreadsheets
description: Create, edit, analyze, export, and verify spreadsheet artifacts including XLSX, XLS, CSV, TSV, and Google Sheets-targeted workbooks. Use for Excel files, formulas, tables, charts, financial models, and sheet deliverables.
metadata: { "openclaw": { "emoji": "📈", "displayName": "Spreadsheets" } }
---

# Spreadsheets

Use this skill for spreadsheet creation, editing, analysis, and delivery.

## Default route

1. Preserve spreadsheet semantics: numbers are numbers, dates are dates, formulas are formulas.
2. Save sheets and typed rows as JSON, then run `openclaw artifacts create-xlsx spec.json --out output.xlsx`.
3. Put assumptions and raw data in clear input areas. Keep derived outputs formula-driven when the sheet is meant to be editable.
4. Check formulas for bad references, circular references, and off-by-one ranges.
5. Inspect important sheets in an available spreadsheet viewer when visual layout matters. Do not make workbook creation depend on that optional viewer.

## Stop rules

- Do not hardcode formula outputs unless the user explicitly asks for static values.
- Do not use CSV when the user asked for Excel formatting, formulas, charts, or multiple sheets.
- If creation fails, report the exact bundled-library error instead of installing or searching for host tools.
