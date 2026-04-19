# Consumer Signing And Notarization Demo Distribution

Last updated: 2026-04-15
Owner: signing-and-notarization lane
Status: Repo path implemented; Apple credentials still blocking notarized output

## Goal

Make the practical consumer demo-distribution path real:

- package a release-flavored consumer `.app`
- verify the consumer bundle identity
- emit a consumer `.zip` and `.dmg`
- sign the DMG with the same selected identity
- cleanly separate Apple credential blockers from app or packaging failures

This is intentionally not broad release engineering or appcast rollout.

## Repo-side fixes landed

- removed the duplicate `MEMORY.md` declarations/templates in `AgentWorkspace.swift` that broke release packaging
- moved launch-agent enable-action selection behind a non-`DEBUG` helper so release builds no longer call a test-only symbol from `GatewayLaunchAgentManager.swift`
- taught the consumer packaging/verifier scripts to honor an overridden release `BUNDLE_ID` instead of assuming every consumer bundle is `*.debug`
- added `scripts/package-consumer-mac-dist.sh` as the guarded consumer release wrapper for:
  - release app packaging
  - consumer verification
  - zip creation
  - DMG creation
  - DMG signing
  - notarization/stapling when Apple requirements are present
- added `consumer_instance_release_bundle_id()` so consumer release bundles no longer have to piggyback on debug bundle-id logic
- hardened `scripts/create-dmg.sh` so Finder styling timeouts no longer wedge the whole packaging flow; the script now warns and continues with an unstyled-but-valid DMG

## Current product truth

- the repo can now produce a release-flavored consumer `.app`, `.zip`, and `.dmg` from the canonical consumer checkout
- the app bundle verifies cleanly as a universal consumer app when signed with the locally available Apple Development certificate
- Gatekeeper rejection on the app is now clearly separated from bundle assembly failure:
  - `scripts/verify-consumer-mac-app.sh` passes
  - `spctl` rejects because the signing authority is `Apple Development`, not because the bundle is malformed
- the DMG is now created successfully even when Finder automation times out during cosmetic layout styling
- the DMG can be code-signed with the same authority that signed the app, even when that identity was auto-selected instead of explicitly exported as `SIGN_IDENTITY`

## Remaining blockers

The practical blocker for real notarized distribution on this Mac is Apple-side, not app-side:

- only `Apple Development: artem.getman@icloud.com (9642P4S39P)` is installed locally
- no `Developer ID Application` certificate is available
- no notary auth is configured in env:
  - `NOTARYTOOL_PROFILE`
  - `NOTARYTOOL_KEY`
  - `NOTARYTOOL_KEY_ID`
  - `NOTARYTOOL_ISSUER`

The new consumer dist wrapper now fails fast with an explicit certificate error before notarization submission when the bundle is not Developer ID signed.

## Clean-machine expectation

- with the current Apple Development certificate, a clean machine should still expect Gatekeeper friction
- the app bundle is valid and the DMG is valid, but they are not acceptable for seamless first-open distribution without Developer ID + notarization
- local/manual-trust demo path remains:
  - unzip or mount the artifact
  - move the app into `Applications` manually if desired
  - use Finder right click -> `Open`
- seamless direct-download expectation remains blocked until:
  - a `Developer ID Application` cert signs the app/DMG
  - notarization succeeds
  - stapling succeeds

## Verification

- `security find-identity -p codesigning -v`
  - result: only `Apple Development: artem.getman@icloud.com (9642P4S39P)` was available
- environment check:
  - `NOTARYTOOL_PROFILE=unset`
  - `NOTARYTOOL_KEY=unset`
  - `NOTARYTOOL_KEY_ID=unset`
  - `NOTARYTOOL_ISSUER=unset`
  - `SIGN_IDENTITY=unset`
- `swift test --package-path apps/macos --filter AgentWorkspaceTests`
  - passed
- `swift test --package-path apps/macos --filter GatewayLaunchAgentManagerTests`
  - passed
- `OPENCLAW_CONSUMER_INSTANCE_ID=signing-notary SKIP_NOTARIZE=1 SKIP_TSC=1 SKIP_UI_BUILD=1 APP_VERSION=0.0.0-demo bash scripts/package-consumer-mac-dist.sh`
  - now fails fast by design
  - key output:
    - `ERROR: consumer distribution packaging must use the stable default release identity.`
    - `Unset OPENCLAW_CONSUMER_INSTANCE_ID before running scripts/package-consumer-mac-dist.sh.`
    - `Use scripts/package-consumer-mac-app.sh --instance <id> for isolated tester/debug lanes.`
- `SKIP_NOTARIZE=1 SKIP_TSC=1 SKIP_UI_BUILD=1 APP_VERSION=0.0.0-demo bash scripts/package-consumer-mac-dist.sh`
  - this is the guarded release/demo path
  - expected output names:
    - `dist/OpenClaw Consumer.app`
    - `dist/OpenClaw Consumer.zip`
    - `dist/OpenClaw Consumer.dmg`
    - `dist/OpenClaw-0.0.0-demo.dSYM.zip`
  - versioned handoff filenames are opt-in:
    - `VERSIONED_ARTIFACT_NAMES=1`
  - release packaging is intentionally default-instance only so user-facing artifacts do not inherit worktree/lane slugs in bundle identity or runtime support paths
- `codesign -dv --verbose=4 "dist/OpenClaw Consumer.dmg"`
  - result:
    - `Format=disk image`
    - `Authority=Apple Development: artem.getman@icloud.com (9642P4S39P)`
    - `TeamIdentifier=SKDYY4SBVV`
- `/usr/sbin/spctl -a -vv -t open "dist/OpenClaw Consumer.dmg"`
  - result:
    - rejected
    - `source=Insufficient Context`
- `SKIP_TSC=1 SKIP_UI_BUILD=1 APP_VERSION=0.0.0-demo bash scripts/package-consumer-mac-dist.sh`
  - without `SKIP_NOTARIZE=1`, the wrapper still fails fast as designed on this Mac with:
    - `ERROR: notarization requires a Developer ID Application signature.`
    - `Current signing authority: Apple Development: artem.getman@icloud.com (9642P4S39P)`
    - `Use a Developer ID Application certificate, or rerun with SKIP_NOTARIZE=1 for local smoke packaging.`
