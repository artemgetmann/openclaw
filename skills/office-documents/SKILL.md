---
name: office-documents
description: Work with Word documents, spreadsheets, presentations, PDFs, and HTML-to-PDF/deck workflows. Use when the user asks to create, inspect, convert, summarize, edit, or export documents such as .docx, .xlsx, .pptx, .pdf, Google Docs, Google Sheets, Google Slides, or browser-rendered PDFs.
metadata:
  { "openclaw": { "emoji": "📚", "displayName": "Documents, Spreadsheets & Presentations" } }
---

# Documents, Spreadsheets & Presentations

Use this skill for document-style work across PDFs, Office files, Google
Workspace files, and HTML-to-PDF outputs.

## Routing

- For Google Docs, Sheets, Slides, or Drive files, use `gog` / Google Workspace
  when connected. If Google auth is missing, route through `consumer-setup`.
- For PDFs, use the built-in PDF tool for analysis and `nano-pdf` for simple
  natural-language PDF edits when available.
- For HTML-to-PDF, create or open the HTML in the browser and export/print to
  PDF. Verify the rendered result before sending it.
- For local `.docx`, `.xlsx`, or `.pptx`, first inspect what tools are actually
  available in the runtime. Do not claim native Office editing is ready unless
  a suitable document/spreadsheet/presentation tool or converter is present.
- If no native Office editor/converter is available, use a truthful fallback:
  extract or summarize when possible, create a clean HTML/PDF version, or ask
  whether the user wants a Google Workspace version instead.

## Product Rule

Speak in user outcomes: "document", "spreadsheet", "presentation", "PDF", or
"deck". Mention file internals, XML, converters, or CLI names only when needed
for setup, debugging, or review.
