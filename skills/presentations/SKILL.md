---
name: presentations
description: Create, convert, and export slide decks such as PowerPoint files with open local tools.
homepage: https://pandoc.org
metadata:
  {
    "openclaw":
      {
        "emoji": "📊",
        "displayName": "Presentations",
        "requires": { "anyBins": ["pandoc", "soffice", "libreoffice"] },
      },
  }
---

# Presentations

Use this skill for PowerPoint-compatible slide work: create `.pptx` decks from
structured source, convert decks to PDF, extract speaker-facing text, or prepare
simple deck edits through a source-first workflow.

## Routing

- Prefer Markdown-to-PPTX for new decks. It is inspectable, easy to revise, and
  avoids fragile binary edits.
- Use LibreOffice headless (`soffice` or `libreoffice`) for export/conversion
  when the input is already `.pptx`, `.odp`, or another office deck format.
- Use `skills/presentations/scripts/presentation-convert.sh` for common
  conversion jobs.
- If the user needs pixel-perfect branded design, ask for the template or
  reference deck first. Do not invent a brand system.
- If local tools are missing, route through `consumer-setup` in product
  language. Do not run Homebrew or mutate global user tools unless explicitly
  asked.

## Common Jobs

```bash
skills/presentations/scripts/presentation-convert.sh deck.md deck.pptx
skills/presentations/scripts/presentation-convert.sh deck.pptx deck.pdf
```

Markdown slide source should use horizontal rules between slides:

```markdown
# Q3 Results

- Revenue up
- Churn down

---

# Risks

- Hiring pace
- Support load
```

## Quality Bar

- Never overwrite the original deck unless the user explicitly asks.
- Verify the output exists and is non-empty.
- For important decks, export a PDF and inspect slide count/layout before
  sending.
