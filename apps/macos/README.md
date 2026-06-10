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
- `bash scripts/rebuild-relaunch-consumer-mac-app.sh --instance <id>`
- `pnpm openclaw:local gateway restart`

## Packaging flow

```bash
scripts/package-mac-app.sh
```

Creates `dist/Jarvis.app` for consumer builds or `dist/OpenClaw.app` for
standard builds, then signs it via `scripts/codesign-mac-app.sh`.

## Consumer build

Use the guarded consumer wrappers instead of hand-setting env vars:

```bash
bash scripts/package-consumer-mac-app.sh
bash scripts/verify-consumer-mac-app.sh
bash scripts/open-consumer-mac-app.sh
```

For fast local founder/tester iteration after dependencies and JS assets are
already warm:

```bash
bash scripts/rebuild-relaunch-consumer-mac-app.sh --instance <id>
```

This keeps the final packaged artifact in `dist/`, but skips the repeated
dependency reinstall, JS build, and Control UI build that are usually unrelated
to a native-app relaunch loop.

For onboarding copy/layout GUI proof, use the native UI smoke instead:

```bash
bash scripts/relaunch-consumer-mac-ui-smoke.sh --instance <id>
```

That script builds `apps/macos` with SwiftPM and launches the debug binary from
the current worktree through a tiny debug `.app` wrapper. It does not install
into `/Applications`, does not run release packaging, does not bundle a
DMG/zip/runtime archive/npm tarball/bundled Node, and does not restart the
default gateway. Reserve `rebuild-relaunch` and full packaging for cases where
the release artifact or installer path is the thing being proven.

For the stable side-by-side Jarvis Consumer release-candidate app, use the
dedicated RC wrapper. Both modes preserve `/Applications/Jarvis Consumer.app`,
`ai.openclaw.consumer.mac.consumer-rc`, and the embedded
`jarvis-consumer-rc` instance identity; neither mode touches
`/Applications/Jarvis.app` or the shared `ai.openclaw.gateway` service.

```bash
bash scripts/package-jarvis-consumer-rc.sh --fast
bash scripts/package-jarvis-consumer-rc.sh --fast --reuse-runtime
bash scripts/package-jarvis-consumer-rc.sh --notarize
```

`--fast` is still a full local RC package. Use `--fast --reuse-runtime` (alias:
`--fast --shell-only-fast`) only for smoke-only app-shell iteration after one
normal fast RC package has created the previous signed bundled runtime. That
mode refuses to run when runtime JS, package/lockfile, Node/uv, extension,
skill, template, device-model, or bundled dependency inputs no longer match the
saved runtime manifest.

To remove generated UI-smoke build output without deleting a currently running
smoke app, run:

```bash
bash scripts/relaunch-consumer-mac-ui-smoke.sh --clean
```

For user-facing OpenClaw handoff builds, use the main product distribution
wrapper:

```bash
SKIP_NOTARIZE=1 bash scripts/package-openclaw-mac-dist.sh
```

The older `scripts/package-consumer-mac-dist.sh` command is still supported as a
compatibility wrapper for old automation, but it is no longer the canonical
shipping command.

The wrapper leaves the `.app` bundle in the invoking checkout's `dist/` for
verification, then copies the distributable `.dmg`, `.zip`, and dSYM `.zip`
when present to the main checkout's `dist/consumer-handoff` directory. Override
that handoff path with `OPENCLAW_CONSUMER_DIST_HANDOFF_DIR=/path`, or set it to
`0` to skip the copy.

The user-facing consumer distribution now ships with the visible product name
`Jarvis.app` / `Jarvis.dmg` / `Jarvis.zip` while preserving the existing
consumer bundle id for continuity:

- bundle identifier: `ai.openclaw.consumer.mac`
- executable: `OpenClaw`
- URL scheme: `openclaw-consumer`
- state dir: `~/Library/Application Support/OpenClaw/.openclaw`
- local gateway port: `18789`
- gateway launch label: `ai.openclaw.gateway`
- app icon: `Jarvis.icns` when that approved asset exists, otherwise the
  packaging scripts keep using `OpenClaw.icns` and print a warning

