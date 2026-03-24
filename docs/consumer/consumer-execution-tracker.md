# OpenClaw Consumer Execution Tracker

Last updated: 2026-03-24
Owner: consumer execution team
Status: Active

## Source of truth

Use these documents in this order when there is any ambiguity:

1. `CONSUMER.md` (branch identity, north star, week-1 boundaries)
2. `docs/consumer/openclaw-consumer-execution-spec.md` (week-1 execution spec)
3. `docs/consumer/CODEX-PROMPT.md` (browser-spike task framing)
4. `docs/consumer/openclaw-consumer-brutal-execution-board.md` (30-day cadence)
5. `docs/consumer/openclaw-consumer-go-to-market-plan.md` (architecture and launch context)
6. `docs/consumer/macos-consumer-app.md` (consumer macOS app identity, UX, and distribution assumptions)

## Locked decisions

- Week 1 scope follows `CONSUMER.md` + execution spec (power mode, no safety-profile build in week 1).
- Browser path priority is CDP first:
  1. `browser profile=user` (existing-session / Chrome MCP)
  2. `browser profile=openclaw` (managed isolated browser)
  3. Claude-in-Chrome investigation/adaptation
  4. Browserbase (currently credential-blocked; run when creds arrive)
- Benchmark output path is `docs/consumer/browser-spike-results.md`.
- Benchmark protocol is 2 runs per approach/task, using median time.
- Consumer runtime root is `~/Library/Application Support/OpenClaw Consumer`.
- Consumer state/config live under the consumer runtime root, not `~/.openclaw`.
- Consumer gateway port is `19001`.
- No migration or reads from founder state in week 1.
- Telegram v1 is guided BYOK; managed/shared bot stays roadmap-only.

## Consumer Bootstrap Tracker

Use this mini-checklist for the runtime/bootstrap work in this branch:

- Runtime isolation: implemented and verified on the isolated consumer runtime
- Bootstrap automation: implemented and verified through packaged app/bootstrap artifact checks
- Telegram onboarding: implemented as guided BYOK seam and live-validated on the isolated consumer runtime
- Telegram onboarding: live BYOK validation is green enough to treat the lane as working
- First real Telegram reply: self-verified through the repo Telegram userbot harness
  - a real DM was sent to `@jarvis_consumer_bot`
  - the bot replied in the same DM
  - the reply asked bootstrap/identity questions instead of dying before first turn
- Seeded templates/default config: implemented and verified in the consumer runtime/workspace
- Bundled starter skills: audited and pinned in consumer bootstrap
  - current seeded allowlist:
    `apple-notes`, `apple-reminders`, `bear-notes`, `camsnap`, `canvas`,
    `gog`, `goplaces`, `himalaya`, `peekaboo`, `summarize`, `weather`
  - rationale:
    keep the baseline curated, but include email and Google Workspace because
    consumer operator value is weak without inbox/calendar surfaces
- Verification/E2E notes: in progress

Notes:

- Keep the normal consumer path local-first.
- Do not touch founder `~/.openclaw` while validating consumer setup.
- Write down any setup decisions here before moving on to PR prep.
- The current merge + validation checklist lives in `docs/consumer/consumer-next-pass-plan.md`.
- Defer provider/auth account strategy until the onboarding flow is stable:
  - founder-managed shared credentials for early testers
  - user-owned ChatGPT / Claude auth
  - dedicated project-owned test accounts
  - API-key versus account-auth tradeoffs
  - current consumer default model is still `openai-codex/gpt-5.4`
  - follow-up decision pending: switch the consumer default to Claude Sonnet
    4.6 thinking-adaptive or keep Codex for now
- Browser also needs to work in the first-install path, but keep that as a
  later setup-validation step once Telegram/bootstrap is stable.
- Add a dedicated GUI-control stability pass to the later validation checklist:
  - validate tab switches, retries, status refreshes, Dock/window behavior,
    and post-setup actions as a product surface, not just backend health
- Telegram consumer UX still needs command-surface reduction:
  - normal users should only see the essential slash commands
  - the long tail should move behind `/help`, `/commands`, or another advanced
    discoverability path
- Launchd identities are split now: the app autostart job uses `ai.openclaw.consumer`, and the gateway job uses `ai.openclaw.consumer.gateway`.
- The consumer runtime root is app-owned Application Support, not the repo checkout.
- Full Xcode (not just Command Line Tools) is required on this Mac for real macOS app packaging and E2E.
- Packaged app runtime now prefers the current worktree `dist/index.js` and seeds `OPENCLAW_FORK_ROOT`, so child commands do not accidentally fall back to a founder wrapper or a stale hoisted package on `PATH`.
- `PortGuardian` now recognizes runtime-shaped gateway commands (`node .../dist/index.js gateway`) as expected local listeners, so the consumer app does not kill its own isolated gateway during startup.
- `GatewayProcessManager` now skips redundant launch-agent ensure work while startup is already in progress, which reduced a packaged-app cold-start self-restart race.
- The consumer gateway health path is verified; the remaining CLI quirk is that bare `gateway status` still assumes profile-derived launchd labels unless the explicit consumer gateway label is present in the env.
- Consumer app runtime now sets `OPENCLAW_CONSUMER_MINIMAL_STARTUP=1`, which keeps first boot non-blocking by skipping founder-oriented sidecars (session lock cleanup, browser-control sidecar, Gmail watcher, internal hook loading, plugin services, memory backend bootstrap) and by backgrounding channel startup.
- Draft PR is open for review:
  - `https://github.com/artemgetmann/openclaw/pull/72`
  - head: `codex/simplify-consumer-bootstrap-flow-telegram`
  - base: `codex/consumer-openclaw-project`
  - merge gate remains: Telegram BYOK E2E on isolated consumer runtime

### 2026-03-24 first-run activation pass

- This pass was scoped to install-to-first-task friction, not new capability.
- Highest-friction setup bugs fixed in the consumer macOS app:
  - browser setup now persists the real runtime config instead of only app-local selection state
  - browser setup now runs a real readiness check before claiming success
  - consumer onboarding now blocks on model readiness via `openclaw models status --json --check`
  - Telegram first-DM capture now auto-starts the first assistant reply
  - consumer workspace bootstrap now seeds `MEMORY.md`
- Default first-run path is now:
  1. open the app
  2. finish the identity/bootstrap prompt
  3. connect Chrome
  4. pass AI readiness
  5. verify Telegram token
  6. send one DM to the bot
  7. capture that DM and let OpenClaw start the first reply automatically
- Product truth after this pass:
  - browser path is honest now; it either becomes ready or fails with a concrete reason
  - AI readiness is no longer hidden behind the first real task
  - consumer bootstrap no longer ships without durable memory
- Canonical first successful task for this pass:
  - send this Telegram DM after setup:
    `Find the latest price and flight time for New York to London next month and summarize the best public option.`
  - success means:
    - Telegram reply comes back in the same DM
    - the reply contains a concrete public-web answer
    - or the failure names the next recovery step plainly
