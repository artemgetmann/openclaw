# OpenClaw Consumer Packaging Contract

Consumer macOS packaging must stay safe for both Intel and Apple Silicon Macs.

## Rules

- Normal consumer app packaging is universal: `arm64` + `x86_64`.
- If one architecture is broken, packaging must fail instead of silently shipping a single-arch app.
- Single-arch consumer packaging is allowed only when `ALLOW_SINGLE_ARCH_CONSUMER_SMOKE=1` is set explicitly for local smoke/debug validation.
- That escape hatch is not a shipping mode.

## Expected entrypoints

- `scripts/package-consumer-mac-app.sh` is the normal consumer app packaging entrypoint.
- `scripts/package-consumer-mac-dist.sh` follows the same universal packaging expectation for release-style consumer artifacts.
- Release/demo packaging must run from the canonical consumer home checkout at `~/Programming_Projects/openclaw-consumer`, not from a feature worktree.
- For any human-facing handoff artifact, use `bash scripts/package-consumer-mac-dist.sh` instead of ad hoc zip/DMG commands so bundle identity, seeded defaults, signing, and output naming stay correct.
- For the exact release/demo command, expected outputs, and current notarization warning, see [consumer-packaging-handoff-note.md](./consumer-packaging-handoff-note.md).

## Failure contract

If a consumer package resolves to anything other than universal/all and the smoke escape hatch is not set, the packager fails fast with a blunt error.

That failure is intentional. It prevents agents from thinking a single-arch app is "done" when it would strand half the user base.
