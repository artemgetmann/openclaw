---
name: wacli
description: Send WhatsApp messages to other people or search/sync WhatsApp history via the wacli CLI (not for normal user chats).
homepage: https://wacli.sh
metadata:
  {
    "openclaw":
      {
        "emoji": "📱",
        "requires": { "bins": ["wacli"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/wacli",
              "bins": ["wacli"],
              "label": "Install wacli (brew)",
            },
            {
              "id": "go",
              "kind": "go",
              "module": "github.com/steipete/wacli/cmd/wacli@latest",
              "bins": ["wacli"],
              "label": "Install wacli (go)",
            },
          ],
      },
  }
---

# wacli

Use `wacli` only when the user explicitly asks you to message someone else on WhatsApp or when they ask to sync/search WhatsApp history.
Do NOT use `wacli` for normal user chats; OpenClaw routes WhatsApp conversations automatically.
If the user is chatting with you on WhatsApp, you should not reach for this tool unless they ask you to contact a third party.
If the user is trying to connect or debug the live WhatsApp bot/channel, stop:
`wacli` is the wrong setup surface. Route that conversation to the WhatsApp
channel setup, not the CLI utility.

Automation Rule

- For consumer checks, start with the cheapest read-only probes:
  `wacli doctor`, then `wacli chats list --limit 5 --json`.
- If setup is missing or unhealthy, do not dump raw CLI noise back to the user.
  Treat it as a setup-needed state and use the shared `consumer-setup` skill.
- Treat send/sync actions as higher-risk than read/list actions. Prove read access
  first before sending to third parties.

Setup Routing

- If `wacli` is missing, not authenticated, or has no usable chat history yet,
  route setup through `consumer-setup`.
- If `wacli doctor` shows `AUTHENTICATED true` but `CONNECTED false`, do not
  present that as a total failure. Explain that WhatsApp is paired, history may
  still be readable, but live sync/send reliability may be degraded until the
  phone reconnects and sync catches up.
- Use the raw CLI steps below only when you are the one performing setup or the
  user explicitly asks for the terminal path.
- For local pairing work, prefer
  `skills/wacli/scripts/wacli-auth-local.sh start`.
  It runs `wacli auth` in an isolated temp store, captures the terminal QR,
  renders a real PNG, and returns a session id plus `qrPath`.
- When returning that QR to the user, send the image itself, not the raw block
  characters. In CLI-agent flows, include `MEDIA:<qrPath>` in the final reply so
  the QR remains scannable.
- After the user scans, confirm completion with
  `skills/wacli/scripts/wacli-auth-local.sh wait --session <id>` before claiming
  WhatsApp is ready.

Safety

- Require explicit recipient + message text.
- Confirm recipient + message before sending.
- If anything is ambiguous, ask a clarifying question.

Auth + sync

- `wacli auth` (QR login + initial sync)
- `wacli sync --follow` (continuous sync)
- `wacli doctor`

Find chats + messages

- `wacli chats list --limit 20 --query "name or number"`
- `wacli messages search "query" --limit 20 --chat <jid>`
- `wacli messages search "invoice" --after 2025-01-01 --before 2025-12-31`

History backfill

- `wacli history backfill --chat <jid> --requests 2 --count 50`

Send

- Text: `wacli send text --to "+14155551212" --message "Hello! Are you free at 3pm?"`
- Group: `wacli send text --to "1234567890-123456789@g.us" --message "Running 5 min late."`
- File: `wacli send file --to "+14155551212" --file /path/agenda.pdf --caption "Agenda"`

Notes

- Store dir: `~/.wacli` (override with `--store`).
- Use `--json` for machine-readable output when parsing.
- Backfill requires your phone online; results are best-effort.
- WhatsApp CLI is not needed for routine user chats; it’s for messaging other people.
- JIDs: direct chats look like `<number>@s.whatsapp.net`; groups look like `<id>@g.us` (use `wacli chats list` to find).
- `wacli doctor` is the health probe:
  - `AUTHENTICATED false` usually means QR pairing has not been completed yet.
  - `AUTHENTICATED true` + `CONNECTED false` usually means the account is paired
    but the phone/session is offline or not actively syncing.
- `wacli chats list --json` is the cheapest proof that history/search access is
  actually working before you attempt send or backfill actions.
