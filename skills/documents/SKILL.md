---
name: documents
description: Create, edit, export, and verify Word/DOCX or Google Docs-targeted document artifacts. Use for readable briefs, call sheets, memos, checklists, scripts, and any request involving .docx or Word-style output.
metadata: { "openclaw": { "emoji": "📝", "displayName": "Documents" } }
---

# Documents

Use this skill for DOCX/Word-style artifacts.

## Default route

1. Draft the content as a clear structured document: title, sections, paragraphs, bullets, tables, and notes.
2. Save that content as JSON and run `openclaw artifacts create-docx spec.json --out output.docx`.
3. Use real Word styles, real lists, and explicit table widths. Do not fake bullets, numbering, or table layout with plain text.
4. Open or inspect the resulting DOCX when the available environment has an Office-compatible viewer. Do not make document creation depend on that optional viewer.

## Stop rules

- If creation fails, report the exact bundled-library error instead of installing or searching for host tools.
- Do not claim visual QA when no Office-compatible viewer is available.
- Keep support files private unless the user asks for them. Deliver the final `.docx`.

## Creation

```bash
openclaw artifacts create-docx spec.json --out output.docx
```
