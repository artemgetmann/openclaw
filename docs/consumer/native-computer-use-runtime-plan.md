# Native Computer Use Runtime Plan

Last updated: 2026-06-19
Status: fork-backed adapter spike in progress, dev-only

## Goal

Use `open-codex-computer-use` / OpenComputerUse as the first native macOS
helper base, while keeping Jarvis TypeScript as the policy, verifier, audit,
and benchmark owner.

## Current Stance

The runtime decision is no longer open-ended for this spike: fork
OpenComputerUse first, wrap it through the existing Jarvis `GuiRuntime`
abstraction, and defer a ground-up Swift rewrite unless the fork cannot pass
workspace and active-user safety gates.

Known constraints:

- GUI control remains deferred from the consumer MVP.
- Codex Computer Use is the quality bar, not a reusable backend.
- Candidate benchmarks run outside the OpenClaw repo in `/tmp`.
- Live X to Claude proof requires explicit user approval with `go clean test`.
- No benchmark may mutate Twitter/X, Jarvis, Telegram, Messages, or the shared
  gateway runtime.
- GUI control remains dev-only until the forked adapter passes benchmark gates.

Current implementation context:

- Worktree: `/Users/user/Programming_Projects/openclaw/.worktrees/gui-control-bakeoff-20260610`
- Branch: `codex/gui-control-bakeoff-20260610`
- Existing wrapper code: `src/gui-control/*`
- OpenComputerUse adapter: `src/gui-control/open-computer-use-runtime.ts`
- Existing decision docs:
  - `docs/consumer/gui-control-mvp-decision.md`
  - `docs/consumer/gui-control-implementation-plan.md`
- First close-clone static pass:
  `/tmp/jarvis-gui-runtime-bakeoff-20260612-181756`
- First approved local/live pass:
  `/tmp/jarvis-gui-runtime-bakeoff-20260612-185025`
- First watched `open-computer-use` X to Claude pass:
  `/tmp/jarvis-open-computer-use-watched-20260612-210244`
- First clean fresh-chat `open-computer-use` X to Claude pass:
  `/tmp/jarvis-open-computer-use-clean-rerun-20260612-211715`

## Architecture Target

Expected architecture unless a benchmarked candidate clearly beats it:

```text
Jarvis TypeScript verifier, policy, and benchmark
        |
thin Node or MCP adapter
        |
native Swift app helper or service
        |
AX tree plus ScreenCaptureKit plus CGEvent plus overlay cursor plus workspace guard
```

Swift helper owns:

- TCC [macOS privacy permission] prompts and permission state.
- AX [Accessibility API] tree extraction with roles, values, labels,
  descriptions, static text, and bounds.
- Screenshots through ScreenCaptureKit.
- Keyboard, mouse, and scroll events through native macOS event APIs.
- Visible virtual cursor or intent overlay.
- App, process, window, space, and workspace identity.
- Workspace restore and focus protection.

TypeScript owns:

- Task-scoped capability policy.
- Action audit.
- Benchmark scorecard.
- Post-state verification.
- Runtime-independent planner interface.

OpenComputerUse owns the first helper substrate:

- AX [Accessibility API] tree extraction.
- Native element-index actions.
- ScreenCaptureKit and software cursor ideas.
- Permission diagnostics and helper packaging lessons.

Cortex remains reference-only. Borrow its screenshot-settle, permission,
forbidden-key, and artifact ideas; do not adopt its coordinate-first planner or
domain-specific assumptions.

## Minimum Runtime API

The first reusable contract should stay small:

- `listApps`
- `getAppState`
- `captureScreenshot`
- `resolveElement`
- `typeText`
- `pressKey`
- `clickElement`
- `scrollElement`
- `focusWindow`
- `restoreWorkspace`

The current Jarvis adapter exposes the existing narrower `GuiRuntime` shape:
`listApps`, `observe`, `setValue`, `click`, `press`, `scroll`, `listWindows`,
and later `focusWindow`. It shells out to the OpenComputerUse CLI first.
Direct Swift package integration is deferred until the CLI adapter proves the
policy and verifier boundaries are clean.

The API must expose stable app, window, and element identity. Raw coordinates
are allowed only as an explicit fallback path and must be recorded as quality
debt.

## First Vertical Slice

Build proof in this order:

1. Claude write/read loop.
2. Safari/X read-only observation.
3. Safari/X read-only summary to Claude.
4. Claude reply extraction.
5. Active-user desktop interference test.

Rules:

- No clipboard fallback for parity proof.
- No raw coordinates as the default action path.
- Every action success requires post-state proof.
- Wrong app, wrong window, stale refs, auth, payment, settings, and destructive
  surfaces fail closed.

## Benchmark Worker Contract

Run benchmarks in a visible tmux worker so logs do not pollute the main chat.

Worker rules:

