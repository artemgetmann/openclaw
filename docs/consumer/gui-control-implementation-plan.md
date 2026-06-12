# Jarvis GUI Control Implementation Plan

Last updated: 2026-06-12
Status: implementation spike, not exposed to consumers

## Goal

Build Jarvis GUI control that feels closer to Codex Computer Use than Peekaboo:
fast, visible, workspace-preserving, fail-closed, and safe enough for consumer
workflows.

The first implementation target is `agent-desktop` behind a Jarvis verifier
layer. Peekaboo stays as fallback, capture, and salvage. Codex Computer Use is
the quality reference, not the reusable backend. If the wrapper becomes duct
tape, switch to native Swift/OpenClaw Computer Use.

## Current State

- Worktree: `/Users/user/Programming_Projects/openclaw/.worktrees/gui-control-bakeoff-20260610`
- Branch: `codex/gui-control-bakeoff-20260610`
- Decision artifact: `docs/consumer/gui-control-mvp-decision.md`
- Current target: make `agent-desktop` approach Codex Computer Use behavior.
- Non-target: expose GUI control in consumer onboarding.

Known benchmark truth:

- `agent-desktop` completed TextEdit and real Safari/X to Claude flows, but had
  false failures, stale refs, and Stage Manager/foreground ambiguity.
- Peekaboo completed the real flow but was too slow and command-heavy: deep AX
  knobs, stale snapshots, duplicate paste recovery, false success/failure, and
  high command count.
- Codex Computer Use completed the real flow in 95 seconds with about 10 CUA
  calls, no clipboard use, one stale-state retry, and visible final proof.
- User screenshots corrected the earlier Stage Manager uncertainty: Codex
  Computer Use opened Safari and Claude behind or alongside the active
  workspace, made intent visible with a virtual pointer, and preserved the
  working feel better than the logs alone suggested.

## Implementation Scope

Add a dev-only GUI benchmark lane:

- benchmark harness and scorecard
- minimal `GuiRuntime` interface
- `agent-desktop` adapter behind a dev-only flag
- verifier and audit layer
- fail-closed safety policy
- CLI-first Codex testing before Jarvis product UX
- optional Codex loopback MCP exposure that reuses the same verifier path
- unit tests for verifier behavior

Do not expose this in consumer onboarding, production defaults, or packaged
Jarvis flows.

## Codex-First Test Path

Before Jarvis uses GUI control directly, test the runtime through Codex. Codex
is the cleaner debugging harness because it removes Jarvis product routing,
Telegram state, and packaged-app variables from the first live GUI iteration.

The primary Codex-facing surface is plain CLI, because it is easier to debug,
replay, paste into a terminal, and hand to another agent without hidden host
state:

```bash
pnpm jarvis gui-control observe --app Safari --window-title X --json
pnpm jarvis gui-control resolve-element --app Claude --intent text-input --label-includes message --json
pnpm jarvis gui-control set-value --app Claude --intent text-input --label-includes message --value "..." --approve-policy-risk --json
pnpm jarvis gui-control click --app Claude --intent button --label-includes send --approve-policy-risk --verify-text "..." --json
pnpm jarvis gui-control press --app Claude --keys cmd+return --approve-policy-risk --verify-text "..." --json
pnpm jarvis gui-control scroll --app Safari --window-title X --intent any --label-includes "Home feed" --direction down --amount 3 --approve-policy-risk --json
```

Codex can use the CLI to:

- observe a macOS app/window
- resolve a real UI element from a fresh snapshot
- set a value only after the verifier accepts the target and post-state proof
- click only when task-specific `--verify-text` is provided, or when the caller
  explicitly accepts changed-state verification with `--allow-observed-click`
- press an app-scoped key combo such as `cmd+return` only after approval and
  post-state proof
- scroll a real element ref with target re-observation and proof

The optional loopback MCP tool named `gui_control` stays available only on the
loopback Codex/MCP tool surface and remains hidden from normal HTTP/Jarvis tool
resolution. It reuses the same CLI/controller verifier path and is not the
primary debugging harness.

The tool must still fail closed on ambiguous elements, wrong app/window, stale
refs, sensitive surfaces, or unapproved mutation risk. Codex should author its
own visible progress during the run; Jarvis-specific progress copy can be tuned
after the Codex test proves the runtime feel.

## Runtime Shape

Keep the abstraction small and runtime-agnostic so native Swift can replace the
first adapter later:

- `listApps()`
- `observe(target)`
- `setValue(target, value)`
- `click(target)`
- optional `press(target, keys)`
- optional `scroll(target, options)`

The initial adapter shells out to `agent-desktop` CLI JSON output. Peekaboo is
fallback-only and must not become the default planner.

## Verifier Loop

Every mutating GUI action must follow this shape:

1. Observe the target app, window, and element.
2. Record intended action, model-authored reason, pre-state, and risk class.
3. Execute the runtime action.
4. Re-observe the target.
5. Verify post-state instead of trusting executor success.

Rules:

- executor success or failure is advisory only
- stale refs trigger one re-observe and retry
- repeated stale state fails closed
- wrong app/window fails closed
- missing element fails closed
- login, auth, CAPTCHA, payment, settings, destructive, or uncertain mutation
  surfaces fail closed
