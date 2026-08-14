---
name: presentations
description: Create, edit, export, and verify PowerPoint/PPTX or Google Slides-targeted decks. Use for slide decks, presentation files, template edits, speaker decks, and .pptx output.
metadata: { "openclaw": { "emoji": "📊", "displayName": "Presentations" } }
---

# Presentations

Use this skill for PPTX/PowerPoint artifacts and PDF slide handouts.

## Default route

1. Plan the deck as structured slide content before authoring: title, story arc, slide list, and per-slide content.
2. If the user needs editable slides, create a JSON spec and run `openclaw artifacts create-pptx deck.json --out deck.pptx`.
3. If the user needs a read-only PDF handout, create a structured PDF directly with `openclaw artifacts create-pdf handout.json --out handout.pdf`. Do not make the default route depend on Office or LibreOffice conversion.
4. Keep layouts simple and inspect for text overflow, overlap, and bad wrapping when an Office-compatible viewer is available.
5. If the user wants native Google Slides, create and verify a local PPTX first, then import through the Google Drive route if available.

## Stop rules

- Do not deliver slides that have not been rendered or visually inspected unless you clearly state the QA gap.
- Do not use screenshots or images as a substitute for editable slide content unless the user requested image-only output.
- Do not deliver HTML-backed slide PDFs when the user asked for editable PPTX/Google Slides; use them only for read-only PDF decks or quick visual drafts.
- If creation fails, report the exact bundled-library error instead of installing or searching for host tools.

## Common commands

```bash
openclaw artifacts create-pptx deck.json --out deck.pptx
openclaw artifacts create-pdf handout.json --out handout.pdf
```
