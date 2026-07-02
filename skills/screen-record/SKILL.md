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
fall back to a screenshot loop as diagnostic evidence and report the capture gap.

Peekaboo can still be useful for still screenshots, UI maps, diagnostics, or a
fallback capture path. Do not present Peekaboo-only artifacts as proof that the
OpenClaw screen recorder worked.
