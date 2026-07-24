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

To open one consumer onboarding page directly, pass `--consumer-step`. For
example, this opens the isolated permissions page without replaying the earlier
Chrome step:

```bash
bash scripts/relaunch-consumer-mac-ui-smoke.sh --instance <id> --consumer-step permissions
```

Valid step identifiers are `chrome`, `permissions`, `aiAccess`,
`accountActivation`, `telegram`, and `telegramGroup`. This debug-only override
is for focused UI checks: it starts the consumer setup shell at the requested
page instead of requiring earlier onboarding prerequisites. The smoke lane is
isolated and visual-only by default (`--no-launchd`), so it does not touch the
shared gateway or prove a full onboarding/runtime flow.

That script builds `apps/macos` with SwiftPM and launches the debug binary from
the current worktree through a tiny debug `.app` wrapper. It does not install
into `/Applications`, does not run release packaging, does not bundle a
DMG/zip/runtime archive/npm tarball/bundled Node, and does not restart the
default gateway. Reserve `rebuild-relaunch` and full packaging for cases where
the release artifact or installer path is the thing being proven.

For a focused packaged-app visual proof, keep the same direct-step override,
but launch the verified app from `dist/` instead of replaying all onboarding
pages. Record only after the target app or System Settings pane is frontmost.
Prefer macOS's bounded native capture for a clean static-UI clip:

```bash
screencapture -v -V6 -D1 -x /tmp/jarvis-permissions-proof.mov
```

Before sharing the result, inspect representative full-resolution frames and a
contact sheet, run `ffprobe`, and run FFmpeg `blackdetect`. Crop to the relevant
app/System Settings window when desktop notifications or unrelated windows are
outside the review surface. If a floating `Transcribe` window appears, it is a
Shortcuts overlay rather than Jarvis; close it through an observed accessibility
element before recording instead of hiding it in the final proof.

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

Packaging also writes `OpenClawRuntime/openclaw/skills.manifest.json`, and
`verify-consumer-mac-app.sh` compares consumer-default bundled skill content
hashes against the source checkout. If a skill changes, rerun packaging without
runtime reuse so Jarvis does not ship stale model-facing skill instructions.
Packaging also writes
`OpenClawRuntime/openclaw/capabilities.manifest.json`, which records packaged
skill hashes, managed CLI version expectations, and release-required native
artifacts from skill metadata. A fresh consumer runtime builds the pinned
universal `Open Computer Use.app` declared by `jarvis-computer-use`, places it
under the resolved OpenClaw package root, and preserves its MIT license notice
and source-ref receipt. The source is built in a process-isolated directory
under the standard build-artifact `runs/` bucket, so parallel release jobs
cannot mutate one checkout and interrupted builds remain cleanup-managed.
Cached/reused runtimes and final app verification fail
closed if the app is missing, has the wrong bundle ID/version/ref, lacks either
required architecture, lacks the license, or is not signed in the final app.
Changing the pinned ref, skill declaration, or materializer invalidates the
consumer runtime cache. During
fresh runtime packaging, local installed CLIs such as `gog`, `wacli`, or
`himalaya` are compared against the packaged `recommendedVersion`; if the local
tool is newer, packaging fails so the release cannot accidentally ship stale
consumer dependency expectations. Use
`OPENCLAW_CONSUMER_ALLOW_CAPABILITY_DRIFT=1` only when that drift is intentional
for a local smoke build.

The Google Workspace CLI is app-managed: fresh packages include the official
vendor-signed arm64 and x86_64 payloads under `openclaw/tools/gog`, and gateway
startup copies the host architecture into Jarvis-owned state when the managed
copy is missing, older, or differs from the same-version packaged binary. The
architecture slices remain separate because combining or re-signing them would
change the code identity macOS Keychain token ACLs expect. Packaging and final
app verification fail closed unless both binaries have the reviewed Gog
identifier, Team ID, architecture, and valid signature. This gives clean
installs and app updates the same pinned CLI without mutating Homebrew or
Keychain. Its MIT license notice ships beside the binaries as
`openclaw/tools/gog.LICENSE`. Heavier optional tools such as `summarize` remain
package-manager-managed; their recommended versions are visible in skill
status, but Jarvis does not silently install or upgrade their global
dependencies.

To remove generated UI-smoke build output without deleting a currently running
smoke app, run:

```bash
bash scripts/relaunch-consumer-mac-ui-smoke.sh --clean
```

