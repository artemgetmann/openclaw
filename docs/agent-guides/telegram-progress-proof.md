# Telegram progress proof

Use this when changing Telegram progress/status/final-answer behavior.

This guide is about product proof, not generic Telegram wiring. Use
`/agent-guides/telegram-live` first to prove isolated runtime ownership,
tester bot claim, and userbot readiness. Then use this guide to prove the
visible message sequence matches the product contract.

## Product contract

- Progress is transient. It may appear while work is happening, but it must not
  become durable final text.
- Progress should coalesce into one evolving message when the channel supports
  it. Avoid a staircase of separate status messages.
- Media artifacts are durable. Screenshots, photos, and files should still be
  delivered even when progress text is transient.
- Final answer text is durable and should appear exactly once.
- With `/tts on`, TTS is an additive final supplement. It must voice only the
  final answer once.
- When the user sends voice/audio, the current turn should get an additive
  final voice supplement without permanently enabling `/tts on`.
- No voice or audio payload may be sent before the final answer.

Do not solve this with English keyword checks such as "if the text says
progress". Classification should come from payload phase, delivery kind, source
marker, channel data, or another structural signal.

## Evidence ladder

Use the lightest evidence that proves the failing layer.

1. Contract tests
   - Prove phase/type/source handling in the local code path.
   - Prove TTS input only receives final text.
   - Prove media survives any progress cleanup.
2. Deterministic live scenario
   - Run `pnpm openclaw:local telegram smoke baseline --json`.
   - Run the smallest relevant scenario, for example:
     - `pnpm openclaw:local telegram scenario progress-long-task --json`
     - `pnpm openclaw:local telegram scenario progress-plus-tts --deterministic --json`
   - Treat this as plumbing proof only. It is not enough when the real bug is
     model-authored progress in a natural task.
3. Userbot message-ID proof
   - Use `pnpm openclaw:local telegram-user send/read/wait ... --json`.
   - Record exact message ids, media kinds, and text.
   - Classify the sequence from Telegram messages, not from assumptions.
4. GUI or screenshot proof
   - Use this only when the question is what the human visibly sees, such as
     whether a progress bubble edited, disappeared, or stayed pinned in view.
   - Userbot message history can prove message order and media kind, but it
     cannot always prove UI feel or visible edit/delete behavior.

## Live proof setup

Never use the shared main bot for feature-lane progress proof.

Run:

```bash
pnpm openclaw:local telegram runtime ensure
pnpm openclaw:local telegram smoke baseline --json
```

Before trusting any result, record:

- `branch`
- `runtime_worktree`
- `runtime_commit`
- `runtime_pid`
- `runtime_port`
- `current_lane_bot`

If the runtime was already running before a code change, rebuild and restart
the isolated runtime before retesting. If there is no restart command, use the
isolated release/ensure cycle:

```bash
pnpm openclaw:local telegram runtime release
pnpm openclaw:local telegram runtime ensure
```

If the restarted lane asks for pairing, approve only against the isolated
state/config paths printed by the bot. Do not approve against the shared main
runtime by accident.

## Progress plus TTS proof

Use this when progress and TTS interact.

```bash
pnpm openclaw:local telegram-user send \
  --chat <tester-bot> \
  --message "/tts on" \
  --json
```

Wait for the `TTS enabled` acknowledgement before sending the test prompt.

Pass criteria:

- Progress appears during work.
- Progress is edited/coalesced instead of becoming a staircase.
- Screenshots/photos/files still appear as media.
- No voice/audio appears before final text.
- Final text appears exactly once.
- Exactly one voice/audio appears after final text.
- The voice/audio input is the final answer only.
- A voice/audio prompt produces a voice/audio final supplement for that turn
  even when typed-message TTS is off.
- Progress text is not present as durable final text.

Failure examples:

- `progress text -> voice -> final text -> voice`
- `progress text -> screenshots -> progress text -> final text`
- screenshots suppressed to make the transcript cleaner
- final text replaced by audio-only output

## Natural stress prompt

Synthetic scenarios can miss model-authored progress. For a stronger natural
proof, use a prompt that exercises browser work, media delivery, file IO,
progress narration, finalization, and TTS:

```text
open example.com, then open iana.org/domains/example, then open developer.mozilla.org/en-US/docs/Web/HTML, take one screenshot after the IANA page and one after the MDN page, write the key info from all three pages into a temporary file, read it back, remove the file after you are done, keep me updated with brief progress updates along the way, then tell me in one short final answer what each page is for and confirm the temporary file was removed
```

Classify the result by message id. A successful sequence looks like:

```text
prompt -> progress/editable progress -> photo(s) -> final text -> one voice
```

There should be no voice between progress/media and final text.

## Userbot proof pattern

After sending a prompt, keep the prompt message id and wait from there:

```bash
pnpm openclaw:local telegram-user send \
  --chat <tester-bot> \
  --message "<prompt>" \
  --json

pnpm openclaw:local telegram-user wait \
  --chat <tester-bot> \
  --after-id <prompt-message-id> \
  --sender-id <bot-id> \
  --json

pnpm openclaw:local telegram-user read \
  --chat <tester-bot> \
  --limit 20 \
  --json
```

Record the final evidence in plain terms:

```text
prompt=<id>
progress=<id(s)>
media=<id(s) and media_kind(s)>
final_text=<id>
voice=<id>
pre_final_voice=<yes/no>
durable_progress_text=<yes/no>
runtime=<pid/port/worktree>
```

## GUI proof escalation

Use GUI proof when the product question is visible state, not only durable
message history. Examples:

- Did a progress bubble edit in place?
- Did the progress bubble disappear after final?
- Did the user see two separate progress bubbles before final?
- Did Telegram visually put voice before final?

If using Computer Use, follow the guard from `AGENTS.md`:

```bash
~/.codex/bin/cua-guard acquire "<task>"
```

Release it when done:

```bash
~/.codex/bin/cua-guard release
```

If Computer Use reports `ScreenCaptureKit -3811` or `Transport closed`, stop
and report that GUI proof is blocked. Do not improvise from broken GUI state.

## Cleanup

Always clean up test state:

```bash
pnpm openclaw:local telegram-user send \
  --chat <tester-bot> \
  --message "/tts off" \
  --json

pnpm openclaw:local telegram runtime release
```

Confirm the `/tts off` acknowledgement when TTS was enabled.
