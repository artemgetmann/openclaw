# Consumer macOS App

The consumer macOS app is the simplified local controller for the OpenClaw consumer product.

## Purpose

- Keep the default experience local-first and beginner-friendly.
- Let the consumer app coexist with the founder app on the same Mac.
- Hide operator-heavy controls behind an **Advanced** toggle instead of exposing everything on day 1.

## Isolation model

The consumer build is a separate app/runtime identity, not a separate repository.

- App identity: separate bundle identifier and app variant metadata
- Default state directory: `~/Library/Application Support/OpenClaw Consumer/.openclaw`
- Named instance state directory: `~/Library/Application Support/OpenClaw Consumer/instances/<instance-id>/.openclaw`
- Legacy fallback: `~/.openclaw-consumer` is still read if it already exists from an older local test setup
- Default local gateway port: `19001`
- Named instance gateway port: deterministic FNV-based offset from the instance id
- Default launch labels: `ai.openclaw.consumer` and `ai.openclaw.consumer.gateway`
- Named instance launch labels: `ai.openclaw.consumer.<instance-id>` and `ai.openclaw.consumer.<instance-id>.gateway`
- Logs: `~/Library/Application Support/OpenClaw Consumer/.openclaw/logs`

This keeps consumer testing from silently reusing the founder runtime.

## Default UX

The consumer app defaults to:

- Local setup on this Mac
- Launch at login enabled by default
- Dock icon visible by default
- Minimal menu bar controls
- Core settings tabs: General, Channels, Permissions, About
- Channels view defaults to Telegram-only in consumer mode
- Remote configuration hidden behind **Advanced**
- Power-user areas such as Skills, Config, Sessions, Cron, and Debug hidden by default

The goal is to reduce cognitive overload without deleting advanced capabilities yet.

## Telegram onboarding in-app

The consumer path keeps Telegram setup inside the app:

- First run stays product-owned: local runtime bootstrap is silent, then the app guides Chrome, AI readiness, core permissions, and Telegram verification on one screen.
- Channels → Telegram includes a one-time BYOK wizard (BotFather -> token verify -> first DM capture).
- The panel includes a placeholder video walkthrough entry that can be rewired later without changing the onboarding flow.
- Runtime writes stay isolated under the consumer runtime root.

To swap the video link without code changes during tests:

- Set `OPENCLAW_CONSUMER_TELEGRAM_VIDEO_URL` before launching the app, or
- Set `OpenClawConsumerTelegramVideoURL` in the app bundle `Info.plist`.

Current default consumer settings shape:

- `General`: active, launch at login, dock icon, advanced toggle, quit
- `Permissions`: a guided recommended-permissions flow plus an optional section for non-core permissions
- `About`: consumer branding, version, website, documentation

Current recommended permission set:

- Screen Recording
- Accessibility
- Notifications
- Automation (AppleScript)
- Microphone
- Location

Optional permission set:

- Camera
- Speech Recognition

## Default bootstrap assets

Consumer workspace bootstrap now seeds the core files the runtime expects from the first run:

- `AGENTS.md`
- `BOOTSTRAP.md`
- `IDENTITY.md`
- `USER.md`
- `MEMORY.md`

`MEMORY.md` is the durable-notes file for long-term preferences and stable user facts. It should exist even before the first task.

## Starter skills reality

Bundled skills are intentionally curated, not universal.

- Shared setup surface:
  - `consumer-setup`
  - consumer-facing skills that need account/config/permission work should
    route setup here instead of embedding large inline setup flows
- Ready now after the normal permissions flow:
  - `summarize`
  - `weather`
  - `peekaboo`
  - `apple-notes`
  - `apple-reminders`
- Available but needs account or app setup:
  - `gog`
  - `goplaces`
  - `himalaya`
- Not part of the clean first-run promise for this MVP:
  - `bear-notes`
  - `camsnap`
  - `canvas`
  - WhatsApp CLI
  - extra Google CLI setup beyond the seeded Google lane
  - manually provisioned founder-only skills
    macOS caveat:

- Accessibility and Screen Recording can remain visually pending until the app restarts, even after the user grants them in System Settings.
- Screen Recording may open System Settings directly instead of showing an in-app prompt.
- The consumer permissions screen should explain this plainly and offer a restart path instead of showing only a stale pending state.
- Current known gap: the Screen Recording fallback behaves as expected, but Accessibility granted-state detection is still not fully reliable in the consumer app and needs follow-up.