For user-facing OpenClaw handoff builds, use the main product distribution
wrapper from the blessed release lane:

```bash
cd /Users/user/Programming_Projects/openclaw
bash scripts/jarvis-release-worktree.sh
cd /Users/user/Programming_Projects/openclaw/.worktrees/jarvis-release-current
SKIP_NOTARIZE=1 bash scripts/package-openclaw-mac-dist.sh \
  --release-intent "<id-from-authorize>"
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
`Jarvis.app` / `Jarvis.dmg` / `Jarvis.zip` and the broad-public Jarvis bundle
identity. Broad-public defaults use Jarvis-owned runtime state and gateway
labels; trusted-tester/debug lanes keep their isolated OpenClaw-shaped
identities:

- bundle identifier: `ai.jarvis.mac`
- executable: `OpenClaw`
- URL scheme: `openclaw-consumer`
- state dir: `~/Library/Application Support/Jarvis/.jarvis`
- local gateway port: `18789`
- gateway launch label: `ai.jarvis.gateway`
- app icon: `Jarvis.icns` when that approved asset exists, otherwise the
  packaging scripts keep using `OpenClaw.icns` and print a warning

## Jarvis CLI dogfooding

For release dogfooding, ambient `openclaw` should resolve to the app-managed
Jarvis runtime, not a source checkout that happens to be earlier in a developer
shell startup file. The managed CLI lives here after the packaged app has
seeded its runtime:

```bash
JARVIS_CLI_BIN="$HOME/Library/Application Support/Jarvis/.jarvis/bin"
test -x "$JARVIS_CLI_BIN/openclaw"
export PATH="$JARVIS_CLI_BIN:$PATH"
command -v openclaw
openclaw --version
```

Use source checkout commands only when you mean to test repo code:

```bash
pnpm openclaw:local --version
pnpm openclaw --version
./openclaw.mjs --version
```

When the gateway is already running with Jarvis state
(`~/Library/Application Support/Jarvis/.jarvis/openclaw.json`), host exec
commands preserve the app-managed CLI ahead of login-shell paths. That keeps
agent-run `openclaw ...` checks on the same runtime a real Jarvis user has,
while checkout-local commands remain explicit.

If `verify-consumer-mac-app.sh` passes but `spctl` still rejects the app, that
means the bundle assembly is fine and the remaining friction is distribution
trust. Apple Development signing is enough for local/manual-trust demos, but
broader distribution still needs Developer ID + notarization.

## Consumer production distribution

Production Consumer releases use Developer ID signing, notarization, and
Sparkle with the public Jarvis appcast. Do not point Consumer builds at the
generic upstream OpenClaw appcast. A release package should verify as
`CFBundleIdentifier=ai.jarvis.mac`; older trusted-tester packages used
`ai.openclaw.consumer.mac`.

This is the public app-release lane, not the default post-merge runtime ship
lane. For normal hotfix validation, follow the fast runtime/app-support split in
`docs/agent-guides/runtime-ops.md` instead of rebuilding, notarizing, or
publishing app artifacts.

Do not open an immediate signed/notarized release task after every merged
runtime fix. The normal policy is to batch several merged, verified fixes into
the next planned Jarvis release while a protected break-glass runtime retains
clear provenance and a bounded, tracked package follow-up. Release immediately
only when protection is absent or failing, an older package can overwrite the
fix, users need the fix now, security/compatibility/migration/release-critical
risk makes waiting unsafe, or the owner explicitly asks. Protection lowers
downgrade risk but cannot cover manual removal, state resets, or every unusual
or older reinstall path. See
`docs/agent-guides/runtime-ops.md` ("Hotfix follow-up and release timing") for
the full decision rule. Until a trigger changes, report packaging as deferred
or batched rather than repeatedly urgent; this saves time, tokens, and build
cycles without hiding the remaining safety risk.

Run the read-only disk gate before starting a release package. By default it
checks both repo `dist/` output and build-artifact `runs/` staging, requires 25
GiB free on each unique filesystem, and prints target resolution plus the
required, free, and shortfall capacity. Targets sharing a filesystem are
deduplicated. A low-space or unresolved target is a hard stop before packaging:

```bash
bash scripts/preflight-jarvis-release-disk.sh
```

`package-openclaw-mac-dist.sh` invokes the same multi-target gate automatically
for phases that build an app, notary upload, DMG, ZIP, or appcast. It runs after
the lock, intent, checkpoint, prewarm, and clean-tree gates, then revalidates
intent both immediately before and after checking capacity. The post-probe
validation closes intent-replacement races before the first packaging mutation.
Pure poll, publish, and verify phases do not create heavy local artifacts and
skip this capacity gate.

Both automatic targets are reported verbatim: `release-output` is the repo's
actual `dist/` directory, while `release-staging` is either the exact explicit
`OPENCLAW_RELEASE_ARTIFACT_RUN_ROOT` or the build-artifact `runs/` parent where
the package creates its unique run. The capacity check resolves these paths
read-only and does not create staging first. Do not replace this with a
repo-root-only check: that recreates the cross-volume blind spot.

If old failed staging is consuming space, report it first, then apply the same
conservative policy explicitly:

```bash
bash scripts/cleanup-build-artifacts.sh --build-cache
bash scripts/cleanup-build-artifacts.sh --build-cache --apply
```

Cleanup keeps the newest Jarvis release/Sparkle staging run, skips live or
explicitly protected runs, and reports owner/mode for permission-protected
entries instead of changing permissions. It never scans installed apps,
`/Applications`, user config/runtime state, or resumable/final `dist/`
artifacts and receipts.

```bash
# Read-only. Reports missing/present state without printing secret values.
# --host-context explicitly asserts this is an ordinary, unsandboxed Terminal.
bash scripts/preflight-consumer-mac-release.sh --host-context
```

Release signature and Keychain conclusions require a valid Apple control sample
in the same execution context. If the preflight or verifier reports
`INDETERMINATE`, do not reject the artifact or recommend reboot, trust-service
restart, or Keychain repair. Run the read-only control probe from an ordinary
macOS Terminal outside Codex/container/process sandboxes, then rerun the
original verification from that same Terminal:

```bash
bash scripts/probe-macos-host-trust.sh
```

The probe verifies `/bin/ls`, a macOS-owned signed binary. A failed control
means the current process cannot distinguish sandbox-limited trust output from
a host problem; it is not evidence of machine-wide trust corruption. Keychain
visibility cannot be inferred from codesign, so the credential preflight also
requires the explicit `--host-context` assertion. Gatekeeper uses its own
macOS-owned Finder control before any app rejection becomes definitive.

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

The App Store Connect API-key triplet above is the canonical notarization lane.
`NOTARYTOOL_PROFILE` is an optional, secondary Keychain fallback. The preflight
checks it independently: `present-not-working` is a warning when the primary
ASC lane is ready, not a release blocker and not evidence that notarization
will use the stale profile. The notarization helper prefers the complete ASC
triplet whenever both lanes are configured.

Only create or repair a fallback profile when an operator separately decides
that redundancy is worth maintaining. That machine-local action uses Apple's
Keychain profile storage and is not part of repository setup:

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

Use one path:

1. Enter the persistent release lane.
2. Run the read-only dry-run.
3. Authorize the exact future command, including its execution-shaping flags.
4. Run the printed `persistent_command` in the durable tmux transport.
5. Inspect status or scrollback without treating tmux as release authority.
6. Recover only through the wrapper's printed `recovery_command`.
7. Publish only with an explicit publish flag and latest GitHub release tag.

Start with the persistent Jarvis release worktree launcher:

```bash
bash scripts/jarvis-release-worktree.sh
```

Use `.worktrees/jarvis-release-current` for the macOS release/update/package,
appcast, and notarization work. Do not create an ad-hoc cold worktree for this
lane; repeated cold bootstraps are slow and make retry evidence noisy. The
release package scripts now enforce this path and branch before doing package,
notary, publish, or verify work.
Follow the launcher's printed next steps, then run the release commands from the
release lane.

Mutating release phases also acquire one fail-fast, user-scoped machine lock
shared by every clone and worktree. If a live owner holds it, use an explicit
chat/session handoff and let that owner finish or exit. Never improvise a `ps`-scanning
`SIGSTOP`/`SIGKILL` guard: the canonical lock reports owner PID/context,
safely reclaims dead owners, and never signals a process. The wrapper's true
read-only path, `jarvis-public-release.sh --dry-run`, exits before delegated
package work and does not acquire the lock. Real wrapper runs acquire before
inspecting release state, then atomically transfer verified ownership to the
package child so phase selection and execution cannot race or lose protection
if the wrapper exits first.

Normal app-building release phases require the blessed release worktree plus
macOS prewarm proof. If the lane is missing or stale, refresh it through the
launcher:

```bash
cd /Users/user/Programming_Projects/openclaw
bash scripts/jarvis-release-worktree.sh
```

`ALLOW_COLD_RELEASE_LANE=1` is only an emergency override for the macOS prewarm
proof inside the blessed release worktree. It does not allow public Jarvis
packaging from random worktrees.

For a real update to existing installations, keep `APP_VERSION` at least as
high as the installed app's marketing version and bump `APP_BUILD`. The release
gate requires `CFBundleShortVersionString` to stay equal or increase and
`CFBundleVersion` to increase strictly. This prevents a higher build number
from installing an app whose About screen visibly regresses to an older version.
For the same CalVer base, release order is `alpha.N`, `beta.N`, stable, then
legacy numeric corrections such as `-1` and `-2`.

The historical public release acceleration spec is archived at
`docs/consumer/archive/jarvis-public-release-acceleration-spec.md`. The
implemented release wrapper, package script, and printed receipt checks are the
current source of truth.

The script generates `dist/jarvis-appcast.xml`, uploads exactly the requested
Jarvis assets, verifies the public `releases/latest/download` URLs, and parses
the public appcast. Keep the two public truths separate:

- `sparkle_update_live=true` means existing Jarvis users can update through
  Sparkle from the public appcast and `Jarvis.zip`.
- `release_sendable=true` means the full public package is live, including the
  notarized `Jarvis.dmg` fresh-install/sendable installer.

#### Local Proof

Do not run the full distribution lane when the question is "does this Jarvis app
build verify locally?" Prove the signed app bundle first:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --local-proof \
  --release-intent "<id-from-authorize>"
```

