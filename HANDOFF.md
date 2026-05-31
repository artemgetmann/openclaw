# signed-in MCP clone spike handoff

## Summary

Confirmed the architecture hypothesis for the raw browser layer: OpenClaw can control a cloned signed-in Chrome profile through Chrome DevTools MCP by configuring an explicit `existing-session` profile with `cdpUrl` pointing at the clone's debug-port browser URL.

No replacement of the built-in `signed-in` profile was made. The coherent product path is an opt-in `signed-in-mcp` profile first, then decide later whether to migrate the default after booking-flow proof.

## Root Cause Confirmed / Corrected

- Confirmed: the built-in `signed-in` lane is still the managed OpenClaw/CDP cloned-browser path.
- Confirmed: custom `driver: "existing-session"` profiles already use Chrome DevTools MCP.
- Confirmed: an HTTP `cdpUrl` on an `existing-session` profile is mapped to Chrome MCP `--browserUrl`.
- Corrected: docs said not to set `cdpUrl` for `existing-session`, but the code and CLI already support it for exact debug-port targeting.
- Extra finding: `pnpm openclaw:local` inferred a consumer instance from this checkout name and ignored my temporary config. Direct `node openclaw.mjs` plus explicit `OPENCLAW_PROFILE`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`, and `OPENCLAW_GATEWAY_PORT` was the honest isolated proof path.

## Files Changed

- `docs/tools/browser.md`
  - clarifies that `existing-session` can use explicit browser URLs for Chrome MCP `--browserUrl`
  - adds an opt-in `signed-in-mcp` cloned Chrome config example
- `docs/cli/browser.md`
  - updates exact-target example from `founder-live` to `signed-in-mcp`
  - makes clear this does not replace the built-in managed `signed-in` lane
- `HANDOFF.md`
  - this proof record
- `scripts/consumer-auth-sync.sh`
  - defaults consumer tester auth sync to the app-owned Jarvis source under `~/Library/Application Support/OpenClaw/.openclaw`
  - keeps legacy `~/.openclaw` fallback only when the app-owned source is absent
- `scripts/isolated-smoke-runtime-auth.sh`
  - bootstraps isolated smoke auth from the app-owned main auth store
  - prunes the copied auth store to the selected model provider
  - pins the isolated config default model when `--config-path` is provided
  - runs a no-op `models status --probe` before browser/product work

## Runtime / Profile Proof

Worktree and branch:

```text
branch=codex/signed-in-mcp-clone-spike-20260531
head=ddbc7402152a7424ab52abb611578b4b3ba67b70
worktree=/Users/user/Programming_Projects/openclaw/.worktrees/signed-in-mcp-clone-spike-20260531
```

Chrome clone launch:

```bash
bash /Users/user/.agents/skills/codex-chrome-control/scripts/launch-clone.sh \
  --clone-root /tmp/openclaw-signed-in-mcp-clone \
  --port 9337 \
  --refresh \
  --ready-timeout 60
```

Result:

```text
clone_root=/tmp/openclaw-signed-in-mcp-clone
profile=Profile 4
port=9337
log=/tmp/openclaw-signed-in-mcp-clone/chrome.log
status=ready
```

Debug endpoint:

```bash
curl --silent --show-error --fail http://127.0.0.1:9337/json/version
```

Key result:

```json
{
  "Browser": "Chrome/148.0.7778.215",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9337/devtools/browser/266947cc-0bd3-43d5-b741-32deffcd5fc5"
}
```

Temporary profile config used, with the generated gateway auth token omitted:

```json
{
  "gateway": {
    "port": 23937,
    "mode": "local"
  },
  "browser": {
    "enabled": true,
    "profiles": {
      "signed-in-mcp": {
        "driver": "existing-session",
        "attachOnly": true,
        "cdpUrl": "http://127.0.0.1:9337",
        "userDataDir": "/tmp/openclaw-signed-in-mcp-clone",
        "profileDirectory": "Profile 4",
        "color": "#3B82F6"
      }
    }
  }
}
```

Isolated gateway command:

```bash
env -u OPENCLAW_CONSUMER_INSTANCE_ID \
  OPENCLAW_PROFILE=signed-in-mcp \
  OPENCLAW_HOME="$PWD/.openclaw-signed-in-mcp/home" \
  OPENCLAW_STATE_DIR="$PWD/.openclaw-signed-in-mcp/state" \
  OPENCLAW_CONFIG_PATH="$PWD/.openclaw-signed-in-mcp/openclaw.json" \
  OPENCLAW_GATEWAY_PORT=23937 \
  OPENCLAW_STAGE_LOG="$PWD/.openclaw-signed-in-mcp/stage-gateway-profile.log" \
  OPENCLAW_SKIP_CHANNELS=1 \
  CLAWDBOT_SKIP_CHANNELS=1 \
  node openclaw.mjs gateway --port 23937
