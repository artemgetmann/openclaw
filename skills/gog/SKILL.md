---
name: gog
description: Use for Google Workspace requests tied to Gmail, Google Calendar, Drive, Docs, Sheets, or Contacts, especially when the user explicitly mentions Google or needs cross-surface Google account access. Prefer this over generic email skills when the task is clearly in the Google ecosystem.
homepage: https://gogcli.sh
metadata:
  {
    "openclaw":
      {
        "emoji": "🎮",
        "displayName": "Google Workspace",
        "dependencies": ["message-drafting"],
        "requires": { "bins": ["gog"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "openclaw/tap/gogcli",
              "bins": ["gog"],
              "label": "Install Google Workspace connector (gog)",
              "versionCommand": ["gog", "--version"],
              "versionRegex": "v?(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)",
              "recommendedVersion": "0.33.0",
            },
          ],
      },
  }
---

# Google Workspace (gog)

For recipient-facing message composition and cross-language review/send behavior, apply the canonical `message-drafting` skill.

Use `gog` for Google Workspace work: Gmail, Google Calendar, Drive, Docs,
Sheets, and Contacts.
This is the Google-account skill, not the generic mailbox skill.

Use it when the user means things like:

- "search Gmail" or "reply in my Gmail"
- "check my Google Calendar" or "create a calendar event"
- "find a file in Drive"
- "read a Google Doc" or "update a Google Sheet"
- "look up a contact from my Google account"

If the task is generic email read/reply/search without a Google-specific ask,
prefer `himalaya` instead. For Gmail fallback, only use `himalaya` after you
have proven it is the same mailbox the user meant. Never use it for Calendar,
Drive, Docs, Sheets, or Contacts.

Setup routing

- Check `gog --version` before assuming newer auth helpers exist. Treat
  v0.31.0+ as the cutoff for `auth setup`, `GOG_HELP=agent`, classified
  corrupt-token reauth recovery, and global `--readonly` / `GOG_READONLY=1`.
  If the local binary is older, use the older setup flow and say so plainly.
- If OAuth client credentials or account auth are missing, `gog auth list`
  returns no matching account, or a read probe reports `invalid_grant`, expired,
  revoked, or corrupt-token evidence, route to the shared `consumer-setup`
  skill. That skill owns Google account disambiguation, prior-service recovery,
  forced consent, browser handoff, consent-checkbox verification, callback and
  Keychain handling, post-auth surface verification, and automatic resumption of
  the original task. Do not duplicate or improvise that recovery flow here.
- In consumer lanes, run the current runtime's `gog` as a direct lane-local
  exec call. Normal permissions allow direct `gog ...` commands; do not wrap
  them in shell chains, pipes, redirection, or `nodes/system.run`, and do not
  bounce to a paired node unless local `gog` is unavailable.
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
- If setup is missing, do not dump raw CLI setup commands back to a consumer.
  Treat it as a setup-needed state and use the shared `consumer-setup` skill.
- On v0.31.0+, `gog auth setup` is the preferred guided setup entrypoint and
  `GOG_HELP=agent` surfaces the agent-oriented help text. Do not assume either
  exists on older binaries.

Email fallback policy

- For Gmail read/search/send tasks, use `gog` when the task is clearly
  Google/Gmail-specific.
- For `invalid_grant`, expired, revoked, or corrupt-token evidence, immediately
  hand recovery to `consumer-setup`; do not ask the user to diagnose or propose
  reauthentication. The shared flow decides whether the account is known,
  restores the authorized services, handles secure-user stops, verifies access,
  and resumes the task.
- Use `himalaya` only when guarded Google recovery is unavailable, blocked, or
  declined, and only after confirming its configured account is the same
  mailbox the user intended.
- For sends, never silently fall back to a different sender identity. If the
  same-mailbox identity is unclear, stop and ask the user which account to use.
- Before drafting a Gmail reply, re-read or re-search the thread/person first
  and check for newer messages. Email is usually less volatile than chat, but
  stale drafts can still answer the wrong state.
- When presenting a Gmail thread context for a reply decision, include the exact
  full text of the latest relevant inbound email from the other person when it
  is available, then add a concise summary only if useful. Do not force the user
  to rely on a summary when the sender's actual wording matters.
- Before any approved Gmail send, refresh the same thread/person again. Stop if
  newer relevant thread movement, inbound or outbound, changes or duplicates the
  reply, even when the draft and approval happen in the same short flow.

### Time-aware Gmail replies

