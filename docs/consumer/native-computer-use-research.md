# Native Computer Use Research

Last updated: 2026-06-12
Status: evidence log for the native-runtime decision

## Purpose

This doc records the evidence used to decide whether Jarvis should borrow or
fork an existing Computer Use clone, or build a native Swift runtime.

The companion plan is `docs/consumer/native-computer-use-runtime-plan.md`.

## Current Conclusion

Codex Computer Use is proprietary and not reusable as the Jarvis backend.

The useful lesson is architectural: it behaves like a native macOS helper, not
a shell wrapper. Jarvis should match that shape unless an open candidate proves
it can deliver the same target safety, visible intent, workspace preservation,
and post-action proof.

Default recommendation after the first static clone and watched live passes:

- treat `open-codex-computer-use` as the strongest fork candidate so far
- keep TypeScript as verifier and policy owner
- treat `mac-computer-use` as a smaller fork candidate that still needs real app
  workflow proof
- borrow implementation ideas from `macos-cua`, Peekaboo, and `agent-desktop`
- keep a Jarvis-owned native Swift helper as the fallback if workspace and
  active-user safety do not pass cleanly
- do not expose GUI control in the consumer MVP

Important limit: `open-codex-computer-use` passed a clean fresh-chat Safari/X to
Claude proof, including semantic Claude `set_value`, no clipboard, no raw
coordinates, and exact AX reply extraction. It also passed a focus-mismatch
targeting run. Workspace restoration remains inconclusive because the user may
have manually switched the frontmost app during the measurement window.
Active-user interference handling remains untested.

## Codex Computer Use Evidence

Local artifacts observed on this Mac:

- helper app: `~/.codex/computer-use/Codex Computer Use.app`
- bundle id: `com.openai.sky.CUAService`
- main executable: `SkyComputerUseService`
- MCP config command: `~/.codex/bin/computer-use-mcp-wrapper mcp`

Observed architecture:

```text
MCP wrapper
  -> SkyComputerUseClient.app
  -> native service over IPC or XPC
  -> macOS frameworks and app-specific control logic
```

Binary/framework evidence:

- Swift runtime
- SwiftUI/AppKit
- ScreenCaptureKit
- ApplicationServices
- CoreGraphics
- SwiftProtobuf

Product behavior evidence:

- visible virtual cursor or intent overlay
- app approvals
- `get_app_state` before actions
- app-specific instruction packs
- event stream or Skysight-style observation
- lock-screen guardian
- stale-state recovery before retrying
- workspace-preserving feel in user-observed screenshots

Practical conclusion:

- Codex Computer Use is a native macOS app/service architecture.
- It is not a reusable Jarvis backend.
- It is still the quality bar for speed, safety, and UX.

## Codex Baseline

The 2026-06-11 calibration run completed the X to Claude task with caveats:

- elapsed time: about 95 seconds
- action count: about 10 Computer Use calls
- clipboard use: none
- visible cursor: yes
- stale-state handling: one warning, then re-query and retry
- double-send: no
- X mutation: no
- workspace feel: better than raw CLI tools, based on user-observed screenshots

This baseline is the comparison target for Jarvis. A candidate can functionally
complete a task and still fail the product bar.

## Prior Open Runtime Evidence

Already benchmarked in `docs/consumer/gui-control-mvp-decision.md`:

- `agent-desktop` completed TextEdit and X to Claude flows, but showed false
  negatives, false positives, stale refs, focus/window ambiguity, and Claude
  submit friction.
- Peekaboo completed a real X to Claude rerun with strict targeting, but needed
  deeper AX configuration and stayed too low-level to own product runtime
  behavior by itself.
- MacosUseSDK built successfully but returned bad app/PID behavior and had
  unsafe CLI help behavior that launched Messages.
- Ghost OS exposed useful MCP and recipe ideas, but its heavier product surface
  and model setup path make it a survey target, not the default runtime owner.

Current wrapper evidence in `docs/consumer/gui-control-implementation-plan.md`:

- a verifier layer can force post-state proof
- runtime success/failure is advisory only
- X/Twitter mutation blocking belongs in policy
- `press`, `scroll`, static text, descriptions, and bounds are required
- clipboard fallback is quality debt
- workspace restoration must be scored explicitly

