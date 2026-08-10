# Jarvis Sparkle updater acceptance

Use `scripts/jarvis-sparkle-update-e2e.sh` after a Jarvis update is already on
the public Sparkle feed. This lane answers one focused question: can the signed
old Jarvis app automatically update to the signed new app and restore the exact
managed Jarvis runtime?

It is not a package, notarization, upload, or release-control lane. It never
replaces `/Applications/Jarvis.app`, edits a LaunchAgent plist, acquires the
release lock, or deletes Jarvis config, Telegram state, identity, or permissions.

## Read-only preflight

Quit every Jarvis/OpenClaw app first. The exclusive app gate prevents a debug
build or a second Sparkle process from contaminating the managed receipt or
creating cache entries that cannot be attributed to this run.

Then run the default read-only mode:

```bash
bash scripts/jarvis-sparkle-update-e2e.sh \
  --old-app /absolute/path/to/Jarvis-2026.7.14.1.app \
  --new-app /absolute/path/to/Jarvis-2026.7.15.1.app \
  --expected-commit <2026.7.15.1-package-commit>
```

Preflight verifies, without creating a run directory:

- the old, new, and `/Applications/Jarvis.app` version/build relationship;
- strict codesign and Gatekeeper acceptance for all three apps, plus the
  official bundle id, pinned Jarvis Team ID, and one designated requirement;
- the first item in the canonical public appcast matches the new version/build;
- the new bundled runtime manifest matches the expected package commit;
- the live managed receipt exactly matches the old signed package, rejecting a
  newer or unrelated debug runtime;
- the exact `ai.jarvis.gateway` plist paths and managed environment;
- the canonical release lock and active package/app owners by inspection only;
- real disk headroom for disposable, download, expansion, staging, and rollback
  copies (12 GB minimum by default).

Do not continue when preflight blocks. Fix the named owner, disk, baseline,
signature, feed, or runtime mismatch and rerun the same read-only command.

### Protected runtime compatibility baseline

A protected break-glass runtime is not a normal signed managed-runtime baseline,
even when `/Applications/Jarvis.app` remains a Gatekeeper-valid public app.
Never disable Gatekeeper or substitute another app to make the app and runtime
look aligned. Instead, the release owner may supply one short-lived compatibility
receipt:

```bash
bash scripts/jarvis-sparkle-update-e2e.sh \
  --old-app /absolute/path/to/the-exact-private-hotfix/Jarvis.app \
  --new-app /absolute/path/to/the-signed-public-target/Jarvis.app \
  --expected-commit <target-package-commit> \
  --protected-hotfix-compatibility-receipt /absolute/path/to/receipt.json
```

The versioned JSON contract uses these exact top-level fields:

```json
{
  "schemaVersion": 1,
  "kind": "jarvis-sparkle-protected-hotfix-baseline-compatibility",
  "receiptId": "one-auditable-transition-id",
  "issuedAt": "2026-08-02T00:00:00.000Z",
  "expiresAt": "2026-08-03T00:00:00.000Z",
  "intent": {},
  "installedApp": {},
  "protectedRuntime": {},
  "targetRelease": {}
}
```

Use the synthetic fixture in `scripts/test-jarvis-sparkle-update-e2e.sh` as the
canonical complete field example. The receipt must be a readable regular file,
not a symlink. Its validity window may not exceed seven days. It binds:

- `intent`: exactly one `sparkle-n-to-n-plus-1` transition on the canonical feed;
- `installedApp`: bundle id, version, build, full commit, signing Team ID,
  CodeDirectory hash, and designated-requirement hash for the exact private app;
- `protectedRuntime`: break-glass source, full protected commit/build, exact
  compatibility manifest, protection marker, backup receipt hashes, and source;
- `targetRelease`: bundle id, version, build, full commit, signing Team ID,
  designated-requirement hash, CodeDirectory hash, Sparkle public-key hash,
  canonical feed, and the exact enclosure URL, length, and EdDSA-signature hash.