This builds `dist/Jarvis.app`, runs `verify-consumer-mac-app.sh` against the
stable release identity, verifies the bundled runtime `package.json` version
matches the app version, verifies bundled skill content hashes, writes
`dist/jarvis-release-manifest.env`, writes the app build receipt, and stops. It
does not create `Jarvis.dmg`, `Jarvis.zip`, or `jarvis-appcast.xml`; it also
does not notarize, publish GitHub assets, install or launch the app, touch
launchd, or change the shared gateway runtime. Use this when the question is
"does this Jarvis app build verify locally?" instead of
"is this public distribution artifact sendable?"

#### Prepare or Resume Artifacts

For normal operator recovery, use the public release wrapper instead of choosing
the phase by hand. Put every known future execution flag on `--authorize`; the
authorization validates those flags without resolving GitHub state or
inspecting/mutating release artifacts, then echoes them into one exact direct
`next_command` and one exact durable `persistent_command`:

```bash
bash scripts/jarvis-public-release.sh --dry-run
bash scripts/jarvis-public-release.sh \
  --authorize \
  --parallel-safe-local-assets \
  --latest-release-tag
# Run the exact persistent_command printed by --authorize.
```

`--dry-run` is strictly read-only: it does not acquire the release lock or
create an authorization. `--authorize` requires clean tracked state, then
creates one expiring release intent bound to the current commit and a stable
fingerprint of the index and tracked working tree. Plain `--authorize` remains
compatible and prints the direct wrapper command. Future flags such as
`--latest-release-tag`, `--github-release-tag <tag>`,
`--publish-release-assets`, `--verify-public-assets`, `--urgent-sparkle`,
`--parallel-safe-local-assets`, `--size-report`, and a supported `--phase` are
inert during authorization and are shell-quoted into both printed commands.
When future flags are present, the intent stores a SHA-256 fingerprint of that
exact wrapper action, including the effective GitHub destination repository.
Changing verify to publish, changing a tag, phase, or repository, or otherwise
reshaping the printed command fails before lock acquisition or release-state
mutation. The wrapper loads one release configuration snapshot and the package
child inherits it, so a later package `release.env` load cannot redirect the
authorized destination. A bound intent also fails when passed directly to the
package script without the matching wrapper context; the wrapper remains the
single authority that selects and delegates the package phase. Delegated
package failures therefore recover through the original wrapper action, never
through a direct package command. If recovery must remove a forced phase or
replace `--latest-release-tag` with a resolved tag, it prints `--authorize`
because that adjusted action requires a fresh lease.
Likewise, when a bound action reaches ready local assets without public action,
its `next_publish_command` is fresh `--authorize`; adding publish flags cannot
reuse the narrower intent.
Conflicting publish/verify or latest/explicit-tag intent fails before an intent
is created or replaced. The
default lease is two hours, sized above the observed end-to-end release time;
use `--intent-ttl-seconds <1-14400>` only when the operator deliberately needs a
different window. Expiry is a backstop, while creating a newer intent remains
the primary cancellation mechanism because it immediately replaces the older
one. Tracked staged changes, unstaged changes, and deletions are rejected during
authorization. Any later tracked-state drift, expiry, or replacement fails at
the existing validation boundaries before build, artifact deletion, notary
submission, or upload.

