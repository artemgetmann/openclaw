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
