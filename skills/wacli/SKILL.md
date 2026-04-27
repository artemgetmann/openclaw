---
name: wacli
description: Send WhatsApp messages to other people or search/sync WhatsApp history via the wacli CLI (not for normal user chats).
metadata:
  {
    "openclaw":
      {
        "emoji": "📱",
        "requires":
          {
            "bins":
              [
                "wacli",
                "./scripts/wacli-live.sh",
                "./scripts/wacli-health.sh",
                "./scripts/wacli-auth-local.sh",
                "./scripts/wacli-send-safe.sh",
                "./scripts/wacli-recent-reply.sh",
                "./scripts/wacli-monitor-check.sh",
              ],
          },
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

- For WhatsApp reply detection, scoped monitors, or "did this person reply yet?" checks, use:
  `skills/wacli/scripts/wacli-monitor-check.sh --target <phone-or-jid> --json`
  This is the default path for monitor jobs because it wraps reconciliation and
  durable baseline state in one command.
- For one-off/manual "did they reply?" checks where monitor state is not needed, use:
  `skills/wacli/scripts/wacli-recent-reply.sh --target <phone-or-jid> --json`
- When authoring a cron monitor, pin the exact `wacli-monitor-check.sh` command
  into the job payload.
  Do not leave the waking run to rediscover the monitor procedure from scratch.
- Do NOT use `wacli chats list --query <phone>` as the primary discovery path for reply checks or monitors.
  It can miss the real sibling `@lid` thread even when replies landed there.
- Do NOT use raw `wacli sync` + `wacli messages list` as the primary monitor implementation when `wacli-recent-reply.sh` covers the same check.
  Raw sync/list is debug or fallback material, not the default authored monitor path.
- For consumer checks, start with the cheapest read-only probes:
  `skills/wacli/scripts/wacli-health.sh --json --ensure-owner`.
- Treat raw `wacli doctor` as fallback/debug-only.
  Under a live OpenClaw-owned lock it can report `CONNECTED false` even when
  `wacli sync --follow` is healthy, so do not use it as the primary readiness
  source for agents.
- When live connectivity matters, prefer
  `skills/wacli/scripts/wacli-live.sh ensure --json`
  to make sure one long-lived `wacli sync --follow` owner exists for the store.
- Prefer direct safe-bin invocation first. Run one command per call.
- In Normal permissions mode, direct `wacli ...` commands are allowed. What
  stays restricted by default is shell wrapping, pipes, chaining, and redirection.
- If you wrap `wacli` through `openclaw nodes run`, insert `--` before the
  child argv so flags like `--json` or `--limit` reach `wacli` instead of the
  wrapper.
- Ban dumb shell chaining, pipes, and redirection around `wacli`.
- Do NOT use bare `wacli sync --json` as a health or status probe.
  `wacli sync` defaults to `--follow=true`, so it is a long-running command and a bad fit for quick readiness checks.
- Allow node execution only when the runtime actually supports it; do not claim
  node exec is invalid just because `system.run.prepare` is absent.
- Do not claim WhatsApp is paired, readable, or ready unless those probes ran in
  the current turn and the results support that claim.
- If you did not run `wacli doctor`, do not infer status from prior chat context,
  old screenshots, or generic expectations. Present it as unverified and offer
  to check now.
- If setup is missing or unhealthy, do not dump raw CLI noise back to the user.
  Treat it as a setup-needed state and use the shared `consumer-setup` skill.
- Treat send/sync actions as higher-risk than read/list actions. Prove read access
  first before sending to third parties.
- For send actions, use `skills/wacli/scripts/wacli-send-safe.sh` as the default path whenever the main `~/.wacli` store might already have a live sync owner.
  This is especially important for monitor-driven replies, Telegram-approved follow-up sends, and any wake flow that decides to answer on WhatsApp after first reading from the shared store.
- Do NOT kill the live sync owner manually, do NOT restart it by hand, and do NOT improvise raw `wacli send ...` if `skills/wacli/scripts/wacli-send-safe.sh` covers the same send.
  Manual stop/send/restart loops are a fallback-of-last-resort debug path, not the authored agent workflow.

Setup Routing

- If `wacli` is missing, not authenticated, or has no usable chat history yet,
  route setup through `consumer-setup`.
- If a policy denial came from your own command shape, describe that truthfully.
  Say the attempted command format was blocked and retry with a direct safe-bin
  call. Do not tell the user that `wacli` itself is unavailable unless a direct
  `wacli` invocation actually failed.
- If `wacli doctor` shows `AUTHENTICATED false`, explicitly say `wacli` is not
  connected yet. Do not soften that into "paired" or "history is readable".
- If raw `wacli doctor` shows `AUTHENTICATED true` but `CONNECTED false`, first
  check `skills/wacli/scripts/wacli-health.sh --json --ensure-owner` before you
  tell the user anything. Under lock, the wrapper is the source of truth and raw `doctor` can be wrong.
- If the normalized health check still reports the session as paired but not
  connected, do not present that as a total failure. Explain that WhatsApp is
  paired, history may still be readable, but live sync/send reliability may be
  degraded until the phone reconnects and sync catches up. Tell the user
  exactly what to do next: keep WhatsApp open on the phone, make sure the phone
  stays online, and leave the linked session active long enough for a bounded
  sync refresh to finish.
- If the user is debugging the live OpenClaw WhatsApp bot/channel, `wacli` is
  the wrong surface. The built-in WhatsApp channel is separate from the external `wacli` CLI.
- Use the raw CLI steps below only when you are the one performing setup or the
  user explicitly asks for the terminal path.
- For local pairing work, prefer
  `wacli-auth-local.sh start`.
  In consumer lanes this resolves to the lane-local cleanroom wrapper, which
  runs `wacli auth` in an isolated temp store, captures the login QR,
  renders a real PNG, and returns a session id plus `qrPath`.
- Run pairing helpers directly too. Do not wrap `wacli-auth-local.sh` inside a
  shell string or node/system-run command.
- Deliver the QR as a real image attachment first. Do not paste the raw QR
  blocks into chat and do not use a browser-tab screenshot as the normal path.
- In CLI-agent flows, include `MEDIA:<qrPath>` only as the transport hint the
  platform needs for the attachment. Keep the surrounding text short and clean.
- If the image cannot be delivered, say so explicitly and stop. Do not retry
  with text QR noise unless the user explicitly asks for the terminal path.
- After the user scans, confirm completion with
  `wacli-auth-local.sh wait --session <id>` before claiming
  WhatsApp is ready.
- In consumer lanes, if the account is paired but the latest messages are still
  stale, use a bounded refresh only: `wacli sync --once --idle-exit 30s`.
  Do not use `wacli sync --follow` as the default product path.

Safety

- Require explicit recipient + message text.
- Confirm recipient + message before sending.
- If anything is ambiguous, ask a clarifying question.

Auth + sync

- `wacli auth` (QR login + initial sync)
- `wacli sync --once --idle-exit 30s` (bounded refresh for consumer lanes)
- `wacli sync --follow` (continuous sync when you intentionally need a live owner)
- Raw debug only: `wacli doctor`

Find chats + messages

- `wacli chats list --limit 20 --query "name or number"`
- `wacli messages search "query" --limit 20 --chat <jid>`
- `wacli messages search "invoice" --after 2025-01-01 --before 2025-12-31`
- Recent-reply reconciliation:
  `skills/wacli/scripts/wacli-recent-reply.sh --target <phone-or-jid> --json`
  This inspects the local `wacli.db`, resolves real sibling chats from stored
  names/contacts/aliases, and returns the newest inbound `from_me=0` across all
  candidate chats, plus `recentConversation` and `continuity` fields for the
  active chat.
- Monitor job helper (stateful baseline + reconciliation in one command):
  `skills/wacli/scripts/wacli-monitor-check.sh --target <phone-or-jid> --json`
  This stores baseline state under `~/.openclaw/wacli-monitor-state/` by default
  so cron jobs can use the same command on every wake.
  For negotiation/follow-up monitors, do not compose a reply from only
  `latestInboundReply.effectiveText`; use `recentConversation` so the wake run
  sees prior outbound turns, and suppress sends when
  `continuity.lastOutboundIsRepeatOfPrevious` is true unless the user explicitly
  wants to resend the same line.

History backfill

- `wacli history backfill --chat <jid> --requests 2 --count 50`

Send

- Text: `skills/wacli/scripts/wacli-send-safe.sh text --to "+14155551212" --message "Hello! Are you free at 3pm?"`
- Group: `skills/wacli/scripts/wacli-send-safe.sh text --to "1234567890-123456789@g.us" --message "Running 5 min late."`
- File: `skills/wacli/scripts/wacli-send-safe.sh file --to "+14155551212" --file /path/agenda.pdf --caption "Agenda"`
- Low-level fallback: `wacli send text --to "+14155551212" --message "Hello! Are you free at 3pm?"`

Monitor-driven reply send pattern

- When a scoped WhatsApp monitor decides that a reply should actually be sent, keep the detection and send paths separate:
  - detection: `skills/wacli/scripts/wacli-recent-reply.sh ... --json`
  - send: `skills/wacli/scripts/wacli-send-safe.sh text --to <phone-or-jid> --message "<approved reply>"`
- Do not turn the wake run into a store-lock debugging exercise.
  The correct authored behavior is: inspect helper output, decide, then call the safe send helper once with pinned args.

Notes

- Store dir: `~/.wacli` (override with `--store`).
- Use `--json` for machine-readable output when parsing.
- Backfill requires your phone online; results are best-effort.
- WhatsApp CLI is not needed for routine user chats; it’s for messaging other people.
- JIDs: direct chats look like `<number>@s.whatsapp.net`; groups look like `<id>@g.us` (use `wacli chats list` to find).
- Do not fabricate `<digits>@lid`.
  Linked-ID chats can use opaque `@lid` values that do not share the phone
  digits. If you need to check whether a DM got a reply, resolve candidate chats
  from actual stored data first, then inspect all of them.
- Media replies count as replies.
  A valid inbound row may have `media_type=image` (or another media type) with a
  caption/body, or a media row with empty text where `display_text` is the only
  visible clue.
- `skills/wacli/scripts/wacli-health.sh --json --ensure-owner` is the primary
  health probe for agents:
  - `not_authenticated` usually means QR pairing has not been completed yet.
  - `paired_not_connected_readable` means the account is paired and history is
    readable, but no live owner is confirmed yet.
  - `healthy` means OpenClaw has a live owner and chat history is readable.
- Raw `wacli doctor` is fallback/debug-only:
  - `AUTHENTICATED false` usually means QR pairing has not been completed yet.
  - `AUTHENTICATED true` + `CONNECTED false` may mean the account is paired but
    offline, or just that another healthy sync owner already holds the store
    lock.
- For consumer product flows, `CONNECTED false` should trigger clear guidance:
  keep WhatsApp open on the phone, keep the phone online, and wait for the
  linked session to catch up. Use a bounded sync refresh if the current turn
  actually needs fresher data.
- `wacli chats list --json` is the cheapest proof that history/search access is
  actually working before you attempt send or backfill actions.
- `skills/wacli/scripts/wacli-live.sh ensure --json` is the preferred minimal
  live-connection recovery path for agents when WhatsApp is paired but not
  staying connected.
- `skills/wacli/scripts/wacli-health.sh --json --ensure-owner` is the preferred
  normalized readiness check for agents. It intentionally avoids bare `wacli sync`.