The durable helper accepts structured public-wrapper arguments only; it never
accepts an arbitrary command:

```bash
bash scripts/jarvis-public-release-session.sh status
bash scripts/jarvis-public-release-session.sh attach
bash scripts/jarvis-public-release-session.sh log
```

`start` is already present in the printed `persistent_command`. It creates the
deterministic `jarvis-public-release` tmux session from the blessed release
worktree, preserves the wrapper's exit status and scrollback, and refuses a
duplicate session. `status` reports running, finished-success,
finished-failure, or missing. `log` is the non-interactive recovery view; use
`attach` for live observation. After inspecting a finished session, clear only
that transport with:

```bash
bash scripts/jarvis-public-release-session.sh clear
```

The persistent child does not copy release credentials or ambient release
overrides into tmux arguments. It clears supported and stale notary, Sparkle,
smoke, package, state-path, and `OPENCLAW_RELEASE_ENV_FILE` values inherited
from either the launcher or tmux server. It also clears release intent, lock,
checkpoint, worktree, disk, ownership-transfer, and other validation test
overrides before the child starts. Shell startup redirects (`BASH_ENV`, `ENV`,
and `ZDOTDIR`) are neutralized when the tmux session is created, before its
initial pane can read them. The wrapper then loads the deterministic
canonical `~/Library/Application Support/OpenClaw/release.env`, and its package
child inherits that exact snapshot. Put persistent release
credentials and settings there; a custom ambient release-env path is
intentionally ignored by this transport. Here `~` comes from the validated
macOS account record, not the launching shell's `HOME`; release tools use a
fixed system plus Apple Silicon/Intel Homebrew `PATH`, never tmux's saved
`PATH`. Status and log stay pinned to the
original pane even if another pane becomes active, and `clear` refuses to kill
the session while any pane in it is still running.

