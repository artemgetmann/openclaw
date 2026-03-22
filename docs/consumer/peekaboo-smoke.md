# Peekaboo Consumer Smoke

This is a minimal native macOS smoke check for **OpenClaw Consumer** using the
`peekaboo` CLI.

Script:

- `scripts/peekaboo-consumer-smoke.sh`

What it verifies:

- `peekaboo` is installed
- Screen Recording and Accessibility are granted
- `OpenClaw Consumer` is running
- Peekaboo can resolve at least one visible consumer app window
- Peekaboo can best-effort capture a screenshot of the consumer app window

What it does **not** verify:

- Clicking through onboarding
- Typing into fields
- Telegram BYOK end-to-end success
- Any flow that should avoid focus stealing on an actively used Mac

Why the scope is narrow:

- Read-only inspection is reliable enough for smoke checks.
- Native macOS interaction [click/type/focus] is much less reliable in the
  background. If the goal is real unattended GUI E2E, use a dedicated VM or
  build a proper XCUITest lane.

Usage:

```bash
scripts/peekaboo-consumer-smoke.sh
```

Optional arguments:

```bash
scripts/peekaboo-consumer-smoke.sh "OpenClaw Consumer" /tmp/peekaboo-consumer-smoke
```

Expected output:

- JSON summary to stdout
- screenshot attempt at `/tmp/peekaboo-consumer-smoke/OpenClaw-Consumer.png`

Interpretation:

- `app.running = true` means the app process was found.
- `window != null` means Peekaboo could resolve a visible app window.
- `screenshot.success = true` means window capture completed.
- `screenshot.timedOut = true` means the app/window was found, but visual capture
  hung long enough that the smoke script cut it off.