```

Runtime identity from gateway startup:

```text
[gateway] listening on ws://127.0.0.1:23937, ws://[::1]:23937
[gateway] runtime identity: branch=codex/signed-in-mcp-clone-spike-20260531 worktree=/Users/user/Programming_Projects/openclaw/.worktrees/signed-in-mcp-clone-spike-20260531 stateDir=/Users/user/Programming_Projects/openclaw/.worktrees/signed-in-mcp-clone-spike-20260531/.openclaw-signed-in-mcp/state configPath=/Users/user/Programming_Projects/openclaw/.worktrees/signed-in-mcp-clone-spike-20260531/.openclaw-signed-in-mcp/openclaw.json serviceLabel=ai.openclaw.signed-in-mcp
[browser/server] Browser control listening on http://127.0.0.1:23939/ (auth=token)
```

Gateway status:

```bash
node openclaw.mjs gateway status --deep --require-rpc
```

Key result:

```text
Runtime ID: branch=codex/signed-in-mcp-clone-spike-20260531 worktree=/Users/user/Programming_Projects/openclaw/.worktrees/signed-in-mcp-clone-spike-20260531 stateDir=/Users/user/Programming_Projects/openclaw/.worktrees/signed-in-mcp-clone-spike-20260531/.openclaw-signed-in-mcp/state configPath=/Users/user/Programming_Projects/openclaw/.worktrees/signed-in-mcp-clone-spike-20260531/.openclaw-signed-in-mcp/openclaw.json serviceLabel=LaunchAgent
Gateway: bind=loopback (127.0.0.1), port=23937 (env/config)
RPC probe: ok
Listening: 127.0.0.1:23937
```

## Browser CLI Proof

Status:

```bash
node openclaw.mjs browser --browser-profile signed-in-mcp status
```

Result:

```text
profile: signed-in-mcp
enabled: true
running: true
tabs: 3
transport: chrome-mcp
userDataDir: /tmp/openclaw-signed-in-mcp-clone
profileDirectory: Profile 4
browser: unknown
detectedBrowser: chrome
detectedPath: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
profileColor: #3B82F6
```

Tabs:

```bash
node openclaw.mjs browser --browser-profile signed-in-mcp tabs
```

Result:

```text
1. (untitled)
   https://example.com/
   id: 1
2. (untitled)
   https://example.com/
   id: 2
3. (untitled)
   https://www.batikair.com.my/
   id: 3
```

Open safe page:

```bash
node openclaw.mjs browser --browser-profile signed-in-mcp open 'https://example.com/?signed_in_mcp=1'
```

Result:

```text
opened: https://example.com/?signed_in_mcp=1
id: 4
```

Snapshot:

```bash
node openclaw.mjs browser --browser-profile signed-in-mcp snapshot --format ai
```

Result:

```text
- rootwebarea "Example Domain"
  - heading "Example Domain" [ref=1_1]
  - statictext "This domain is for use in documentation examples without needing permission. Avoid use in operations."
  - link "Learn more" [ref=1_3]
    - statictext "Learn more"
```

Safe act via browser control route:

```bash
curl --silent --show-error --fail \
  -H "Authorization: Bearer <redacted>" \
  -H 'Content-Type: application/json' \
  'http://127.0.0.1:23939/act?profile=signed-in-mcp' \
  --data '{"kind":"wait","text":"Example Domain","timeoutMs":5000}'
