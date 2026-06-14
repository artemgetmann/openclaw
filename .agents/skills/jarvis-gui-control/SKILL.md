---
name: jarvis-gui-control
description: "Use when asked to test or operate macOS apps through Jarvis GUI Control, agent-desktop, or the OpenClaw gui-control/gui-benchmark CLI. Proactively use for natural-language GUI tasks such as reading Safari/X, writing Claude, resolving real UI elements, or proving fail-closed desktop automation behavior."
---

# Jarvis GUI Control

## Overview

Use the repo CLI as the GUI-control surface. Treat the CLI result as the
authority: if it says wrong target, ambiguous element, blocked policy risk, or
missing verification, stop instead of working around it.

Primary commands:

```bash
pnpm jarvis gui-control --help
pnpm jarvis gui-control observe --app <App> --window-title <Title> --json
pnpm jarvis gui-control resolve-element --app <App> --intent <text-input|button|any> --label-includes <text> --json
pnpm jarvis gui-control set-value --app <App> --intent text-input --label-includes <text> --value <text> --approve-policy-risk --json
pnpm jarvis gui-control click --app <App> --intent button --label-includes <text> --verify-text <proof> --approve-policy-risk --json
pnpm jarvis gui-control press --app <App> --keys <combo> --verify-text <proof> --approve-policy-risk --json
pnpm jarvis gui-control scroll --app <App> --intent any --label-includes <text> --direction down --amount 3 --approve-policy-risk --json
pnpm jarvis gui-benchmark --runtime agent-desktop --task x-to-claude --json
pnpm jarvis gui-benchmark --runtime agent-desktop --task x-to-claude --open-x-home --approve-claude-send --json
pnpm jarvis gui-benchmark --runtime agent-desktop --task x-to-claude --open-x-home --approve-claude-send --no-clipboard-fallback --require-codex-parity --json
```

## Workflow

1. Start from the user's natural-language goal.
2. Run `pnpm jarvis gui-control --help` once when unsure. Do not inspect source
   code or run every subcommand help unless the CLI output is genuinely unclear.
3. Observe the target app/window before acting.
4. Resolve real elements by fresh snapshot refs, role, label, description, or value.
   Use `--value-includes` for placeholders/current values such as Claude's
   `Write a message` composer. Use `--label-includes` for visible labels and AX
   descriptions such as a `Send message` button.
5. For mutation, use the CLI's verified action commands. Do not use raw
   coordinates, AppleScript/JXA, Computer Use, Browser/Chrome plugins, or MCP
   as a workaround unless the user explicitly changes the test scope.
6. When the user asks to open a known URL, prefer shell URL navigation such as
   `open -a Safari https://x.com/home`, then verify with `gui-control observe`.
   Do not click through unrelated sensitive pages or login tabs just to reach a
   different site.
7. Re-observe or use benchmark JSON for proof.
8. If a button reports success but does not change state, treat it as failed.
   For Claude-like composers where the send button is unreliable, use scoped
   `press --app Claude --keys cmd+return` with post-state proof.
9. Report the CLI fields that matter: `ok`, `failureReason`, `actionCount`,
   `staleRefs`, `usedClipboard`, `movedFocus`, `falseSuccesses`,
   `falseFailures`, `replyExtractionMethod`, `workspace`, `qualityGate`,
   `postStateResult`, and elapsed time when present.

## Safety Rules

- Fail closed. Wrong app/window, ambiguous element, stale refs, login/auth,
  CAPTCHA, payment, settings/account/profile, destructive actions, or unclear
  mutation risk means stop and report.
- Do not mutate X/Twitter: no post, like, reply, repost, follow, bookmark,
  unbookmark, DM, profile/account/settings changes.
- Read-only observation is allowed.
- A one-off send to Claude is allowed only when the user explicitly approved
  that destination and the CLI can verify the target element.
- Login is not autonomous unless the user's prompt clearly approves login to
  that exact service. Password/passkey/OTP steps should stop for the user.
- Do not treat a tool's process exit alone as proof. Use structured JSON and
  visible post-state verification.

## Product Feel

Prefer short model-authored progress like "Reading X", "Opening Claude", or
"Verifying the reply." Do not expose raw element ids in user-facing progress
unless debugging needs them.

Codex Computer Use is the feel benchmark: low command count, visible intent,
workspace-preserving behavior, and post-action proof. Peekaboo-style recovery
ideas are useful only as safety lessons: scope actions to app/window/snapshot,
prefer structured element refs, and never coordinate-click around uncertainty.

## Benchmark

Use `gui-benchmark` for scorecard proof, not for every ordinary GUI task. The
current benchmark task is `x-to-claude`; it reads Safari/X, sends one approved
labelled Claude message through the wrapper only, submits with scoped press, and
records failure/safety metrics. It must not drop to raw `agent-desktop`.

When the runtime exposes windows, the benchmark must resolve a single Safari
`Home / X` window and observe it by window id. Missing or ambiguous X windows
fail closed before Claude is touched.

Use `--open-x-home` only when the user approved opening X Home. The benchmark
then opens `https://x.com/home` in Safari, waits for one exact `Home / X`
window, records `xWindow.openAttempted/openSucceeded/selectedWindowId`, and
still forbids X/Twitter mutations.

The benchmark labels each Claude prompt with a fresh reply token. Count the run
as successful only when the wrapper extracts a Claude reply containing that
token. AX-visible text is preferred; a controlled clipboard copy/restore
fallback is allowed only when it is reported through `usedClipboard`.

Functional success is not the same as Codex Computer Use parity. Use
`qualityGate.codexComputerUseParity` and `qualityGate.blockers` to distinguish a
clean pass from a pass that still has debt such as clipboard recovery, missing
Stage Manager proof, unrestored frontmost app, or no visible pointer/intent
overlay.

Use `--require-codex-parity` when the benchmark is a release/decision gate. The
plain command exits on functional completion; the parity-required command exits
nonzero unless `qualityGate.onParWithCodexComputerUse` is true.
Parity-required CLI runs disable clipboard fallback automatically. Use
`--no-clipboard-fallback` explicitly when testing that Claude reply extraction
is AX-visible and does not touch the user's clipboard.

The benchmark should restore the originally focused window when the runtime can
identify it. Treat `workspace.restoreAttempted`, `workspace.restoreSucceeded`,
and `workspace.frontmostRestored` as part of the proof, not cosmetic metadata.