- Verification evidence captured for the 2026-03-24 pass:
  - `swift test --package-path apps/macos --filter AgentWorkspaceTests` -> passed
  - `swift test --package-path apps/macos --filter BrowserSetupSupportTests` -> passed
  - `swift test --package-path apps/macos --filter ConsumerBootstrapTests` -> passed
  - `swift test --package-path apps/macos --filter OnboardingViewSmokeTests` -> passed
  - `swift test --package-path apps/macos --filter TelegramSetupVerifierTests` -> passed
  - `swift test --package-path apps/macos --filter TelegramSetupBootstrapTests` -> passed
  - `pnpm build` initially failed because this worktree had no `node_modules`
  - `pnpm install` completed successfully
  - rerun `pnpm build` progressed normally and then failed on unrelated existing TypeScript errors in `src/agents/pi-embedded-runner/run/attempt.ts` (`skipWaitForIdle` not in type)
- Remaining pain is documented in `docs/consumer/first-run-friction-report.md`.

### 2026-03-21 Telegram BYOK E2E status

- Live consumer Telegram setup now persists correctly on the isolated runtime:
  - `channels.telegram.enabled = true`
  - `channels.telegram.dmPolicy = "allowlist"`
  - `channels.telegram.allowFrom` contains the captured consumer tester user
  - `channels.telegram.groupPolicy = "open"`
- Guarded consumer app packaging/opening remains the required launch path:
  - `scripts/package-consumer-mac-app.sh`
  - `scripts/open-consumer-mac-app.sh`
- Current blocker is no longer Telegram config persistence.
- Current blocker is no longer "first real agent reply does not work."
- First-turn Telegram reply is now self-verified:
  - a repo userbot session sent a fresh DM to `@jarvis_consumer_bot`
  - `scripts/telegram-e2e/userbot_wait.py` observed the bot reply after that
    message
  - the reply content confirmed consumer bootstrap/identity behavior
- Current blocker is the consumer macOS app lifecycle/status surface:
  - General can still show stale gateway failure even while `19001` is healthy
  - Channels can still paint `Checking...` while Telegram is already saved locally
  - `Retry now` needed to be upgraded from "just re-probe" to actual local gateway recovery
- New practical next step:
  - run one full fresh-user walkthrough on the packaged consumer app and record
    friction in the app shell, setup copy, first reply, and post-setup affordances
- Regression coverage added for:
  - forced gateway recovery bypassing stale running state
  - consumer Telegram fallback staying configured when the latest snapshot is missing

### 2026-03-20 Worktree A handoff

- Worktree A consumer-shell simplification already landed in PR #73.
- The consumer macOS shell is now intentionally minimal:
  - `General`
  - `Permissions`
  - `About`
- `OpenClaw Consumer` packaging identity is the default consumer app path now; this is not the old founder/dev shell.
- Remaining known shell bug from that lane:
  - Accessibility granted-state detection is still unreliable after the user enables it in System Settings.
  - Do not pretend this is fixed.
- Product conclusion from that lane:
  - The shell is good enough for now.
  - Do not reopen a broad consumer UI refactor unless a concrete consumer-facing problem justifies it.
  - The critical path remains Worktree B priorities:
    - consumer runtime startup
    - port `19001` bring-up
    - Telegram/bootstrap flow
    - actual end-to-end consumer setup

### 2026-03-20 runtime debug note

- Added targeted diagnostics and hardening in this branch:
  - startup path no longer references undefined gateway startup wrapper symbols
  - consumer launchd service env now forwards `OPENCLAW_CONSUMER_MINIMAL_STARTUP=1`
  - consumer minimal mode skips Telegram startup bot-probe preflight
- Verification state:
  - `pnpm build` passed
  - `swift test --package-path apps/macos --filter SettingsViewSmokeTests` passed
  - `swift test --package-path apps/macos --filter OnboardingViewSmokeTests` passed
  - `pnpm test -- extensions/telegram/src/channel.test.ts` passed
  - `pnpm test -- src/daemon/service-env.test.ts` passed
  - `bash -n scripts/package-mac-app.sh` passed
- Active blocker for final E2E sign-off:
  - In this local environment, enabling Telegram on the consumer runtime can drive a high-CPU gateway hot loop and RPC timeouts.
  - Paused stack sampling points to `jiti` module resolution while Telegram startup is active.
  - Consumer runtime remains healthy when Telegram channel is disabled.
  - Next required validation is a fresh Telegram BYOK run with a dedicated bot token (no parallel poller) and captured diagnostics.

## Workstream registry (single source)

This file is the only master tracker. Do not create per-worktree tracker copies.

- All delegated branches should start from `origin/codex/consumer-openclaw-project`.
- Each delegated workstream owns one scoped branch and one PR.
- Workstreams should not edit files owned by another active workstream.
- Only merge-validated work should update this master tracker status.

### Active workstreams

| WS-ID                | Phase focus | Owner | Branch                             | Status      | No-touch files                                                                                                                                        | PR  |
| -------------------- | ----------- | ----- | ---------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| WS-B-CORE            | Phase B     | codex | `codex/consumer-openclaw-smoke`    | in-progress | `src/agents/models-config.ts`, `src/agents/models-config.providers.ts`, `src/plugins/provider-discovery.ts`, `docs/consumer/browser-spike-results.md` | -   |
| WS-C-PREP            | Phase C     | open  | `codex/consumer-phase-c-prep`      | unassigned  | `src/agents/models-config.ts`, `src/agents/models-config.providers.ts`, `src/plugins/provider-discovery.ts`, `docs/consumer/browser-spike-results.md` | -   |
| WS-D-PREP            | Phase D     | open  | `codex/consumer-phase-d-prep`      | unassigned  | `src/agents/models-config.ts`, `src/agents/models-config.providers.ts`, `src/plugins/provider-discovery.ts`, `docs/consumer/browser-spike-results.md` | -   |
| WS-B-SIDE (optional) | Phase B     | open  | `codex/consumer-phase-b-side-lane` | parked      | `src/agents/models-config.ts`, `src/agents/models-config.providers.ts`, `src/plugins/provider-discovery.ts`, `docs/consumer/browser-spike-results.md` | -   |

### Delegation protocol

1. Assign WS-ID -> owner -> branch before coding.
2. If a needed file appears in another WS `No-touch files`, pause and coordinate before editing.
3. Open a scoped PR into `origin/codex/consumer-openclaw-project`.
4. Update this table after PR merge (status, PR link, notes).

## Current baseline snapshot

