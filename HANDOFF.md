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
- Batik booking smoke through `profile="signed-in-mcp"`: not run.
- Reason: task required raw CLI proof first and no final booking/payment actions. The raw proof already answers the architecture attach question; booking-flow proof should be a separate controlled TUI/agent run with the stop protocol from `/tmp/openclaw-browser-tui-test-workflow.md`.

Exact next smoke command shape:

```bash
env -u OPENCLAW_CONSUMER_INSTANCE_ID \
  OPENCLAW_PROFILE=signed-in-mcp \
  OPENCLAW_HOME="$PWD/.openclaw-signed-in-mcp/home" \
  OPENCLAW_STATE_DIR="$PWD/.openclaw-signed-in-mcp/state" \
  OPENCLAW_CONFIG_PATH="$PWD/.openclaw-signed-in-mcp/openclaw.json" \
  OPENCLAW_GATEWAY_PORT=23937 \
  node openclaw.mjs agent --browser-profile signed-in-mcp "<single-line Batik prompt; stop before payment>"
```

## Risks

- The cloned profile root in this spike was `/tmp/openclaw-signed-in-mcp-clone`, so it is proof-grade, not durable product storage.
- The first `pnpm openclaw:local` attempt drifted to the checkout-derived consumer instance config. Use direct `node openclaw.mjs` or a proper `.dev-launch.env` for isolated proof.
- `chrome-devtools-mcp@latest` is live-resolved by `npx`, so future behavior can drift. Existing code already uses that convention.
- This does not prove Batik's dropdown/fare flow is better under Chrome MCP; it proves OpenClaw can route a cloned signed-in profile through Chrome MCP cleanly.

## PR / Merge Status

- Branch: `codex/signed-in-mcp-clone-spike-20260531`
- Draft PR: not opened yet.
- Merge: not attempted.

## Rollback Notes

- Revert docs changes in `docs/tools/browser.md` and `docs/cli/browser.md`.
- Remove this `HANDOFF.md` if the spike record should not ship.
- Stop any leftover isolated gateway started with `OPENCLAW_PROFILE=signed-in-mcp`.
- Quit the temporary Chrome clone with `--user-data-dir=/tmp/openclaw-signed-in-mcp-clone` if it is still running.