- X post, like, reply, repost, follow, bookmark, unbookmark, DM, profile,
  account, and settings actions are hard-blocked by default
- read-only observation is allowed
- explicitly approved one-off sends are allowed only for the approved target

The "about to act on app/window/element" requirement is an audit record, not a
per-click approval prompt. Ask the user only for policy-risk actions such as
posting, deleting, account changes, login, sensitive data, or irreversible
mutations.

## Progress Style

Progress must be short, visible, and model-authored:

- Opening Safari
- Reading X
- Writing Claude
- Verifying the reply

Do not expose low-level element ids, raw snapshot ids, or implementation noise
in user-facing progress.

## Benchmark Harness

Target command:

```bash
pnpm jarvis gui-benchmark --runtime agent-desktop --task x-to-claude
```

Required task behavior:

- inspect existing Safari/X Home read-only
- select one exact Safari `Home / X` window by runtime window id when available,
  and fail closed if no matching or multiple matching X windows exist
- optionally open `https://x.com/home` in Safari with `--open-x-home`, but only
  when the live test explicitly approves browser navigation
- summarize visible Home/front page
- send one labelled Claude message
- verify the message and reply
- require the Claude reply to include a fresh benchmark reply token before it
  counts as extracted
- submit Claude through the wrapper's scoped `press`, not raw `agent-desktop`
- perform no X mutation
- record elapsed time, action count, retries, stale refs, focus movement, Stage
  Manager behavior, clipboard use, false success/failure, direct runtime escape
  use, and whether reply text was extracted
- record `workspace.frontmostBefore`, `workspace.frontmostAfter`, and whether
  the frontmost app was restored after the run
- restore the originally focused window when the runtime can identify it, then
  include the restore action in the benchmark action count
- distinguish functional completion from Codex Computer Use parity through a
  `qualityGate` block that lists blockers such as clipboard fallback, missing
  workspace proof, unrestored focus, or missing visible intent

Output:

- structured JSON for machines
- concise markdown for humans
- explicit `replyExtractionMethod`, `workspace`, and `qualityGate` fields
- explicit `xWindow` fields for X-open attempt and selected Safari window id
- optional `--require-codex-parity` CLI gate that exits nonzero unless
  `qualityGate.onParWithCodexComputerUse` is true
- `--require-codex-parity` disables clipboard fallback, and
  `--no-clipboard-fallback` is available for explicit AX-visible reply proof
- no repo mutation unless `--write-report` is passed

Dry-run proof command:

```bash
pnpm jarvis gui-benchmark --runtime agent-desktop --task x-to-claude --dry-run
```

Live benchmark requires explicit user approval before sending anything to
Claude or touching a real logged-in app.

## Scorecard Gate

Compare every live result against the Codex Computer Use baseline:

- 95 seconds
- about 10 CUA calls
- no clipboard use
- one stale-state retry
- visible virtual pointer
- strong workspace feel

The benchmark must record:

- elapsed seconds
- action/tool count
- whether Terminal/user workspace stayed usable
- whether Safari/Claude stayed same-stage or background-safe
- whether a virtual pointer/intent equivalent existed
- whether any double paste, clipboard use, wrong-app action, or false
  success/failure occurred
- whether reply extraction came from direct AX-visible text or required the
  controlled clipboard copy/restore fallback

Stage Manager same-stage preservation is a benchmark gate. The runtime should
prefer existing windows and avoid kicking the user's active workspace away.

## Native Swift/OpenClaw Computer Use Spike

Do not build full native runtime in the first adapter PR. Keep this as the
replacement path if `agent-desktop` cannot hit the Codex Computer Use feel
quickly:

- macOS app owns TCC permissions
- Swift service owns ScreenCaptureKit, AX tree, event synthesis, and overlay
- Node/Jarvis requests structured snapshots and actions over local IPC
- TypeScript verifier loop remains the policy and audit owner

Native Swift must include a real visual pointer or intent overlay.

## Kill Switch

Stop investing in the `agent-desktop` wrapper and build native Swift/OpenClaw
Computer Use if any of these remain after the v0 spike:

- cannot preserve Stage Manager workspace
- cannot provide virtual pointer or equivalent visible intent
- repeated false success/failure
- command/action count stays much higher than Codex Computer Use
- app-specific hacks pile up for Safari or Claude
- stale refs require fragile retry rituals
- user experience feels closer to Peekaboo than Codex Computer Use

## Validation

Required before v0 is done:

- unit tests for stale ref retry
- unit tests for false success requiring post-state verification
- unit tests for wrong app/window fail-closed
- unit tests for mutation-risk blocking
- unit tests for audit record creation
- CLI dry-run test:

```bash
pnpm jarvis gui-benchmark --runtime agent-desktop --task x-to-claude --dry-run
```

Live manual benchmark is separate and requires user approval:

```bash
pnpm jarvis gui-benchmark --runtime agent-desktop --task x-to-claude
```

Decision-gate live command:

```bash
pnpm jarvis gui-benchmark --runtime agent-desktop --task x-to-claude --open-x-home --approve-claude-send --no-clipboard-fallback --require-codex-parity
```
