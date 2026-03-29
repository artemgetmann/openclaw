# OpenClaw macOS app (dev + signing)

## Quick dev run

```bash
# from repo root
scripts/restart-mac.sh
```

Options:

```bash
scripts/restart-mac.sh --no-sign   # fastest dev; ad-hoc signing (TCC permissions do not stick)
scripts/restart-mac.sh --sign      # force code signing (requires cert)
scripts/restart-mac.sh --app-scope all   # explicitly kill every OpenClaw app process
```

Default scope is `self`, which only restarts the current app bundle and its gateway. Use `--app-scope all` only when you explicitly want to terminate other OpenClaw app instances on the machine.

For linked worktrees, prefer the scoped launchers instead of relying on the shared app restart path:

- `bash scripts/dev-launch-mac.sh`
- `bash scripts/open-consumer-mac-app.sh --instance <id>`
- `pnpm openclaw:local gateway restart`

## Packaging flow

```bash
scripts/package-mac-app.sh
```

Creates `dist/OpenClaw.app` and signs it via `scripts/codesign-mac-app.sh`.

## Consumer build

Use the guarded consumer wrappers instead of hand-setting env vars:

```bash
bash scripts/package-consumer-mac-app.sh
bash scripts/verify-consumer-mac-app.sh
bash scripts/open-consumer-mac-app.sh
```

This consumer flavor defaults to its own runtime identity:

- bundle identifier: `ai.openclaw.consumer.mac.*`
- state dir: `~/Library/Application Support/OpenClaw Consumer/.openclaw`
- local gateway port: `19001`
- launch labels: `ai.openclaw.consumer.*`

If `verify-consumer-mac-app.sh` passes but `spctl` still rejects the app, that
means the bundle assembly is fine and the remaining friction is distribution
trust. Apple Development signing is enough for local/manual-trust demos, but
broader distribution still needs Developer ID + notarization.

## Signing behavior

Auto-selects identity (first match):
1) Developer ID Application
2) Apple Distribution
3) Apple Development
4) first available identity

If none found:
- errors by default
- set `ALLOW_ADHOC_SIGNING=1` or `SIGN_IDENTITY="-"` to ad-hoc sign

## Team ID audit (Sparkle mismatch guard)

After signing, we read the app bundle Team ID and compare every Mach-O inside the app.
If any embedded binary has a different Team ID, signing fails.

Skip the audit:
```bash
SKIP_TEAM_ID_CHECK=1 scripts/package-mac-app.sh
```

## Library validation workaround (dev only)

If Sparkle Team ID mismatch blocks loading (common with Apple Development certs), opt in:

```bash
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh
```

This adds `com.apple.security.cs.disable-library-validation` to app entitlements.
Use for local dev only; keep off for release builds.

## Useful env flags

- `SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"`
- `ALLOW_ADHOC_SIGNING=1` (ad-hoc, TCC permissions do not persist)
- `CODESIGN_TIMESTAMP=off` (offline debug)
- `DISABLE_LIBRARY_VALIDATION=1` (dev-only Sparkle workaround)
- `SKIP_TEAM_ID_CHECK=1` (bypass audit)