- Branch: `codex/consumer-openclaw-project`
- `consumer...origin/main`: ahead 17, behind 27
- `codex/consumer-openclaw-project...origin/main`: ahead 22, behind 5
- `origin/main...upstream/main`: ahead 88, behind 220
- Phase A merge and runtime validation are complete.
- Phase B status now:
  - `profile=user` control lane passes (`start/status/tabs`) after remote debugging enablement.
  - `profile=openclaw` control lane passes (`start/status/tabs`) on isolated runtime.
  - Local `agent --local` prompt execution now exits cleanly in the isolated runtime after teardown fixes.
  - Remaining blocker is provider/auth health for full task-matrix execution:
    - `openai-codex:default` returns `API rate limit reached`.
    - `openai-codex:notblockedamazon` returns `API rate limit reached`.
    - lower-priority Codex OAuth profiles previously surfaced `refresh_token_reused`.
    - Anthropic fallback previously surfaced `overloaded`.
  - Consumer Telegram onboarding is now materially healthy:
    - token verify works,
    - first-DM capture persists the Telegram allowlist,
    - the live card now settles into a steady configured/running state,
    - the live card exposes `Open your bot`,
    - and a self-driven Telegram userbot E2E has proven the first real reply
      can come back from the consumer runtime.
  - Current UI simplification direction:
    - consumer local menubar chat is being hidden for MVP so Telegram remains
      the single visible conversation surface
    - threaded mode remains tracked for a later pass after the chat-bar cleanup
- Remaining blocker after that win:
  - `General` can still report stale health failures or status nonsense while
    the Telegram lane is already healthy.
  - 2026-03-21 root cause isolated for the most haunted failures:
    - `~/Library/LaunchAgents/ai.openclaw.consumer.gateway.plist` had drifted
      to another worktree's `dist/index.js`
    - that let launchd resurrect the wrong consumer gateway even while the
      correct app bundle was open
    - current branch now forces a reinstall whenever an existing consumer
      LaunchAgent does not point at this worktree's entrypoint
  - Browser must be part of the first-install validation checklist in a later
    pass, but it remains a parked follow-up until the first-turn reply path is
    stable.
  - LaunchAgent route was tested and reverted in the benchmark lane: it could bind `19001`, but that path was not yet honoring the intended isolated consumer runtime state, so auth/state checks failed.
  - `profile=user` is partially healthy on clean gateway (`status` passes), but `tabs`/`open` are blocked by Chrome MCP attach behavior in the current Chrome session.
  - `profile=openclaw` control lane passes on a clean direct-built gateway (`start`, `status`, `tabs`, `open https://example.com`).
  - Gateway/browser control is healthy for managed profile; existing-session remains the active blocker.
  - A benchmark-only runtime at `/tmp/openclaw-consumer-bench` disables Telegram and removes the stale `plugins.entries.openai` config noise so browser checks do not collide with shared bot traffic.
  - Local runner is no longer blocked: trivial `agent --local` prompt now returns `OK` reliably.
  - External probe confirms the same failure outside OpenClaw (`chrome-devtools-mcp list_pages` times out on `--autoConnect` against current Chrome session).
  - `pnpm openclaw ...` runs from a dirty tree can trigger rebuild churn via `scripts/run-node.mjs`; use the already-built `node dist/entry.js ...` path for clean benchmark/debug runs to avoid false negatives.
  - New benchmark evidence:
    - Task 1 runs 1-2 passed on both profiles.
    - Task 1 medians now favor `profile=openclaw` (`69.9s`) over `profile=user` (`121.0s`).
    - Task 2 run 1 passed on both profiles (`user`: `63.1s`, `openclaw`: `78.8s`) when the task used a concrete public form target.
    - Task 3 runs 1-2 passed on `profile=user` with median `39.0s`.
    - Task 3 runs 1-2 passed on `profile=openclaw` with median `33.9s`.
  - Existing-session selector/frame snapshot requests now degrade to full-page snapshot with warning (compatibility patch landed on this branch), instead of failing the snapshot call.
  - The benchmark gateway must stay alive in a persistent terminal session; backgrounding it from a short-lived exec shell causes false "silent exit" failures.
  - Port `19001` is currently owned by the desktop Consumer app runtime, so the isolated benchmark lane is now on `19011` to avoid token mismatch noise.
  - Current hardening loop status:
    - Session-path rebasing fixes landed for isolated benchmark runs; stale absolute `sessionFile` paths no longer bleed bench transcripts into shared runtime state.
    - Browser availability/status timeouts were widened; both `profile=user` and `profile=openclaw` pass direct `status` checks on the isolated benchmark gateway.
    - `profile=user` `new_page` now honors a `45000ms` timeout budget and reaches Emirates reliably; this step previously failed at the old 10-20s window.
    - Existing-session interaction helpers now forward `timeoutMs` instead of dropping or rejecting it for `click`, `fill`, `fill_form`, `hover`, `drag`, and `press`.
    - Screenshots are confirmed in real runs (`[agents/tool-images] Image resized ...`), so screenshot-first prompts are actually taking effect.
    - Upstream evidence confirms the Chrome/user-lane timeout pattern is already known and not just local environment noise:
      - `openclaw/openclaw#48182`
      - `openclaw/openclaw#46495`
      - `openclaw/openclaw#49295`
      - `ChromeDevTools/chrome-devtools-mcp#116`
      - `ChromeDevTools/chrome-devtools-mcp#863`
  - External-lane research status:
    - Browserbase remains the official remote-CDP fallback for the week-1 decision once creds are available.
    - Browser Use is a real open-source direct-CDP competitor and should be benchmarked before Agent S3.
    - Agent S3 stays on the board, but later; it is a computer-use lane, not a clean browser-native replacement.
  - External-lane execution status (2026-03-21 update):
    - Browserbase credentials are now verified.
    - Browserbase transport is viable only when sessions are created with `keepAlive: true`; the provider default (`keepAlive: false`) is not compatible with OpenClaw's current probe/connect lifecycle.
    - Direct OpenClaw Browserbase CLI smoke now passes (`status`, `open`, `tabs`) with `keepAlive: true`.
    - A fresh-session minimal local-agent Browserbase run also passes, so the local-agent/browser-tool path is not universally broken.
    - Browserbase Task 3 rerun `r3` gets past attach/open and fails later on browser-tool timeout while inspecting article contents for summarization.
    - Browserbase Task 1 split rerun on this worktree is more precise: `r1` still fails early on Google Flights with `Remote CDP ... not reachable`, but a fresh-session warm-up run (`status` + `open https://www.google.com/travel/flights`) succeeds on the same lane and then moves the next concrete blocker downstream to a Google Flights `locator.fill` timeout.
    - Browserbase account concurrency is currently very tight (`3` concurrent sessions), so leaked probe sessions quickly trigger `429 Too Many Requests`.
    - Browserbase is temporarily blocked again by account credits: fresh session creation now returns HTTP `402 Payment Required` (`Free plan browser minutes limit reached`).
    - Because Browserbase now requires paid credits to continue useful testing here, it should not be the next remote infra lane by default.
    - Try `Kernel` or `Steel` first unless the explicit question is Cloudflare / Signed Agents / Browserbase-specific anti-bot behavior.
    - Browser Use local setup is now done:
      - repo-local venv `.venv-browser-use` exists
      - pinned Browser Use CLI is installed and runnable
      - cloned Chrome profile prep works via `scripts/repro/browser-use-profile4-clone.sh prepare-profile`
      - Browser Use `doctor` passes `4/5` checks locally
    - Browser Use no longer appears blocked on local model/API-key setup alone:
      - simple local real-browser `open https://example.com` now works with `OPENAI_API_KEY`
      - but the current CLI behavior is more limited than we assumed
    - Corrected Browser Use local real-browser model:
      - it launches Chrome with its own temp `--user-data-dir`
      - the `--profile` flag names the profile directory inside that temp browser root
      - so this is not the same thing as OpenClaw's cloned real-Chrome lane
    - Current Browser Use blockers are now more precise:
      - `--profile 'Profile 4'` still times out during `BrowserStartEvent` after 30s
      - a fresh profile name can start and open pages successfully
      - but a longer Emirates `run` on that fresh profile currently times out on Browser Use's local socket response path and leaves the session without a usable root CDP client
    - Strategic interpretation:
      - Browser Use should stay a side lane only
      - it is agent-on-agent and therefore not a clean architectural comparison for OpenClaw browser control
    - Claude for Chrome correction:
      - keep this separate from Anthropic's generic computer-use API
      - the user is specifically interested in Chrome-integrated control behavior, not generic desktop screenshot/mouse automation
  - Real-Chrome execution status (2026-03-21 update):
    - Chrome will not allow CDP on the user's live daily data dir directly; it requires a non-default `--user-data-dir`.
    - The practical "real browser state" lane is therefore a cloned-profile lane:
      - detect the real profile via `chrome://version`
      - clone that profile into a throwaway user-data-dir
      - launch Chrome against the clone with `--remote-debugging-port`
      - attach `profile=user` to that CDP endpoint
    - Founder profile detection is now confirmed:
      - source profile: `Profile 4`
    - Emirates benchmark on the cloned `Profile 4` lane passed for `DPS -> DXB` on `2026-03-22`.
    - The same Emirates benchmark on `profile=openclaw` failed on widget instability before visible flight options loaded.

