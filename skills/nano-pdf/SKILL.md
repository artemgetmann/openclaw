---
name: nano-pdf
description: Edit PDFs with natural-language instructions using the nano-pdf CLI.
homepage: https://github.com/gavrielc/Nano-PDF
metadata:
  {
    "openclaw":
      {
        "emoji": "📄",
        "displayName": "PDF Editing",
        "requires": { "bins": ["nano-pdf"] },
        "install":
          [
            {
              "id": "uv",
              "kind": "uv",
              "package": "nano-pdf",
              "bins": ["nano-pdf"],
              "label": "Install nano-pdf (uv)",
            },
          ],
      },
  }
---

# PDF Editing (nano-pdf)

Use `nano-pdf` to apply natural-language edits to existing PDF pages or insert a
new generated page.

## Setup

- Requires `GEMINI_API_KEY` with Gemini billing enabled.
- Requires system PDF/OCR helpers: Poppler and Tesseract.
- Install the CLI with `uv tool install nano-pdf` when `nano-pdf` is missing.

## Quick start

```bash
nano-pdf edit deck.pdf 1 "Change the title to 'Q3 Results' and fix the typo in the subtitle"
nano-pdf edit deck.pdf 1 "Make the title more concise" 5 "Replace the chart caption"
nano-pdf add deck.pdf 0 "Add a title page with a dark background and the title 'Q3 Results'"
nano-pdf add deck.pdf 3 "Insert a summary page after page 3"
```

## Useful Options

- `--output <path>` sets the output PDF path. The default is
  `edited_<filename>`.
- `--style-refs <file-or-dir>` passes visual references for style matching.
- `--resolution 4K|2K|1K` controls generated-page/edit resolution.
- `--use-context` includes neighboring PDF context when editing.
- `--disable-google-search` disables Google Search grounding when supported.

Notes:

- `edit` page numbers are 1-based.
- `add` uses `0` to insert at the beginning; otherwise, the page number is
  1-based and inserts after that page.
- For multi-page edits, pass repeated page/instruction pairs.
- Always sanity-check the output PDF before sending it out.
