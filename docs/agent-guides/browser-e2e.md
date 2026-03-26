# Browser and agent end-to-end checks

Use this flow when the bug is in browser control, tool routing, or live Chrome behavior and Telegram is not the thing under test.

This is the default debug path because it isolates the stack that matters:

1. `browser` or browser service health
2. gateway wiring
3. agent or TUI tool selection

Telegram comes later only if the transport itself needs validation.

## Isolation rules

- Use an isolated tester lane:
  - separate gateway port
  - separate tester bot or local CLI session
  - separate profile, config, or state if the task can mutate shared runtime state
- Do not debug this on the long-lived primary bot gateway.
- If the primary bot lives on `main`, keep it there. Validate the fix in a worktree first, then merge, then restart the primary gateway from `main`.

See `docs/agent-guides/workflow.md` and `docs/agent-guides/runtime-ops.md` for the runtime ownership rules.

## Preferred validation order

### 1. Prove raw browser control first

Use the isolated gateway and run the narrowest browser checks that exercise the user path:

- `browser status --browser-profile user-live`
- `browser tabs --browser-profile user-live`
- `browser open --browser-profile user-live <url>`
- `browser snapshot --browser-profile user-live --json --timeout 60000`

Goal:

- prove `gateway -> browser service -> Chrome MCP -> live Chrome`

If this layer fails, stop. The agent is not the bug yet.

### 2. Prove the agent or TUI path next

Once raw browser control works, run one narrow agent-level smoke against the same isolated gateway:

- ask for a simple read action on the existing live tab
- require an exact short reply so the result is easy to judge

Example:

- `In my Google Chrome browser, use my existing tab and reply with exactly: TITLE: <page title>`

Goal:

- prove `agent or TUI -> gateway -> browser tool -> live Chrome`

If raw browser works but the agent smoke fails, the problem is in agent tool routing, browser availability handling, or timeout policy.

### 3. Touch Telegram only if Telegram matters

Use Telegram last, not first.

Telegram live validation is for:

- bot transport issues
- bot token or channel ownership issues
- chat-specific formatting or state issues

It is not the fastest way to debug browser or tool-path bugs.

Use `docs/agent-guides/telegram-live.md` only after the isolated browser and agent path is already proven or when the bug is clearly Telegram-specific.

## Proof to collect

Keep the evidence small and concrete:

- gateway port
- branch and worktree that own the isolated runtime
- exact `browser` command that passed
- exact agent or TUI prompt that passed
- exact reply text or browser-visible result

Good proof:

- `browser --browser-profile user-live tabs` returned two expected tabs
- agent replied `TITLE: Example Domain`

Bad proof:

- `tested locally`
- `seems fixed`
- a giant log dump with no interpretation

## Fast triage map

- Raw browser fails:
  - debug browser service, gateway health, Chrome attach, or runtime ownership
- Raw browser passes but agent fails:
  - debug agent tool routing, browser availability checks, or timeout handling
- Agent passes but Telegram fails:
  - debug Telegram transport, bot assignment, or runtime ownership for the Telegram lane

That ordering removes noise. It tells you which layer is actually broken instead of making Telegram absorb every failure.
