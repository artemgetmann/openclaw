# Agent-First Durable Monitors E2E Validation Plan

## Goal

Prove the durable monitor redesign works in a real execution flow, not just in unit tests.

Success means:

- monitor creation allocates a durable monitor session
- repeated wakes resume the same `monitorSessionKey`
- the waking agent fetches fresh source state from the watched surface
- default routing goes back to the CLI origin session
- default policy is `notify_draft`
- checkpointing prevents endless reprocessing
- WhatsApp no longer behaves like latest-message-only stateless logic
- Gmail/email works through the same generic monitor model

## Hard Stop Rules

If any of these happen, stop immediately and report instead of improvising:

- OpenAI/model auth is broken
- the target model immediately rate-limits on the first tiny probe
- WhatsApp source access is unavailable or unusable
- Gmail/email source access is unavailable or unusable
- the execution path requires guessing about missing credentials or hidden runtime assumptions

Do not fake E2E with mocks and do not silently downgrade to a weaker validation without saying so.

## Origin Surface

Use OpenClaw CLI as the origin chat for this validation.

Why:

- it removes Telegram transport noise
- it directly proves "default route is the origin chat"
- it keeps the test focused on the monitor architecture instead of channel delivery quirks

This means:

- watched source = WhatsApp or Gmail/email
- origin route = the OpenClaw CLI session where the monitor was created
- expected result = the assistant reports back into that same CLI-origin conversation

Telegram is not required for this validation.

## Execution Order

1. preflight auth and source access
2. create an isolated tester lane
3. validate generic durable monitor creation
4. validate WhatsApp end to end
5. validate Gmail/email end to end
6. collect evidence
7. stop and summarize findings or blockers

## 1. Preflight

### Model/Auth Preflight

Run the smallest possible probe for the intended model/provider.

Verify:

- provider config exists
- the model can be resolved
- a tiny request completes without immediate auth failure
- a tiny request completes without immediate quota/rate-limit failure

If this fails, stop.

### WhatsApp Access Preflight

Verify the same WhatsApp access path the product uses is readable.

Minimum checks:

- `skills/wacli/scripts/wacli-health.sh --json --ensure-owner`
- `skills/wacli/scripts/wacli-recent-reply.sh --target <test-target> --json`

If this fails, stop.

### Gmail/Email Access Preflight

Verify the same Gmail/email access path the product uses is readable enough to inspect a test thread.

Minimum checks:

- confirm the configured Gmail/email tool path can list or inspect a known test thread
- confirm the account/thread can be reached without auth failure

If this fails, stop.

## 2. Isolated Tester Lane

Use an isolated tester runtime or CLI lane.

Requirements:

- separate config/state/workspace from the shared runtime
- no shared LaunchAgent takeover
- no testing against the shared production-ish runtime by accident
- polling-based wake behavior only

The tester lane may use CLI first and only use gateway/runtime process pieces if the validation requires actual scheduled wakes.

## 3. Generic Durable Monitor Creation

Create a real monitor from a normal CLI conversation.

Use instructions shaped like:

- "Monitor replies from this WhatsApp chat and draft the next response. Do not auto-send."
- "Monitor this email thread for replies and draft my next response. Do not auto-send."

Capture:

- `monitorId`
- `monitorSessionKey`
- cron job id
- origin route
- action policy
- initial checkpoint if present

Verify:

- `actionPolicy` defaults to `notify_draft`
- output route defaults to the CLI-origin session
- the monitor got a dedicated durable `monitorSessionKey`

## 4. WhatsApp E2E

### Required Test Surface

This requires a real reachable WhatsApp test chat.

That can be:

- a safe existing chat you control
- a dedicated test number/chat
- any other real chat where sending the test sequence is acceptable

Without real source access, this is not full E2E.

### Actual Validation Flow

1. Create the monitor from CLI targeting the WhatsApp chat.
2. Confirm the monitor record and durable `monitorSessionKey`.
3. Drive the failing negotiation shape from the external side of the chat:
   - inbound: `Wanna go to Georgian restaurant today at 7pm?`
   - assistant drafts or sends the "8pm works better" style response
   - inbound: `Hmm maybe 7:30 pm?`
   - inbound: `What bout 7:45 pm bro please`
4. Trigger repeated wakes, either by waiting for the tester schedule or forcing the job in the isolated lane.
5. After each wake, inspect:
   - same `monitorSessionKey` reused
   - source fetch happened through normal WhatsApp tools/helpers
   - CLI origin session received the monitor result
   - checkpoint advanced

### Pass Condition

Pass only if:

- each wake resumes the same durable monitor session
- the waking assistant behaves like it remembers prior context
- it does not keep replaying the same stale `8pm` negotiation line after `7:30` and `7:45`
- the same inbound item is not reprocessed forever

### Evidence To Save

- monitor record before/after wakes
- cron/wake logs showing the same `monitorSessionKey`
- CLI-origin output for each wake
- helper or source-inspection evidence showing fresh WhatsApp state
- checkpoint state transitions

## 5. Gmail/Email E2E

### Required Test Surface

This requires a real reachable Gmail/email test thread.

That can be:

- a dedicated test mailbox
- a safe existing thread you control
- any other real thread where the test reply is acceptable

Without real source access, this is not full E2E.

### Actual Validation Flow

1. Create the monitor from CLI targeting the Gmail/email thread.
2. Confirm the monitor record and durable `monitorSessionKey`.
3. Introduce a real new reply into the watched thread.
4. Trigger repeated wakes, either by waiting for the tester schedule or forcing the job in the isolated lane.
5. After each wake, inspect:
   - same `monitorSessionKey` reused
   - source fetch happened through normal Gmail/email tools
   - CLI origin session received a draft/summary
   - checkpoint advanced

### Pass Condition

Pass only if:

- the same durable monitor session is resumed
- the agent detects the new reply through the normal source path
- the result is routed back to the CLI-origin session
- default behavior is `notify_draft`, not auto-send
- later wakes do not keep re-announcing the same reply when nothing changed

### Evidence To Save

- monitor record before/after wakes
- cron/wake logs showing the same `monitorSessionKey`
- CLI-origin output
- source-inspection evidence for the watched thread
- checkpoint state transitions

## 6. Routing Validation

Explicitly verify:

- watched source and origin chat are different surfaces
- monitor output goes to the CLI-origin conversation by default
- no send back to WhatsApp/email happens unless explicitly authorized

## 7. Final Evidence Bundle

At minimum collect:

- exact commands run
- model/auth preflight result
- WhatsApp access preflight result
- Gmail/email access preflight result
- `monitorId`
- `monitorSessionKey`
- cron job id
- wake logs
- origin-session outputs
- checkpoint before/after values
- explicit pass/fail judgment for WhatsApp
- explicit pass/fail judgment for Gmail/email
- explicit blocker report if validation stopped early

## Reporting Rules

If blocked, report:

- exactly what failed
- the first concrete failing command or probe
- whether the blocker was model auth, rate limit, WhatsApp access, or Gmail/email access
- whether the remaining validation was intentionally not attempted

If successful, report:

- proof that wakes reused the same durable monitor session
- proof that default routing went to CLI origin
- proof that checkpointing prevented repeated processing
- proof that WhatsApp no longer behaved like stateless latest-message-only logic
- proof that Gmail/email used the same generic monitor path
