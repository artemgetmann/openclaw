---
name: apple-notes
description: Manage Apple Notes via the `memo` CLI on macOS (create, view, edit, delete, search, move, and export notes). Use when a user asks OpenClaw to add a note, list notes, search notes, or manage note folders.
homepage: https://github.com/antoniorodr/memo
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "os": ["darwin"],
        "requires": { "bins": ["memo"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "antoniorodr/memo/memo",
              "bins": ["memo"],
              "label": "Install memo via Homebrew",
            },
          ],
      },
  }
---

# Apple Notes

Use Apple Notes on macOS.

## Automation Rule

- On a local macOS machine, use the local host directly. Do not route Notes actions through `nodes run` / `system.run`.
- Keep `memo` for list/search/export and fuzzy note lookup.
- For deterministic create/delete, use the local helper at `scripts/apple-notes-local.sh`.

## Setup Routing

- If `memo` is missing or Notes automation permission is blocked, use the
  shared `consumer-setup` skill.
- `memo` still exposes interactive create/edit/delete flows, so consumer-safe
  automation should keep using the local helper for deterministic create/delete
  instead of falling back to the interactive path.

## Deterministic Create/Delete

Create a note without dropping into an editor:

```bash
scripts/apple-notes-local.sh create \
  --folder "Notes" \
  --title "OpenClaw skills audit note" \
  --body "hello from consumer test"
```

Delete a note by exact note id:

```bash
scripts/apple-notes-local.sh delete --id "x-coredata://REPLACE_ME"
```

## Browse And Search

- List all notes: `memo notes`
- Filter by folder: `memo notes --folder "Folder Name"`
- Search notes (fuzzy): `memo notes -s`
- View a specific note from the current list: `memo notes --view 3`
- Refresh cache before listing if Notes changed out of band: `memo notes --no-cache`

## Editing And Moving

- `memo notes -e` is interactive.
- `memo notes -m` is interactive.
- `memo notes -ex` exports a selected note to HTML/Markdown.
- If you need deterministic automation, prefer create + exact delete over trying to drive `memo` interactively.

## Limitations

- `memo` still does not expose a structured non-interactive create/edit/delete API.
- `memo` cannot edit notes containing images or attachments.
- Apple Notes automation requires macOS Automation permission for Notes.app.