This path still requires strict code-signature integrity for the old and
installed apps, whether Gatekeeper accepts them or not, and their Team ID plus
designated requirement must match the signed public target. The old and
installed apps must also carry the exact
nonblank Sparkle public key from that receipt-bound signed target so the running
host can authenticate and replace itself. It excuses only
the mismatch between the installed app's bundled manifest and the newer,
receipt-bound protected runtime (and, for a private app, its Gatekeeper
rejection). The target still
must pass strict codesign, Gatekeeper, pinned Jarvis Team ID, designated
requirement, package-commit, and public-appcast checks. A Gatekeeper-valid
installed app grants no runtime-transition authority by itself: the receipt must
still bind the exact protected marker, compatibility manifest, backup, live
break-glass proof, target, expiry, and one-time intent. Missing, stale, unknown,
or extra receipt fields fail closed. The target build must be newer than both
the private app and the protected runtime backup. The canonical read-only
runtime proof must also match the receipt's exact protected commit and
break-glass source. Installed/live, protection/backup, signing, or target drift
therefore fails before any run directory is created. After a
successful transition changes the managed manifest, replaying the old receipt
fails the same exact-state binding.

Output distinguishes `baseline_mode=normal_signed`,
`baseline_mode=accepted_signed_app_protected_runtime_compatibility_receipt`, and
`baseline_mode=accepted_protected_hotfix_compatibility_receipt`. A Gatekeeper
failure without the receipt names that missing authorization directly.

## Explicit apply

After reviewing preflight, repeat the command with `--apply`:

```bash
bash scripts/jarvis-sparkle-update-e2e.sh \
  --old-app /absolute/path/to/Jarvis-2026.7.14.1.app \
  --new-app /absolute/path/to/Jarvis-2026.7.15.1.app \
  --expected-commit <2026.7.15.1-package-commit> \
  --scratch-root /tmp \
  --apply
```

Apply copies the old app into a sentinel-owned scratch directory. It backs up
the `ai.jarvis.mac` preference domain, forces the automatic Sparkle schedule,
launches the disposable app, waits for the exact new version/build, and verifies
codesign, Gatekeeper, and the bundled package commit again. It then relaunches
the updated disposable app, waits for the real Application Support receipt to
reseed, performs an exact `ai.jarvis.gateway` bootout/bootstrap from the existing
plist, and runs `scripts/prove-jarvis-runtime.sh` for managed-bundle, PID,
listener, RPC, health, and commit proof.

The app has no dependable visible window, so this lane intentionally uses the
automatic updater path rather than menu/UI automation.

Add `--telegram-chat <chat>` only when a Telegram-as-user nonce roundtrip is
explicitly wanted. Telegram runs last and records the sent and reply message
IDs. Without that flag, the Telegram proof layer is `skipped`.

## Cleanup and rollback boundary

EXIT/HUP/INT/TERM cleanup:

- terminates only app PIDs started by this invocation;
- restores the exact pre-run `ai.jarvis.mac` preferences;
- audits first-level Sparkle cache entries against the pre-run snapshot without
  deleting any entry whose ownership cannot be proven;
- removes only the sentinel-owned scratch app, logs, temporary files, and
  rollback copies;
- preserves the sentinel-owned run and exits nonzero if exact preference
  restoration fails, so the only rollback copy is never discarded;
- reloads the same existing gateway plist if interruption happens between
  bootout and completed runtime proof.

The harness does not downgrade a successfully reseeded managed runtime on a
later proof failure. Deleting or rewriting Jarvis Application Support would put
user config and identity at risk; the safe recovery is to rerun proof or rerun
the signed package update after fixing the reported gate.

If Sparkle leaves any post-snapshot cache entry, the run fails, prints the
residue path, and leaves it untouched for bounded operator review. "New since
snapshot" is not proof of lane ownership; manual cleanup is safer than deleting
data another updater may own.

## Proof layers

Keep these claims separate in the output:

- `proof.public_feed`
- `proof.installed_app`
- `proof.protected_runtime` (receipt path only)
- `proof.sparkle_transition`
- `proof.managed_runtime`
- `proof.gateway`
- `proof.telegram`

A preflight pass leaves transition/runtime/gateway/Telegram as pending or
skipped. Only an apply run can mark the live layers `ok`.

## Synthetic verification

Development must remain offline and synthetic:

```bash
bash scripts/test-jarvis-sparkle-update-e2e.sh
```

Proof and mutation command overrides are accepted only with the explicit
test-mode gate and an isolated `--test-root`; production runs use fixed system
commands and a fixed system `PATH`. Test mode also requires every overridable
proof or mutation shim under that fixture root and launches the synthetic app
with a fixture-local home. The Telegram layer accepts only a reply whose text
equals the nonce.

The test suite remaps all live paths and replaces codesign, Gatekeeper, feed,
process, defaults, launchd, runtime proof, and Telegram commands with local
shims. It exercises the same preflight/apply functions, including interruption
cleanup. It does not install/update a live app, restart a real service, acquire
the release lock, or send Telegram.