## Candidates To Benchmark Next

| Candidate           | Link                                                 | Initial fit                             | Current status                             |
| ------------------- | ---------------------------------------------------- | --------------------------------------- | ------------------------------------------ |
| `mac-computer-use`  | `https://github.com/TheGuyWithoutH/mac-computer-use` | close Codex-style clone candidate       | `fork/watch`; visible fixture nonce passed |
| `macos-cua`         | `https://github.com/code-yeongyu/macos-cua`          | close Codex-style clone candidate       | `borrow`; local install failed             |
| `open-computer-use` | `https://github.com/iFurySt/open-codex-computer-use` | open Codex Computer Use clone candidate | `fork`; clean fresh-chat X to Claude pass  |

First-pass output:

- `/tmp/jarvis-gui-runtime-bakeoff-20260612-181756/results.json`
- `/tmp/jarvis-gui-runtime-bakeoff-20260612-181756/results.md`
- `/tmp/jarvis-gui-runtime-bakeoff-20260612-185025/results.json`
- `/tmp/jarvis-gui-runtime-bakeoff-20260612-185025/results.md`

Reference-only targets:

| Candidate     | Use                                   | Current view                              |
| ------------- | ------------------------------------- | ----------------------------------------- |
| Peekaboo      | Swift/macOS capture and control ideas | useful primitive, not product owner       |
| agent-desktop | AX refs, JSON shape, failure lessons  | useful adapter evidence, not enough alone |
| Ghost OS      | MCP loop, recipes, local vision ideas | survey if closest clones fail             |
| agent-ctrl    | survey candidate                      | not yet inspected in this lane            |
| OculOS        | survey candidate                      | not yet inspected in this lane            |

## Critique Notes

The prior plan cited Claude and Gemini critique notes, but the raw critique
transcripts are not present in this fresh context. Preserved takeaways:

- Do not choose by README claims. Run local benchmarks.
- Treat native macOS permission handling as product surface, not plumbing.
- Require stable app/window/element identity before actions.
- Require post-action state proof before claiming success.
- Treat visible intent and workspace preservation as user trust features.
- Build native Swift if wrappers accumulate app-specific repair code.

Confidence: moderate until the raw critique transcripts are recovered or the
new benchmarks replace them with fresh evidence.

## Benchmark Result Template

Each candidate result should include:

| Field                  | Required evidence                                                           |
| ---------------------- | --------------------------------------------------------------------------- |
| language/runtime       | source inspection and build metadata                                        |
| license                | license file and package metadata                                           |
| install/build friction | exact commands, failures, elapsed setup time                                |
| permission model       | Accessibility, Screen Recording, Input Monitoring, helper app prompts       |
| AX/static text/bounds  | snapshot output with roles, values, descriptions, bounds                    |
| screenshot/OCR         | screenshot API and OCR capability if present                                |
| event synthesis        | AX action, AX set value, CGEvent, AppleScript, browser-only, or coordinates |
| workspace behavior     | frontmost app before/after, focus movement, stage/window effects            |
| visible cursor/overlay | yes/no with command or screenshot proof                                     |
| scoped targeting       | app/window/element targeting support                                        |
| verification support   | post-action observe or state API                                            |
| failure messages       | raw errors and whether recovery is obvious                                  |
| maturity/forkability   | commits, release shape, dependency burden, code clarity                     |
| recommendation         | `fork`, `borrow`, `avoid`, or `watch`                                       |

## Live Test Gate

Do not run the live X to Claude proof until the user explicitly approves it,
for example:

```text
go clean test
```

Before that approval, allowed work is limited to:

- static inspection
- local build/install tests in `/tmp`
- safe TextEdit or Notes nonce tests
- focus mismatch tests that do not touch X/Twitter or Claude

## Current Open Questions

- Can any close Codex-style clone expose the same visible cursor or intent
  overlay as Codex Computer Use?
- Can any clone preserve the active user workspace while acting on a background
  target?
- Can any clone return reliable AX static text, descriptions, bounds, and
  stable element ids across stale-state retries?
- Can any clone send to Claude without clipboard fallback, duplicate paste, or
  raw coordinates?