- Preserve Gmail message timestamps as the source timestamp when triaging or
  quoting an actionable email.
- Resolve today, tomorrow, yesterday, and weekdays against the source message
  time, then compare with trusted current time. Show the absolute source date;
  if it is absent, say timing is unknown rather than inventing it.
- Use sender timezone when known, otherwise user timezone; flag material
  ambiguity instead of guessing.
- If the resolved intent has passed, offer a recovery or reschedule draft rather
  than replying as though the original timing is still current.

### Gmail read-state commands

- Gmail read/unread mutations consume message IDs:
  `gog gmail mark-read <messageId> --account <account> --json --no-input`
  and
  `gog gmail unread <messageId> --account <account> --json --no-input`.
- Multiple explicit message IDs may be passed in one command. Use IDs returned
  by message-level results such as `gog gmail messages search`; do not pass a
  thread ID returned by `gog gmail search`.
- A conversation may contain several messages with different state. Identify
  the intended message IDs before changing state, avoid broad query mutations
  for ambiguous triage items, and report unsupported or failed updates.

- If guarded Google recovery cannot start or cannot finish, report the exact
  blocker and the smallest secure browser or Keychain step the user must take.
- For Calendar, Drive, Docs, Sheets, and Contacts tasks, do not suggest
  Himalaya as a fallback. Himalaya is email-only.

Gmail triage pattern

- Default to Gmail inbox plus a clear timeframe unless the user asks for a
  broader audit.
- Shortlist before deep reads. Prefer `gog gmail search` or
  `gog gmail messages search` with a small `--max` before reading full messages
  or drafting replies.
- Use Gmail query shape to control scope: unread/recent mail, sender, topic,
  attachments, labels, or `newer_than:7d`. Tighten noisy searches before
  reading bodies.
- Filter obvious noise early: newsletters, calendar churn, receipts,
  automated alerts, delivery notifications, and FYI-only threads.
- Use `gog gmail search` for thread-level triage. Use
  `gog gmail messages search` when individual message order matters or thread
  grouping would hide who said what.
- Deep-read only shortlisted items where snippets are not enough, active
  conversations, attachment/media items, or reply candidates.
- Bucket results as `Urgent`, `Needs reply soon`, `Waiting on them`,
  `Schedule`, `Delegate`, `Archive / no action`, or `FYI`.
- State scope and confidence: account, query, max/result count, timeframe, and
  what was excluded or only sampled.
- Treat "needs reply" as an inference unless the thread context clearly shows
  the user is the next responder.
- Before sending a Gmail reply, always re-search or re-read the target
  thread/person and compare against the context used for the approved draft.

Setup Routing

- `gog` owns Google Workspace task execution and detection of setup/auth
  failures. `consumer-setup` owns the complete consumer Google connection and
  recovery procedure. Route there whenever credentials, account authorization,
  requested services, or token health are not ready.
- Use the raw CLI reference below only when the user explicitly asks for an
  unguarded terminal path. Never run it alongside an active guarded setup
  session.

Setup (terminal-only reference)

- Consumer/Jarvis setup must use the guarded flow owned by `consumer-setup`.
  The raw commands here are only for a user who explicitly requested an
  unguarded terminal workflow; never run them beside an active helper session.
- `gog auth credentials /path/to/client_secret.json`
- `gog auth add you@gmail.com --services gmail,calendar,drive,contacts,docs,sheets`
- `gog auth list`

Common commands

- Gmail search: `gog gmail search 'newer_than:7d' --max 10`
- Gmail messages search (per email, ignores threading): `gog gmail messages search "in:inbox from:ryanair.com" --max 20 --account you@example.com`
- Gmail mark explicit messages read: `gog gmail mark-read <messageId> --account you@example.com --json --no-input`
- Gmail mark explicit messages unread: `gog gmail unread <messageId> --account you@example.com --json --no-input`
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
- On v0.31.0+, use `--readonly` or `GOG_READONLY=1` for safe read-only probes.
- Sheets values can be passed via `--values-json` (recommended) or as inline rows.
- Docs supports export/cat/copy. In-place edits require a Docs API client (not in gog).
- Confirm before sending mail or creating events.
- After sending an important Gmail reply, you may offer to monitor that thread
  for a response. Ask before creating any monitor, and include the target,
  cadence, stop condition, expiry, and draft-vs-send policy.
- `gog gmail search` returns one row per thread; use `gog gmail messages search` when you need every individual email returned separately.
