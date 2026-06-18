# GUI Control OCU Stability

Last updated: 2026-06-15
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
2. Do not acquire the Codex Computer Use lease for Jarvis/OpenComputerUse
   benchmark runs. Use that guard only when this session is directly using
   Codex Computer Use.
3. Run benchmarks through `pnpm jarvis gui-benchmark`, not ad hoc app scripts.
4. Use OpenComputerUse semantic controls only.
5. Write a report for every live run.
6. Treat benchmark JSON as the source of truth.
7. Post exact report paths on the PR before calling the slice proven.

Do not use AppleScript/JXA, raw coordinates, clipboard fallback, or macOS focus
hacks as acceptance proof. If one is used for diagnosis, mark the run
diagnostic-only.

## Adjacent Tooling

`macos-automator-mcp` is installed locally and can be reached through
`mcporter call macos-automator.*`. It is useful for deterministic operational
fallbacks, scripted app setup, or comparison diagnostics because it ships a
large AppleScript/JXA knowledge base.

Do not use it as acceptance proof for this OCU parity slice. The project is
explicitly AppleScript/JXA over MCP, so using it to focus apps, create Notes
content, read Safari tabs, or repair workspace state would violate the semantic
OpenComputerUse-only acceptance boundary. Use it only when the run is labelled
diagnostic-only or when the task is outside GUI-control parity validation.

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
- restore diagnostic:
  `/tmp/jarvis-ocu-workspace-restore-20260614/workspace-restore-1781436673214.json`

2026-06-15 native restore patch:

- pinned OpenComputerUse fork:
  `https://github.com/artemgetmann/open-codex-computer-use`
- pinned OpenComputerUse commit:
  `d71101e6262460a62a96463c4a3c86747e3b3fc4`
- pinned OpenComputerUse branch:
  `codex/raise-activates-frontmost`
- reproducible bootstrap:
  `bash scripts/bootstrap-open-computer-use-runtime.sh`
- local OpenComputerUse checkout used for the first proof:
  `/tmp/jarvis-ocu-stability-20260614-175656/open-codex-computer-use`
- rebuilt OpenComputerUse dev app copied to stable permission path:
  `/Users/user/Applications/Open Computer Use (Dev).app`
- current OCU binary pointer:
  `/tmp/jarvis-ocu-stability-bin-path.txt`
- permission note: after rebuilding or changing the app signature, verify
  `$(cat /tmp/jarvis-ocu-stability-bin-path.txt) doctor`; macOS may require
  one-time Accessibility and Screen Recording approval for the stable app or
  executable path before live benchmarks can run
- code proof: OpenComputerUse `swift test` passed 134 tests after changing
  `perform_secondary_action` for `Raise` to activate the owning app through
  native `NSRunningApplication` and verify the target PID is frontmost
- restore report:
  `/tmp/jarvis-ocu-workspace-restore-20260615-after-perms/workspace-restore-1781501791763.json`
- repeat root:
  `/tmp/jarvis-ocu-repeat-20260615-after-stage-score-fix/repeat-a0e1105c42d9`
- medium report:
  `/tmp/jarvis-ocu-medium-20260615-after-stage-score-fix/safari-notes-claude-1781502124856.json`
- live proof status: clean after granting Accessibility and Screen Recording
  to the stable copied dev app path

Current result:

- `x-to-claude` repeated 3/3 functional pass
- `x-to-claude` repeated 3/3 clean parity pass
- `safari-notes-claude` clean parity pass with fresh Claude chat
- no clipboard fallback in the accepted live proof
- AX-visible Claude reply extraction worked
- Notes and Claude mutations used semantic controls
- OpenComputerUse pointer evidence was present
- restore-only diagnostic passed 3/3 source-app cases:
  Terminal -> Claude -> Terminal, Safari -> Claude -> Safari, and Notes ->
  Claude -> Notes all restored the source app frontmost

Current blocker:

- The OpenClaw wrapper has clean local parity evidence against the pinned
  OpenComputerUse fork build.
- Upstream OpenComputerUse has not accepted the `Raise` activation patch yet.
  Until then, use `scripts/bootstrap-open-computer-use-runtime.sh` to rebuild
  from the Jarvis/OpenClaw-owned fork pin.

## Restore Diagnostic

Run this restore-only benchmark before expanding to messaging apps or changing
the pinned OpenComputerUse ref.

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

If this benchmark regresses, keep workspace restore as explicit parity debt
instead of hiding the failure inside higher-level functional runs.
