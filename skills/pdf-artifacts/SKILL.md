---
name: pdf-artifacts
description: Create polished, fixed PDF deliverables such as reports, briefs, call sheets, and applications, then render and visually verify every page before delivery. Use when the user wants a finished PDF file; use the general PDF capability instead for OCR, extraction, forms, merging, splitting, or editing an existing PDF.
metadata:
  {
    "openclaw":
      {
        "emoji": "📄",
        "displayName": "PDF Artifacts",
        "install":
          [
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

# PDF Artifacts

Create finished PDF documents and verify their visual quality before delivery.

## Choose the source format

- For ordinary text-heavy reports, briefs, and call sheets, create a JSON spec
  and generate the PDF directly.
- For a visually designed report where typography, color, cards, charts, or
  precise layout materially improve scanning, create self-contained HTML/CSS
  and convert it to PDF. The user does not need to request HTML explicitly.
- When the source is already HTML/CSS, preserve that source and convert it.
- Do not introduce HTML for plain prose that direct PDF generation handles
  clearly.

## Create and verify

1. Generate the PDF with the appropriate route:
   - `openclaw artifacts create-pdf spec.json --out output.pdf`
   - `openclaw artifacts html-to-pdf input.html --out output.pdf --scale 1`
2. Render the final PDF pages with
   `openclaw artifacts render-pdf output.pdf --out-dir rendered` when Poppler
   is available.
3. Inspect every rendered page for clipping, missing spaces, broken glyphs,
   overlap, poor contrast, and unreadable tables.
4. Correct the source and regenerate until the latest rendered pages are
   readable.
5. Deliver the PDF, not the intermediate HTML or JSON, unless the user asks for
   those source files.

Text extraction is only a quick sanity check. It does not prove that the page
layout is correct.

## Stop rules

- If the PDF cannot be rendered or inspected locally, name the missing
  dependency and do not claim visual verification passed.
- After a deterministic conversion failure, fix the selected route or report
  the blocker instead of cycling through unrelated converters.
- Do not send a generated PDF until the latest rendered pages are visually
  readable.

## Useful checks

```bash
pdftoppm -png input.pdf output/page
pdfinfo input.pdf
```