## Phase B hardening tracker

Current objective: convert the Chrome/user Emirates flow from "transport works but task flakes" into a clean benchmarkable run with trustworthy artifacts.

### Confirmed fixed

- [x] Existing-session attach path reaches explicit CDP Chrome via `OPENCLAW_CHROME_MCP_BROWSER_URL`
- [x] Existing-session `new_page` uses the widened timeout budget
- [x] Existing-session action helpers accept and forward `timeoutMs`
- [x] Screenshot-first prompts produce image artifacts during real runs
- [x] Isolated bench session state no longer leaks into shared runtime state

### Still open

- [x] Capture one clean `profile=user` Emirates result artifact on the latest dist
- [x] Capture one clean `profile=openclaw` Emirates result artifact on the latest dist
- [ ] Clean up benchmark artifact capture so JSON results are not polluted by service log lines
- [ ] Decide whether remaining failures are browser-lane bugs or benchmark-harness bugs
- [ ] Capture one clean Browserbase Task 1 artifact now that the split rerun has moved the blocker from attach to field interaction
- [ ] Re-run Browserbase benchmark tasks after clearing leaked provider sessions / avoiding 429 concurrency caps
- [ ] Decide whether to keep investing in Browser Use CLI local `run`, given that simple `open` works but Emirates `run` currently leaves the session unhealthy even on a fresh profile
- [ ] Add explicit benchmark rows for Gmail test account, Reddit DM/reply, Google Sign-In throwaway account, and Emirates baseline
- [ ] Evaluate Claude for Chrome extension as its own browser-control lane if access and reproducible policy boundaries are available
- [ ] Try `Kernel` or `Steel` before paying to continue Browserbase evaluation
- [x] Run the new Kernel repro helper (`doctor` -> `smoke-open` -> `open-emirates`) once `KERNEL_API_KEY` exists
- [x] Document Kernel as infra-validated but integration-deferred in the benchmark matrix and recommendation block
- [ ] Productize Chrome profile detection/setup so users do not need manual `chrome://version` discovery for cloned-profile lanes
- [ ] Parallel workstream in progress: Chrome-only onboarding MVP spec is being explored in a separate AI thread. Keep that work scoped to onboarding UX/state machine/profile chooser/settings copy. Do not let it rewrite the runtime browser-lane semantics underneath the current cloned-session implementation work.
- [ ] Keep Agent S3 documented as a later experiment, not a week-1 gate
- [ ] Teach the browser prompt/skill routing which browser lane to prefer by task shape (for example signed-in hostile travel flow vs clean generic browsing)

### Immediate next 7 actions

1. Keep benchmark lane on `/tmp/openclaw-consumer-bench` and port `19011`; do not reuse the desktop Consumer app runtime.
2. Treat cloned real-Chrome state as the current best `profile=user` recipe for hostile travel sites.
3. Keep `profile=openclaw` as the reliability fallback, but not the current winner on Emirates.
4. Re-run Browserbase with fresh `keepAlive: true` sessions once credits are restored and isolate the remaining deeper browser-tool inspection timeout on real tasks.
5. Continue Browser Use only if we can either stabilize the local `run` session lifecycle or move to a lower-level Python path that exposes more control than the current CLI.
6. Treat Gmail test account, Reddit DM, Google Sign-In throwaway flow, and Emirates as the next practical benchmark set.
7. Delay Browserbase spend until after we learn whether `Kernel` or `Steel` cover the same anti-bot/session problem space for free or cheaper.
8. Keep Claude for Chrome extension on the board as a browser-specific control comparison, but do not conflate it with Anthropic desktop computer-use.
9. Design a user-facing Chrome setup flow that can discover or guide selection of the correct profile instead of relying on manual `chrome://version` inspection.
10. Keep the week-1 primary browser recommendation explicit:
    - cloned real-Chrome state for signed-in travel/browser tasks
    - `openclaw` managed browser as fallback
11. Add browser-lane guidance to the system prompt / browser skill layer so the agent chooses the right lane automatically instead of treating all browser tasks as equivalent.
12. Treat auth/session portability as a product follow-up:
    - credential broker
    - login skill
    - MFA strategy
    - future 1Password integration
    - one-time post-update announcement / setup education for credential tooling
13. Treat browser setup UX as a product follow-up:
    - detect when Chrome is missing
    - guide install cleanly
    - detect or help choose the right profile
    - keep the setup flow Apple-simple for non-technical users
    - explain cloned-browser isolation in simple language
    - recover cleanly if no usable signed-in browser lane exists
14. After the consumer prompt/routing update lands, run an end-to-end check on the founder's main Jarvis Claw bot to verify it actually prefers the cloned Chrome lane in live usage.
15. Treat Kernel as infra-validated and integration-deferred until the current OpenClaw lanes have been benchmarked on the next task set.
16. Use the repo-local Kernel smoke helper instead of ad-hoc shell experiments:
    - `scripts/repro/kernel-browser-smoke.sh doctor`
    - `scripts/repro/kernel-browser-smoke.sh smoke-open https://example.com`
    - `scripts/repro/kernel-browser-smoke.sh open-emirates`
17. Execute the next benchmark wave with exact tasks instead of vague categories:
    - Gmail read-first-email on a sacrificial account
    - Reddit DM/reply on a throwaway or low-risk account
    - Google Sign-In on a throwaway account
    - Emirates `DPS -> DXB` on `2026-03-22`
18. Keep fallback behavior simple:
    - do not silently switch from `profile="user"` to `profile="openclaw"` when the task depends on existing login state
    - surface the blocker and offer the fallback explicitly instead

