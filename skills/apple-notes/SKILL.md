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

Use Apple Notes on macOS. `memo` is useful for browsing/searching existing
notes, but its create/edit/delete flows are interactive and can drop into Vim.
For automation or agent use, prefer direct AppleScript on the local macOS host.

## Automation Rule

- On a local macOS machine, use the local host directly. Do not route Notes
  actions through `nodes run` / `system.run`.
- For deterministic create/delete, prefer `osascript` over `memo`.
- Use `memo` mainly for listing/searching/exporting notes.

Setup

- Install (Homebrew): `brew tap antoniorodr/memo && brew install antoniorodr/memo/memo`
- Manual (pip): `pip install .` (after cloning the repo)
- Current upstream release is `v0.5.2`; older `0.3.x` builds are stale.
- macOS-only; if prompted, grant Automation access to Notes.app.

## Deterministic Create/Delete

Create a note in the default `Notes` folder:

```bash
osascript <<'EOF'
tell application "Notes"
  tell folder "Notes"
    make new note with properties {body:"<h1>Note Title</h1><p>Body text here.</p>"}
  end tell
end tell
EOF
```

That returns a note id such as `x-coredata://...`. Use that exact id to delete
the note later:

```bash
osascript <<'EOF'
tell application "Notes"
  delete note id "x-coredata://REPLACE_ME"
end tell
EOF
```

If you need to verify the note exists after creation, use `memo` to list notes
in the folder and confirm the title appears:

```bash
memo notes --folder Notes
```

If AppleScript is unavailable and you still need to create a note through
`memo`, drive the `$EDITOR` hook non-interactively with a wrapper script:

```bash
cat >/tmp/memo-editor.sh <<'EOF'
#!/bin/sh
printf '%s\n' '# Note Title' '' 'Body line 1' 'Body line 2' > "$1"
EOF
chmod +x /tmp/memo-editor.sh
EDITOR=/tmp/memo-editor.sh memo notes -a -f "Notes"
```

That path works for create, but it is less deterministic than AppleScript and
should not be your first choice for cleanup or repeated automation.

View Notes

- List all notes: `memo notes`
- Filter by folder: `memo notes --folder "Folder Name"`
- Search notes interactively: `memo notes -s`

Create Notes

- Avoid `memo notes -a` for automation. It is interactive and can hang while
  waiting for an editor.
- Use AppleScript create for agent/local automation.

Edit Notes

- `memo notes -e` is interactive.
- For consumer-safe automation, prefer creating a replacement note or use
  AppleScript/JXA with an exact note id when possible.

Delete Notes

- `memo notes -d` is interactive and expects a list ordinal, not the visible
  note id shown by `memo`.
- For deterministic cleanup, use AppleScript delete by exact note id.

Move Notes

- Move note to folder: `memo notes -m`
  - Interactive selection of note and destination folder.

Export Notes

- Export to HTML/Markdown: `memo notes -ex`
  - Exports selected note; uses Mistune for markdown processing.

Limitations

- Cannot edit notes containing images or attachments.
- `memo` create/edit/delete prompts may require terminal access and an editor.
- AppleScript create/delete is better for consumer-agent automation on macOS.

Notes

- macOS-only.
- Requires Apple Notes.app to be accessible.
- For automation, grant permissions in System Settings > Privacy & Security > Automation.