tmux session state and scrollback are transport evidence only. They do not
authorize, resume, or classify a release. The wrapper's intent, repository
lock, strict checkpoints, and printed `recovery_command` remain authoritative.

The wrapper inspects existing `dist/` artifacts and strict artifact
checkpoints, chooses the next safe package phase, and delegates to
`scripts/package-openclaw-mac-dist.sh`. The release manifest remains a readable
operator summary, but neither `Accepted` text nor file existence authorizes
reuse. Every app, DMG, ZIP, and appcast checkpoint binds the exact app path,
version/build, embedded Git commit, and signed-code CDHash in addition to the
release commit, intended phase, exact artifact path and checksum, live signature
verification, notary receipt and submission ID, and live staple/Gatekeeper
validation where applicable. If any field or artifact fails validation, the
wrapper falls back to the earliest safe rebuild/resubmit phase.

With
`--parallel-safe-local-assets`, the wrapper may create local `Jarvis.zip` and
`jarvis-appcast.xml` after app notarization is accepted and a DMG notary
submission exists, while DMG polling remains a separate resumable step. This is
local-only P2 parallelism: the appcast upload still stays last because it is the
public go-live switch. If the wrapper selects
`create-local-release-assets-only`, let it resolve the latest release tag so
the Sparkle appcast signs an immutable tagged `Jarvis.zip` URL:

```bash
bash scripts/jarvis-public-release.sh \
  --authorize \
  --parallel-safe-local-assets \
  --latest-release-tag
# Run the exact persistent_command printed by --authorize.
```

#### Publish Gates

Publishing is never implicit. Use the narrow gate that matches the truth you
need to make public.

For an urgent existing-user update, publish only after app notarization is
accepted and existing `dist/Jarvis.app`, `dist/Jarvis.zip`, and
`dist/jarvis-appcast.xml` are present. This uploads only `Jarvis.zip` and
`jarvis-appcast.xml`; it does not upload `Jarvis.dmg` and must not be described
as a fresh-install/sendable release:

```bash
bash scripts/preflight-consumer-mac-release.sh
bash scripts/jarvis-public-release.sh \
  --authorize \
  --urgent-sparkle \
  --publish-release-assets \
  --latest-release-tag
# Run the exact persistent_command printed by --authorize.
```

Required successful urgent-update ending:

```text
sparkle_update_live=true
release_sendable=false
fresh_install_sendable=false
dmg_update_live=false
```

For a full sendable release, publish only after app and DMG notarization are
accepted and existing `dist/Jarvis.dmg`, `dist/Jarvis.zip`, and
`dist/jarvis-appcast.xml` are present:

```bash
bash scripts/preflight-consumer-mac-release.sh
bash scripts/jarvis-public-release.sh \
  --authorize \
  --publish-release-assets \
  --latest-release-tag
# Run the exact persistent_command printed by --authorize.
```

Use `--github-release-tag <tag>` only when you intentionally want to pin the
wrapper to a specific known tag. The wrapper rejects combining it with
`--latest-release-tag` so publish and verification commands cannot hide
ambiguous operator intent.

Before the large GitHub release asset upload, the package script runs a
GitHub-specific network preflight. It checks routes to `github.com`,
`api.github.com`, and `uploads.github.com`, then quickly probes the GitHub API
and upload host. If those hosts route through a tunnel/VPN interface such as
`utun*`, `wg*`, `ppp*`, or `ipsec*`, the script fails before upload. Turn off
VPN/tunnel routing, switch Wi-Fi/hotspot, then rerun the publish phase. If the
slow route is intentional and known-good, rerun with:

```bash
ALLOW_SLOW_RELEASE_UPLOAD=1 bash scripts/package-openclaw-mac-dist.sh \
  --phase publish-assets-only \
  --release-intent "<id-from-authorize>" \
  --publish-release-assets \
  --github-release-tag "<latest-tag-from-gh-release-view>"
```

Apple notarization submit also prints route warnings for likely notary hosts,
the artifact size, submit start/end timestamps, and elapsed-time heartbeats.
`notarytool` does not expose reliable byte-level upload progress. If it stalls
before returning a submission ID, fix the network and retry the same artifact.
If it returns a submission ID, poll that ID and do not resubmit the artifact.
VPN/tunnel routing should be off for Apple and GitHub release uploads unless the
slow path is intentional and known-good.

`--phase` controls where packaging starts. The default is `full`: build, sign,
verify, notarize, package, publish, and verify in one pass. `--local-proof` is
an alias for `--phase local-proof` and is the fastest app-only proof path. Use
the broad recovery phase only after the app build/sign/verify steps already
succeeded and `dist/Jarvis.app` is still present:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --phase post-app-build \
  --release-intent "<id-from-authorize>" \
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
`dist/Jarvis.dmg.notary.env`. Artifact checkpoints are written beside the app,
DMG, ZIP, and appcast as `*.release-checkpoint.env`. The manifest is operator
metadata only; do not store credentials there and do not hand-edit checkpoints.

Failure recovery has one machine-readable contract: a failing release command
prints exactly one `recovery_command=...` line. Run that command exactly. If the
intent expired or was replaced, the only recovery command is:

```bash
bash scripts/jarvis-public-release.sh --authorize
```

Then run the newly printed `next_command`. Do not reuse an older intent ID, do
not infer a phase from artifact existence, and do not bypass checkpoint gates
with manifest edits. For long-running release work, authorize the intended
future flags again and run the newly printed `persistent_command`.

Wrapper runs write `dist/jarvis-public-release-summary.env`; timed package
substeps append to `dist/jarvis-release-timing.tsv`. GitHub release view,
upload, and public verification get bounded retries only for obvious transient
network or GitHub service failures. Authentication, permission, missing release,
wrong tag, and non-latest tag failures remain fast failures.

Build/package the app once and stop before notarization:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --phase build-app-only \
  --release-intent "<id-from-authorize>"
```

For repeat local proof, prefer `--local-proof` over `--phase build-app-only`.
It uses the same app build and verifier path, but also forces local proof
defaults: no notarization, no dSYM, no publish, default Sparkle key allowed for
smoke proof, and cached bundled runtime reuse from a clean tracked commit.

Submit app notarization only from the existing app bundle:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --phase submit-app-notarization \
  --release-intent "<id-from-authorize>"
```