- Use `/tmp/jarvis-gui-runtime-bakeoff-*`.
- Do not edit the OpenClaw repo.
- Do not mutate X/Twitter.
- Do not use Codex Computer Use as backend.
- Do not install persistent or system components without explicit approval.
- Do not rely on raw coordinates unless the candidate requires it; record that
  as a product failure.

Candidate evaluation fields:

- language/runtime
- license
- install/build friction
- permission model
- AX/static text/bounds quality
- screenshot/OCR support
- event synthesis method
- window/workspace preservation
- visible cursor/overlay
- scoped app/window targeting
- post-action verification support
- failure messages
- maturity and forkability

Benchmark tasks:

1. Static inspection only.
2. Safe local app nonce insert in TextEdit or Notes.
3. Focus mismatch test: bring another app frontmost and prove the target action
   still scopes correctly or fails closed.
4. Live X to Claude proof only after explicit user approval.

Future reliability probes:

1. Safari flight-booking dry run. Use real Safari, not browser control or Chrome,
   to search for a flight and reach a reviewable itinerary page. Stop before
   login, passenger details, payment, purchase, or any externally visible
   booking action. Score AX targeting, stale-state recovery, form handling,
   navigation robustness, and workspace disruption.
2. Jarvis macOS app smoke. Open the installed Jarvis app, navigate core screens,
   click Check for Updates, and verify the UI reacts correctly. Stop before
   installing an update unless separately approved. Score native app targeting,
   buttons, dialogs, focus behavior, and fail-closed handling.

Live proof requirements:

- Open or observe Safari X Home read-only.
- Do not mutate X.
- Send one approved labelled message to Claude.
- Extract Claude reply.
- Record elapsed time, action count, retries, stale refs, focus movement,
  clipboard use, raw coordinate use, false success or failure, and reply
  extraction method.

Worker output:

- `/tmp/jarvis-gui-runtime-bakeoff-*/results.json`
- compact markdown table
- recommendation per candidate: `fork`, `borrow`, `avoid`, or `watch`

## Candidates

Benchmark first:

- `mac-computer-use`: `https://github.com/TheGuyWithoutH/mac-computer-use`
- `macos-cua`: `https://github.com/code-yeongyu/macos-cua`
- `open-computer-use`: `https://github.com/iFurySt/open-codex-computer-use`

First approved test status:

- `mac-computer-use`: `fork` candidate; small MIT substrate with the right
  Swift-helper plus TypeScript-MCP shape. `npm run build` and `npm test` passed
  under `/tmp`; npm reported dependency audit debt. Visible fixture nonce proof
  passed with screenshot before/after and AX `set_value`.
- `macos-cua`: static `borrow` candidate; useful targeting ideas, but license
  ambiguity, coordinate-first CLI examples, and local install failure block
  direct adoption.
- `open-computer-use`: `fork` candidate; most complete product-shaped runtime.
  `swift test` and the Go CLI tests passed under `/tmp`; built-in tool smoke
  and fixture nonce proof passed. One watched X to Claude run functionally
  passed without clipboard or raw coordinates, but did not meet Codex parity
  because Claude `set_value` failed and the run needed keyboard/type fallback.
  A clean fresh-chat rerun then passed semantic Claude `set_value`, send, and
  exact AX reply extraction without clipboard, raw coordinates, or placeholder
  prefix debt.

`open-computer-use` has passed a clean fresh-chat Safari/X to Claude proof. It
has also passed a focus-mismatch targeting proof. It has not passed the full
Codex-parity gate because workspace restoration is still inconclusive and
active-user interference remains unproven.

Reference only unless the first three fail to answer the decision:

- Peekaboo: useful Swift/macOS automation code, but not product runtime owner.
- agent-desktop: useful AX refs and failure-mode evidence, but too flaky as the
  runtime owner without a verifier.
- Ghost OS: useful survey target if close Codex-style clones fail.
- agent-ctrl: useful survey target if close Codex-style clones fail.
- OculOS: useful survey target if close Codex-style clones fail.

## Decision Gate

Build native Jarvis Swift runtime if candidates:

- fail X to Claude cleanly
- need fragile duct tape
- lack visible cursor or overlay
- cannot preserve workspace
- cannot expose reliable AX/static text/bounds
- have license or install risk
- require raw coordinates as the primary action path

Fork or borrow only if a candidate:

- passes local app proof and X to Claude proof
- has a clean commercial license
- can be embedded under Jarvis ownership
- supports or approximates a native helper architecture
- improves velocity without surrendering product control

Expected default after the clean rerun:

- Treat `open-computer-use` as the strongest fork candidate.
- Borrow selectively from `open-computer-use`, `mac-computer-use`, `macos-cua`,
  Peekaboo, and `agent-desktop`.
- Keep a Jarvis-owned native Swift helper as the fallback if `open-computer-use`
  cannot be hardened with runtime-owned workspace restore and active-user
  interference protection.

## Validation

Automated checks:

- policy fail-closed tests
- wrong app/window rejection
- stale-state retry
- action success requires post-state proof
- generic capability blocks
- benchmark scorecard field coverage
- OpenComputerUse parser tests for MCP JSON envelopes and live AX text dumps