### Current benchmark wave status (2026-03-22)

- Completed once on both lanes:
  - Gmail read-first-email
  - Google Sign-In first visible decision point
  - Reddit DM/reply access
  - Emirates `DPS -> DXB` on `2026-03-22`
- Current directional result:
  - cloned real-Chrome state is winning the signed-in and hostile flows
  - `openclaw` managed browser remains the clean fallback but is currently losing on session reuse and Reddit anti-bot friction
  - Emirates is now also a current-loss case for the managed lane due to booking-flow instability / error-page collapse
- Next decision point:
  - either execute second runs for median timing on the four-task matrix
  - or lock the MVP browser recommendation now and treat second runs as confidence-building rather than decision-making

### Auth and rate-limit sanity checks

Before any long benchmark wave:

1. Verify the isolated bench runtime still points at `openai-codex/gpt-5.4`.
2. Verify the auth order is pinned to the intended `openai-codex` profile set; do not let the run silently rotate into known-bad tokens.
3. Run one tiny local sanity turn (`Reply exactly OK`) before starting expensive browser tasks.
4. If logs/status show `refresh_token_reused`, repeated `API rate limit reached`, or repeated `overloaded`, stop retrying and reauth or change the auth order before continuing.
5. Treat repeated auth/provider failures as a runtime-preflight failure, not as browser evidence.

## Execution phases and gates

### Worktree A: Consumer macOS app simplification and isolation

- [x] Consumer app uses a separate app/runtime identity
  - [x] Separate bundle/app identity documented
  - [x] Separate state dir + port defaults implemented
  - [x] Separate launch labels/log roots implemented
- [x] Consumer onboarding is local-first
  - [x] Remote setup hidden behind Advanced
  - [x] Consumer-facing copy avoids gateway jargon in the main flow
- [x] Consumer default surface is simplified
  - [x] Menu bar trimmed to status/chat/settings/pause/quit
  - [x] Default settings tabs reduced to General/Permissions/About
  - [x] Advanced toggle reveals hidden power-user surfaces
- [x] Docs updated for the consumer app
  - [x] Tracker kept current
  - [x] Consumer app doc explains isolation and direct-download assumptions
  - [x] Safe local testing instructions included
  - [x] Dedicated consumer package/open wrappers documented so we stop launching the wrong app bundle

Gate to exit Worktree A:

- [x] Consumer app can coexist with founder app on the same Mac without sharing runtime state unintentionally
- [x] Consumer default UX is materially simpler while advanced controls remain accessible
- [x] Docs match the implemented consumer behavior

Worktree A validation notes (2026-03-19):

- `swift build -c debug --product OpenClaw --build-path .build --arch arm64 -Xlinker -rpath -Xlinker @executable_path/../Frameworks` passed after fixing a missing `return` in `OnboardingView+Pages.swift`.
- `swift test --package-path apps/macos --filter GatewayEnvironmentTests` passed.
- `swift test --package-path apps/macos --filter SettingsViewSmokeTests` passed.
- A consumer bundle was packaged manually at `dist/OpenClaw Consumer.app` with:
  - bundle identifier `ai.openclaw.consumer.mac.debug`
  - URL scheme `openclaw-consumer`
  - app variant `consumer`
- Same-Mac isolation smoke passed with the founder gateway still active on `18789`:
  - consumer app process launched from `dist/OpenClaw Consumer.app`
  - consumer defaults plist written to `~/Library/Preferences/ai.openclaw.consumer.mac.debug.plist`
  - consumer runtime socket created at `~/Library/Application Support/OpenClaw Consumer/.openclaw/exec-approvals.sock`
  - consumer app held no TCP listener and did not take over the founder gateway launch label
- Gateway auto-bootstrap on consumer port `19001` was not exercised in Worktree A; that remains Worktree B scope.

Consumer packaging hardening note (2026-03-20):

- Added `scripts/package-consumer-mac-app.sh` to package the consumer app with the correct:
  - display name `OpenClaw Consumer`
  - bundle id `ai.openclaw.consumer.mac.debug`
  - app variant `consumer`
- Added `scripts/open-consumer-mac-app.sh` to refuse opening any bundle that does not match those consumer identifiers.
- This closes the repeated operator error where `dist/OpenClaw.app` was launched by accident during consumer E2E.
- Deferred Telegram/setup polish is tracked in `docs/consumer/telegram-setup-followups.md`.

Worktree A follow-up notes (2026-03-20):

- Consumer settings were reduced again after live review:
  - `General` now keeps only active, launch-at-login, dock icon, advanced toggle, and quit.
  - `Permissions` now defaults to a simple recommended checklist plus an optional disclosure for non-core permissions.
  - `About` now uses consumer branding/copy instead of the upstream project presentation.
- Consumer permission UX now reflects current macOS behavior more honestly:
  - recommended set includes `Screen Recording`, `Accessibility`, `Notifications`, `Automation`, `Microphone`, and `Location`
  - optional set currently includes `Camera` and `Speech Recognition`
  - Accessibility and Screen Recording may still require an app restart before status flips to granted
  - Screen Recording now opens the relevant System Settings pane directly because the native prompt is inconsistent on recent macOS releases
  - permission requests now fall back to the relevant System Settings panes when prompts do not appear
- Manual consumer-app check status:
  - Screen Recording flow now works and opens the expected System Settings path
  - Accessibility can be granted in System Settings, but the app still sometimes fails to reflect the granted state reliably even after refresh/restart guidance
- Remaining Worktree A cleanup before considering this surface final:
  - [ ] fix Accessibility granted-state detection / refresh behavior in the consumer app
  - [ ] verify the new `Grant recommended permissions` flow manually end to end on a clean machine/profile
  - [ ] verify Screen Recording fallback opens the correct System Settings pane on a fresh machine/profile
  - [ ] decide whether consumer onboarding needs an inline accessibility help link/video for MVP
  - [ ] decide whether `Show Dock icon` belongs in default General or should move behind Advanced

### Phase A: Branch convergence (blocking)

- [x] Merge `origin/main` into `consumer`
- [x] Resolve conflicts (runtime/browser behavior follows merged mainline)
- [x] Validate:
  - [x] `pnpm install`
  - [x] `pnpm build`
  - [x] `pnpm openclaw gateway --port 19001 --bind loopback` (after `gateway.mode=local` bootstrap)
- [x] Push updated `consumer`
- [x] Merge updated `origin/consumer` into this worktree branch

Gate to exit Phase A:

- [x] `consumer` no longer materially behind `origin/main` for runtime/browser work

Phase A validation notes (2026-03-16):

- Consumer profile configured: `gateway.mode=local`.
- Gateway probe on isolated runtime passed (`Gateway reachable`) on `19001`.
- `browser --browser-profile openclaw status` passed.
- `browser --browser-profile user status|tabs` failed with `Could not find DevToolsActivePort` (existing-session readiness not satisfied).

### Phase B: Browser spike (week 1, days 1-3)

- [ ] Finalize benchmark matrix in `docs/consumer/browser-spike-results.md`
- [ ] Run approach: `user` existing-session path
  - Control lane verified; task execution now blocked by model auth health, not browser attach.