- Can any clone insert text into Claude semantically without falling back to
  keyboard replacement of the live composer?
- Are licenses and packaging clean enough for a Jarvis-owned consumer runtime?

## Research Log

### 2026-06-12

Created durable native-runtime plan and research docs before running the next
candidate benchmark wave. This preserves the decision gate and prevents the
thread from collapsing back into ad hoc GUI experiments.

Ran the first safe static benchmark pass for the closest Codex-style clones.
Scope stayed read-only except for cloning into `/tmp`; no builds, installs,
MCP launches, app permissions, TextEdit mutation, X/Twitter access, Claude
access, or Codex Computer Use calls.

| Candidate           | Commit                                     | Result   | Evidence summary                                                                                                                                         |
| ------------------- | ------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mac-computer-use`  | `17bfe6ea53d42d513bf1540191384b84a362e31e` | `fork`   | MIT, small TypeScript MCP plus Swift helper, AX tree with bounds, screenshot artifacts, structured errors, focus restore, Stage Manager notes, overlay.  |
| `macos-cua`         | `6ef43416324e07e7bd9666a93556412874eb569b` | `borrow` | Strong FFI targeting ideas and AX extraction, but no license file in clone, coordinate-first CLI examples, private SkyLight/AppKit FFI risk, no overlay. |
| `open-computer-use` | `b753b790cace188152ffb755cd13b2ac9ff6ebf7` | `fork`   | MIT, Swift app/kit, app-bundle permission model, ScreenCaptureKit, AX snapshots, software cursor overlay, fixture smoke suite, safety denylist.          |

Follow-up non-GUI verification:

- `mac-computer-use`: `npm install`, `npm run build`, and `npm test` passed
  under `/tmp` with `npm_config_cache` redirected to the benchmark directory.
  The test suite ran 11 Node tests with 0 failures. `npm install` reported 5
  dependency vulnerabilities: 4 moderate and 1 high. No dependency fix was
  attempted.
- `open-computer-use`: `swift test --cache-path <tmp-cache>` passed. The suite
  built the Swift package and ran 133 XCTest tests with 0 failures. One Swift
  warning appeared: an unnecessary `nonisolated(unsafe)` on a `Sendable`
  `NSImage?` constant in `SoftwareCursorGlyphRenderer.swift`.
- `open-computer-use`: `go test ./...` passed in
  `scripts/computer-use-cli`.
- Candidate clones stayed git-clean after these checks. Ignored build/cache
  outputs were created only under
  `/tmp/jarvis-gui-runtime-bakeoff-20260612-181756`.

The key product takeaway: the fork decision is not settled. Static evidence
shows `open-computer-use` is the most complete product-shaped candidate and
`mac-computer-use` is the cleanest small substrate. The next proof must be a
permission-safe local nonce test, then the gated X to Claude live proof.

Side effects recorded by the worker:

- cloned the three GitHub repos under
  `/tmp/jarvis-gui-runtime-bakeoff-20260612-181756`
- created and later closed tmux session `jarvis_gui_bakeoff_20260612`
- wrote `/tmp/jarvis-gui-runtime-bakeoff-20260612-181756/results.json`
- wrote `/tmp/jarvis-gui-runtime-bakeoff-20260612-181756/results.md`
- created ignored dependency/build caches under the same `/tmp` benchmark
  directory for the non-GUI verification pass

Ran the first user-approved local/live pass:
`/tmp/jarvis-gui-runtime-bakeoff-20260612-185025`.

Preflight:

- `screencapture` produced a full desktop screenshot, so the screen was usable.
- `ioreg` console metadata looked root/loginwindow-like, likely because of
  screen sharing or lock-state weirdness. Treat GUI evidence as useful but keep
  that caveat attached.

Local candidate results:

| Candidate           | Result       | Evidence                                                                                                                                              |
| ------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open-computer-use` | pass         | Built-in smoke completed all 10 tools plus cursor-idle proof. Fixture nonce was set by element index `3` and verified in post-state.                  |
| `mac-computer-use`  | pass         | Visible fixture was discovered, screenshot was present, AX text field index `5` was set, and the nonce was verified in post-state.                    |
| `macos-cua`         | install fail | `pnpm install` failed while building `node-mac-permissions` under Node 25. License ambiguity remains, so keep this as borrow-only.                    |
| `agent-desktop`     | live fail    | Dry-run passed, but live X to Claude parity failed: first on Safari load race, then on Claude write verification after 10 retries. No verified reply. |

