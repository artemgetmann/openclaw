---
name: consumer-setup
description: Help consumer users connect bundled skills without dumping raw CLI setup instructions into the chat.
homepage: https://docs.openclaw.ai/platforms/macos
metadata: { "openclaw": { "emoji": "🧰" } }
---

# Consumer Setup

Use this shared setup surface when a consumer-facing skill is installed but not
ready because it still needs account connection, permissions, configuration, or
API credentials.

## Core Behavior

- Explain the missing setup in plain product language, not raw CLI noise.
- Offer to help complete setup now.
- Ask only for the information, approval, or login step the user must provide.
- Prefer GUI or browser-assisted setup when that will be clearer than sending
  the user to a terminal.
- Do not expose secrets in chat, logs, or pasted commands.
- Distinguish missing user setup from missing product/runtime setup.
- Once setup finishes, verify the skill with the cheapest read-only check before
  moving into write or send actions.

## Shared Response Pattern

When setup is missing, use this shape:

- "<integration> is not connected yet."
- "I can help set it up now."
- "I only need <the missing info or approval>."
- "Once connected, I can <the useful outcome>."

Do not tell a consumer user to go run terminal commands on their own unless they
explicitly ask for the CLI path.

## Skill-Specific Guidance

### Himalaya

- Missing states usually look like: no config file, no configured account, or
  auth failures before mailbox access.
- Tell the user email is not connected yet.
- Ask for the mail provider and permission to walk through login/config.
- Prefer provider login or app-password guidance over dumping a manual TOML
  template into chat.
- Verify with read-only commands first: `himalaya account list`,
  `himalaya folder list`, or `himalaya envelope list`.

### WhatsApp CLI

- Missing states usually look like: `wacli` not installed, QR pairing not
  completed, or `wacli doctor` showing `AUTHENTICATED false`.
- Tell the user WhatsApp is not connected yet.
- Offer to help pair it now, usually by showing the QR login flow and waiting
  for the phone to approve it.
- If `wacli doctor` shows `AUTHENTICATED true` but `CONNECTED false`, explain
  the nuance clearly: WhatsApp is paired, history/search may still work, but
  live sync or sending may be unreliable until the phone is online and the
  session reconnects.
- Prefer product-language guidance such as "open WhatsApp on your phone and
  finish pairing" over dumping `wacli auth` / `wacli sync --follow` into chat
  unless the user explicitly wants the CLI path.
- Verify with the cheapest read-only checks first: `wacli doctor`, then
  `wacli chats list --limit 5 --json`.

### gog

- Missing states usually look like: no OAuth client credentials, no authorized
  account, or auth/account list coming back empty.
- Tell the user Google is not connected yet.
- Ask which Google account and which surfaces they want enabled first
  (Gmail, Calendar, Drive, Docs, Sheets, Contacts).
- Prefer a browser-assisted OAuth flow when available.
- Verify with a read-only command such as `gog auth list`, `gog gmail search`,
  or a calendar/list call before creating drafts or events.

### Apple Notes

- Missing states usually look like: `memo` not installed or macOS Automation
  permission not granted for Notes.
- Tell the user Apple Notes is not ready on this Mac yet.
- Offer to help install the dependency and grant permission.
- Once ready, keep deterministic create/delete on
  `skills/apple-notes/scripts/apple-notes-local.sh`; do not fall back to
  interactive `memo` flows for consumer automation unless the user explicitly
  wants that path.

### Apple Reminders

- Missing states usually look like: `remindctl` not installed or Reminders
  access not authorized yet.
- Tell the user Reminders is not connected yet.
- Offer to help grant access on this Mac.
- If Reminders access is not authorized, tell the user exactly what to do next:
  approve the macOS permission prompt, or open System Settings > Privacy &
  Security > Reminders and allow the terminal/app that OpenClaw is using.
- After the user approves the prompt, re-check with `remindctl status` and/or a
  read-only list call such as `remindctl today --json` before creating or
  deleting reminders.

### goplaces

- Missing states usually look like: `GOOGLE_PLACES_API_KEY` unavailable or the
  CLI missing entirely.
- For the consumer product, first decide whether this is a missing product
  secret or user setup. Do not blame the user for a missing product-provided
  key.
- Tell the user place search is not ready yet, then explain whether the missing
  step is on their side or the product/runtime side.
- Verify with a simple read-only search using `--json` once the key is present.

## CLI Escape Hatch

If the user explicitly asks for the terminal path, it is fine to use the raw
CLI setup steps or vendor docs from the underlying skill/reference files. Keep
that path opt-in, not the default consumer experience.