- [ ] Run approach: `openclaw` managed profile path
  - Control lane verified; task execution now blocked by model auth health, not browser attach.
- [ ] Run approach: Claude-in-Chrome investigation/adaptation
- [ ] Mark Browserbase rows `credential-blocked` until credentials are available
- [ ] Re-run Browserbase rows once credentials are provided
- [ ] Select primary + fallback browser architecture

Gate to exit Phase B:

- [ ] Clear recommendation with evidence
- [ ] Reliability threshold met or explicit fix-loop declared

### Phase C: Consumer loop integration (week 1, days 4-5)

- [ ] Start isolated consumer runtime on port `19001`
- [ ] Confirm Telegram bot responds in isolated runtime
- [ ] Confirm Telegram -> agent -> browser -> Telegram roundtrip
- [ ] Confirm observability with `openclaw logs --follow`
- [ ] Document the consumer runtime root and setup flow in this tracker before PR

Gate to exit Phase C:

- [ ] End-to-end loop works without manual intervention
- [ ] Another engineer can read this tracker and reproduce the consumer setup without guesswork

### Phase D: Killer task hardening (week 1, days 6-7)

- [ ] Implement/test: "Find flights NYC to London in April"
- [ ] Run 3 consecutive attempts
- [ ] Ensure each run is < 3 minutes

Gate to exit Phase D:

- [ ] 3/3 consecutive successful autonomous runs

## Runbook commands

### Consumer runtime baseline

```bash
pnpm install && pnpm build
OPENCLAW_HOME=/tmp/openclaw-consumer \
OPENCLAW_PROFILE=consumer-test \
pnpm openclaw gateway run --port 19001 --bind loopback
```

### Health and probes

```bash
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw channels status --probe
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw logs --follow
```

### Browser verification (post-merge)

```bash
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw browser --browser-profile user status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw browser --browser-profile user tabs
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw browser --browser-profile openclaw status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw browser --browser-profile openclaw start
```

## Benchmark tracker template

| Approach                | Task 1 Flight | Task 2 Form | Task 3 Web Summary | Task 4 X Summary | Task 5 Multi-step | Status             | Notes                                                                                        |
| ----------------------- | ------------- | ----------- | ------------------ | ---------------- | ----------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| user (existing-session) | blocked       | blocked     | blocked            | blocked          | blocked           | blocked            | control lane passes; local agent run works; current blocker is model rate limits/auth health |
| openclaw (managed)      | blocked       | blocked     | blocked            | blocked          | blocked           | blocked            | control lane passes; local agent run works; current blocker is model rate limits/auth health |
| Claude-in-Chrome        | TODO          | TODO        | TODO               | TODO             | TODO              | pending            | feasibility + adaptation                                                                     |
| Browserbase             | blocked       | blocked     | blocked            | blocked          | blocked           | credential-blocked | run after creds                                                                              |

Out of scope:

- Safety profile implementation
- Irreversible confirmation gate implementation
- Billing/licensing
- Onboarding wizard polish
- WhatsApp and managed hosting expansion

## Daily log template

```md
### YYYY-MM-DD

- Done:
- Blocked:
- Evidence links:
- Next 3 actions:
```

## Daily log

### 2026-03-18

- Done:
  - Confirmed `profile=user` and `profile=openclaw` control lanes remain healthy.
  - Confirmed isolated `agent --local` turns now complete and exit cleanly after CLI teardown fixes.
  - Landed consumer runtime isolation helpers, first-run bootstrap defaults, and consumer onboarding copy updates.
  - Split the consumer app autostart launchd label from the gateway launchd label so the two jobs do not collide.
  - Added bundle packaging for the consumer workspace templates so shipped app builds can load the consumer bootstrap ritual directly.
  - Added a guided Telegram setup panel with token verification, BotFather launch, and first-DM allow-list capture.
  - Direct typecheck sanity passed for `ConsumerRuntime.swift`, `ConsumerBootstrap.swift`, `OpenClawPaths.swift`, `ConnectionModeResolver.swift`, `ProcessInfo+OpenClaw.swift`, `TelegramSetupVerifier.swift`, and the guided Telegram setup extension using local stubs.
  - Pinned `openai-codex` auth order per agent to test individual profiles directly.
- Blocked:
  - `openai-codex:default` returns `⚠️ API rate limit reached. Please try again later.`
  - `openai-codex:notblockedamazon` returns `⚠️ API rate limit reached. Please try again later.`
  - Historical isolated logs show lower-priority Codex profiles hitting `refresh_token_reused`.
  - Historical isolated logs show Anthropic fallback surfacing `overloaded`.
  - `swift test --filter ConsumerRuntimeTests` and `swift test --disable-experimental-prebuilts --filter ConsumerRuntimeTests` both fail on this machine because the installed Command Line Tools do not include the Xcode macro plugins required by `swiftui-math`.
- Evidence links:
  - `/tmp/openclaw-profile-default.out`
  - `/tmp/openclaw-profile-default.err`
  - `/tmp/openclaw-profile-nba.out`
  - `/tmp/openclaw-profile-nba.err`
  - `/tmp/openclaw-codex.err`
  - `/tmp/openclaw-agent-local.err`
  - `/tmp/consumer-bootstrap-check.swift`
- Next 3 actions:
  - Keep only the least-bad Codex profiles in isolated auth order so future runs skip known-bad refresh tokens.
  - Update `docs/consumer/browser-spike-results.md` so benchmark state reflects provider-auth blockage rather than browser failure.
    <<<<<<< HEAD
  - # Finish the app build on a machine with Xcode installed, then run the consumer runtime and onboarding E2E.
  - If credentials remain unhealthy, request reauth or a non-Codex API-key-backed model for isolated runtime smoke.
    <<<<<<< HEAD
    =======
    > > > > > > > origin/codex/consumer-openclaw-project

### 2026-03-19

