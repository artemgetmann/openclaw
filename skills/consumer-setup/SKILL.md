---
name: consumer-setup
description: Use when the user asks to use a consumer integration that is not set up yet: WhatsApp as Me, Email, Google Workspace, Apple Notes, Apple Reminders, Telegram as Me, Google Maps Search, or creative audio. Route here only when the right integration exists but is blocked by missing login, OAuth, QR pairing, permissions, local dependency setup, configuration, or API credentials, and the response should guide setup in product language instead of dumping CLI commands.
metadata: { "openclaw": { "emoji": "🧰" } }
---

# Consumer Setup

Use this skill when another consumer-facing skill is the correct match for the
user's request, but that skill cannot proceed yet because the account,
permissions, OAuth session, QR pairing, local dependency, API credential, or
product-side configuration is not ready.

Trigger it for requests like:

- "read my email" when mail is not connected yet
- "check my calendar" when Google auth is missing
- "send a Telegram message as me" when Telegram-as-me still needs login
- "send a WhatsApp message" when WhatsApp-as-me QR pairing or live sync is not ready
- "create a reminder" when macOS access has not been granted yet

Do not use it when the underlying skill is already connected and ready, or when
the problem is normal task execution rather than setup.

## Core Behavior

- Explain the missing setup in plain product language, not raw CLI noise.
- Use consumer-facing capability names first, such as Google Workspace, Email,
  WhatsApp as Me, Telegram as Me, Google Maps Search, and Mac Screen Control. Mention raw
  tool ids like `gog`, `himalaya`, `wacli`, or `peekaboo` only when the user is
  debugging setup, reviewing a PR, or explicitly asks for the technical path.
- Offer to help complete setup now.
- Ask only for the information, approval, or login step the user must provide.
- Prefer GUI, browser-assisted, or QR-based setup when that will be clearer than
  sending the user to a terminal.
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

### WhatsApp as Me

- Missing states usually look like: `wacli` not installed, QR pairing not
  completed, or
  `skills/wacli/scripts/wacli-health.sh --json --ensure-owner` reporting
  `not_authenticated`.
- Tell the user WhatsApp as Me is not connected yet.
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
- Start with the setup-state interpreter:
  `openclaw telegram-user doctor --json`.
  It reads Telegram User status and explains whether credentials, login/session,
  reauth, or readiness is the blocker without repairing anything.
- If doctor state is `missing_credentials`, say Telegram-as-me is not connected yet
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
  but the user must complete Telegram sign-in and any sensitive account approval
  themselves. Once the app page shows API credentials, ask the
  user to confirm that OpenClaw may use the API ID/API hash for Telegram-as-me
  setup. If browser control is unavailable, say that plainly and switch to
  concise self-serve steps.
- If the user approves setup, ask for the phone number, then the API ID/API hash
  if missing. When Telegram sends the fresh OTP, say: "Send me a screenshot of
  the OTP. Do not paste the code into chat and do not forward Telegram's code
  message." Read the OTP from that screenshot and submit it once through the
  pending Telegram-as-me login session without echoing it back.
- A Telegram account 2FA password is long-lived, unlike the OTP. Never request
  or accept that password in chat or media. If it is required, open Jarvis
  Settings → Telegram → Telegram as you for secure local entry.
- If doctor state is `missing_session`, say Telegram-as-me has credentials but is not
  logged in yet. Offer to connect it now and start
  `openclaw telegram-user login --phone <phone> --json` only after the user
  confirms.
- If doctor state is `awaiting_code`, request one fresh OTP screenshot and use
  only the digits shown in that image. If it is `awaiting_password`, direct the
  user to the secure local Mac field and do not receive the 2FA password.
- If the local flow reports invalid, expired, or cooldown, state that exact
  outcome once. Do not retry automatically or request another secret in chat.
- If doctor state is `needs_reauth`, say the saved Telegram session is no longer
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

### Google Workspace (`gog`)

- Missing states usually look like: no OAuth client credentials, no authorized
  account, auth/account list coming back empty, or `invalid_grant` showing that
  the saved refresh token expired or was revoked.
- Tell the user Google Workspace needs to reconnect; do not frame a recoverable
  expired token as a terminal blocker.
