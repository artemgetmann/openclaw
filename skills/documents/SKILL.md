---
name: documents
description: Create, edit, convert, inspect, and export Word-compatible documents with open local tools.
homepage: https://pandoc.org
metadata:
  {
    "openclaw":
      {
        "emoji": "📄",
        "displayName": "Documents",
        "requires": { "anyBins": ["pandoc", "soffice", "libreoffice"] },
      },
  }
---

# Documents

Use this skill for Word-compatible document work: create `.docx` files, convert
Markdown or HTML into documents, export documents to PDF, extract plain text,
or make scoped edits to document source before regenerating the final file.

## Routing

- Prefer source-first edits. If the user has Markdown, HTML, or text, edit that
  source and regenerate the `.docx`/PDF output instead of patching binary files
  blindly.
- Use `pandoc` for Markdown, HTML, plain text, and structured export workflows.
- Use LibreOffice headless (`soffice` or `libreoffice`) for Office-format
  import/export when the file is already `.docx`, `.odt`, `.rtf`, or similar.
- Use `skills/documents/scripts/document-convert.sh` for common conversion jobs.
- If the required local tools are missing, route through `consumer-setup` in
  product language. Do not run Homebrew or mutate global user tools unless the
  user explicitly asks for that technical path.

## Common Jobs

```bash
skills/documents/scripts/document-convert.sh input.md output.docx
skills/documents/scripts/document-convert.sh input.docx output.pdf
skills/documents/scripts/document-convert.sh input.html output.docx
```

For text extraction:

```bash
pandoc input.docx -t plain -o output.txt
```

## Quality Bar

- Never overwrite the original unless the user explicitly asks.
- Verify the output file exists and is non-empty before claiming it is ready.
- For important documents, inspect exported text or render/export a PDF before
  sending.
- Ask before changing legal, financial, medical, or contractual wording.
