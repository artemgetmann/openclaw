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

## First-run path

The default consumer setup path should be:

1. Open the app.
2. Finish the identity/bootstrap prompt.
3. Connect Chrome.
4. Pass AI readiness.
5. Verify the Telegram bot token.
6. Send the bot one direct message.
7. Capture that message and let OpenClaw start the first reply automatically.

Important product rules for this path:

- The browser step is not complete until the real runtime config is written and a browser readiness check passes.
- The AI step is not complete until the bundled default model is actually usable.
- Telegram setup should feel like one continuous setup flow, not "configure now, maybe chat later."

## AI model path

Consumer MVP defaults to a founder-managed shared model path.

- Default behavior: the packaged build tries to use the app-owned shared credential path first.
- Advanced fallback: users can still switch to their own model setup later.
- UX rule: if the shared credential is missing, expired, or rate-limited, the app must say that plainly before setup finishes.

This keeps the first-run path simple for demo users while preserving a BYOK escape hatch.

## Browser readiness outcomes

The browser step should end in one of these explicit states:

- Chrome missing:
  - tell the user to install Google Chrome
- Chrome installed but no profile found:
  - tell the user to open Chrome once, then retry
- Profile selected and readiness passes:
  - browser setup is complete
- Profile selected but readiness fails:
  - clear the stale selection and ask the user to choose again
- Signed-in task later needs login:
  - open the OpenClaw browser and ask the user to log in manually

## Telegram onboarding in-app

The consumer path keeps Telegram setup inside the app:

- Channels → Telegram includes a one-time BYOK wizard (BotFather -> token verify -> first DM capture).
- After the first DM is captured, the consumer runtime should auto-start the first assistant reply instead of waiting for a second user message.
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
  - `bear-notes`
- Not part of the clean first-run promise for this MVP:
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
pnpm consumer:preflight
scripts/open-consumer-mac-app.sh
```

These wrappers fail fast unless the bundle name, bundle identifier, and app variant all match the consumer app. That prevents accidentally launching the generic founder/dev shell during consumer testing.

For the full lane-health checklist, see `docs/consumer/consumer-runtime-preflight.md`.

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

Before opening either app, run preflight for that exact lane:

```bash
OPENCLAW_CONSUMER_INSTANCE_ID=ux-audit pnpm consumer:preflight
OPENCLAW_CONSUMER_INSTANCE_ID=agent-a pnpm consumer:preflight
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

Telegram warning:

- one bot token can only be owned by one active runtime
- preflight will print token collisions before you waste time on `409 getUpdates`

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
