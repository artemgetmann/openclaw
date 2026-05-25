# Telegram Managed Onboarding Tracker

Status: handoff tracker created 2026-05-25.

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

## Next Gates

- [ ] Run runtime-backed onboarding smoke with an isolated instance:
      `bash scripts/relaunch-consumer-mac-ui-smoke.sh --instance <id> --with-runtime`.
- [ ] Prove the full first-run path: account activation, AI access, Managed
      Bots approval, first Telegram DM, and assistant reply.
- [ ] Add or verify a lightweight post-DM group setup hint / next page. It must
      cover group setup only; threaded/forum mode stays out of this gate.
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