Live checks:

- TextEdit or Notes nonce insert
- focus mismatch proof
- X Home read-only observe
- Claude labelled send
- Claude reply extraction
- active-user desktop interference test

Current live evidence:

- `open-computer-use` passed fixture nonce insert, fixture click, Safari/X
  read-only observe, one approved Claude send, and AX reply extraction in
  `/tmp/jarvis-open-computer-use-watched-20260612-210244`.
- That same run failed Codex parity because Claude semantic text insertion
  failed, a child `set_value` produced a false success, and workspace restore
  was not proven.
- `open-computer-use` then passed a clean fresh-chat rerun in
  `/tmp/jarvis-open-computer-use-clean-rerun-20260612-211715`: Safari/X
  read-only observe, fresh Claude chat, semantic `set_value`, send, and exact
  AX reply extraction all passed with no clipboard and no raw coordinates.
- `open-computer-use` passed focus-mismatch targeting in
  `/tmp/jarvis-open-computer-use-focus-workspace-20260612-212446`: Claude was
  observed and controlled while Terminal or Jarvis was frontmost, with no
  clipboard and no raw coordinates.
- The same focus/workspace run left workspace restore inconclusive: original
  frontmost app was Terminal, final frontmost app was Jarvis, and the user may
  have manually switched apps during the measurement window.
- The remaining live gate is active-user interference and workspace guard
  design, not basic X to Claude capability.

## Adapter Spike

Implemented in this worktree:

- `GuiRuntimeName` now includes `open-computer-use`.
- `OpenComputerUseRuntime` shells out to `open-computer-use call ...`.
- The adapter parses structured JSON and MCP-style text envelopes from the
  OpenComputerUse fork. Restore parity currently uses the pinned Jarvis fork
  commit `d71101e6262460a62a96463c4a3c86747e3b3fc4`, which strengthens
  `Raise` with native frontmost activation.
- Element refs use OpenComputerUse AX indices, surfaced as Jarvis refs like
  `@121`, then mapped back to `element_index`.
- `gui-control` and `gui-benchmark` accept `--runtime open-computer-use`.
- `scripts/bootstrap-open-computer-use-runtime.sh` builds the pinned local fork
  and writes the executable path consumed by `OPENCLAW_OPEN_COMPUTER_USE_BIN`.
- `GuiTaskPolicy` replaces hardcoded X/Twitter mutation logic with generic
  capabilities and denied surfaces.
- Benchmark workspace telemetry now records `workspaceMeasurement` as `clean`,
  `changed-by-runtime`, `user-interference-suspected`, or `unknown`.

Acceptance still pending:

- local fixture nonce set and click through the Jarvis adapter
- fresh Claude write/read loop through the Jarvis adapter
- Safari/X read-only observe through the Jarvis adapter
- Safari/X summary to fresh Claude with no clipboard fallback
- focus mismatch with another app frontmost
- isolated workspace measurement while the user does not touch the desktop

Codex Computer Use baseline:

- about 95 seconds
- about 10 calls
- no clipboard
- visible cursor
- workspace preserved in user-observed screenshots
- stale-state recovery without double send

## Native Spec Draft

The native helper should be a signed macOS app or service owned by Jarvis. The
helper is responsible for local machine interaction. Jarvis TypeScript is
responsible for deciding whether an action is allowed.

Process boundary:

- Node starts or connects to the helper through a local, authenticated channel.
- Helper exposes a small request/response API for state and actions.
- Helper returns structured errors that distinguish permission, target,
  stale-state, unsupported action, and policy rejection.
- Helper never executes policy-risk actions without an explicit policy token
  from the TypeScript verifier.

State model:

- app identity: bundle id, process id, localized name, active state
- window identity: window id, title, app id, frame, space/stage metadata when
  available
- element identity: stable runtime id, AX role, title, value, description,
  static visible text, actions, frame, ancestry, enabled state
- screenshot identity: capture id, target app/window, timestamp, scale, image
  dimensions

Action model:

- Actions target app/window/element ids, not free-floating coordinates.
- Helper revalidates target identity immediately before action.
- Helper reports the exact event path used: AX action, AX set value, CGEvent
  keyboard, CGEvent mouse, scroll, or fallback coordinate.
- Helper can draw a visible cursor or overlay before and during actions.
- Helper can restore the previous frontmost app/window when safe.

Failure model:

- Permission missing: return the missing TCC category and recovery hint.
- Target mismatch: return expected and observed app/window ids.
- Stale state: return `STALE_STATE` and require the caller to re-observe.
- Unsafe surface: return the surface classification and do nothing.
- Action uncertain: return the pre/post evidence and force caller decision.

Non-goals for this phase:

- no production onboarding exposure
- no shared gateway ownership changes
- no automated Twitter/X mutation
- no hidden clipboard dependency
- no dependency on Codex Computer Use internals
