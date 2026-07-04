---
name: screen-record
description: Use when a user asks for screen recording, video proof, browser/GUI visual proof, or UI/UX verification that depends on motion, sequence, progress, or feel. Prefer `openclaw screen record` for target-aware recordings of a specific app/window; use full-display recording only with an explicit reason.
metadata:
  {
    "openclaw":
      {
        "emoji": "🎥",
        "displayName": "Screen Record",
        "os": ["darwin"],
        "requires": { "bins": ["openclaw"] },
      },
  }
---

# Screen Record

Use this skill when visual proof needs a short video rather than a static final
state. Typical cases: browser automation proof, Telegram progress/churn proof,
native GUI workflows, onboarding polish, or any UI/UX issue where sequence,
motion, timing, or feel matters.

## Default

### Desktop-Unlocked Preflight

Before any video proof, take a still screenshot and confirm the desktop is
actually visible. A locked Mac can produce black screenshots or black video even
when recording commands appear to succeed.

```bash
mkdir -p ".artifacts/<run>"
screencapture -x ".artifacts/<run>/preflight-screen.png"
```

Inspect the image before starting video. If the screenshot is black, blank, only
shows the lock screen, or does not show the target app/window, stop. Do not
record a video and call it proof.

When the screen appears locked or black:

- Use the `macos-remote-unlock` skill.
- Do not run unlock or GUI lease commands without explicit approval from the
  user in the current conversation.
- After unlock/lease proof reports `locked=false`, take a new preflight
  screenshot and inspect it again before recording.

If Screen Recording permission is missing, fix permission first, relaunch the
target/proof app, then repeat this still-screenshot preflight.

### Recording Target

Record the target app or window, not the whole display:

```bash
openclaw screen record --app Telegram --duration 60s --out ".artifacts/<run>/review.mp4"
openclaw screen record --bundle com.google.Chrome --duration 90s --out ".artifacts/<run>/review.mp4"
openclaw screen record --window-id <id> --duration 60s --out ".artifacts/<run>/review.mp4"
```

Use full-display capture only when the proof genuinely crosses apps or windows:

```bash
openclaw screen record --display 0 --reason "workflow switches between Chrome and Telegram" --duration 60s --out ".artifacts/<run>/review.mp4"
```

## Consumer Mac Live Proof

When proving the recorder through a local Jarvis macOS app, use the canonical
debug proof fixture by default:

- instance: `screen-record-proof`
- bundle id: `ai.openclaw.consumer.mac.debug`
- app path: `dist/Jarvis (screen-record-proof).app`
- required env: `OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY=1`

This fixture is intentionally stable so macOS Screen Recording permission can
be granted once and reused. Do not create a new random instance id for routine
video proof; every new bundle id/path can create another TCC permission target.
Use `/Applications/Jarvis.app` only when the proof specifically needs installed
production-app behavior.

Do not point the app at an isolated gateway with `launchctl setenv` alone; the
consumer app bootstrap owns `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and
`OPENCLAW_GATEWAY_PORT`.

Package and open the proof lane from the repo:

```bash
OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY=1 \
  ALLOW_SINGLE_ARCH_CONSUMER_SMOKE=1 \
  npx -y pnpm@10.23.0 exec bash scripts/package-consumer-mac-app-fast.sh --instance screen-record-proof

OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY=1 \
  npx -y pnpm@10.23.0 exec bash scripts/open-consumer-mac-app.sh --instance screen-record-proof --replace --refresh-gateway
```

Use `OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY=1` for this fixture because the proof
depends on an existing Screen Recording permission row. With `--replace`, the
launcher also terminates other running Jarvis debug apps that share the stable
bundle id so macOS duplicate-instance handling cannot make the proof app exit.

If Screen Recording is missing, open System Settings and grant it to this debug
Jarvis app:

```bash
open 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
```

Then relaunch the fixture with `--replace --refresh-gateway` before retrying.

Before recording, verify the native macOS node is connected and advertises
`screen.record`:

```bash
bash -lc 'source scripts/lib/consumer-instance.sh; consumer_instance_apply_runtime_env screen-record-proof; pnpm openclaw:local nodes status --json'
```

If the macOS app asks to upgrade from operator to node, approve it with
`openclaw devices list` and `openclaw devices approve <request-id>`. Do not use
`openclaw nodes pending` for this case; device repair requests live in the
device pairing queue.

## Artifact Rule

Save recordings under a run-specific artifact directory. Keep the raw proof local
by default. Send one compressed review video only when the user asks, when the
task explicitly requires video proof, or when the result would otherwise be hard
to verify.

Do not send repeated screenshot messages for long browser or GUI work. Use
progress text while work is ongoing, then offer the final review video when the
recording exists and the user did not explicitly request automatic delivery.

## Pair With Structured Proof

Video proves what was visible. It does not prove transport semantics, backend
state, message ids, or irreversible-action boundaries.

For Telegram proof, save the matching message ids, transcript, runtime branch,
commit, and worktree beside the video. For browser proof, save the command,
target profile, URL/page title, and any trace or tool errors beside the video.

## Fallbacks

If `openclaw screen record` cannot target the app/window, use full-display
recording only with a written reason. If native recording is blocked or black,
first treat that as a likely locked-screen, wrong-display, or TCC failure and
rerun the desktop-unlocked preflight. Fall back to a screenshot loop only as
diagnostic evidence, and report the capture gap plainly.

Peekaboo can still be useful for still screenshots, UI maps, diagnostics, or a
fallback capture path. Do not present Peekaboo-only artifacts as proof that the
OpenClaw screen recorder worked.
