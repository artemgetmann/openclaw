# Jarvis Public Release Acceleration Spec

## Problem

The public Jarvis release path is correct but too slow and too operator-heavy.
The expensive parts are mostly external Apple and GitHub work, not local code
execution, but repo tooling can still remove serial waste, bad retries, and
manual recovery decisions.

Recent public release measurements:

- Local proof package: about 623 seconds.
- App notarization submit and wait: about 807 seconds.
- DMG notarization submit and wait: about 692 seconds.
- GitHub transient recovery: about 124 seconds.
- Built app size: about 1.7 GB.
- DMG size: about 325 MB.
- ZIP size: about 476 MB.
- Main size source: `Contents/Resources/OpenClawRuntime`, especially bundled
  OpenClaw payload, Node, and `node_modules`.

## Goals

- Make public release recovery one-command resume from existing artifacts,
  receipts, and `dist/jarvis-release-manifest.env`.
- Retry transient GitHub release failures without retrying real auth,
  permission, missing release, wrong tag, or non-latest tag mistakes.
- Parallelize independent phases safely where the release state allows it.
- Write durable timing reports so future release runs can compare real costs.
- Provide a read-only Jarvis app size inventory before any bundle diet work.
- Preserve public release correctness while reducing operator wait and
  decision time.

## Non-Goals

- Do not skip Apple notarization for public releases.
- Do not publish assets in tests.
- Do not upload or publish the Sparkle appcast before every public asset is
  ready and verified.
- Do not remove bundled files or start bundle diet work in the first slice.
- Do not change Sparkle version, build, or latest-release semantics.
- Do not touch `/Applications/Jarvis.app`, launchd, shared runtimes, Telegram,
  or unrelated services.

## Operator Policy

Public release correctness beats speed. The appcast is the public go-live
switch, so appcast upload stays last in any public publish flow.

Final public proof must verify the actual GitHub release assets and the public
Sparkle appcast, not only local files.

## P0: Resume and GitHub Retry

Implementation:

- Add a public release wrapper that inspects `dist/Jarvis.app`,
  `dist/Jarvis.dmg`, `dist/Jarvis.zip`, `dist/jarvis-appcast.xml`, notary
  receipts, and `dist/jarvis-release-manifest.env`.
- Choose the next existing `scripts/package-openclaw-mac-dist.sh --phase`
  automatically.
- Add bounded retry classification around GitHub release view, upload, and
  public verification operations.

Acceptance criteria:

- Missing app selects `full`.
- Existing app without app notary submission selects `submit-app-notarization`.
- Existing app submission selects `poll-app-notarization`.
- Accepted app without accepted DMG selects `submit-dmg-notarization` or
  `poll-dmg-notarization`.
- Accepted app and DMG without ZIP/appcast selects
  `create-local-release-assets-only`.
- Ready local assets select `publish-assets-only` only when publishing is
  explicitly requested.
- Auth, permission, missing release, wrong tag, and non-latest tag failures do
  not retry.

Risks:

- Bad state inference could choose a phase that redoes expensive work.
- Overbroad retry logic could hide a real release configuration mistake.
- Mitigation: parse receipt values read-only, keep package execution in the
  canonical script, and classify only obvious transient failures as retryable.

## P1: Timing and Size Visibility

Implementation:

- Write a durable release timing report under `dist/`.
- Print a compact success or failure summary with phase, status, elapsed time,
  summary path, and timing path.
- Add a read-only size report for Jarvis app/runtime/package bloat.

Acceptance criteria:

- Timing output survives the terminal scrollback.
- Failed wrapper runs still write a summary.
- Size reporting does not delete or mutate bundle contents.
- Size report includes app, runtime, runtime `openclaw`, Node, uv,
  `node_modules`, extensions, skills, templates, DMG, ZIP, and appcast when
  present.

Risks:

- Timing numbers can be misleading if they mix cold and warm lanes.
- Size reports can encourage premature deletion.
- Mitigation: reports are observational only and must be paired with release
  lane context before decisions.

## P2: Safe Phase Parallelism

Implementation direction:

- Create Sparkle ZIP and appcast after app notarization is accepted while DMG
  notarization is still running.
- Keep DMG notarization independent from ZIP/appcast creation when state allows.
- Upload public assets only after app notarization, DMG notarization, ZIP, and
  appcast are all ready.
- Upload appcast last because Sparkle reads the public appcast as the update
  switch.

Acceptance criteria:

- Parallel work never publishes partial public state.
- If one lane fails, rerun can resume from the remaining receipts and artifacts.
- Appcast upload remains last and is explicitly visible in operator output.

Risks:

- Parallel phase orchestration can make state harder to reason about.
- A partial artifact set could look ready if manifest checks are too loose.
- Mitigation: keep parallelism behind explicit state gates and add tests before
  enabling public publish concurrency.

## P3: Bundle Diet After Proof

Implementation direction:

- Use size inventory first, then remove only with compatibility proof.
- Candidate areas include unused bundled extensions, duplicate dist or
  plugin-sdk assets, dev-only TypeScript/types, heavy optional providers, local
  LLM/native dependencies, and architecture duplication if product support
  allows it.

Acceptance criteria:

- Any deletion has proof for Intel support, runtime startup, onboarding
  templates, bundled skills, extension behavior, native modules, signing,
  notarization, Sparkle validation, and first-launch runtime seeding.
- Size deltas are measured before and after.

Risks:

- Bundle diet can create a smaller broken app.
- Removing architecture payloads can silently drop supported Macs.
- Mitigation: no blind removals, no release-lane cleanup, and no diet PR
  without compatibility proof.
