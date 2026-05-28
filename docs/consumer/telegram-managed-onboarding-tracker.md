# Telegram Managed Onboarding Tracker

Status: local proof updated 2026-05-25.

Purpose: keep the remaining Telegram Managed Bots onboarding proof work small
and explicit after the visual copy/layout slice landed.

## Current Truth

- PR #792 simplified the Telegram onboarding states on `main`.
- Managed Bots is the primary path.
- BotFather / BYO token remains collapsed advanced fallback.
- The page stays DM-first. Group setup is not bundled into the first Telegram
  setup page.
- Runtime-not-reachable copy was intentionally left unchanged; if it appears in
  the real consumer flow, that is a proof failure, not normal onboarding copy.
- Local branch `codex/fix-telegram-setup-replay-20260525` now has a runtime
  patch for `channels.telegram.setup-replay`, outbound Telegram activity
  recording, and a post-DM plain group hint page. This is local proof only until
  PR/merge.
- Isolated runtime-backed smoke instance `telegram-managed-fresh-review`
  verified Managed Bots DM setup end to end: created/used
  `@jarvis_a82ae5fb_bot`, sent `Wake up my friend`, received a bot reply, and
  the app reached `Telegram verified` with `Finish` enabled.
- The post-DM group page was verified visually after the Telegram page. It
  covers regular Telegram groups only and does not include threaded/forum setup.
- The verified bot reply is still product-wrong for tester onboarding: the
  isolated workspace still has the default `BOOTSTRAP.md` first-run ritual, so
  Jarvis asks "Who am I? What am I?" instead of behaving like the consumer
  Jarvis persona. Telegram transport is proven, but the seeded workspace/persona
  still needs a product pass before tester packaging.

## Next Gates

- [x] Run runtime-backed onboarding smoke with an isolated instance:
      `bash scripts/relaunch-consumer-mac-ui-smoke.sh --instance <id> --with-runtime`.
- [x] Prove the Managed Bots Telegram path in the isolated runtime: Managed
      Bots approval, first Telegram DM, and assistant reply.
- [x] Add or verify a lightweight post-DM group setup hint / next page. It must
      cover group setup only; threaded/forum mode stays out of this gate.
- [ ] Prove the full first-run path from scratch: account activation, AI access,
      Managed Bots approval, first Telegram DM, and assistant reply.
- [ ] Replace or complete the default workspace bootstrap ritual for consumer
      Jarvis so the first Telegram reply is useful product behavior, not the
      generic "I was just born" identity setup.
- [ ] Click through all onboarding pages from scratch in the real app path.
- [ ] If the full app run passes, recut/package from current `main`.
- [ ] Before sending the package to the waiting testers, run package
      verification and the package secret audit.

## Handoff For Pane 1

Pane 1 should pull current `main`, then continue from the next gate above.

Message:

> Onboarding/account/AI access/Telegram visual UI polish has landed. Relevant
> PRs: #786, #788, #792. Run `git pull` in your worktree, then continue with
> runtime-backed onboarding smoke. After that, verify the group setup hint/page
> exists for plain group setup only, run a full from-scratch app click-through,
> and if it passes proceed toward recut/package verification. Do not treat
> threaded/forum Telegram setup as part of this gate.
