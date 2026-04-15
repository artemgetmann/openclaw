---
summary: "Gateway runtime on macOS (external launchd service)"
read_when:
  - Packaging OpenClaw.app
  - Debugging the macOS gateway launchd service
  - Installing the gateway CLI for macOS
title: "Gateway on macOS"
---

# Gateway on macOS

There are now two distinct macOS runtime shapes:

- Consumer app:
  - bundles its own Node runtime + `openclaw` payload inside the signed app
  - seeds that bundled helper into the consumer-owned state dir on first run
  - should not require CLT, Homebrew, git, npm, or pnpm on a fresh user Mac
- Standard/operator app:
  - still expects an external `openclaw` CLI install
  - manages a per-user launchd service to keep the Gateway running
  - can attach to an existing local Gateway if one is already running

This page describes the standard/operator external-CLI flow unless noted
otherwise.

## Install the CLI (standard/operator app only)

Node 24 is the default runtime on the Mac. Node 22 LTS, currently `22.16+`, still works for compatibility. Then install `openclaw` globally:

```bash
npm install -g openclaw@<version>
```

The standard/operator macOS app’s **Install CLI** button runs the same flow via
npm/pnpm (bun not recommended for Gateway runtime).

Consumer builds should repair the local helper from the packaged app bundle
instead of sending the user through this flow.

## Launchd (Gateway as LaunchAgent)

Label:

- `ai.openclaw.gateway` (or `ai.openclaw.<profile>`; legacy `com.openclaw.*` may remain)

Plist location (per‑user):

- `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
  (or `~/Library/LaunchAgents/ai.openclaw.<profile>.plist`)

Manager:

- The macOS app owns LaunchAgent install/update in Local mode.
- The CLI can also install it: `openclaw gateway install`.

Behavior:

- “OpenClaw Active” enables/disables the LaunchAgent.
- App quit does **not** stop the gateway (launchd keeps it alive).
- If a Gateway is already running on the configured port, the app attaches to
  it instead of starting a new one.

Logging:

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## Version compatibility

The macOS app checks the gateway version against its own version. If they’re
incompatible, update the global CLI to match the app version.

## Smoke check

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Then:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
