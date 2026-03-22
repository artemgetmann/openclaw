# Consumer Telegram Setup Follow-ups

Last updated: 2026-03-21
Scope: consumer macOS Telegram onboarding polish and adjacent consumer-shell cleanup

## Parked status

Consumer Telegram/UI polish is parked until the main OpenClaw macOS app is healthy enough to act
as the GUI-control/operator lane again.

Keep these fixes, but do not expand consumer scope right now:

- Telegram token verification bug fix
- Telegram capture persistence fix
- launchd stale-worktree detection / reinstall fix
- consumer channel-state fallback / live-state improvements

## Immediate follow-ups

- Fix the stale `General` health pane after the consumer gateway recovers.
  - Current bug: the General tab can still show `Cannot reach gateway at localhost:19001` even while the consumer gateway is healthy and listening.
  - Why it matters: it makes the app look broken even after setup actually succeeded.

- Make `Retry now` trigger local consumer gateway recovery before rerunning health.
  - Current bug: the button can just reprobe a dead listener and keep the stale failure visible.
  - Why it matters: a normal user expects Retry to heal, not to merely confirm the app is still broken.

- Stop the Telegram consumer pane from showing `Checking...` after setup is already saved locally.
  - Current bug: the Telegram BYOK flow can be persisted correctly while the channel list still looks unconfigured if the latest status snapshot is late or missing.
  - Why it matters: this makes a working setup look fake-broken.

## Copy and layout polish

- Add an explicit loading indicator while `Verify token` is in progress.
  - Why it matters: verification currently looks frozen because the buttons gray out but there is no obvious in-progress animation.

- Reduce `Verify token` latency and investigate any long-running verify hang.
  - Current behavior: verification can sit for around a minute or more, which feels broken.
  - Why it matters: token verification should feel near-instant in the normal case.

- Move the threaded-mode recommendation above the power-user groups/topics note.
  - Why it matters: it is a near-default recommendation, not an afterthought.

- Make the threaded-mode recommendation visually stronger than muted gray helper text.
  - Why it matters: it is optional, but important for user experience.

- Tighten or relocate the `Token verified for @...` status text.
  - Why it matters: step 5 already explains what to do next, so the current status line is partly redundant.

- Review whether `Verify token` should auto-open the bot.
  - Why it matters: the current consumer flow is easier to follow when `Open your bot` stays an explicit step-5 action.

- Review the Telegram setup copy once the runtime flow is stable.
  - Why it matters: copy polish is only worth doing after the underlying setup behavior stops lying.

## Consumer app shell follow-ups

- Make clicking the `OpenClaw Consumer` app icon open the settings window directly.
  - Current behavior: the app can activate in the menu bar without surfacing the settings window.
  - Why it matters: this feels broken to normal users.

- Clean up the leftover old `Permissions` internals that still leak into the simplified consumer shell.
  - Why it matters: the shell should not look partially simplified.

- Fix Accessibility granted-state detection in the consumer macOS app.
  - Current behavior: Accessibility can be enabled in System Settings, but the app does not reliably reflect the granted state.
  - Why it matters: this was the main known leftover bug from the consumer-shell pass.

## Notes

- Do not reopen a broad UI redesign while Telegram setup persistence is still being fixed.
- The hard blocker remains: one clean consumer Telegram BYOK flow that persists allowlist state on the isolated consumer runtime.