## Safe local testing

Package the consumer app with the dedicated wrapper:

```bash
bash scripts/package-consumer-mac-app.sh
```

Verify the packaged app before you open it:

```bash
bash scripts/verify-consumer-mac-app.sh
```

Open the packaged app with the matching preflight:

```bash
bash scripts/open-consumer-mac-app.sh
```

These wrappers fail fast unless the bundle name, bundle identifier, app variant, signing state, and runtime expectations all match the consumer app. That prevents accidentally launching the generic founder/dev shell during consumer testing.

## Reproducible demo checklist

Use this exact path when you want a repeatable consumer demo build instead of a
"works on my machine" shrug:

1. Package the guarded consumer app:

```bash
bash scripts/package-consumer-mac-app.sh
```

2. Re-run the verifier if you want a standalone verdict:

```bash
bash scripts/verify-consumer-mac-app.sh
```

3. Open the guarded bundle:

```bash
bash scripts/open-consumer-mac-app.sh
```

4. Confirm the first-run expectations printed by the verifier:
   - runtime root: `~/Library/Application Support/OpenClaw Consumer`
   - config path: `~/Library/Application Support/OpenClaw Consumer/.openclaw/openclaw.json`
   - workspace path: `~/Library/Application Support/OpenClaw Consumer/.openclaw/workspace`
   - logs path: `~/Library/Application Support/OpenClaw Consumer/.openclaw/logs`
   - gateway port: `19001`
   - launch labels: `ai.openclaw.consumer` and `ai.openclaw.consumer.gateway`

5. If you need to hand the build to another Mac for a demo, zip the `.app`
   without changing its on-disk structure:

```bash
ditto -c -k --sequesterRsrc --keepParent \
  "dist/OpenClaw Consumer.app" \
  "dist/OpenClaw Consumer.zip"
```

6. On the receiving Mac or clean macOS VM:
   - unzip the archive
   - use Finder -> right click -> **Open** on `OpenClaw Consumer.app`
   - if Gatekeeper still blocks the app, that is expected for the current Apple Development-signed demo build

The point of this checklist is clarity: if the verifier passes, the consumer
bundle is assembled correctly. Any remaining friction is launch trust, not
consumer bundle identity.

Default consumer packaging and launch are reserved for the main consumer checkout. Feature worktrees should always use `--instance <id>` so they do not fight over the shared runtime or port.

## Parallel worktree testing

Use named consumer instances when multiple agents or worktrees need to run the
consumer app on one Mac without sharing state.

Package two isolated instances:

```bash
bash scripts/package-consumer-mac-app.sh --instance ux-audit
bash scripts/package-consumer-mac-app.sh --instance agent-a
```

Open them in parallel:

```bash
bash scripts/open-consumer-mac-app.sh --instance ux-audit
bash scripts/open-consumer-mac-app.sh --instance agent-a
```

What changes per instance:

- runtime root under `~/Library/Application Support/OpenClaw Consumer/instances/<instance-id>`
- config, logs, workspace, and app persistence namespace
- gateway port
- launch labels
- packaged debug app name and debug bundle identifier

Use `--replace` only when you want to recycle the same named instance:

```bash
bash scripts/open-consumer-mac-app.sh --instance ux-audit --replace
```

That path targets the matching bundle binary only. It does not broad-kill other
consumer app instances.

## Distribution assumption

Consumer v1 targets signed + notarized direct download distribution.

- Web-based subscriptions and billing are allowed and assumed outside the app.
- Mac App Store distribution is deferred.
- Current product decisions should not be shaped by Mac App Store constraints.
- Current packaging status:
  - the guarded consumer `.app` path is reproducible now
  - raw demo handoff is acceptable with a manual trust/open step
  - broader distribution is still blocked by Developer ID signing plus notarization/stapling

## Future iPhone path

The Mac remains the execution host.

- Telegram is the current primary consumer interface.
- A future iPhone app should act as a companion/controller for the same consumer runtime.
- Consumer UI copy should describe a local AI operator, not hardcode Telegram as the only long-term control surface.
