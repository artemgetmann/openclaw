---
name: gog
description: Use for Google Workspace requests tied to Gmail, Google Calendar, Drive, Docs, Sheets, or Contacts, especially when the user explicitly mentions Google or needs cross-surface Google account access. Prefer this over generic email skills when the task is clearly in the Google ecosystem.
metadata:
  {
    "openclaw":
      {
        "emoji": "🎮",
        "requires": { "bins": ["gog"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/gogcli",
              "bins": ["gog"],
              "label": "Install gog (brew)",
            },
          ],
      },
  }
---

# gog

Use `gog` for Gmail, Google Calendar, Drive, Docs, Sheets, and Contacts work.
This is the Google-account skill, not the generic mailbox skill.

Use it when the user means things like:

- "search Gmail" or "reply in my Gmail"
- "check my Google Calendar" or "create a calendar event"
- "find a file in Drive"
- "read a Google Doc" or "update a Google Sheet"
- "look up a contact from my Google account"

If the task is generic email read/reply/search without a Google-specific ask,
prefer `himalaya` instead. Requires OAuth setup.

Setup routing

- If OAuth client credentials, account auth, or `gog auth list` are missing,
  use the shared `consumer-setup` skill instead of pushing raw setup commands at
  the user.
- In consumer lanes, run `gog` as a direct lane-local exec call. Do not wrap it
  in shell chains, pipes, or `nodes/system.run`.
- If `gog` is wrapped through `openclaw nodes run`, insert `--` before the
  child argv so `gog` keeps its own flags.
- Start with the cheapest truthful checks: `gog auth list`, then a read-only
  surface probe such as `gog gmail search`, `gog drive search`, or
  `gog calendar events`.
- Allow node execution when the runtime supports it. Missing
  `system.run.prepare` alone is not a valid reason to mark `gog` execution as
  blocked.
- If a direct `gog auth list` succeeds but returns no accounts, say the Google
  connection is missing. Do not tell the user `gog` itself is unavailable.
- If the real blocker is OAuth client/test-user setup, say that immediately in
  plain product language instead of burning turns on unrelated command retries.
- Keep the CLI setup path opt-in. If the user explicitly wants the terminal
  flow, you can execute the normal `gog auth ...` commands yourself.
- Prefer direct safe-bin invocation first: `gog auth list`, then a read-only
  probe like `gog gmail search`, `gog drive search`, or `gog calendar events`.
- In Normal permissions mode, direct `gog ...` commands are allowed. The
  default restriction is on shell wrappers (`bash -lc`, `sh -c`), pipes,
  chaining, and redirection.
- If the current runtime already has `gog`, stay local first. Do not bounce to
  a paired node unless local `gog` is actually unavailable.
- If you wrap `gog` through `openclaw nodes run`, insert `--` before the child
  argv so `gog` keeps its own flags.
- Ban dumb shell chaining, pipes, and redirection around `gog`.
- Allow node execution when the runtime supports it. Missing
  `system.run.prepare` alone is not a valid reason to mark `gog` execution as
  blocked.
- If setup is missing, do not dump raw CLI setup commands back to a consumer.
  Treat it as a setup-needed state and use the shared `consumer-setup` skill.

Setup Routing

- If `gog` is missing OAuth credentials, has no authorized account, or the
  requested account/surfaces are not ready, route setup through
  `consumer-setup`.
- Use the raw CLI steps below only when you are the one performing setup or the
  user explicitly asks for the terminal path.
- For new Google setups, default to the Google Workspace core bundle:
  `gmail,calendar,drive,contacts,docs,sheets`.
- Do not default to Drive-only or make the user come back later for Calendar
  unless they explicitly want a narrower scope.
- For local browser OAuth, prefer a direct safe-bin invocation first:
  `gog auth add <email> --services gmail,calendar,drive,contacts,docs,sheets`.
  `gog` can open the browser itself on this Mac, and that path avoids repo-local
  helper allowlist problems.
- If repo-local helper execution is denied, fall back to direct `gog auth add`
  instead of telling the user to use Terminal or detouring to a node.
- For local consumer OAuth setup, prefer
  `skills/gog/scripts/gog-auth-local.sh start --email <email> --services <csv>`
  when the runtime allows repo-local helper scripts and you need resumable
  polling across turns. It launches `gog auth add` on this Mac in the
  background so the Google consent screen can open in the local browser while
  you keep chatting.
- Prefer opening the real Google consent tab in Google Chrome when available.
  If Chrome handoff is not available, fall back to the default browser instead
  of stalling on auth errors.
- After starting the helper, tell the user plainly that you opened the Google
  consent flow in the browser and that Google may require them to finish the
  sign-in, Touch ID, passkey, or 2FA step there themselves.
- Do not pretend the agent can bypass biometrics or Google account protections.
  Say explicitly that this is a secure Google step and that manual completion
  may be required even when the rest of the workflow is automated.
- Poll completion with
  `skills/gog/scripts/gog-auth-local.sh wait --session <id>` before claiming
  Google is connected.
