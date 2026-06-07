# GUI verification

Use this when a change has a visual acceptance condition that terminal output
cannot prove by itself.

## Principle

GUI evidence proves what the operator could see. It does not replace structured
proof such as logs, API calls, transcripts, message IDs, or state files.

For transport UI bugs, collect both:

- visual proof: screenshot or video during the behavior and after completion
- structured proof: exact IDs/events showing what was sent, edited, deleted, or
  persisted

## Capture order

1. Create an artifact directory for the run.
2. Capture the precondition state if it matters.
3. Capture the during state while the visual behavior is visible.
4. Capture the after state once the operation completes.
5. Save the matching structured evidence next to the images.

Name artifacts by phase, for example:

- `telegram-during-progress.png`
- `telegram-after-final.png`
- `transcript-after-final.json`
- `runtime-release.txt`

## Preferred tools

Use Computer Use when it can see and control the target app. It is the best
option when the task needs app selection, scrolling, clicking, or visual
inspection.

If Computer Use is unavailable or fails to attach, use macOS screenshot capture
as the fallback:

```bash
screencapture -x .artifacts/<run>/during.png
```

For fast-changing UI, run a short screenshot loop and keep the frame that proves
the behavior:

```bash
for i in 1 2 3 4 5; do
  screencapture -x ".artifacts/<run>/during-$i.png"
  sleep 0.75
done
```

## Telegram-specific rule

Screenshots alone are not enough for Telegram delivery or progress bugs. Pair
them with `telegram-user read` output or logs that identify the exact message
IDs involved.

For transient progress proof, record:

- prompt message ID
- progress message ID
- evidence the same progress message was edited
- evidence that progress message was deleted or disappeared before the final
- final message ID
- after-final transcript showing the final once and no durable progress
- isolated runtime release proof

If GUI capture is unavailable, classify the run as diagnostic only unless the
acceptance criteria explicitly allow structured evidence alone.
