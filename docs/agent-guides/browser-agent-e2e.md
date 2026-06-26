# Browser and agent end-to-end checks

Use this flow when the bug is in browser control, tool routing, or agent behavior.

Do not start with Telegram unless the bug is clearly Telegram-specific.

## Why this flow is the default

- It isolates the browser and agent stack from transport noise.
- It keeps the long-lived primary bot and gateway clean.
- It makes failures legible:
  - raw browser failure means browser or gateway
  - agent failure after raw browser passes means tool routing or agent path
  - Telegram failure after agent smoke passes means transport/runtime ownership

## Required runtime shape

- Use an isolated tester lane.
- Use an explicit non-default gateway port.
- Use isolated config, state, and bot credentials when a bot is involved.
- Do not repoint the long-lived primary bot or LaunchAgent at a feature worktree.

For public social-posting benchmarks, default to the isolated tester lane even
when the final product proof will eventually use the main bot. Use the main bot
only when the user explicitly wants production-thread proof, and treat that as a
final validation step after the browser/tool path is already proven. Shared
runtime restarts, other agents, and chat-history state can otherwise turn a
browser-editor bug into transport noise.

## Recommended order

1. Prove runtime ownership.
2. Prove the expected fix exists in the current branch and build.
3. Run a raw browser smoke against the isolated gateway.
4. Run an agent or TUI smoke against the same isolated gateway.
5. Use Telegram only as the final transport smoke, if needed.

## Step 1: runtime ownership

Before debugging behavior, prove you are talking to the intended runtime.

Capture proof lines such as:

- `branch=<...>`
- `runtime_worktree=<...>`
- `gateway_port=<...>`

If those do not match the intended tester lane, stop and fix runtime ownership first.

## Step 2: prove the fix exists

Do the 2-minute check before blaming the runtime:

- `git rev-parse --abbrev-ref HEAD`
- `git log --oneline -1`
- `rg` for the expected patch signature in the touched files

If the signature is missing, stop debugging and sync the code first.

## Step 3: raw browser smoke

Use the browser CLI first. Keep it small.

Examples:

- `browser status --browser-profile user-live`
- `browser --browser-profile user-live tabs`
- `browser --browser-profile user-live snapshot --json --timeout 60000`

This answers one question only:

- can the gateway control the intended browser session?

If this fails, do not waste time on agent prompts yet.

## Step 4: agent or TUI smoke

Once raw browser control works, run one agent-path task through the same isolated gateway.

Prefer a task that proves routing and read access without extra site complexity.

Example shape:

- `In my Google Chrome browser, use my existing tab and reply with exactly: TITLE: <page title>`

This answers the next question:

- can the agent choose the right browser lane and complete a simple live-browser task?

If raw browser passes but the agent fails, debug the agent/tool path, not Chrome attach.

### Signed-in Chrome MCP Batik TUI smoke

Use this stricter smoke when validating signed-in `existing-session` browser changes against
real booking behavior.

This proof must be visible to the operator:

- Run the OpenClaw TUI in the user's `claude` tmux session.
- Put the gateway logs in the same tmux window as a side-by-side vertical split.
- Use the user's preferred `claude` window when one is already assigned for the test.
- Before sending the booking prompt, send `/new`.
- Verify the TUI is using `openai-codex/gpt-5.5`.
- Set reasoning to `/think medium`.
- Send `/verbose on`.
- Capture the TUI pane and gateway pane before the booking prompt.
- Send the booking prompt as one single-line TUI message. Do not paste a multiline prompt:
  the TUI can split or stage pasted newlines, which makes passenger details look missing and
  invalidates the 1:1 proof.

Do not count the smoke as 1:1 proof if any of those gates are missing.

Use Batik's Malaysia site explicitly. The `.com` landing path can create a separate site
availability failure, so anchor the prompt to `https://www.batikair.com.my/` unless the
bug under test is domain selection.

Before sending the TUI prompt, run a raw `signed-in` browser smoke against the same gateway.
At minimum, `status` and `tabs` for `profile="signed-in"` must return without Chrome MCP
attach errors. Do not continue the TUI proof if `signed-in` is unavailable; fixing or
approving Chrome attach is part of the precondition.

Use a full booking prompt that exercises the real passenger-detail path. The prompt must be
one physical line when pasted into the TUI. Example:

```text
Use only the signed-in cloned browser profile; every browser tool call must use profile "signed-in"; if signed-in is unavailable, stop and report the error, do not use profile "openclaw" or any non-signed-in fallback; start specifically at https://www.batikair.com.my/; book me a one-way flight from Kuala Lumpur (KUL) to Bali/Denpasar (DPS) on June 10; preferred flight: Batik Air OD177, 16:30 -> 19:40, direct; book on Batik's official website if possible; pick the sensible fare with checked baggage included, ideally the Value fare with about 15kg baggage; skip unnecessary extras like insurance, meals, SMS, or paid seats unless required; use these passenger/contact details if the flow requires them: ARTEM GETMAN; Male / Mr if title is required; DOB 17/08/2001; Nationality Ukraine; Email artemnaumenko1@gmail.com; Phone +971 55 285 7036; proceed through the booking flow up to payment; stop before the final payment/charge step and ask me to confirm; do not click Pay Now, do not enter payment details, and do not take any irreversible payment action; report the exact page reached, selected flight, fare/baggage choice, total price, and every browser tool error.
```

Useful evidence to record:

- raw browser smoke command and result before TUI
- exact TUI setup commands or pane captures proving `/new`, `/verbose on`, model, and thinking level
- whether `chooseOption` failed closed instead of accepting the wrong city
- whether screenshot fallback recovered or reported `Chrome MCP screenshot output file was not created`
- whether passenger details were entered correctly
- exact stop boundary: passenger details, extras, payment page, or final charge confirmation

## Step 5: Telegram only as final transport smoke

Use Telegram after the raw browser and agent/TUI checks pass.

Telegram adds extra failure modes:

- wrong bot token or bot claim
- wrong runtime owning the gateway
- message delivery noise
- chat-history pollution

That makes Telegram a bad first debugger for browser issues.

## What to record in the PR

- exact raw browser command names
- exact agent or TUI smoke command
- exact observed result text
- exact gateway port and runtime lane used
- exact blocker if transport validation was skipped

## Fast decision table

- Raw browser fails:
  - debug browser or gateway
- Raw browser passes, agent fails:
  - debug tool routing, browser client, or agent prompts
- Agent passes, Telegram fails:
  - debug Telegram transport or runtime ownership
