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

### Clean-Scene Preflight

Treat the visible desktop as part of the deliverable before recording:

- Bring the exact review surface to the front and size it for readability.
- Prefer an app or window target so unrelated desktop content and notifications
  cannot enter the capture.
- Close unrelated dialogs, authentication prompts, floating utilities, and
  overlays through observed semantic UI elements. Do not hide them with a crop
  after recording when they cover or distract from the requested flow.
- Wait for transient banners and animations to clear before starting.
- Never enter credentials or dismiss an authentication/security prompt merely
  to clean up a recording; stop and ask the user when that action needs approval.

Take another still screenshot after staging and inspect it. Start recording
only when that exact scene is suitable to send to the user.

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

Save recordings under a run-specific artifact directory. User-facing proof is
MP4/video by default. Keep the raw proof local by default. Send one compressed
review video only when the user asks, when the task explicitly requires video
proof, or when the result would otherwise be hard to verify.

Inspect the final video locally before calling it proof. A created file is only
a capture artifact until you verify it is readable, nonblank, and shows the
target flow. Contact sheets, extracted frames, stills, and thumbnails are
internal/local inspection artifacts unless the user explicitly asks to receive
them.

GIF is not the default proof format. Send a GIF only when the user explicitly
asks for one, or when a channel/tool cannot accept video and you state that
technical reason clearly.

Do not send repeated screenshot messages for long browser or GUI work. Use
progress text while work is ongoing, then offer the final review video when the
recording exists and the user did not explicitly request automatic delivery.

## Local Inspection

Use the `media-editor` skill's proof-inspection recipe before user-facing
delivery: verify metadata with `ffprobe`, check for black intervals with
`ffmpeg` `blackdetect`, and inspect a local contact sheet. Confirm the metadata
matches the intended capture, no unexplained black intervals appear, and the
contact sheet is readable.

If `media-editor` is not available because this install has a custom bundled
skill allowlist, run the minimum inspection inline:

```bash
ffprobe -v error \
  -show_entries format=duration,size \
  -show_entries stream=codec_name,width,height,avg_frame_rate \
  -of json ".artifacts/<run>/review.mp4"

ffmpeg -hide_banner -nostats \
  -i ".artifacts/<run>/review.mp4" \
  -vf blackdetect=d=0.2:pix_th=0.10 \
  -an -f null -

ffmpeg -y -hide_banner -nostats \
  -i ".artifacts/<run>/review.mp4" \
  -vf "fps=1,scale=360:-1,tile=5x1" \
  -frames:v 1 ".artifacts/<run>/review-contact.png"
```

### Final Visual Quality Gate

Before sending the video, inspect the exact final file—not merely the raw
recording or an earlier export:

1. Inspect the contact sheet for the full sequence.
2. Extract and inspect full-resolution frames from the start, the important
   interaction, and the final state. A small contact sheet can hide clipped
   copy, cursor mistakes, unreadable text, or unwanted overlays.
3. Confirm the video starts after setup noise, ends after the result is clearly
   visible, and contains no unrelated notifications, prompts, windows, private
   content, black intervals, or confusing dead time.
4. Confirm the target UI is large enough to review without zooming and that the
   recording demonstrates the requested behavior rather than merely showing
   the app open.

If any check fails, fix the scene, capture, or edit and run the complete
inspection again. Do not send a visibly flawed video with a disclaimer when a
clean re-recording is possible.

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
