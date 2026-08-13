---
name: presentations
description: Create, edit, export, and verify PowerPoint/PPTX or Google Slides-targeted decks. Use for slide decks, presentation files, template edits, speaker decks, and .pptx output.
metadata:
  {
    "openclaw":
      {
        "emoji": "📊",
        "displayName": "Presentations",
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

# Presentations

Use this skill for PPTX/PowerPoint artifacts and PDF slide handouts.

## Default route

1. Plan the deck as structured slide content before authoring: title, story arc, slide list, and per-slide content.
2. If the user needs editable slides, create a JSON spec and run `openclaw artifacts create-pptx deck.json --out deck.pptx`.
3. If the user only needs a shareable/read-only deck PDF, an HTML/CSS slide deck is acceptable; export it with `openclaw artifacts html-to-pdf deck.html --out deck.pdf --scale 1 --prefer-css-page-size`.
4. Keep layouts simple and inspect for text overflow, overlap, and bad wrapping.
5. Export editable decks to PDF with `openclaw artifacts pptx-to-pdf deck.pptx --out deck.pdf` when visual QA is needed.
6. Render PDF slides before delivery whenever possible; use `openclaw artifacts render-pdf deck.pdf --out-dir rendered` after any PDF export.
7. If the user wants native Google Slides, create and verify a local PPTX first, then import through the Google Drive route if available.

## Stop rules

- Do not deliver slides that have not been rendered or visually inspected unless you clearly state the QA gap.
- Do not use screenshots or images as a substitute for editable slide content unless the user requested image-only output.
- Do not deliver HTML-backed slide PDFs when the user asked for editable PPTX/Google Slides; use them only for read-only PDF decks or quick visual drafts.
- If the required runtime or renderer is unavailable, report that blocker instead of improvising multiple converters.

## Common commands

Use HTML export for compact visual decks, PDF handouts, or when the user explicitly wants a PDF presentation and does not need editable PPTX.

```bash
openclaw artifacts create-pptx deck.json --out deck.pptx
openclaw artifacts pptx-to-pdf deck.pptx --out deck.pdf
openclaw artifacts html-to-pdf deck.html --out deck.pdf --scale 1 --prefer-css-page-size
openclaw artifacts render-pdf deck.pdf --out-dir rendered
```