- Done:
  <<<<<<< HEAD
  - Installed full Xcode locally, accepted the license, and unblocked real macOS package/test execution.
  - Focused macOS verification passed:
    - `swift test --filter GatewayEnvironmentTests`
    - `swift test --filter ConsumerRuntimeTests`
    - `swift test --filter OnboardingViewSmokeTests`
    - `swift build -c debug --product OpenClaw`
  - Packaged the mac app successfully with `scripts/package-mac-app.sh`.
  - Verified the packaged app/bootstrap path creates the isolated consumer runtime under `~/Library/Application Support/OpenClaw Consumer/.openclaw`.
  - Verified isolated consumer artifacts exist and are separate from founder state:
    - consumer config at `~/Library/Application Support/OpenClaw Consumer/.openclaw/openclaw.json`
    - consumer workspace at `~/Library/Application Support/OpenClaw Consumer/.openclaw/workspace`
    - consumer logs at `~/Library/Application Support/OpenClaw Consumer/.openclaw/logs`
  - Verified the generated consumer config defaults:
    - `gateway.mode=local`
    - `gateway.bind=loopback`
    - `gateway.port=19001`
    - consumer workspace path under the consumer runtime root
    - curated bundled skill allowlist present
  - Found and fixed an extra launchd-label bug during E2E:
    - the consumer gateway daemon was being installed as `ai.openclaw.consumer`
    - the app now passes an explicit gateway launchd label override
    - the shared daemon install helper now preserves explicit `OPENCLAW_LAUNCHD_LABEL` overrides instead of silently re-deriving from profile
  - Added a focused regression test for the explicit launchd-label override path:
    - `pnpm test -- src/commands/daemon-install-helpers.test.ts`
  - Added consumer-minimal startup mode wiring:
    - mac app bootstrap exports `OPENCLAW_CONSUMER_MINIMAL_STARTUP=1`
    - gateway sidecars now honor that mode so consumer first-run startup is non-blocking and isolated from founder-oriented sidecars
    - channel startup is backgrounded in consumer-minimal mode so gateway liveness does not depend on Telegram connect timing
  - Found and fixed additional packaged-app runtime/bootstrap failures:
    - repo-root inference: packaged app commands now discover the real worktree root and export `OPENCLAW_FORK_ROOT`, avoiding `could not resolve an OpenClaw repo root` failures.
    - stale runtime resolution: command selection now prefers the current worktree `dist/index.js` over a hoisted `node_modules/openclaw` wrapper, which corrected the service version and preserved the custom consumer gateway label.
    - self-kill bug: `PortGuardian` now treats runtime gateway commands as expected listeners instead of terminating the consumer gateway on `19001`.
    - startup race: `GatewayProcessManager` now skips launch-agent ensure work while the gateway is already `.starting`.
  - Added focused regression coverage for the packaged-app fixes:
    - `swift test --filter CommandResolverTests`
    - `swift test --filter PortGuardianTests`
    - `swift test --filter GatewayProcessManagerTests`
    - `swift test --filter GatewayLaunchAgentManagerTests`
  - Verified the stabilized packaged-app consumer gateway with direct machine evidence:
    - `launchctl list` shows `ai.openclaw.consumer.gateway`
    - `launchctl print gui/$(id -u)/ai.openclaw.consumer.gateway` shows the correct plist, `dist/index.js`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and `OPENCLAW_LAUNCHD_LABEL`
    - `lsof -nP -iTCP:19001 -sTCP:LISTEN` shows the consumer gateway listening on loopback
    - consumer `gateway.log` records runtime identity at `~/Library/Application Support/OpenClaw Consumer/.openclaw` with `serviceLabel=ai.openclaw.consumer.gateway`
  - Tightened the consumer bootstrap/runtime follow-through after the first E2E pass exposed stale state:
    - `ConsumerBootstrap` now fills in missing consumer defaults on existing installs instead of only seeding brand-new configs.
    - consumer bootstrap now writes `discovery.mdns.mode=off`, which removes unnecessary local Bonjour advertising from the consumer runtime.
    - `ConfigStore.save` now refreshes the resolved gateway endpoint and shared connection immediately after config writes, so the app does not keep reconnecting with a stale gateway token.
    - `GatewayConnectivityCoordinator` now treats auth changes as endpoint changes and refreshes the control channel when token/password state changes, not only when the URL changes.
  - Added focused regression coverage for the bootstrap/default refresh path:
    - `swift test --filter ConsumerBootstrapTests`
    - `swift test --filter ConfigStoreTests`
  - Verified the live consumer config is updated by the packaged app on launch:
    - `~/Library/Application Support/OpenClaw Consumer/.openclaw/openclaw.json` now includes `discovery.mdns.mode=off`
  - Verified the old failure signatures stopped reproducing after the consumer config/default refresh:
    - no fresh consumer `token_mismatch` reconnect storm after the new packaged app launch
    - no fresh consumer Bonjour/`ciao` conflict lines after `discovery.mdns.mode=off` landed in the live consumer config
- Blocked:
  - Live Telegram onboarding E2E is still not complete.
  - The remaining blocker is now narrower and more specific:
    - the isolated consumer gateway can bind `127.0.0.1:19001`, but it can still wedge before becoming RPC-healthy when launched from the current runtime path.
    - this reproduces both through the consumer LaunchAgent and a direct `node dist/index.js gateway run --bind loopback --port 19001 --force` launch with consumer env.
    - symptom: the process listens on `19001`, but `gateway status --deep --require-rpc` and `channels status --probe` time out or close before a healthy WS/RPC handshake completes.
    - current evidence suggests this is a runtime/startup wedge after bind, not the original stale-token or Bonjour-collision failure.
  - During Telegram validation, other local worktrees can still claim the same tester bot and create `getUpdates` conflicts.
    - `d3b8` was observed doing this during validation and had to be stopped.
    - founder `~/.openclaw` is still isolated from the consumer runtime, but tester-bot contention across worktrees remains an operational footgun for live E2E.
  - Bare CLI `gateway status` still narrates the profile-derived app label unless `OPENCLAW_LAUNCHD_LABEL=ai.openclaw.consumer.gateway` is supplied explicitly; runtime behavior is correct, but this diagnostic path still assumes profile -> label on macOS.
- Evidence links:
  - `~/Library/Application Support/OpenClaw Consumer/.openclaw/openclaw.json`
  - `~/Library/Application Support/OpenClaw Consumer/.openclaw/workspace/BOOTSTRAP.md`
  - `~/Library/Application Support/OpenClaw Consumer/.openclaw/logs/gateway.log`
  - `/tmp/openclaw/openclaw-2026-03-19.log`
  - `~/Library/LaunchAgents/ai.openclaw.consumer.gateway.plist`
- Next 3 actions:
  - Isolate and fix the post-bind consumer gateway wedge on `19001` so RPC health succeeds again.
  - Re-run the packaged mac app + guided Telegram BYOK path after that runtime fix.
  - Decide whether to fix the custom-label CLI status quirk before PR prep or leave it documented for this branch.

### 2026-03-19 verification addendum

- Resolved:
  - Consumer launchd cold-start is green after allowing for real first-start warm-up time.
  - Verified end-to-end daemon health with:
    - launchd label `ai.openclaw.consumer.gateway`
    - listener on `127.0.0.1:19001`
    - `node dist/index.js gateway status --deep --require-rpc`
    - runtime identity now logs `serviceLabel=ai.openclaw.consumer.gateway`
- Important nuance:
  - First cold start can spend extra time building missing Control UI assets.
  - Early probes can therefore fail even though the runtime is healthy a few seconds later.
  - This is a startup-latency issue, not a consumer runtime-isolation failure.
  - Direct terminal proof is strongest via `launchctl print`, `lsof`, and consumer `gateway.log`; `gateway status` is accurate only when the explicit consumer gateway launchd label is supplied in env.

### 2026-03-19 gateway-bisect addendum

- New finding:
  - The remaining consumer E2E blocker is a reproducible high-CPU gateway spin after startup, not a bootstrap/config collision.
  - It reproduces on the isolated consumer runtime even when the gateway is moved to an off-port debug lane (`19123`), so it is not caused by the app or another local client polling `19001`.
  - It also reproduces with no external client connections on the debug port (`lsof` showed only the listening sockets).
