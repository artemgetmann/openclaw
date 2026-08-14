---
name: pdf
description: Create, inspect, render, and verify PDF deliverables. Use for requests to make a new PDF, export readable call sheets or briefs, inspect PDF text/layout, or prepare a PDF before sending it.
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

Use this skill for PDF creation, export, inspection, and delivery QA.

## Default route

1. For a new simple PDF, create a JSON spec and run `openclaw artifacts create-pdf spec.json --out output.pdf`.
2. Use `openclaw artifacts html-to-pdf input.html --out output.pdf --scale 1` only when the source is already HTML/CSS or the user explicitly asks for an HTML-backed PDF.
3. Render final PDF pages to PNG before sending when Poppler is available with `openclaw artifacts render-pdf output.pdf --out-dir rendered`.
4. Inspect rendered pages for clipping, missing spaces, bad glyphs, overlap, and unreadable tables.
5. Use text extraction only as a quick sanity check. Do not treat extracted text as proof that visual layout is correct.

## Stop rules

- If the requested PDF cannot be rendered or inspected locally, say which dependency is missing and do not claim visual QA passed.
- Do not keep trying unrelated converters after a deterministic route fails. Fix the route or report the blocker.
- Do not convert ordinary text into HTML just to make a PDF. Pick direct PDF generation or DOCX export first.
- Do not send a generated PDF until the latest rendered pages are visually readable.

## Common commands

```bash
openclaw artifacts create-pdf spec.json --out output.pdf
openclaw artifacts html-to-pdf input.html --out output.pdf --scale 1
openclaw artifacts render-pdf output.pdf --out-dir rendered
pdftoppm -png input.pdf output/page
pdfinfo input.pdf
```
