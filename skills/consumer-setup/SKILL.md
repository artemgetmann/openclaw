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
- Prefer the product-native setup surface first.
- For QR-based flows, prefer a direct image attachment over browser or
  terminal workarounds.
- In consumer lanes, prefer the direct safe-bin execution surface for local
  tools. Do not build compound shell strings or use `nodes/system.run` for
  checks that already have approved lane-local binaries.
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
- For Gmail and iCloud on the stock Homebrew build, prefer app-password setup
  with provider-specific folder aliases. Do not default to OAuth2 unless the
  installed Himalaya build actually includes that feature.
- Verify with read-only commands first: `himalaya account list`,
  `himalaya folder list -a <account>`, or
  `himalaya envelope list -a <account>`.

### WhatsApp CLI

- First separate the two product surfaces:
  - The WhatsApp channel is the live bot transport for real conversations.
  - `wacli` is the local Mac tool for searching, reading, and optionally sending
    messages from the user’s paired WhatsApp data.
- Do not describe those as the same thing. If the user wants the bot to reply
  to people in live WhatsApp conversations, they need the WhatsApp channel. If
  they want local inbox/search/send utility on this Mac, `wacli` is the right
  tool.
- Be blunt when the user mixes them up: "That is the wrong setup surface."
- Missing states usually look like: `wacli` not installed, QR pairing not
  completed, or `wacli doctor` showing `AUTHENTICATED false`.
- Never say WhatsApp is paired, readable, or partially ready unless you have a
  fresh `wacli doctor` result from this turn. No guessing from prior context.
- Tell the user exactly which thing is not connected yet:
  - "The WhatsApp channel is not connected yet." for live chat transport.
  - "`wacli` is not connected yet." for the local Mac utility.
- Offer to help pair it now, usually by showing the QR login flow and waiting
  for the phone to approve it.
- If `wacli doctor` shows `AUTHENTICATED false`, stop there and route to setup.
  Do not imply existing history/search access.
- If `wacli doctor` shows `AUTHENTICATED true` but `CONNECTED false`, explain
  the nuance clearly: WhatsApp is paired, history/search may still work, but
  live sync or sending may be unreliable until the phone is online and the
  session reconnects. Tell the user what to do next in plain language:
  keep WhatsApp open on the phone, make sure the phone stays online, and leave
  the linked session active long enough for a short sync refresh to complete.
- When pairing via QR, the normal path is to deliver a real image attachment
  from the helper. Do not transcribe QR block text or force a browser screenshot
  as the first response.
- If the QR image cannot be delivered, say that explicitly and stop. Do not
  retry with text QR noise unless the user explicitly asks for the terminal
  path.
- For the terminal path in consumer lanes, prefer the lane-local
  `wacli-auth-local.sh start` helper instead of the repo script path.
- Prefer product-language guidance such as "open WhatsApp on your phone and
  finish pairing" over dumping `wacli auth` / `wacli sync --follow` into chat
  unless the user explicitly wants the CLI path.
- Do not tell a consumer user to run `/opt/homebrew/bin/wacli auth` or
  `/opt/homebrew/bin/wacli sync --follow` verbatim unless they explicitly ask
  for the terminal path.
- For consumer product flows, do not suggest `wacli sync --follow` as the
  default next step. If a refresh is actually needed after pairing, prefer the
  bounded path `wacli sync --once --idle-exit 30s`.
- Verify with the cheapest read-only checks first: `wacli doctor`, then
  `wacli chats list --limit 5`, or use
  `skills/wacli/scripts/wacli-health.sh --json`.
- In consumer chat flows, use the plain `wacli doctor` shape unless the user
  explicitly asks for JSON output. Do not invent `--json` on your own here.
- Run those checks as separate direct invocations. Never combine them into one
  shell command with `&&` or similar operators in consumer chat flows.
- If an attempted command is blocked because you used the wrong execution
  surface, say that plainly and retry with the direct safe-bin call. Do not tell
  the user the lane lacks `wacli` unless the direct invocation actually fails.

### gog

- Missing states usually look like: no OAuth client credentials, no authorized
  account, or auth/account list coming back empty.
- Tell the user Google is not connected yet.
- Ask which Google account and which surfaces they want enabled first
  (Gmail, Calendar, Drive, Docs, Sheets, Contacts).
- Prefer a browser-assisted OAuth flow when available.
- In consumer lanes, use direct lane-local `gog` invocations for checks and
  setup steps that already map to the product flow. Do not wrap `gog` inside a
  shell string, pipes, or `nodes/system.run`.
- Run the cheapest truthful checks first: `gog auth list`, then a read-only call
  for the requested surface such as `gog gmail search`, `gog drive search`, or
  `gog calendar events`.
- If `gog auth list` comes back empty, say Google is not connected yet. Do not
  pretend the CLI itself is unavailable unless the direct `gog` invocation
  failed.
- If OAuth/test-user/client setup is the blocker, say that early in plain
  product language. Do not spend several turns debugging around it before
  telling the user what is actually missing.
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
