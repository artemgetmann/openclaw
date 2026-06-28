---
name: telegram-user
description: Use for Telegram-as-me requests on this Mac: reading, sending, replying, or waiting as the user's real Telegram account. Do not use it for the normal Telegram bot channel, BotFather setup, or generic bot onboarding.
metadata:
  {
    "openclaw":
      {
        "emoji": "✈️",
        "displayName": "Telegram as Me",
        "requires": { "bins": ["openclaw"] },
      },
  }
---

# Telegram User

Use `telegram-user` only for Telegram-as-me flows on this machine: the user's
own Telegram account, not a bot token and not BotFather setup.

Use it when the user means:

- "send from my Telegram account"
- "read my real Telegram messages"
- "download/transcribe a voice note from my real Telegram messages"
- "wait for their reply to land in my Telegram account"
- "connect or repair Telegram-as-me on this Mac"

Do not use this skill for:

- the normal Telegram bot-account channel
- BotFather token creation or bot onboarding
- generic "set up Telegram" requests when the user really means the bot channel
- Telegram Desktop UI automation

This skill is the Telegram analogue of the WhatsApp CLI surface: a narrow,
deterministic command layer on top of the existing in-repo MTProto backend. It
is not macOS UI automation and not a second Telegram runtime.

Automation Rule

- Prefer the installed OpenClaw CLI first:
  `openclaw telegram-user <subcommand> ...`
- Use the bundled wrapper only as a human/operator fallback when you are
  already inside this repo and explicitly want the lane-local entrypoint:
  `skills/telegram-user/scripts/telegram-user-cli.sh <subcommand> ...`
- Run one command per call. Do not add shell chains, pipes, or redirection
  around the wrapper unless the user explicitly asks for raw shell plumbing.
- Use structured CLI filters before shell parsing. If you need to find a known
  chat or message, prefer `inbox --contains ...`, `read --contains ...`, or
  `wait --contains ...`; do not pipe Telegram JSON to `grep` when one of those
  options fits.
- Start with the cheapest truthful check:
  `openclaw telegram-user doctor --json`
- Use raw `status --json` only when you need the underlying state object. If
  setup is not ready, `doctor --json` is the clearest interpreter because it
  names the expected env file, expected session path, missing setup piece, and
  next product step.
- For broad unread triage, start with inbox discovery before picking a chat:
  `openclaw telegram-user inbox --json`
- To focus only on unread conversations, use:
  `openclaw telegram-user inbox --unread --json`
- Narrow scope with `--dm-only` or `--limit` when the user wants a lighter inbox sweep.
- For a target-specific read/send workflow, prove the session first with
  `status --json` or `precheck --chat <chat> --json` before write actions.
- Use `read --chat <chat>` only after inbox triage or the user has already named
  the target chat.
- Before drafting a message to a specific person or chat, read the recent
  conversation context for that exact target. Telegram is live chat, so never
  draft from memory, stale user-provided snippets, or an earlier read when the
  current thread can be checked.
- When reporting the context or proposing a draft, include the exact full text
  of the latest relevant inbound Telegram message(s) from the other person,
  plus a concise context summary only if it helps. Do not replace the other
  person's wording with only an AI summary when the actual message text is
  available.
- Immediately before sending any Telegram-as-me message, re-read the target
  chat with `read --chat <chat> --limit 5 --json` (or the narrowest equivalent)
  and compare it with the context used for the draft. If a newer inbound message
  arrived, stop and update the draft or ask the user before sending. This is the
  same basic safety step a human would take before replying in Telegram.
- If `read` shows `media_kind` for a voice/audio message, download the payload
  with `telegram-user download`, then use the generic `media transcribe`
  command. Do not inspect Telethon internals or write a one-off downloader.
- Prefer direct repo-local execution on this machine. Do not invent a second
  Python backend or wrap a third-party Telegram CLI.

When To Use

- Read recent messages from a Telegram chat as the user's real account.
- Download a known Telegram message media payload by chat and message id.
- Transcribe downloaded Telegram voice/audio through the generic media command.
- Triage broad unread Telegram activity before drilling into one chat.
- Send or reply to a Telegram chat as the user's real account.
- Wait for a matching reply in a Telegram DM/thread/topic-aware flow.
- Check Telegram-as-me auth/session health.

When Not To Use

- Normal Telegram bot-account routing in OpenClaw.
- Telegram group/bot setup through BotFather.
- macOS UI clicking/typing in Telegram Desktop.
- Broad history sync/search features that the current `telegram-user` backend
  does not promise yet.

Setup Routing

- If `doctor --json` returns `missing_credentials`, route through
  `consumer-setup`.
  Explain plainly that Telegram-as-me is not connected yet because this Mac
  still needs the user's Telegram API credentials from `my.telegram.org/apps`.