- If the Google page opened but the local callback expired or was missed, use
  `skills/gog/scripts/gog-auth-local.sh reopen --session <id>` and tell the
  user to complete the approval immediately in that browser window.
- Translate common Google failures into direct product language instead of
  generic auth noise:
  missing OAuth client credentials, OAuth app still in Testing without this
  account added as a test user, required API not enabled, missed localhost
  callback handoff, or local Keychain approval still pending.
- Once auth completes, verify with `gog auth list` before moving into Gmail,
  Calendar, Drive, Docs, Sheets, or Contacts actions.
- Treat successful auth as a resume point. After `gog auth list` or another
  read-only probe succeeds, continue the user’s original Gmail/Calendar/Drive
  task automatically instead of asking them to restate it.

Setup (once)

- `gog auth credentials /path/to/client_secret.json`
- `gog auth add you@gmail.com --services gmail,calendar,drive,contacts,docs,sheets`
- `gog auth list`

Common commands

- Gmail search: `gog gmail search 'newer_than:7d' --max 10`
- Gmail messages search (per email, ignores threading): `gog gmail messages search "in:inbox from:ryanair.com" --max 20 --account you@example.com`
- Gmail send (plain): `gog gmail send --to a@b.com --subject "Hi" --body "Hello"`
- Gmail send (multi-line): `gog gmail send --to a@b.com --subject "Hi" --body-file ./message.txt`
- Gmail send (stdin): `gog gmail send --to a@b.com --subject "Hi" --body-file -`
- Gmail send (HTML): `gog gmail send --to a@b.com --subject "Hi" --body-html "<p>Hello</p>"`
- Gmail draft: `gog gmail drafts create --to a@b.com --subject "Hi" --body-file ./message.txt`
- Gmail send draft: `gog gmail drafts send <draftId>`
- Gmail reply: `gog gmail send --to a@b.com --subject "Re: Hi" --body "Reply" --reply-to-message-id <msgId>`
- Calendar list events: `gog calendar events <calendarId> --from <iso> --to <iso>`
- Calendar create event: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso>`
- Calendar create with color: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso> --event-color 7`
- Calendar update event: `gog calendar update <calendarId> <eventId> --summary "New Title" --event-color 4`
- Calendar show colors: `gog calendar colors`
- Drive search: `gog drive search "query" --max 10`
- Contacts: `gog contacts list --max 20`
- Sheets get: `gog sheets get <sheetId> "Tab!A1:D10" --json`
- Sheets update: `gog sheets update <sheetId> "Tab!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED`
- Sheets append: `gog sheets append <sheetId> "Tab!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS`
- Sheets clear: `gog sheets clear <sheetId> "Tab!A2:Z"`
- Sheets metadata: `gog sheets metadata <sheetId> --json`
- Docs export: `gog docs export <docId> --format txt --out /tmp/doc.txt`
- Docs cat: `gog docs cat <docId>`

Calendar Colors

- Use `gog calendar colors` to see all available event colors (IDs 1-11)
- Add colors to events with `--event-color <id>` flag
- Event color IDs (from `gog calendar colors` output):
  - 1: #a4bdfc
  - 2: #7ae7bf
  - 3: #dbadff
  - 4: #ff887c
  - 5: #fbd75b
  - 6: #ffb878
  - 7: #46d6db
  - 8: #e1e1e1
  - 9: #5484ed
  - 10: #51b749
  - 11: #dc2127

Email Formatting

- Prefer plain text. Use `--body-file` for multi-paragraph messages (or `--body-file -` for stdin).
- Same `--body-file` pattern works for drafts and replies.
- `--body` does not unescape `\n`. If you need inline newlines, use a heredoc or `$'Line 1\n\nLine 2'`.
- Use `--body-html` only when you need rich formatting.
- HTML tags: `<p>` for paragraphs, `<br>` for line breaks, `<strong>` for bold, `<em>` for italic, `<a href="url">` for links, `<ul>`/`<li>` for lists.
- Example (plain text via stdin):

  ```bash
  gog gmail send --to recipient@example.com \
    --subject "Meeting Follow-up" \
    --body-file - <<'EOF'
  Hi Name,

  Thanks for meeting today. Next steps:
  - Item one
  - Item two

  Best regards,
  Your Name
  EOF
  ```

- Example (HTML list):
  ```bash
  gog gmail send --to recipient@example.com \
    --subject "Meeting Follow-up" \
    --body-html "<p>Hi Name,</p><p>Thanks for meeting today. Here are the next steps:</p><ul><li>Item one</li><li>Item two</li></ul><p>Best regards,<br>Your Name</p>"
  ```

Notes

- Set `GOG_ACCOUNT=you@gmail.com` to avoid repeating `--account`.
- For scripting, prefer `--json` plus `--no-input`.
- Sheets values can be passed via `--values-json` (recommended) or as inline rows.
- Docs supports export/cat/copy. In-place edits require a Docs API client (not in gog).
- Confirm before sending mail or creating events.
- `gog gmail search` returns one row per thread; use `gog gmail messages search` when you need every individual email returned separately.
