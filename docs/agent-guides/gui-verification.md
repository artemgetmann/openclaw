# GUI verification

Use this when a change has a visual acceptance condition that terminal output
cannot prove by itself.

For OpenComputerUse-backed Jarvis GUI-control benchmark work, use
`docs/agent-guides/gui-control-ocu-stability.md` as the active checklist and
methodology.

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

### Telegram progress preview video proof

Use this flow when the acceptance bar includes progress-bubble churn, final
answer stability, or TTS voice-caption snippets:

1. Create a unique run directory under `.artifacts/` and include the nonce in
   the Telegram prompt.
2. Prove the isolated tester runtime owns the bot before sending anything.
3. Open the actual tester-bot thread before recording. Prefer targeting the
   Telegram app bundle directly so browser URL handlers do not steal the deep
   link:

   ```bash
   open -b ru.keepcoder.Telegram "tg://resolve?domain=<tester-bot-username-without-at>"
   ```

4. If screenshots or recordings are black, do not keep retrying capture tools.
   Check whether another automation owner is currently using the desktop, then
   check the macOS lock state through the canonical Application Support unlock
   script. Only unlock when it reports `locked=true`, then start a short GUI
   lease long enough for the proof run:

   ```bash
   SCRIPT="$HOME/Library/Application Support/OpenClaw/.openclaw/workspace/bin/openclaw-unlock.sh"
   LEASE="$HOME/Library/Application Support/OpenClaw/.openclaw/workspace/bin/openclaw-gui-lease.sh"

   "$SCRIPT" status
   "$LEASE" start 900
   "$LEASE" status
   ```

   A usable lease shows `locked=false`, live lease processes, and
   `PreventUserIdleDisplaySleep 1`. Stop the lease and lock the screen again
   after proof if the run required unlocking.

5. Start a native macOS recording:

   ```bash
   screencapture -v -V 60 -D 1 -k ".artifacts/<run>/telegram-preview.mov"
   ```

6. Send the benchmark prompt, wait for final delivery, then extract review
   frames:

   ```bash
   ffmpeg -hide_banner -loglevel error -i ".artifacts/<run>/telegram-preview.mov" -vf fps=2 ".artifacts/<run>/frame-%03d.png"
   ```

7. If Telegram shows a new-message down arrow, click it and capture a final
   still. The video proves the actual GUI run; the still makes the final text
   and voice caption easy to inspect later.
8. Save the matching structured proof beside the video:
   - `telegram.preview.ledger` lines for the nonce or trace id
   - prompt/progress/final/TTS Telegram message ids
   - `telegram-user read` transcript after cleanup
   - isolated runtime status with branch, commit, and worktree

Use native `screencapture -v` as the primary recorder for this proof. Peekaboo
still screenshots are useful for quick checks, but Peekaboo live capture can
produce black frames even when native stills and video are usable. If you do use
`peekaboo capture live --mode screen --duration <seconds> --video-out <path>
--path <frames-dir> --json`, inspect the contact sheet before trusting it.
Do not use Computer Use unless the local `cua-guard acquire` check passes in the
same process.