Resume app notary polling from the saved submission:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --phase poll-app-notarization \
  --release-intent "<id-from-authorize>"
```

Submit DMG notarization only after the app poll phase records
`JARVIS_APP_NOTARY_STATUS=Accepted`:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --phase submit-dmg-notarization \
  --release-intent "<id-from-authorize>"
```

Resume DMG notary polling from the saved submission:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --phase poll-dmg-notarization \
  --release-intent "<id-from-authorize>"
```

Create only local Sparkle release assets from the existing notarized
`dist/Jarvis.app`:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --phase create-local-release-assets-only \
  --release-intent "<id-from-authorize>" \
  --github-release-tag "<latest-tag-from-gh-release-view>"
```

This phase creates `dist/Jarvis.zip` and `dist/jarvis-appcast.xml` only. It
does not rebuild the app, recreate or notarize the DMG, staple anything, upload
GitHub assets, verify public URLs, touch `/Applications/Jarvis.app`, or touch
the shared gateway runtime. It requires `JARVIS_APP_NOTARY_STATUS=Accepted` in
`dist/jarvis-release-manifest.env`, but it intentionally does not require
accepted DMG notarization so the ZIP/appcast can be prepared while DMG
notarization is still pending.

Publish the full sendable package only from existing `dist/Jarvis.dmg`,
`dist/Jarvis.zip`, and `dist/jarvis-appcast.xml` after the manifest records
accepted app and DMG notarization:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --phase publish-assets-only \
  --release-intent "<id-from-authorize>" \
  --publish-release-assets \
  --github-release-tag "<latest-tag-from-gh-release-view>"
```

Verify only against the public GitHub release URLs without uploading:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --phase verify-public-assets-only \
  --release-intent "<id-from-authorize>" \
  --github-release-tag "<latest-tag-from-gh-release-view>"
```

Publish an urgent Sparkle-only update from existing `dist/Jarvis.zip` and
`dist/jarvis-appcast.xml` after the manifest records accepted app notarization:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --phase publish-sparkle-assets-only \
  --release-intent "<id-from-authorize>" \
  --publish-release-assets \
  --github-release-tag "<latest-tag-from-gh-release-view>"
```

Verify only the public Sparkle update URLs without uploading or checking the
DMG:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --phase verify-sparkle-assets-only \
  --release-intent "<id-from-authorize>" \
  --github-release-tag "<latest-tag-from-gh-release-view>"
```

For trusted-ring drops where Apple notarization and public GitHub release work
are intentional overkill, use the fast lane. It still builds signed local
artifacts under `dist/`, but forces notarization, dSYM, publish, and public URL
verification off:

```bash
bash scripts/package-openclaw-mac-dist.sh \
  --trusted-ring-fast \
  --release-intent "<id-from-authorize>"
```

The trusted-ring lane also uses the local fast packaging path: it skips the
bundled CLI npm tarball and reuses the cached bundled runtime when runtime
inputs are unchanged. Because the distribution wrapper requires a clean tracked
worktree, the cache follows the current commit instead of rehashing generated
`dist/` output. Run a normal full release phase before relying on a public
release artifact; trusted-ring output is for local proof and tester handoff.

Cache and retry rules:

- `SKIP_PNPM_INSTALL=1` is only for already-bootstrapped retry lanes. If
  dependencies or `node_modules` are missing, bootstrap first instead of hiding
  a setup problem.
- Runtime cache is acceptable only when the clean-git runtime cache guards pass.
  A dirty tracked worktree is not a release cache input.
- `--reuse-runtime` remains smoke-only. Do not use it for public release
  packaging because it can preserve stale bundled runtime code.
- Trusted-ring fast output is separate from the public release path. It is for
  local proof and tester handoff, not a substitute for Developer ID signing,
  Apple notarization, Sparkle appcast signing, GitHub upload, and public URL
  verification.

Required successful full-release ending:

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

### Jarvis app size inventory

Before removing anything to shrink artifacts, inspect the built app and record
what actually dominates size. This is read-only:

```bash
bash scripts/report-jarvis-release-size.sh --app dist/Jarvis.app
```

The script writes an env summary, a largest-entry report, and a focused detail
report covering top packages, bundled extensions, duplicate asset buckets,
native binaries, and likely dev/docs/test payload candidates.

Do not delete bundled files in the release lane without proof that Intel
support, runtime startup, onboarding templates, bundled skills, and Sparkle
validation still work.

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
