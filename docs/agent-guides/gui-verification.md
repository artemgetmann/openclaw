# GUI verification

Use this when a change has a visual acceptance condition that terminal output
cannot prove by itself.

For OpenComputerUse-backed Jarvis GUI-control benchmark work, use
`docs/agent-guides/gui-control-ocu-stability.md` as the active checklist and
methodology.

## Principle

GUI evidence proves what the operator could see. It does not replace structured
proof such as logs, API calls, transcripts, message IDs, or state files.

Use video when the acceptance question is about sequence, motion, polish, or
feel. Screenshots can prove a final state, but they usually cannot prove whether
the UI felt stable while it changed. For UI/UX regressions, a short recording
should show the user-visible flow from before the action, through the transition,
to the final settled state.

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

Use `openclaw screen record` when the proof needs a short video. Record the
target app or window by default:

```bash
openclaw screen record --app Telegram --duration 60s --out ".artifacts/<run>/review.mp4"
openclaw screen record --bundle com.google.Chrome --duration 90s --out ".artifacts/<run>/review.mp4"
openclaw screen record --window-id <id> --duration 60s --out ".artifacts/<run>/review.mp4"
```

Use full-display recording only when the flow genuinely switches apps or windows
and write the reason into the command:

```bash
openclaw screen record --display 0 --reason "workflow switches between Chrome and Telegram" --duration 60s --out ".artifacts/<run>/review.mp4"
```

Do not send long runs of separate screenshot messages to the user. Prefer
progress text while work is ongoing, then send or offer one compressed final
review video depending on whether the user requested automatic video proof.

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
   Check the macOS lock state through the canonical Application Support unlock
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

5. Start a target-aware native recording:

   ```bash
   openclaw screen record --app Telegram --duration 60s --out ".artifacts/<run>/telegram-preview.mp4"
   ```

   If `openclaw screen record` is unavailable, use native macOS display
   recording as a fallback. Pass `screencapture` video options without spaces
   between the flag and value; some macOS builds treat the spaced form as file
   arguments and produce a tiny non-proof clip:

   ```bash
   screencapture -v -V60 -D1 -k ".artifacts/<run>/telegram-preview.mov"
   ```

6. If native video hangs or does not write a real-duration file, fall back to a
   screenshot loop. This still records actual GUI state and is more storage
   predictable:

   ```bash
   mkdir -p ".artifacts/<run>/frames"
   (
     i=1
     while :; do
       screencapture -x -t jpg ".artifacts/<run>/frames/frame-$(printf '%04d' "$i").jpg"
       i=$((i + 1))
       sleep 1
     done
   ) > ".artifacts/<run>/frame-loop.log" 2>&1 &
   FRAME_LOOP_PID=$!
   ```

   Stop the loop after final text and any expected final voice have arrived:

   ```bash
   kill "$FRAME_LOOP_PID" 2>/dev/null || true
   wait "$FRAME_LOOP_PID" 2>/dev/null || true
   ```

7. Send the benchmark prompt, wait for final delivery, then extract review
   frames or encode the frame loop:

   ```bash
   ffmpeg -hide_banner -loglevel error -i ".artifacts/<run>/telegram-preview.mov" -vf fps=2 ".artifacts/<run>/frame-%03d.png"

   ffmpeg -y -hide_banner -loglevel error \
     -framerate 2 \
     -i ".artifacts/<run>/frames/frame-%04d.jpg" \
     -vf "scale=1280:-2" \
     -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p \
     -movflags +faststart \
     ".artifacts/<run>/telegram-preview-review.mp4"
   ```

8. Always create a compact review copy before sending the artifact to Telegram.
   Keep the raw `.mov` or full frame directory only while auditing the run; after
   the review copy and contact sheet are accepted, delete bulky raw artifacts or
   leave them under `/tmp` so normal cleanup can reclaim them:

   ```bash
   ffmpeg -y -hide_banner -loglevel error \
     -i ".artifacts/<run>/telegram-preview.mov" \
     -vf "scale=1280:-2,fps=24" \
     -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p \
     -movflags +faststart -an \
     ".artifacts/<run>/telegram-preview-review.mp4"

   ffmpeg -y -hide_banner -loglevel error \
     -framerate 1 \
     -i ".artifacts/<run>/frames/frame-%04d.jpg" \
     -vf "select='not(mod(n,5))',scale=360:-1,tile=4x5" \
     -frames:v 1 \
     ".artifacts/<run>/contact-sheet.jpg"
   ```

   If the user wants to review from iPad or mobile, send the compressed
   `*-review.mp4` through the current tester/Jarvis bot and include the nonce,
   trace id, prompt/progress/final/TTS ids, and any caveat in the caption. Do
   not send the raw `.mov` unless the user explicitly asks for full-fidelity
   proof.

9. If Telegram shows a new-message down arrow, click it and capture a final
   still. The video proves the actual GUI run; the still makes the final text
   and voice caption easy to inspect later.

10. Save the matching structured proof beside the video. Include
    `telegram.preview.ledger` lines for the nonce or trace id,
    prompt/progress/final/TTS Telegram message ids, `telegram-user read`
    transcript after cleanup, and isolated runtime status with branch, commit,
    and worktree.

If a macOS security/privacy prompt covers Telegram, classify the run as a GUI
proof gap even when logs and `telegram-user read` prove the message sequence.
Denying a prompt is acceptable only when it is needed to restore the pre-proof
state; never click `Allow` as part of a proof run.

Use `openclaw screen record` as the primary recorder for this proof. Native
`screencapture -v` remains the display-capture fallback. Peekaboo still
screenshots are useful for quick checks, but Peekaboo live capture can produce
black frames even when native stills and video are usable. If you do use
`peekaboo capture live --mode screen --duration <seconds> --video-out <path>
--path <frames-dir> --json`, inspect the contact sheet before trusting it. Do
not use Computer Use unless the local `cua-guard acquire` check passes in the
same process.