Important live detail: after the `agent-desktop` live failure, Claude visible
text contained benchmark token `JARVIS_GUI_1781261869467_KF` and `Retry`, while
the wrapper still reported "Claude message not visible after write." That is a
real false-failure signal. Do not treat the current wrapper as a runtime owner.

Current architecture read:

- `open-computer-use` is the strongest fork candidate because it already has the
  Swift app/kit shape, app-bundle permission model, ScreenCaptureKit, AX
  snapshots, software cursor overlay, smoke suite, and safety policy surface.
- `mac-computer-use` is the smaller fork candidate. It proved the core fixture
  primitive cleanly, but it is less product-shaped and needs real app workflow
  proof.
- `macos-cua` remains useful for ideas only.
- The current Jarvis `agent-desktop` wrapper remains benchmark/salvage tooling,
  not the foundation.

Ran a watched `open-computer-use` live proof:
`/tmp/jarvis-open-computer-use-watched-20260612-210244`.

Safety envelope:

- no Codex Computer Use backend
- no X/Twitter mutation
- no raw coordinates
- no clipboard fallback
- no persistent install
- one user-approved Claude send

Result:

| Check                         | Result                | Evidence                                                                                  |
| ----------------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| fixture nonce `set_value`     | pass                  | fixture post-state contained `JARVIS_WATCHED_OPEN_CU_FIXTURE_1781269385`                  |
| fixture click                 | pass                  | increment button click produced `Counter: 1`                                              |
| Safari/X read-only observe    | pass                  | X Home was observed with `For you`, topic tabs including `OpenClaw`, and composer visible |
| Claude parent `set_value`     | fail                  | element refused: "Cannot set a value for an element that is not settable."                |
| Claude child `set_value`      | fail / false success  | command returned state, but token was not visible in the composer                         |
| Claude keyboard/type fallback | functional pass, debt | click composer, Command-A, Backspace, `type_text`, then click Send                        |
| Claude reply extraction       | pass                  | final AX text contained exact reply token in Claude response container                    |
| Codex parity                  | fail                  | semantic input and workspace restoration were not cleanly proven                          |

The watched token was `JARVIS_OPEN_CU_WATCHED_1781269519`. Final AX evidence
shows Claude responded with the same token. The artifact packet is:

- `/tmp/jarvis-open-computer-use-watched-20260612-210244/results.json`
- `/tmp/jarvis-open-computer-use-watched-20260612-210244/results.md`
- `/tmp/jarvis-open-computer-use-watched-20260612-210244/18-claude-final-state.json`

Decision impact: `open-computer-use` is now the best fork/watch candidate, but
the run does not justify adopting it unchanged. It is evidence that the native
Swift shape is right. It is not evidence that the existing runtime already owns
Jarvis-grade app semantics, workspace protection, and verifier behavior.

Ran a clean watched `open-computer-use` rerun in a fresh Claude chat:
`/tmp/jarvis-open-computer-use-clean-rerun-20260612-211715`.

Result:

| Check                       | Result   | Evidence                                                                            |
| --------------------------- | -------- | ----------------------------------------------------------------------------------- |
| Safari/X read-only observe  | pass     | `Home / X` at `x.com/home`, `For you` selected, `OpenClaw` tab and composer visible |
| fresh Claude chat           | pass     | `https://claude.ai/new`; prior watched token absent                                 |
| Claude semantic `set_value` | pass     | token visible before send, no `Write a message...` placeholder prefix in composer   |
| Claude send                 | pass     | clicked `Send message` after semantic `set_value`                                   |
| Claude reply extraction     | pass     | exact token appeared in Claude response after `Stop response` disappeared           |
| clipboard                   | not used | no clipboard fallback                                                               |
| raw coordinates             | not used | element-index/native actions only                                                   |
| workspace restore           | unproven | frontmost restoration was not part of this clean rerun                              |
| Codex parity                | partial  | functional clean pass; workspace and active-user interference gate remains          |

The clean token was `JARVIS_OPEN_CU_CLEAN_1781270299`. The artifact packet is:

- `/tmp/jarvis-open-computer-use-clean-rerun-20260612-211715/results.json`
- `/tmp/jarvis-open-computer-use-clean-rerun-20260612-211715/results.md`
- `/tmp/jarvis-open-computer-use-clean-rerun-20260612-211715/08-claude-reply-poll-03.json`

Decision impact: this materially improves the `open-computer-use` case. The
remaining gate is no longer "can it do X to Claude cleanly in principle?" It
can, at least in a fresh Claude chat. The remaining gate is whether it can do
so while preserving workspace, rejecting wrong focus/window targets, and
handling active-user interference without brittle app-specific repair code.

Ran the focus-mismatch and workspace-restore gate:
`/tmp/jarvis-open-computer-use-focus-workspace-20260612-212446`.

Result:

| Check                         | Result   | Evidence                                                             |
| ----------------------------- | -------- | -------------------------------------------------------------------- |
| initial user workspace        | pass     | Terminal was frontmost before runtime actions                        |
| observe Claude from mismatch  | pass     | Claude observed while Terminal stayed frontmost                      |
| target New Chat from mismatch | pass     | fresh Claude chat opened, old token absent, Terminal still frontmost |
| semantic `set_value` mismatch | pass     | token visible in Claude composer, no placeholder prefix              |
| send/reply from mismatch      | pass     | Claude response contained exact token                                |
| clipboard                     | not used | no clipboard fallback                                                |
| raw coordinates               | not used | element-index/native actions only                                    |
| workspace restore             | unclear  | final frontmost app was Jarvis, but user may have switched apps      |
| Codex parity                  | partial  | targeting works, runtime-owned restore still needs isolated proof    |

The focus token was `JARVIS_OPEN_CU_FOCUS_1781270746`. The artifact packet is:

- `/tmp/jarvis-open-computer-use-focus-workspace-20260612-212446/results.json`
- `/tmp/jarvis-open-computer-use-focus-workspace-20260612-212446/results.md`
- `/tmp/jarvis-open-computer-use-focus-workspace-20260612-212446/11-reply-poll-03.json`

Decision impact: `open-computer-use` can target the intended app even when the
frontmost app is wrong. The user-observed behavior was strong: Claude received
input and sent a reply while another app was intended to stay in front. The
remaining proof should isolate runtime-owned workspace restoration by asking
the user not to touch the desktop during a short measured run, or by recording a
separate before/after window identity trace. A Jarvis fork should still add a
workspace guard around the helper, or the helper itself should grow explicit
`captureWorkspace` and `restoreWorkspace` primitives before consumer use.

Implemented the first Jarvis adapter spike against the OpenComputerUse fork
decision.

Code changes:

- `src/gui-control/open-computer-use-runtime.ts` adds a CLI-backed
  `OpenComputerUseRuntime`.
- `GuiRuntimeName` now includes `open-computer-use`.
- `gui-control` and `gui-benchmark` accept `--runtime open-computer-use`.
- `OPENCLAW_OPEN_COMPUTER_USE_BIN` can point at a pinned local fork build such
  as `/tmp/jarvis-gui-runtime-bakeoff-20260612-181756/open-codex-computer-use/.build/debug/OpenComputerUse`.
- OpenComputerUse AX text-tree lines are normalized into Jarvis `ElementRef`
  values like `@121`, then mapped back to OpenComputerUse `element_index`.
- Action telemetry preserves `usedClipboard=false` and
  `rawCoordinatesUsed=false` for element-index actions unless the runtime
  explicitly reports otherwise.
- `GuiTaskPolicy` replaces hardcoded X/Twitter mutation blocking with generic
  capabilities and sensitive-surface terms.
- Benchmark workspace telemetry now records whether a focus change was `clean`,
  `changed-by-runtime`, `user-interference-suspected`, or `unknown`.

Decision impact: this is an adapter spike, not consumer exposure. The fork base
is now concrete enough to run through the Jarvis verifier and benchmark layer.
Remaining proof is live adapter acceptance: fixture set/click, Claude
write/read, Safari/X read-only observe, X summary to Claude, focus mismatch,
and an isolated workspace measurement where the user does not touch the
desktop.