- For a new or ambiguous setup, ask which Google account and surfaces they want
  enabled first (Gmail, Calendar, Drive, Docs, Sheets, Contacts). Reuse the
  known account and requested surface during expired-token recovery.
- Treat an account as known only when the failing command/error or original task
  identifies it, or one configured Gog account clearly matches. If multiple
  accounts could fit, stop and ask instead of choosing from the browser UI.
- Prefer a browser-assisted OAuth flow when available.
- Check `gog --version` before assuming newer auth helpers exist. Treat
  v0.31.0+ as the cutoff for `gog auth setup`, `GOG_HELP=agent`, classified
  corrupt-token recovery, and global `--readonly` / `GOG_READONLY=1`.
- Route consumer Google auth through
  `skills/gog/scripts/gog-auth-local.sh start --email <email> --services <csv>`.
  On macOS, its single-flight lock prevents multiple setup sessions from
  producing overlapping Google or Keychain prompts. Other platforms use a
  direct background worker, so do not claim cross-session serialization there.
- During expired-token recovery, populate `<csv>` from that account's saved
  `gog auth list --json` services when available, plus only the surfaces required
  by the current task. If the saved service set is unavailable, reuse the
  explicitly established setup/task scope and ask before broadening it.
- Prefer opening the real auth tab in Google Chrome when the runtime can do so.
  If Chrome is unavailable, use the default browser rather than dumping raw
  terminal instructions back to the user.
- If the default browser opens Safari but Jarvis cannot control it, keep the
  same guarded auth session alive and open its stored OAuth URL in Jarvis's
  controllable signed-in Chrome profile. The callback belongs to the local
  helper, not to Safari, so moving the tab itself is unnecessary.
- On the Google permissions checklist, select every checkbox for the resolved
  services and verify all expected boxes are checked before Continue. Stop on
  an unexpected account or broader scope request; `Select all` is not permission
  to grant unrelated access.
- If Normal permissions block the guarded helper, report setup as blocked. Do
  not bypass the guard with direct `gog auth setup`, `gog auth add`, or
  `gog auth list` calls while setup is active.
- If the local runtime can launch the flow itself, say that explicitly:
  "I opened the Google consent flow in the local browser. Finish the
  Google approval there."
- Say the secure step out loud: Google may require password entry, Touch ID,
  passkey approval, or 2FA in the browser, and the user may need to complete
  that manually even if the rest of the setup is automated.
- If the flow reaches email-only fallback, use `himalaya` only after proving it
  is the same mailbox the user meant. Never offer `himalaya` for Calendar,
  Drive, Docs, Sheets, or Contacts.
- If the local runtime cannot complete the consent click itself, say what the
  user must do in the browser. Do not translate that limitation into "go run
  this in Terminal."
- Poll the guarded session with `skills/gog/scripts/gog-auth-local.sh wait`.
  Its successful exit already verifies the account with a short bounded
  `gog auth list`; do not launch a parallel direct verification probe.
- If Keychain approval times out, ask the user to unlock the Mac, retry once,
  complete the single macOS Keychain prompt with their Mac login password, and
  choose Always Allow. Never capture, store, type, or bypass that password.
- After the guarded session succeeds, a read-only Gmail search or calendar/list
  call can verify the requested surface before creating drafts or events.
- Confirm the resolved services in `gog auth list --json`. When the recovery is
  supposed to restore both Gmail and Calendar, prove both with separate harmless
  reads; do not call the connection complete after Gmail alone succeeds.
- After verification succeeds, continue the user’s original Google task
  automatically instead of stopping at “auth is done”.
- When a known account returns `invalid_grant`, start this guarded recovery with
  forced consent as part of the original Google task. Do not require the user to
  propose re-authentication first; pause only for a secure Google challenge or
  an explicit scope/account ambiguity.
- A roughly seven-day recurrence plus Google's unverified tester warning usually
  means the OAuth app is External + Testing. Explain that the durable owner fix
  is publishing the OAuth app to Production; an administered Workspace domain
  can instead use an approved internal/trusted deployment. Never promise that a
  refresh token is immortal: Google can still revoke it for password changes,
  user/admin revocation, long inactivity, token limits, or security policy.

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
