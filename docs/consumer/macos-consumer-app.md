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
- Logs: `/tmp/openclaw-consumer`

This keeps consumer testing from silently reusing the founder runtime.

## Default UX

The consumer app defaults to:

- Local setup on this Mac
- Minimal menu bar controls
- Core settings tabs: General, Channels, Permissions, About
- Channels view defaults to Telegram-only in consumer mode
- Remote configuration hidden behind **Advanced**
- Power-user areas such as Skills, Config, Sessions, Cron, and Debug hidden by default

The goal is to reduce cognitive overload without deleting advanced capabilities yet.

## Telegram onboarding in-app

The consumer path keeps Telegram setup inside the app:

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
scripts/package-consumer-mac-app.sh
```

Open the packaged app with the matching preflight:

```bash
scripts/open-consumer-mac-app.sh
```

These wrappers fail fast unless the bundle name, bundle identifier, and app variant all match the consumer app. That prevents accidentally launching the generic founder/dev shell during consumer testing.

Default consumer packaging and launch are reserved for the main consumer checkout. Feature worktrees should always use `--instance <id>` so they do not fight over the shared runtime or port.

## Parallel worktree testing

Use named consumer instances when multiple agents or worktrees need to run the
consumer app on one Mac without sharing state.

Package two isolated instances:

```bash
scripts/package-consumer-mac-app.sh --instance ux-audit
scripts/package-consumer-mac-app.sh --instance agent-a
```

Open them in parallel:

```bash
scripts/open-consumer-mac-app.sh --instance ux-audit
scripts/open-consumer-mac-app.sh --instance agent-a
```

What changes per instance:

- runtime root under `~/Library/Application Support/OpenClaw Consumer/instances/<instance-id>`
- config, logs, workspace, and app persistence namespace
- gateway port
- launch labels
- packaged debug app name and debug bundle identifier

Use `--replace` only when you want to recycle the same named instance:

```bash
scripts/open-consumer-mac-app.sh --instance ux-audit --replace
```

That path targets the matching bundle binary only. It does not broad-kill other
consumer app instances.

## Distribution assumption

Consumer v1 targets signed + notarized direct download distribution.

- Web-based subscriptions and billing are allowed and assumed outside the app.
- Mac App Store distribution is deferred.
- Current product decisions should not be shaped by Mac App Store constraints.

## Future iPhone path

The Mac remains the execution host.

- Telegram is the current primary consumer interface.
- A future iPhone app should act as a companion/controller for the same consumer runtime.
- Consumer UI copy should describe a local AI operator, not hardcode Telegram as the only long-term control surface.
