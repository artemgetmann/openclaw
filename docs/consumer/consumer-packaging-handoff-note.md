# Consumer Packaging Handoff Note

Use this note when a human or AI needs to produce the current consumer handoff build without rediscovering the packaging rules.

## Command

Run from the canonical consumer home checkout only:

```bash
cd ~/Programming_Projects/openclaw-consumer
SKIP_NOTARIZE=1 SKIP_DSYM=1 bash scripts/package-consumer-mac-dist.sh
```

Do not run the release/demo packager from a feature worktree.

## Expected outputs

After the command succeeds, the human-facing artifacts should be:

- `dist/OpenClaw Consumer.app`
- `dist/OpenClaw Consumer.zip`
- `dist/OpenClaw Consumer.dmg`

If you explicitly need versioned handoff filenames for archival or release-bucket automation, opt in:

```bash
cd ~/Programming_Projects/openclaw-consumer
VERSIONED_ARTIFACT_NAMES=1 SKIP_NOTARIZE=1 SKIP_DSYM=1 bash scripts/package-consumer-mac-dist.sh
```

That produces:

- `dist/OpenClaw Consumer-<version>.zip`
- `dist/OpenClaw Consumer-<version>.dmg`

## What this command already handles

- universal consumer app packaging for Apple Silicon + Intel
- consumer seeded defaults and bundled API keys from the local packaging env
- strict consumer bundle verification
- clean user-facing zip + DMG naming
- DMG creation and DMG signing

## Still not notarized

This build is still not frictionless internet distribution.

- Current local flow is Apple Development signed.
- That is fine for trusted founder-led installs.
- It is not the same thing as Developer ID + notarization.
- Gatekeeper friction can still happen on a clean Mac.

If someone asks whether this is ready for broad non-technical public install, the honest answer is: not yet.

## Fast sanity check

Before sending the build to someone, confirm:

- `dist/OpenClaw Consumer.app` exists
- `dist/OpenClaw Consumer.zip` exists
- `dist/OpenClaw Consumer.dmg` exists
- the DMG mounts and shows `OpenClaw Consumer.app` plus the `/Applications` shortcut

If the verifier passes but macOS still warns on first open, that is a trust/notarization issue, not a broken consumer bundle.