If `verify-consumer-mac-app.sh` passes but `spctl` still rejects the app, that
means the bundle assembly is fine and the remaining friction is distribution
trust. Apple Development signing is enough for local/manual-trust demos, but
broader distribution still needs Developer ID + notarization.

## Consumer production distribution

Production Consumer releases use Developer ID signing, notarization, and
Sparkle with the public Jarvis appcast. Do not point Consumer builds at the
generic upstream OpenClaw appcast.

```bash
# Read-only. Reports missing/present state without printing secret values.
bash scripts/preflight-consumer-mac-release.sh
```

Set release credentials with real values in your local shell, or put non-secret
release settings and secret file pointers in the deterministic local env file:
`~/Library/Application Support/OpenClaw/release.env`. Keep actual notary
credentials in Keychain and private key files outside the repo.

```bash
export SPARKLE_FEED_URL="https://github.com/artemgetmann/openclaw/releases/latest/download/jarvis-appcast.xml"
export SPARKLE_PUBLIC_ED_KEY="<consumer Sparkle public EdDSA key>"
export SPARKLE_PRIVATE_KEY_FILE="$HOME/Library/Application Support/OpenClaw/release/sparkle-consumer-private-key"
export NOTARYTOOL_KEY="<path outside the repo>/AuthKey_<key id>.p8"
export NOTARYTOOL_KEY_ID="<App Store Connect API key id>"
export NOTARYTOOL_ISSUER="<App Store Connect issuer id>"
```

Notary profile setup uses Apple's keychain profile storage:

```bash
xcrun notarytool store-credentials "<keychain notary profile>" \
  --apple-id "<apple-id@example.com>" \
  --team-id "<TEAMID>" \
  --password "<app-specific-password>"
```

If the local Sparkle tools are built, generate a Consumer keypair with:

```bash
apps/macos/.build/artifacts/sparkle/Sparkle/bin/generate_keys
```

Store the generated private key outside the repo, put only the public EdDSA key
in `SPARKLE_PUBLIC_ED_KEY`, and never commit generated key material.

Local smoke packaging can skip Apple trust services and must not publish:

```bash
SKIP_NOTARIZE=1 \
ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE=1 \
ALLOW_SINGLE_ARCH_CONSUMER_SMOKE=1 \
bash scripts/package-consumer-mac-app-fast.sh
```

Strict release verification is explicit so normal smoke checks do not require
Developer ID:

```bash
SPARKLE_EXPECTED_PUBLIC_ED_KEY="$SPARKLE_PUBLIC_ED_KEY" \
bash scripts/verify-consumer-mac-app.sh --release "dist/Jarvis.app"
```

### Sendable Jarvis DMG or app update

If the user asks an agent to "build me a new application", "push an update",
or "make a sendable Jarvis package", this is the canonical lane.

For a real update to existing installations, bump `APP_VERSION` and/or
`APP_BUILD` before packaging. Sparkle updates only when the new
`CFBundleVersion` is higher than the installed app's `CFBundleVersion`; a
same-build upload is just a republish and will not trigger an update.

The script generates `dist/jarvis-appcast.xml`, uploads exactly the Jarvis
assets, verifies the public `releases/latest/download` URLs, parses the public
appcast, and only declares the package sendable after Sparkle is live.

```bash
bash scripts/preflight-consumer-mac-release.sh
gh release view --repo artemgetmann/openclaw --json tagName,url
bash scripts/package-openclaw-mac-dist.sh \
  --publish-release-assets \
  --github-release-tag "<latest-tag-from-gh-release-view>"
```

