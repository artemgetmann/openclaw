---
name: consumer-setup
description: Use when the right consumer-facing skill is installed but blocked on account connection, permissions, login, OAuth, or local setup, and the next turn should guide setup instead of attempting the task or dumping raw CLI steps.
homepage: https://docs.openclaw.ai/platforms/macos
metadata: { "openclaw": { "emoji": "🧰" } }
---

# Consumer Setup

Use this skill when another consumer-facing skill is the correct match for the
user's request, but that skill cannot proceed yet because the account,
permissions, OAuth session, local login, or product-side configuration is not
ready.

Trigger it for requests like:

- "read my email" when mail is not connected yet
- "check my calendar" when Google auth is missing
- "send a Telegram message as me" when Telegram-as-me still needs login
- "create a reminder" when macOS access has not been granted yet

Do not use it when the underlying skill is already connected and ready, or when
the problem is normal task execution rather than setup.

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
- For Gmail and iCloud on the stock Homebrew build, prefer app-password setup
  with provider-specific folder aliases. Do not default to OAuth2 unless the
  installed Himalaya build actually includes that feature.
- Verify with read-only commands first: `himalaya account list`,
  `himalaya folder list -a <account>`, or
  `himalaya envelope list -a <account>`.

### WhatsApp CLI

- Missing states usually look like: `wacli` not installed, QR pairing not
  completed, or
  `skills/wacli/scripts/wacli-health.sh --json --ensure-owner` reporting
  `not_authenticated`.
- Tell the user WhatsApp is not connected yet.
- Offer to help pair it now, usually by showing the QR login flow and waiting
  for the phone to approve it.
- If the normalized health check reports `paired_not_connected_readable`,
  explain the nuance clearly: WhatsApp is paired, history/search may still
  work, but live sync or sending may be unreliable until the phone is online
  and the session reconnects.
- For that state, prefer wording like:
  "WhatsApp is already paired on this Mac. I can still read recent synced
  history, but live updates may be delayed until the connection comes back."
- Prefer product-language guidance such as "open WhatsApp on your phone and
  finish pairing" over dumping `wacli auth` / `wacli sync --follow` into chat
  unless the user explicitly wants the CLI path.
- Do not tell a consumer user to run `/opt/homebrew/bin/wacli auth` or
  `/opt/homebrew/bin/wacli sync --follow` verbatim unless they explicitly ask
  for the terminal path.
- Verify with the normalized check first:
  `skills/wacli/scripts/wacli-health.sh --json --ensure-owner`.
- Use raw `wacli doctor` only for fallback debugging, not as the primary user
  status, because it can misreport `CONNECTED false` while a healthy sync owner
  holds the lock.

### Telegram User

- First separate the two Telegram product surfaces:
  - The Telegram channel is the live bot transport where users talk to an
    OpenClaw bot account.
  - `telegram-user` is the local Mac tool for reading, sending, replying, and
    waiting as the user's real Telegram account.
- Use this setup guidance only for Telegram-as-me requests such as "read my
  Telegram messages" or "send this to someone from my Telegram account." Do not
  use it for BotFather, group privacy mode, or normal bot-channel setup.
- Start with the cheapest truthful check: `openclaw telegram-user status --json`.
- If status is `missing_credentials`, say Telegram-as-me is not connected yet
  because this Mac still needs the user's Telegram API credentials. Explain that
  Telegram requires the user to create an app at `my.telegram.org/apps` and
  provide the resulting API ID and API hash before OpenClaw can act through
  their account.
- Offer two setup paths in product language: "I can open the browser and help
  you create the Telegram app now, or I can give you the steps to do it
  yourself."
- Ask for explicit approval before starting setup because this connects
  OpenClaw to the user's real Telegram identity and will allow read/send actions
  after login.
- If the user approves browser-assisted setup, open `https://my.telegram.org/apps`
  in the browser when browser control is available. The model may help navigate
  the Telegram app page and fill ordinary app fields after the user approves,
  but the user must complete Telegram sign-in, OTP, 2FA, and any sensitive
  account approval themselves. Once the app page shows API credentials, ask the
  user to confirm that OpenClaw may use the API ID/API hash for Telegram-as-me
  setup. If browser control is unavailable, say that plainly and switch to
  concise self-serve steps.
- If the user approves setup, ask for only the minimum required info in order:
  the phone number, then the API ID/API hash if missing, then the OTP Telegram
  sends during login. If Telegram 2FA is enabled, explain that the user must
  complete that secure step too.
- Do not ask the user to paste the Telegram account password into chat. If 2FA
  is required, prefer the product's secure prompt path; otherwise explain that
  password entry must happen locally and should not be logged or echoed.
- If status is `missing_session`, say Telegram-as-me has credentials but is not
  logged in yet. Offer to connect it now and start
  `openclaw telegram-user login --phone <phone> --json` only after the user
  confirms.
- If status is `awaiting_code`, ask for the Telegram OTP that was just sent to
  their Telegram app/SMS, then submit it with the existing login flow.
- If status is `awaiting_password`, explain that Telegram 2FA is still required
  before OpenClaw can use the real-account session.
- If status is `needs_reauth`, say the saved Telegram session is no longer
  accepted and offer to reconnect it.
- Once setup succeeds, verify with a read-only check before any write action:
  `openclaw telegram-user status --json`, then preferably
  `openclaw telegram-user inbox --unread --dm-only --limit 5 --json`.
- Before sending messages, require an explicit recipient and exact message text.
  Confirm the recipient when the target is ambiguous.
- Do not expose Telegram API hash, session files, OTPs, 2FA secrets, or raw
  backend logs in chat.
- If the user explicitly asks for the terminal path, it is fine to show the
  `telegram-user` CLI commands from the `telegram-user` skill. Otherwise keep
  the flow in product language and drive the setup step by step.
- After verification succeeds, continue the user's original Telegram-as-me task
  instead of stopping at "setup is done".

### gog

- Missing states usually look like: no OAuth client credentials, no authorized
  account, or auth/account list coming back empty.
- Tell the user Google is not connected yet.
- Ask which Google account and which surfaces they want enabled first
  (Gmail, Calendar, Drive, Docs, Sheets, Contacts).
- Prefer a browser-assisted OAuth flow when available.
- On runtimes where `gog` safe-bin execution is available, prefer a direct
  `gog auth add <email> --services <csv>` launch first. That path can open the
  browser itself without telling the user to use Terminal.
- Prefer opening the real auth tab in Google Chrome when the runtime can do so.
  If Chrome is unavailable, use the default browser rather than dumping raw
  terminal instructions back to the user.
- If Normal permissions block a shell wrapper or helper script, retry the
  direct command form first. Do not translate that into "go use Terminal"
  unless the user explicitly asks for the CLI path.
- If the local runtime can launch the flow itself, say that explicitly:
  "I opened the Google consent flow in the browser on this Mac. Finish the
  Google approval there."
- Say the secure step out loud: Google may require password entry, Touch ID,
  passkey approval, or 2FA in the browser, and the user may need to complete
  that manually even if the rest of the setup is automated.
- If the local runtime cannot complete the consent click itself, say what the
  user must do in the browser. Do not translate that limitation into "go run
  this in Terminal."
- Use `skills/gog/scripts/gog-auth-local.sh` only when repo-local helper
  scripts are allowed and you need resumable polling across turns.
- Verify with a read-only command such as `gog auth list`, `gog gmail search`,
  or a calendar/list call before creating drafts or events.
- After verification succeeds, continue the user’s original Google task
  automatically instead of stopping at “auth is done”.

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
