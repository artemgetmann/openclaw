# ROOT_CAUSE_BRIEF: MCP-backed cloned signed-in browser lane

## Observed Bug

The Batik booking TUI test used `profile="signed-in"` and controlled a cloned Chrome profile through OpenClaw's managed CDP/Playwright path. The original CDP attach failure improved after PR #826, but a later `chooseOption` timeout on Batik's phone country-code dropdown was surfaced as broad "restart gateway / do not retry browser tool" guidance. The agent then abandoned normal browser tools.

The deeper architecture concern is that Codex can control a cloned Chrome profile reliably through the official Chrome DevTools MCP server, while OpenClaw's default `signed-in` clone is not using that path.

Follow-up auth bug: the first controlled Batik product smoke for `signed-in-mcp` never reached Batik because the ad-hoc isolated runtime was hand-built under `.openclaw-signed-in-mcp/state` without a validated model auth bootstrap from the app-owned Jarvis runtime.

## Expected Behavior

OpenClaw should have a first-class way to control a cloned signed-in Chrome profile through Chrome DevTools MCP, equivalent to Codex clone mode:

- launch a persistent cloned Chrome profile with `--remote-debugging-port`
- attach Chrome DevTools MCP via `--browserUrl http://127.0.0.1:<port>`
- expose it to agents as an explicit OpenClaw browser profile such as `signed-in-mcp`
- prove `status`, `tabs`, `snapshot`, and a simple `act` use Chrome MCP, not Playwright/CDP managed browser helpers

## Evidence

- Official Chrome DevTools for agents supports MCP setup with `chrome-devtools-mcp@latest`.
- Official docs support `--autoConnect` for live Chrome and `--browser-url=http://127.0.0.1:<port>` for a manually launched debug-port Chrome.
- Codex clone skill launches a cloned Chrome with `--remote-debugging-port=9333`, `--user-data-dir=<clone-root>`, and configures `chrome-devtools-mcp` with `--browserUrl http://127.0.0.1:9333`.
- OpenClaw `driver="existing-session"` already uses Chrome DevTools MCP.
- OpenClaw `src/browser/chrome-mcp.ts` maps existing-session `cdpUrl` HTTP URLs to MCP `--browserUrl` and WebSocket URLs to `--wsEndpoint`.
- OpenClaw's default built-in `signed-in` profile is currently `cloneFromUserProfile: true` under the managed `openclaw` driver, so it follows the older Playwright/CDP path.
- The app-owned main auth source exists at `~/Library/Application Support/OpenClaw/.openclaw/agents/main/agent/auth-profiles.json`.
- The failed ad-hoc smoke used an isolated state dir and first lacked usable Anthropic auth, then hit stale OpenAI Codex OAuth refresh, then hit an invalid raw `OPENAI_API_KEY` when switched to plain OpenAI.

## Root Cause

OpenClaw has two competing browser architectures:

1. Managed CDP/Playwright profiles (`openclaw`, current `signed-in`)
2. Chrome DevTools MCP existing-session profiles (`user-live`, custom existing-session profiles)

For cloned signed-in Chrome, architecture 2 is likely the better fit now. The current default `signed-in` lane is still on architecture 1, so OpenClaw ends up maintaining custom browser action helpers that Codex-style Chrome MCP may avoid.

The product-smoke failure was a separate auth bootstrap bug: isolated smoke runtimes are state-isolated by design, but the manual gateway launch did not copy/sanitize/probe auth from the app-owned main Jarvis runtime before starting an agent. It also allowed raw host OpenAI env to hijack the isolated model lane.

## Minimal Spike Plan

1. Do not replace the built-in `signed-in` profile yet.
2. Implement or document the smallest first-class `signed-in-mcp` experiment:
   - persistent clone root
   - dedicated debug port
   - existing-session profile config with `cdpUrl` pointing at clone browser URL
   - explicit profile name so tests can opt in
3. Prove raw browser control first:
   - `status`
   - `tabs`
   - `snapshot`
   - simple safe `act`
4. Prove the logs/outputs show Chrome MCP attach mode (`--browserUrl` / `chrome-devtools-mcp`) instead of managed Playwright/CDP.
5. Only after raw proof, run a controlled Batik smoke through `profile="signed-in-mcp"` and stop before payment.
6. Before any controlled product smoke, run `scripts/isolated-smoke-runtime-auth.sh` against the isolated state/config:
   - default source is the app-owned runtime under `~/Library/Application Support/OpenClaw/.openclaw`
   - target auth store is provider-pruned to the selected model provider
   - raw host OpenAI env is stripped for OpenAI Codex probes
   - `models status --probe` must pass before browser work starts

## Do Not Touch

- Do not overwrite the user's global Codex Chrome MCP config.
- Do not replace the built-in `signed-in` default until proof exists.
- Do not use Peekaboo/cliclick as the fix.
- Do not run a live booking/payment flow without the explicit stop protocol.
- Do not restart or repoint the sacred shared gateway unless explicitly approved.

## Tests / Proof Required

- Unit tests for any profile/config/code changes.
- CLI proof that `signed-in-mcp` attaches to the cloned Chrome through Chrome MCP.
- If live smoke is attempted, record exact commands, profile config, runtime identity, session id, and stop method.

## Execution Mode

Medium fix / architecture spike.

Worker owns implementation, targeted proof, and `HANDOFF.md`. Coordinator reviews proof and decides whether to productize or fall back.
