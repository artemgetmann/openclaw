---
name: documents
description: Create, edit, export, and verify Word/DOCX or Google Docs-targeted document artifacts. Use for readable briefs, call sheets, memos, checklists, scripts, and any request involving .docx or Word-style output.
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "displayName": "Documents",
        "install":
          [
            {
              "id": "libreoffice-brew",
              "kind": "brew",
              "formula": "libreoffice",
              "bins": ["soffice"],
              "label": "Install LibreOffice (brew)",
            },
            {
              "id": "poppler-brew",
              "kind": "brew",
              "formula": "poppler",
              "bins": ["pdftoppm", "pdfinfo"],
              "label": "Install Poppler (brew)",
            },
          ],
      },
  }
---

# Documents

Use this skill for DOCX/Word-style artifacts and document-to-PDF export.

## Default route

1. Draft the content as a clear structured document: title, sections, paragraphs, bullets, tables, and notes.
2. Save that content as JSON and run `openclaw artifacts create-docx spec.json --out output.docx`.
3. Use real Word styles, real lists, and explicit table widths. Do not fake bullets, numbering, or table layout with plain text.
4. Export DOCX to PDF with `openclaw artifacts docx-to-pdf input.docx --out output.pdf` when the user wants a PDF copy.
5. Render the exported PDF with `openclaw artifacts render-pdf output.pdf --out-dir rendered` and inspect the page PNGs before delivery.

## Stop rules

- If `soffice` or the document library is missing, report the missing dependency instead of cycling through LaTeX, browser print, Typst, CUPS, and other unrelated fallbacks.
- Do not send a maybe-good document. Render and inspect it, or say visual QA could not be completed.
- Keep support files private unless the user asks for them. Deliver the final `.docx`, `.pdf`, or both.

## LibreOffice export

```bash
openclaw artifacts create-docx spec.json --out output.docx
openclaw artifacts docx-to-pdf input.docx --out output.pdf
openclaw artifacts render-pdf output.pdf --out-dir rendered
soffice --headless --convert-to pdf --outdir output input.docx
```