`--phase` controls where packaging starts. The default is `full`: build, sign,
verify, notarize, package, publish, and verify in one pass. Use the broad
recovery phase only after the app build/sign/verify steps already succeeded and
`dist/Jarvis.app` is still present:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --phase post-app-build \
  --publish-release-assets \
  --github-release-tag "<latest-tag-from-gh-release-view>"
```

`--phase post-app-build` resumes from the existing `dist/Jarvis.app`, then
notarizes and staples the app, creates/signs/notarizes `Jarvis.dmg`, creates
`Jarvis.zip`, generates `jarvis-appcast.xml`, and publishes/verifies release
assets when `--publish-release-assets` is present. Do not use it after changing
source, dependencies, signing inputs, app version/build, Sparkle keys, or bundle
metadata; run the default full phase instead.

For faster failure recovery, prefer the narrow phases once a durable artifact or
notary receipt exists. The script records release state in
`dist/jarvis-release-manifest.env`, app notarization in
`dist/Jarvis.app.notary.env`, and DMG notarization in
`dist/Jarvis.dmg.notary.env`. The manifest is operator metadata only; do not
store credentials there.

Build/package the app once and stop before notarization:

```bash
bash scripts/package-openclaw-mac-dist.sh --phase build-app-only
```

Submit app notarization only from the existing app bundle:

```bash
bash scripts/package-openclaw-mac-dist.sh --phase submit-app-notarization
```

Resume app notary polling from the saved submission:

```bash
bash scripts/package-openclaw-mac-dist.sh --phase poll-app-notarization
```

Submit DMG notarization only after the app poll phase records
`JARVIS_APP_NOTARY_STATUS=Accepted`:

```bash
bash scripts/package-openclaw-mac-dist.sh --phase submit-dmg-notarization
```

Resume DMG notary polling from the saved submission:

```bash
bash scripts/package-openclaw-mac-dist.sh --phase poll-dmg-notarization
```

Publish only from existing `dist/Jarvis.dmg`, `dist/Jarvis.zip`, and
`dist/jarvis-appcast.xml` after the manifest records accepted app and DMG
notarization:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --phase publish-assets-only \
  --publish-release-assets \
  --github-release-tag "<latest-tag-from-gh-release-view>"
```

Verify only against the public GitHub release URLs without uploading:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --phase verify-public-assets-only \
  --github-release-tag "<latest-tag-from-gh-release-view>"
```

For trusted-ring drops where Apple notarization and public GitHub release work
are intentional overkill, use the fast lane. It still builds signed local
artifacts under `dist/`, but forces notarization, dSYM, publish, and public URL
verification off:

```bash
bash scripts/package-openclaw-mac-dist.sh --trusted-ring-fast
```

Required successful ending:

```text
release_sendable=true
sparkle_update_live=true
```

If notarized packaging is run without `--publish-release-assets`, the local DMG
may be useful for debugging, but it is not the sendable release. The script must
print `release_sendable=false` in that mode.

For `HTTPClientError.deadlineExceeded`, Apple queue stalls, or other cases
where submission likely succeeded but waiting timed out, submit and poll as
separate steps instead of rebuilding the app:

```bash
ditto -c -k --sequesterRsrc --keepParent \
  "dist/Jarvis.app" \
  "dist/Jarvis-${APP_VERSION}.notary.zip"

STAPLE_APP_PATH="dist/Jarvis.app" \
bash scripts/notarize-mac-artifact.sh \
  --submit-only \
  --receipt "dist/Jarvis.app.notary.env" \
  "dist/Jarvis-${APP_VERSION}.notary.zip"

source "dist/Jarvis.app.notary.env"
bash scripts/notarize-mac-artifact.sh \
  --poll "$NOTARY_SUBMISSION_ID" \
  --artifact "$NOTARY_ARTIFACT" \
  --staple-app "$NOTARY_STAPLE_APP_PATH"
```

Receipts and logs must not contain secrets. Keep them to the notary submission
ID, artifact path, staple target, status, and timestamps; credentials stay in
Keychain or local env outside the repo.

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
