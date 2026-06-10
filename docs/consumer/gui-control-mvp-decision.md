# Consumer GUI Control MVP Decision

Last updated: 2026-06-10
Status: deferred for launch; active bakeoff for a later Jarvis GUI-control lane

## Decision

Consumer GUI control is still not part of the first MVP by default.

Reason:

- most consumer users do not need desktop GUI control on day one
- GUI control adds macOS Accessibility, Screen Recording, and sometimes Input
  Monitoring permission burden
- shipping it half-working would create more confusion than value
- the recent Peekaboo run proved the real failure mode: raw CLI control plus
  an LLM can click the wrong app when focus, coordinates, and provider state
  are not wrapped by strict planning and verification

## Problem Statement

Jarvis should eventually operate desktop apps, but raw Peekaboo CLI plus a
general LLM loop is not product-grade by itself.

The observed failure chain was concrete:

1. Peekaboo paste syntax changed or was misused after an update.
2. `--analyze` failed because Peekaboo had no configured AI provider/API key.
3. Claude launched blank or slowly, and foreground/window targeting became
   confused.
4. Retina screenshot pixels were manually translated into click coordinates.
5. A final raw coordinate click omitted `--app Claude` or `--window-id` and
   clicked Telegram instead of Claude.

That is exactly the kind of bug a consumer Jarvis product cannot treat as
"operator error". The runtime must make wrong-target actions hard.

## Immediate Rule

Use Peekaboo as a short-term capture/control primitive, not as the default
planner or brain.

Rules:

- the primary Jarvis/Codex model inspects screenshots, UI maps, and command
  output itself
- Peekaboo `--analyze` is disabled by default for Jarvis flows
- use `--analyze` only after provider config is verified and the task
  explicitly wants Peekaboo's own AI answer
- every action must be scoped by app, process id, window id, or snapshot
- prefer Accessibility API tree [structured UI map exposed by macOS] element
  refs over coordinates
- coordinates are last resort, must stay target-scoped, and must be verified by
  a fresh screenshot or UI map before continuing

The bundled Peekaboo skill should carry these operating rules so future agents
do not repeat the Telegram-vs-Claude click failure.

## Current Peekaboo Reality

Verified on 2026-06-10:

- local Homebrew install: `peekaboo` 3.1.2
- Homebrew stable in `steipete/tap`: 3.3.0
- upstream `openclaw/Peekaboo` latest release: `v3.4.1`, published
  2026-06-10
- upstream Peekaboo is MIT, Swift, macOS 15+, and now exposes capture, UI maps,
  background-targeted input, direct accessibility actions, CLI, MCP, and an
  agent loop

Keep Homebrew-stable and upstream-release facts separate. They do not move in
lockstep.

## Evaluation Matrix

| Candidate            | Fit                                               | Strength                                                                                                                            | Main Risk                                                                                                                  |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| MacosUseSDK          | Best Swift-native control primitive to test first | MIT Swift library; traverses macOS Accessibility trees and simulates input                                                          | Low-level API still uses coordinates for some actions; SDK polish and packaging need proof                                 |
| mcp-server-macos-use | Useful wrapper/reference for MacosUseSDK          | Swift MCP server over stdio; opens apps and traverses AX trees                                                                      | License conflict: package metadata says MIT, but `LICENSE` is Business Source License; treat as BSL until clarified        |
| agent-desktop        | Best low-level runtime candidate to test first    | Rust CLI, Apache-2.0, deterministic refs, structured JSON, AX-first actions, FFI artifacts                                          | Young project; macOS permission behavior and background/focus guarantees need live proof                                   |
| Ghost OS             | Best turnkey loop candidate if recipes matter     | MIT Swift, AX-first, MCP tools, recipes, local vision fallback, `ghost doctor` diagnostics                                          | Heavier product surface; macOS 14+/Swift 6.2, Python vision sidecar, and multi-GB model path may be more than Jarvis needs |
| screenpipe           | Observation and memory layer only                 | MIT main repo, with an enterprise-licensed `ee/` area; records screen/audio/app context locally; captures AX tree with OCR fallback | Not a primary click/type engine; high privacy and storage burden for consumer default                                      |
| Appium Mac2 Driver   | QA harness only                                   | Apache-2.0; XCTest/WebDriver; deterministic app-under-test model                                                                    | Xcode/Appium setup friction; designed for tests, not user desktop operation                                                |
| browser-use          | Web-only adjacent option                          | MIT Python; browser automation agent and cloud/browser harness                                                                      | Does not solve native macOS app control                                                                                    |
| Skyvern              | Web-only adjacent option                          | Browser workflows with Playwright plus LLM/vision; useful for hosted web tasks                                                      | AGPL-3.0 for OSS repo and browser-only scope make it a poor native Jarvis foundation                                       |
| Peekaboo             | Short-term bridge and fallback host               | MIT Swift; already installed path; strong capture/control surface; MCP optional                                                     | Too low-level unless wrapped by strict planner/executor discipline                                                         |

