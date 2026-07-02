---
name: screen-record
description: Use when a user asks for screen recording, video proof, browser/GUI visual proof, or UI/UX verification that depends on motion, sequence, progress, or feel.
---

# Screen Record

Canonical instructions live in the product-bundled skill when this skill is
loaded from the repository:

```text
../../../skills/screen-record/SKILL.md
```

Read that file and follow it when the path exists. This repo-local skill exists
so dev agents and Codex select the same screen-recording runbook that ships to
Jarvis users.

Portable fallback:

- Prefer `openclaw screen record --app <App>` or `--bundle <bundle-id>` for
  target-aware recording.
- Use `--window-id <id>` when the exact CoreGraphics window id is known.
- Use full-display recording only with an explicit reason.
- Store recordings locally by default and send one final review video only when
  requested or required.
- Do not spam the user with many screenshot messages during long GUI/browser
  work.
