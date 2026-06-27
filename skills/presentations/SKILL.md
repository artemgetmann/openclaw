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

Use this skill for presentation work: create `.pptx` decks when the user needs
an editable PowerPoint-compatible file, create HTML presentations when the user
needs a polished artifact the bot can design and preview directly, convert decks
or HTML to PDF, extract speaker-facing text, or prepare simple deck edits through
a source-first workflow.

## Routing

- Prefer HTML-to-PDF for polished read/send/share presentations when the user
  does not explicitly need an editable `.pptx`. HTML gives the bot direct layout
  control, browser preview, responsive visuals, and reliable PDF export.
- Prefer Markdown-to-PPTX for new editable decks. It is inspectable, easy to
  revise, and avoids fragile binary edits.
- Ask or infer the output contract before choosing the format:
  use `.pptx` when the user needs to keep editing in PowerPoint, hand off a
  corporate deck file, or use an existing template.
  Use HTML plus PDF when the user wants a final presentation, memo deck, visual
  report, pitch preview, or shareable artifact and has not asked for PowerPoint
  specifically.
- Use LibreOffice headless (`soffice` or `libreoffice`) for export/conversion
  when the input is already `.pptx`, `.odp`, or another office deck format.
- Use `skills/presentations/scripts/presentation-convert.sh` for common
  conversion jobs.
- For HTML presentations, build the page as a local, self-contained HTML file,
  preview it in a browser when available, then export/print to PDF if the user
  needs a portable file.
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

For a polished shareable deck, create `deck.html`, preview it, then export or
print it to `deck.pdf`.

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