## Scoring Criteria

Score each candidate 0-2 for the first bakeoff, where 0 fails, 1 is workable
with risk, and 2 is product-shaped.

- AX-first targeting: can it identify and act on UI elements without raw
  coordinates?
- Deterministic refs: can a model point to stable element/window ids from a
  snapshot?
- Background and focus behavior: can it act on the intended app without
  stealing focus or hitting the frontmost wrong app?
- Swift/macOS embeddability: can Jarvis call or bundle it without a fragile
  sidecar?
- License and commercial fit: can it ship in a consumer product without legal
  cleanup?
- Setup friction: can a normal user get through permissions and install?
- Failure messages: does it fail with actionable cause and recovery?
- Jarvis permission model fit: can we explain and request only the permissions
  needed for the requested action?

## Recommended Next Bakeoff

Do not build a custom GUI-control runtime yet.

First run a narrow bakeoff against MacosUseSDK and agent-desktop. Add Ghost OS
only if the team decides it wants a turnkey MCP agent loop or recipe layer.
Keep screenpipe for observation/memory research, Appium Mac2 for QA, and
browser-use/Skyvern for web-only workflows.

Workflow each candidate must pass:

1. Open or focus a safe app, preferably TextEdit or Notes.
2. Identify the editable input without raw coordinates.
3. Insert a nonce string by element ref or direct set-value API.
4. Submit or perform one simple action, such as save, search, or create note.
5. Re-observe and verify the nonce is visible in the intended app/window.
6. Force a focus mismatch by bringing another app forward.
7. Retry the action and confirm it either targets the intended window or fails
   closed before acting.
8. Record exact permission prompts, failure messages, and recovery steps.

Suggested task prompt:

```text
Open TextEdit, create a new document, insert exactly
JARVIS_GUI_BAKEOFF_<timestamp>, save nothing, and verify the text is visible.
If TextEdit is not the active intended target, stop before typing.
```

Candidate command sketches:

```bash
# MacosUseSDK
git clone https://github.com/mediar-ai/MacosUseSDK /tmp/MacosUseSDK
cd /tmp/MacosUseSDK
swift build
swift run AppOpenerTool TextEdit
swift run TraversalTool --visible-only <PID>

# agent-desktop
npx agent-desktop permissions --request
npx agent-desktop launch TextEdit
npx agent-desktop snapshot --app TextEdit -i --compact
npx agent-desktop type @e5 --snapshot <snapshot_id> "JARVIS_GUI_BAKEOFF_<ts>"
npx agent-desktop snapshot --app TextEdit -i --compact

# Ghost OS, only if turnkey loop is in scope
brew install ghostwright/ghost-os/ghost-os
ghost setup
ghost doctor
```

## Recommendation

Default path:

1. Keep Peekaboo as the immediate fallback/bridge host, with strict scoped
   actions and no default `--analyze`.
2. Evaluate MacosUseSDK for the embeddable Swift foundation.
3. Evaluate agent-desktop for the agent-facing CLI/runtime foundation.
4. Evaluate Ghost OS only if Jarvis wants a prebuilt MCP loop, recipes, and
   local vision fallback.
5. Treat screenpipe as optional observation/memory, not a click/type engine.
6. Treat Appium Mac2 as QA-only.
7. Use browser-use or Skyvern only for browser surfaces.

The 80/20 next slice is not "invent computer use". It is proving whether an
AX-first runtime can complete one safe workflow while refusing to type into the
wrong app.

## Sources Checked

- `https://github.com/openclaw/Peekaboo`
- `https://github.com/mediar-ai/MacosUseSDK`
- `https://github.com/mediar-ai/mcp-server-macos-use`
- `https://github.com/lahfir/agent-desktop`
- `https://github.com/ghostwright/ghost-os`
- `https://github.com/screenpipe/screenpipe`
- `https://github.com/appium/appium-mac2-driver`
- `https://github.com/browser-use/browser-use`
- `https://github.com/Skyvern-AI/skyvern`

## Non-Goals

- no new GUI-control runtime implementation in this pass
- no default consumer onboarding change for desktop automation yet
- no shared gateway restart, deployment, or packaged-app mutation
- no use of the local Codex Computer Use plugin as a reusable Jarvis backend
