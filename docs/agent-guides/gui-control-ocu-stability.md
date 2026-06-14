# GUI Control OCU Stability

Last updated: 2026-06-14
Status: active stability slice, dev-only

Use this checklist when proving OpenComputerUse-backed Jarvis GUI control. The
goal is not to show that a demo happened once. The goal is to prove what the
runtime did, what it avoided, and which debt remains.

## Current Scope

This slice proves two paths:

- repeat `x-to-claude` stability through OpenComputerUse
- medium `safari-notes-claude`: Safari/X read, Apple Notes write, Claude
  summarize

Keep WhatsApp, Telegram, Gemini, and other external-send surfaces out of this
slice until the medium chain is stable. Those apps add approval and delivery
policy risk that makes runtime failures harder to interpret.

## Method

Run the smallest live path that proves the next claim.

1. Use terminal checks first: targeted tests, typecheck, and diff hygiene.
2. Acquire the Computer Use lease before live macOS control.
3. Run benchmarks through `pnpm jarvis gui-benchmark`, not ad hoc app scripts.
4. Use OpenComputerUse semantic controls only.
5. Write a report for every live run.
6. Treat benchmark JSON as the source of truth.
7. Post exact report paths on the PR before calling the slice proven.
8. Release the Computer Use lease when live control is done.

Do not use AppleScript/JXA, raw coordinates, clipboard fallback, or macOS focus
hacks as acceptance proof. If one is used for diagnosis, mark the run
diagnostic-only.

## Repeat Benchmark Checklist

Command shape:

```bash
OPENCLAW_OPEN_COMPUTER_USE_BIN=/path/to/OpenComputerUse pnpm jarvis gui-benchmark \
  --runtime open-computer-use \
  --task x-to-claude \
  --open-x-home \
  --open-claude-new \
  --approve-claude-send \
  --no-clipboard-fallback \
  --require-codex-parity \
  --write-report \
  --report-dir /tmp/jarvis-ocu-stability-repeat-<date> \
  --repeat 3 \
  --json
```

Required evidence:

- 3 reports, one per run
- aggregate pass count
- elapsed and action-count ranges
- `usedClipboard=false` for every run
- `replyTextExtracted=true` for every run
- `replyExtractionMethod=ax-visible-text` for every run
- `virtualPointer.present=true` for every run
- `qualityGate.codexComputerUseParity=pass` for clean parity, or exact blockers
  if not clean

Functional success is not the same as parity. If the task works but workspace
restore fails, record `functional-pass-with-debt` and keep the blocker visible.

## Medium Benchmark Checklist

Command shape:

```bash
OPENCLAW_OPEN_COMPUTER_USE_BIN=/path/to/OpenComputerUse pnpm jarvis gui-benchmark \
  --runtime open-computer-use \
  --task safari-notes-claude \
  --open-x-home \
  --open-claude-new \
  --approve-notes-write \
  --approve-claude-send \
  --no-clipboard-fallback \
  --reply-extraction-timeout-ms 120000 \
  --reply-extraction-interval-ms 3000 \
  --write-report \
  --report-dir /tmp/jarvis-ocu-medium-live-<date> \
  --json
```

Required evidence:

- Safari/X visible text was read without mutating X
- Apple Notes wrote a fresh note body with a unique token
- Notes visible AX text contained the token after write
- Claude opened a fresh chat when `--open-claude-new` is passed
- Claude composer was written through semantic `setValue`
- Claude send used a verified semantic Send control
- Claude reply was extracted from AX-visible text and included the token
- no clipboard fallback
- no raw coordinates
- pointer evidence present for OpenComputerUse actions
- `qualityGate` and `workspace` fields are included in the report

## Current Truth

Latest live evidence for this slice:

- repeat root:
  `/tmp/jarvis-ocu-stability-repeat-20260614-resume/repeat-ddd6dd7b93fd`
- medium report:
  `/tmp/jarvis-ocu-medium-live-freshclaude-20260614/safari-notes-claude-1781434831490.json`
- medium pointer evidence:
  `/tmp/jarvis-ocu-medium-live-freshclaude-20260614/open-computer-use-visual-cursor-observation.json`

Current result:

- `x-to-claude` repeated 3/3 functional pass
- `x-to-claude` repeated 2/3 clean parity pass
- `safari-notes-claude` functional pass with fresh Claude chat
- no clipboard fallback in the accepted live proof
- AX-visible Claude reply extraction worked
- Notes and Claude mutations used semantic controls
- OpenComputerUse pointer evidence was present

Current blocker:

- OpenComputerUse workspace restore is not reliable enough for clean parity.
  The runtime can report that it raised the previous app while macOS still
  leaves Safari or Claude frontmost.

## Next Diagnostic

Add a restore-only benchmark before expanding to messaging apps.

Minimum matrix:

- Terminal -> Claude -> restore Terminal
- Safari -> Claude -> restore Safari
- Notes -> Claude -> restore Notes

Each run should record:

- frontmost app before action
- frontmost app after task action
- restore action attempted
- restore action result from OpenComputerUse
- frontmost app after restore
- whether the restored app is actually frontmost
- exact failure reason if restore lies or fails

If the restore-only benchmark confirms unreliable restore without a non-hacky
fix, keep workspace restore as explicit parity debt instead of blocking
functional medium-chain work forever.