```

Result:

```json
{ "ok": true, "targetId": "4" }
```

Chrome MCP attach evidence:

```text
.openclaw-signed-in-mcp/stage-gateway-profile.log:370:2026-05-31T08:13:16.229Z chrome-mcp-attach-mode profile=signed-in-mcp mode=browserUrl url=http://127.0.0.1:9337/
```

Process evidence:

```text
npm exec chrome-devtools-mcp@latest --experimentalStructuredContent --experimental-page-id-routing --browserUrl http://127.0.0.1:9337/
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9337 --user-data-dir=/tmp/openclaw-signed-in-mcp-clone --profile-directory=Profile 4 ...
```

## Validation Commands / Results

Bootstrap:

```bash
pnpm install
pnpm exec vitest --version
```

Result:

```text
vitest/4.1.0 darwin-arm64 node-v25.8.1
```

Build:

```bash
pnpm build
```

Result:

```text
exit 0
```

Targeted tests:

```bash
pnpm test -- src/browser/chrome-mcp.test.ts src/browser/profiles-service.test.ts src/browser/config.test.ts
```

Result:

```text
Test Files  3 passed (3)
Tests  82 passed (82)
Duration  17.23s
```

Docs format:

```bash
pnpm exec oxfmt --check docs/tools/browser.md docs/cli/browser.md
```

Result:

```text
All matched files use the correct format.
```

One invalid command worth preserving:

```bash
pnpm exec vitest run --config vitest.unit.config.ts src/browser/chrome-mcp.test.ts src/browser/profiles-service.test.ts src/browser/config.test.ts
```

Result:

```text
No test files found
exclude: ... src/browser/** ...
```

The repo's unit config excludes `src/browser/**`; `pnpm test -- <paths>` is the correct targeted wrapper here.

## Smoke Proof / Gaps

- Raw Chrome MCP profile proof: done.
- Batik booking smoke through `profile="signed-in-mcp"`: done on 2026-05-31.
- Result: success. The agent reached the payment boundary for OD177 without using the old managed `signed-in` lane.
- Stop boundary: stopped at Batik `/book/payment`; no Pay Now/payment/final charge action was run.

Auth/runtime note:

- The first smoke attempt failed before browser interaction because the isolated copied auth store used an Anthropic env-backed profile and this shell had no `ANTHROPIC_API_KEY`.
- A second attempt using copied OpenAI Codex profiles failed OAuth refresh.
- The successful smoke bootstrapped only the isolated test auth store from `~/.codex/auth.json` via `bootstrapTelegramLiveCodexAuthStore`.
- No global Codex/OpenClaw config was overwritten.
- Follow-up fix: `scripts/isolated-smoke-runtime-auth.sh` now bootstraps future isolated product smokes from the app-owned Jarvis auth store by default, prints non-secret source/target fingerprints, strips raw host OpenAI env for OpenAI Codex probes, and fails before browser work if the selected model cannot complete a no-op probe.

Auth bootstrap proof after follow-up fix:

```bash
bash scripts/isolated-smoke-runtime-auth.sh \
  --state-dir /tmp/openclaw-smoke-auth-test/state \
  --config-path /tmp/openclaw-smoke-auth-test/openclaw.json \
  --model openai-codex/gpt-5.5
```

Result:

```text
smoke_auth_bootstrap=ok
smoke_auth_source=/Users/user/Library/Application Support/OpenClaw/.openclaw/agents/main/agent/auth-profiles.json
smoke_auth_target=/tmp/openclaw-smoke-auth-test/state/agents/main/agent/auth-profiles.json
smoke_auth_provider=openai-codex
smoke_auth_profiles=openai-codex:default
smoke_auth_probe=ok
smoke_auth_probe_command_exit=0
```

Exact booking prompt used:

```text
Use OpenClaw browser profile signed-in-mcp. Do not use Peekaboo, cliclick, raw CDP, direct manual Chrome control, or payment/final purchase. Book a one-way Batik Air flight from Kuala Lumpur KUL to Bali/Denpasar DPS on June 2, 2026. Preferred flight is OD177, 16:30 to 19:40, direct. Choose Value fare / 15kg checked baggage if available. Fill passenger details if needed: ARTEM GETMAN; Male; DOB 17/08/2001; Nationality Ukraine; Email artemnaumenko1@gmail.com; Phone +971 55 285 7036. Skip unnecessary extras like insurance, meals, SMS, or paid seats unless required. Proceed only up to the payment or final confirmation boundary, then stop and ask for confirmation before any charge.
```

Successful agent command:

```bash
env -u OPENCLAW_CONSUMER_INSTANCE_ID \
  OPENCLAW_PROFILE=signed-in-mcp \
  OPENCLAW_HOME="$PWD/.openclaw-signed-in-mcp/home" \
  OPENCLAW_STATE_DIR="$PWD/.openclaw-signed-in-mcp/state" \
  OPENCLAW_CONFIG_PATH="$PWD/.openclaw-signed-in-mcp/openclaw.json" \
  OPENCLAW_GATEWAY_PORT=23937 \
  OPENCLAW_STAGE_LOG="$PWD/.openclaw-signed-in-mcp/stage-agent-batik-codex-auth.log" \
  OPENCLAW_SKIP_CHANNELS=1 \
  CLAWDBOT_SKIP_CHANNELS=1 \
  node openclaw.mjs agent \
    --session-key agent:main:signed-in-mcp-batik-smoke-20260531-codex-auth \
    --message "$PROMPT" \
    --timeout 900 \
    --json
```

Agent result:

```text
runId=68544a40-e8e7-4df2-8e6d-d08982e2c5e5
sessionId=28c39ceb-bdc9-44df-bbe2-54460e332bfe
provider=openai-codex
model=gpt-5.5
durationMs=287378
stopReason=stop
```

Agent-reported booking boundary:

```text
I’ve brought the booking to the payment boundary and stopped before any charge.

Summary:
- Batik Air OD177
- One-way KUL -> DPS
- Tue 2 Jun 2026
- 16:30 -> 19:40, direct
- Fare: Value
- Included checked baggage: 15kg
- Passenger: MR ARTEM GETMAN
- Seat: not selected
- Extras skipped, including SMS
- Amount to be charged: RM 609.00

The page is on “Pay Now”. I have not clicked it.
```

Transcript evidence:

```text
url=https://www.batikair.com.my/book/passenger-details
Passenger Details: MR ARTEM GETMAN
phone country code: United Arab Emirates (+971)
url=https://www.batikair.com.my/book/add-on
url=https://www.batikair.com.my/book/seat-selection
url=https://www.batikair.com.my/book/payment
Depart Flights: Tue, 02 Jun 2026
Batik Air, MY(OD177)
16:30 19:40
Kuala Lumpur (KUL) -> Bali (DPS)
Value
Grand Total / amount boundary: RM 609.00
```

Previous failure point:

- Reached phone/passenger area: yes.
- Reached the prior phone country code failure surface: yes.
- Got past phone country code: yes; transcript showed `United Arab Emirates (+971)`.
- Reached payment boundary: yes.

Fallback check:

- No Peekaboo/cliclick process was found.
- No direct manual Chrome control was used.
- No payment/final purchase action was run.
- The agent used OpenClaw `browser` tool calls routed to `profile="signed-in-mcp"`.
- It did use `browser.act kind=evaluate` for DOM inspection/clicks through the OpenClaw browser tool. That is not Peekaboo/cliclick/manual direct Chrome control, but it is a less product-clean path than pure ARIA clicks and should be documented as MCP-backed DOM evaluation.

Cleanup proof:

```text
lsof -nP -iTCP:23937 -sTCP:LISTEN -> no output
lsof -nP -iTCP:9337 -sTCP:LISTEN -> no output
pgrep -fl 'openclaw.mjs agent|openclaw.mjs gateway --port 23937|chrome-devtools-mcp.*9337|--user-data-dir=/tmp/openclaw-signed-in-mcp-clone|remote-debugging-port=9337|cliclick|peekaboo|Peekaboo' -> no output
```

## Visible TUI Smoke Rerun

Date/time: 2026-05-31 17:29 Asia/Kuala_Lumpur.

Purpose: rerun the controlled Batik smoke in the user's visible `claude` tmux session so the browser/tool path and final payment boundary could be inspected live.

Visible tmux setup:

```text
tmux session/window: claude:5
window name: signed-in-mcp-tui-smoke
gateway pane: claude:5.1
TUI pane: claude:5.2
TUI session: agent:main:signed-in-mcp-tui-visible-medium-20260531
thinking: medium
verbose: on
```

TUI launch command shape:

```bash
env -u OPENCLAW_CONSUMER_INSTANCE_ID \
  OPENCLAW_PROFILE=signed-in-mcp \
  OPENCLAW_HOME="$PWD/.openclaw-signed-in-mcp/home" \
  OPENCLAW_STATE_DIR="$PWD/.openclaw-signed-in-mcp/state" \
  OPENCLAW_CONFIG_PATH="$PWD/.openclaw-signed-in-mcp/openclaw.json" \
  OPENCLAW_GATEWAY_PORT=23937 \
  OPENCLAW_SKIP_CHANNELS=1 \
  CLAWDBOT_SKIP_CHANNELS=1 \
  node openclaw.mjs tui \
    --url ws://127.0.0.1:23937 \
    --token "$TOKEN" \
    --session agent:main:signed-in-mcp-tui-visible-medium-20260531 \
    --deliver \
    --thinking medium \
    --timeout-ms 900000
```

The initial `--thinking medium` flag did not update the persisted TUI status by itself; the visible session was corrected in-place with:

```text
/think medium
/verbose on
```

Because the TUI editor treated normal tmux `Enter` as text/newline in this terminal mode, the commands were submitted using tmux hex carriage return:

```bash
tmux send-keys -t 'claude:5.2' -H 0d
```

Status-line proof before sending the Batik prompt:

```text
agent main | session signed-in-mcp-tui-visible-medium-20260531 | openai-codex/gpt-5.5 | think medium | verbose on | tokens ?/200k
```

MCP attach evidence from the visible run:

```text
Browser start:
profile: signed-in-mcp
driver: existing-session
transport: chrome-mcp
running: true
cdpReady: true
cdpHttp: true
pid: 26473
```

Visible run result:

```text
url=https://www.batikair.com.my/book/payment
Depart Flights: Tue, 02 Jun 2026
Batik Air, MY(OD177)
16:30 19:40
Kuala Lumpur (KUL) -> Bali (DPS)
Value
Passenger: MR ARTEM GETMAN
Amount to be Charged: RM 609.00
Pay Now button visible
```

The visible TUI final answer:

```text
I'm at the payment boundary and have stopped before any charge.

Booking staged:
- Batik Air OD177
- One-way KUL -> DPS
- Tue, 2 Jun 2026
- 16:30 -> 19:40, direct / non-stop
- Fare: Value
- Included: 15kg checked baggage
- Passenger: MR ARTEM GETMAN
- Seat: none selected
- Add-ons: none
- SMS: unchecked / not added
- Amount to be charged: RM 609.00

The page is showing a "Pay Now" button. I have not clicked it.
```

Previous failure point evidence from visible run:

```text
url=https://www.batikair.com.my/book/passenger-details
Country code
AE +971
United Arab Emirates (+971)
url=https://www.batikair.com.my/book/add-on
```

Fallback check for visible run:

- No Peekaboo/cliclick/direct manual Chrome control was used.
- The run used OpenClaw TUI -> gateway -> OpenClaw browser tool -> `profile="signed-in-mcp"`.
- It used `browser.act kind=evaluate` through the OpenClaw browser tool for DOM inspection/clicks, same as the CLI proof.
- No payment/final purchase action was run.

Visible-run stop/cleanup status:

- The TUI run is idle at the payment boundary in `claude:5.2` for user inspection.
- The isolated gateway and cloned Chrome are intentionally still running for the visible demo.
- Cleanup after inspection should stop the TUI with `stop` or Escape, then stop the gateway and Chrome clone, then remove `.openclaw-signed-in-mcp/` and `/tmp/openclaw-signed-in-mcp-clone`.

## Risks

- The cloned profile root in this spike was `/tmp/openclaw-signed-in-mcp-clone`, so it is proof-grade, not durable product storage.
- The first `pnpm openclaw:local` attempt drifted to the checkout-derived consumer instance config. Use direct `node openclaw.mjs` or a proper `.dev-launch.env` for isolated proof.
- `chrome-devtools-mcp@latest` is live-resolved by `npx`, so future behavior can drift. Existing code already uses that convention.
- This does not prove Batik's dropdown/fare flow is better under Chrome MCP; it proves OpenClaw can route a cloned signed-in profile through Chrome MCP cleanly.

## PR / Merge Status

- Branch: `codex/signed-in-mcp-clone-spike-20260531`
- Draft PR: #828 (`https://github.com/artemgetmann/openclaw/pull/828`)
- Merge: not attempted.

## Rollback Notes

- Revert docs changes in `docs/tools/browser.md` and `docs/cli/browser.md`.
- Remove this `HANDOFF.md` if the spike record should not ship.
- Stop any leftover isolated gateway started with `OPENCLAW_PROFILE=signed-in-mcp`.
- Quit the temporary Chrome clone with `--user-data-dir=/tmp/openclaw-signed-in-mcp-clone` if it is still running.
