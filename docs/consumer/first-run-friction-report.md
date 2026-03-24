# Consumer First-Run Friction Report

Last updated: 2026-03-24
Scope: install -> permissions -> browser -> Telegram -> first delegated task

## What blocked first-run users

- Browser setup could say "connected" without configuring the real runtime.
  - The app stored the chosen Chrome profile in app defaults only.
  - The gateway still had no browser profile to clone, so the first browser task could fail after onboarding had already claimed success.
- AI readiness was implicit instead of explicit.
  - The onboarding flow did not check whether the bundled default model was actually usable.
  - A missing, expired, or rate-limited shared credential would surface only after the user tried the first real task.
- Telegram setup still had an unnecessary extra step.
  - The bot token could be verified and the first DM could be captured, but the user still had to send another message before seeing the first real assistant turn.
- Consumer workspace bootstrap looked incomplete.
  - `MEMORY.md` was not created on first run, even though the agent already knows how to use durable memory when the file exists.

## What was fixed

- Browser onboarding now writes the actual consumer runtime config and verifies readiness before marking Chrome as connected.
  - The consumer path now persists a real `browser.profiles.user` cloned-profile config.
  - After profile selection, the app runs a browser readiness check and fails clearly if Chrome is still unusable.
- Onboarding now blocks on AI readiness.
  - The consumer welcome flow checks `openclaw models status --json --check`.
  - Setup finishes only when the default model is actually ready.
  - Failure states now explain whether AI access is missing, unavailable, or expiring.
- Telegram setup now starts the first reply automatically after the first DM is captured.
  - The first captured message is reused to bootstrap the first delegated turn.
  - If the auto-start fails, the user gets a plain fallback instruction instead of silent failure.
- Consumer workspace bootstrap now seeds `MEMORY.md`.
  - Durable notes exist from the first run without extra setup.

## What still hurts

- Shared-model auth is still only as good as the packaged credential path.
  - The onboarding flow now fails clearly, but this does not eliminate the underlying founder-managed key rotation problem yet.
- Telegram still depends on manual BotFather setup.
  - This is acceptable for the first hundred manually onboarded users, but it is still too much friction for wider self-serve adoption.
- Browser readiness is now honest, not fully magical.
  - Chrome still has to be installed.
  - Signed-in tasks still depend on the user being logged into the relevant site inside Chrome.
- Starter skills are seeded, but they are not all equally ready on a clean Mac.
  - Ready now after the core app permissions:
    - `summarize`
    - `weather`
    - `peekaboo`
    - `apple-notes`
    - `apple-reminders`
  - Available but needs account/app setup:
    - `gog`
    - `goplaces`
    - `himalaya`
    - `bear-notes`
  - Not part of the clean default promise for this MVP:
    - WhatsApp CLI
    - generic Google CLI setup beyond the seeded Google lane
    - other founder-only or manually provisioned skills

## Canonical first successful task

- Recommended first Telegram message:
  - `Find the latest price and flight time for New York to London next month and summarize the best public option.`
- Why this is the canonical first task:
  - it proves Telegram -> agent -> browser/public web -> reply
  - it does not require extra third-party account login on minute one
  - it is concrete enough for a non-technical user to judge success quickly
- Expected success shape:
  - the bot replies in the same DM
  - the answer contains at least one concrete route or fare summary
  - if browser access is unavailable, the failure should say exactly what to fix next

## Browser failure matrix

- Chrome missing:
  - app should stop setup and tell the user to install Google Chrome
- Chrome installed but no profile found:
  - app should tell the user to open Chrome once, then retry
- Profile selected but readiness probe fails:
  - app should clear the stale selection and ask the user to choose again
- Signed-in task requires login:
  - app should tell the user to log in manually in the OpenClaw browser window

## What should be next

- Harden the founder-managed model credential path so packaged builds can refresh shared auth cleanly.
- Reduce Telegram setup overhead further with clearer BotFather copy and tighter retry/recovery guidance.
- Add a dedicated starter-skills readiness screen or assistant-guided checklist that distinguishes:
  - ready now
  - available but needs account/app setup
  - intentionally deferred for MVP
- Run and record one fresh packaged-app walkthrough on a clean-ish Mac and keep updating this report from real evidence, not developer memory.