- If `doctor --json` returns `missing_session`, route through `consumer-setup`.
  Explain that Telegram-as-me is not logged in yet and offer to connect it now.
- If `doctor --json` returns `awaiting_code`, ask the user for the Telegram OTP
  that was just sent to their Telegram app/SMS.
- If `doctor --json` returns `awaiting_password`, explain that Telegram 2FA is
  still required before the real-account session can be used.
- If `doctor --json` returns `needs_reauth`, say the saved Telegram session is
  no longer accepted and must be logged in again.
- Do not use repo-local `scripts/telegram-e2e/.env.local` or
  `scripts/telegram-e2e/tmp/userbot.session` as the normal consumer setup
  answer. Those files are test/operator compatibility only; consumers need the
  packaged Telegram User setup path.
- If the user explicitly wants the terminal path, use the exact commands below.
  Otherwise keep the explanation in product language first.

Login Flow

- Start login:
  `openclaw telegram-user login --phone "+15551234567" --json`
- Submit OTP:
  `openclaw telegram-user login --phone "+15551234567" --code 12345 --json`
- If Telegram 2FA is enabled, prefer the interactive prompt path or set
  `OPENCLAW_TELEGRAM_USER_LOGIN_PASSWORD` in the environment.
  Do not pass the Telegram account password on argv.
- Re-check state after each login step:
  `openclaw telegram-user status --json`

Default Commands

- Doctor / setup-state interpreter:
  `openclaw telegram-user doctor --json`
- Status:
  `openclaw telegram-user status --json`
- Inbox overview across recent chats:
  `openclaw telegram-user inbox --json`
- Inbox overview limited to unread chats:
  `openclaw telegram-user inbox --unread --json`
- Inbox overview matching a known chat label or preview text:
  `openclaw telegram-user inbox --contains "Artem" --json`
- Unread DM-only sweep with a smaller result set:
  `openclaw telegram-user inbox --unread --dm-only --limit 10 --json`
- Precheck one chat:
  `openclaw telegram-user precheck --chat @jarvis_tester_1_bot --json`
- Read recent messages from one chosen chat:
  `openclaw telegram-user read --chat @jarvis_tester_1_bot --limit 5 --json`
- Read recent messages matching known text:
  `openclaw telegram-user read --chat @jarvis_tester_1_bot --contains "proof" --limit 5 --json`
- Download media from a known message:
  `openclaw telegram-user download --chat @jarvis_tester_1_bot --message-id 52830 --output /tmp/openclaw-media --json`
- Transcribe the downloaded audio file:
  `openclaw media transcribe --file /tmp/openclaw-media/telegram-jarvis_tester_1_bot-52830.oga --json`
- Send a message:
  `openclaw telegram-user send --chat @jarvis_tester_1_bot --message "hello" --json`
- Reply to a specific message:
  `openclaw telegram-user send --chat @jarvis_tester_1_bot --reply-to 12345 --message "on it" --json`
- Create a forum topic:
  `openclaw telegram-user topic-create --chat -1003783709877 --title "strategy follow-up" --json`
- Send into a forum topic:
  `openclaw telegram-user send --chat -1003783709877 --topic-anchor 12345 --message "seed prompt" --json`
- Wait for a reply:
  `openclaw telegram-user wait --chat @jarvis_tester_1_bot --after-id 12345 --sender-id 67890 --json`
- Logout / clear local session:
  `openclaw telegram-user logout --json`

Behavior Notes

- This surface reads and writes as the user's real Telegram account.
- `telegram-user login` persists pending login state so the caller does not
  manage `phone_code_hash` by hand.
- Use `inbox` for discovery and unread triage across chats.
- Use `read --chat` only once the target chat is known.
- `read` exposes `media_kind` for media-bearing messages; use `download` for
  the payload and keep transcription generic through `openclaw media transcribe`.
- `wait` is thread-aware through the existing backend semantics around
  `reply_to_msg_id`, `reply_to_top_id`, and DM topic metadata.
- `topic-create` returns `topic_anchor`. Use that value as `--topic-anchor`
  (or `--reply-to`) when sending into the newly created Telegram forum topic.
- Do not promise broad media/history search features beyond the explicit
  read/download/transcribe path the CLI supports.

Safety

- Require an explicit chat target and explicit message text before sending.
- Confirm the intended recipient when the target is ambiguous.
- Do not expose Telegram API hash, session files, OTPs, or 2FA secrets in logs
  or chat transcripts.
- After sending, if follow-up handling would clearly help, offer a scoped wait
  or monitor for that same chat. Do not create a new monitor or imply fully
  autonomous conversation driving unless the user explicitly approves the scope,
  cadence or wait condition, stop condition, and whether replies should only be
  drafted or can be sent.