- Narrowed shape:
  - The process reaches `listening on ws://127.0.0.1:<port>`.
  - It can also finish the reduced `startGatewaySidecars()` path and log `[startup/sidecars] complete`.
  - It then pegs CPU and never reaches the outer `[startup] sidecars started` log in `src/gateway/server.impl.ts`.
  - `/healthz` and `/readyz` time out while the process stays alive at ~90%+ CPU.
- Reduction results:
  - Reproduced with the real isolated consumer config on `19001`.
  - Reproduced again on `19123` with all of these bypassed:
    - channels
    - cron
    - canvas host
    - browser control server
    - Gmail watcher
    - internal hook loading
    - plugin services
    - memory-backend startup
    - delivery recovery
    - Tailscale exposure
    - session-lock cleanup
  - This means the current startup spin is deeper than the original plugin/hook suspicion and is now isolated to code after the reduced sidecar function returns.
- Temporary debugging seams added to support the bisect:
  - `OPENCLAW_DEBUG_SKIP_TAILSCALE_EXPOSURE`
  - `OPENCLAW_DEBUG_SKIP_SESSION_LOCK_CLEANUP`
  - `OPENCLAW_DEBUG_SKIP_GMAIL_WATCHER_PHASE`
  - `OPENCLAW_DEBUG_SKIP_INTERNAL_HOOK_LOADING`
  - `OPENCLAW_DEBUG_SKIP_PLUGIN_SERVICES`
  - `OPENCLAW_DEBUG_SKIP_MEMORY_BACKEND_STARTUP`
- Evidence links:
  - `/tmp/openclaw-tailscale-hang.sample.txt`
  - `/tmp/openclaw-report-run.log`

### 2026-03-19 startup-order isolation fix

- Fixed:
  - `OpenClawApp` now bootstraps consumer runtime env before any shared singleton is touched.
  - This removed an early-init race where app singletons were resolving founder defaults (`~/.openclaw`, `18789`) before consumer env overrides were applied.
  - `GatewayConnectivityCoordinator.shared.start()` is now invoked after bootstrap, and singleton references in `OpenClawApp` are resolved lazily.
  - Added focused diagnostics for faster future triage:
    - `GatewayProcessManager` now logs startup snapshots (`context`, mode, port, launchd label, profile, config path, state dir, fork root) and appends port-guardian summaries on readiness timeouts.
    - `ControlChannel` now logs endpoint state context when endpoint refresh fails, so failures show `ready|connecting|unavailable` plus the resolved URL/detail.
- Verified:
  - Packaged app was rebuilt with `SKIP_TSC=1 SKIP_UI_BUILD=1 bash scripts/package-mac-app.sh`.
  - Fresh `dist/OpenClaw.app` launch no longer logs new connects to `ws://127.0.0.1:18789`; it targets `ws://127.0.0.1:19001`.
  - With `openclaw.onboardingSeen=true` and local mode set, consumer gateway comes up on `19001` while founder runtime remains on `18789`:
    - `lsof -nP -iTCP:19001 -sTCP:LISTEN` -> consumer gateway listener present
    - `lsof -nP -iTCP:18789 -sTCP:LISTEN` -> founder gateway listener still present
  - Logging patch compiles cleanly:
    - `swift build --package-path apps/macos -c debug --product OpenClaw`
- Notes:
  - This addresses runtime cross-talk and keeps consumer/founder lanes isolated at app startup.
  - A separate node-service command warning (`Did you mean devices?`) still appears in logs and should be handled as a follow-up, but it no longer forces consumer to attach to founder runtime.

### 2026-03-20 PR + consumer onboarding alignment

- Done:
  - Opened draft PR for this branch against `codex/consumer-openclaw-project`:
    - https://github.com/artemgetmann/openclaw/pull/72
  - Merged `codex/worktree-a-minimal` into this branch and resolved conflicts in consumer onboarding/runtime files.
  - Fixed a merge regression in `Onboarding.pageOrder` (remote branch missing `return`).
  - Aligned consumer settings navigation with Telegram onboarding:
    - consumer now keeps `Channels` visible without forcing full Advanced mode
    - normal consumer channel list is Telegram-only; other channels remain behind Advanced
  - Added in-app Telegram setup help entry points:
    - written guide button (docs link)
    - video walkthrough button (default link + override seam)
  - Updated consumer app doc to reflect current tabs and Telegram onboarding behavior.
- Verified:
  - `swift build --package-path apps/macos -c debug --product OpenClaw`
  - `pnpm build`
  - `bash -n scripts/package-mac-app.sh`
- Blocked / pending:
  - Full manual Telegram BYOK E2E as a real novice user flow is still in progress for this PR gate.
- Follow-up note:
  - `macos-app` CI on the fork PR is currently noisy and failing in unrelated `apps/macos/Sources/Clawdis/*` formatting/lint paths rather than the consumer `apps/macos/Sources/OpenClaw/*` files touched in this lane.
  - Treat that lane as separate cleanup work after merging this consumer branch line forward.
- Next 3 actions:
  - Run isolated runtime launch check on `19001` with founder runtime untouched.
  - Walk full in-app Telegram BYOK flow (token verify + first DM capture) and collect logs/evidence.
  - # Update PR #72 checklist and switch from draft only after E2E is green.
  - Proved gateway/browser control works on a clean direct-built runtime rather than the rebuild-prone `pnpm openclaw ...` path.
  - Landed startup-path performance fixes so local runner no longer stalls on trivial prompts (`agent --local ... -> OK`).
  - Verified `profile=openclaw` passes `start`, `status`, `tabs`, and `open https://example.com` on the clean bench gateway.
  - Added Chrome MCP attach diagnostics/timeouts so failures are explicit (no blind 45s gateway timeout).
  - Reproduced `profile=user` failure outside OpenClaw with direct MCP probe (`list_pages` timeout using `chrome-devtools-mcp --autoConnect`).
  - Created `/tmp/openclaw-consumer-bench` as a benchmark-only copy with Telegram disabled and stale `plugins.entries.openai` removed.
- Blocked:
  - `profile=user` existing-session path is still blocked by current Chrome MCP handshake behavior (`autoConnect` call timeout; `--browserUrl http://127.0.0.1:9222` returns `/json/version` 404).
- Evidence links:
  - `/tmp/openclaw-consumer-bench/.openclaw/openclaw.json`
  - `/tmp/openclaw/openclaw-2026-03-19.log`
  - `/tmp/openclaw-stage.log`
  - `/tmp/chrome-mcp-probe.log`
  - `/tmp/chrome-mcp-probe-browserurl.log`
- Next 3 actions:
  - Validate existing-session against a Chrome instance started with explicit CDP flags (`--remote-debugging-port`) and re-run `user` lane control checks.
  - Run phase-B benchmark tasks on `profile=openclaw` immediately while existing-session is being stabilized.
  - Keep benchmark/debug runs on `node dist/entry.js ...` until the rebuild-churn path is out of the picture. > > > > > > > 7e0dacea11 (fix(browser): improve chrome-mcp attach reliability and diagnostics)
    > > > > > > > origin/codex/consumer-openclaw-project
