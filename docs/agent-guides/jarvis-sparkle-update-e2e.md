# Jarvis Sparkle update E2E harness

`scripts/jarvis-sparkle-update-e2e.sh` is a safety harness for proving the
shape of an old-to-new Jarvis Sparkle update. It is intentionally synthetic:
it does not package, publish, notarize, install into `/Applications`, touch
LaunchAgents, restart `ai.jarvis.gateway`, or send Telegram messages.

## Operating modes

The default mode is read-only preflight:

```bash
bash scripts/jarvis-sparkle-update-e2e.sh --fixture /absolute/path/to/fixture
```

`--apply` is an explicit mutation gate, but it only mutates disposable files
under `<fixture>/.sparkle-e2e-lane`:

```bash
bash scripts/jarvis-sparkle-update-e2e.sh --apply --fixture /absolute/path/to/fixture
```

The lane is removed by EXIT/HUP/INT/TERM cleanup when it carries the ownership
sentinel. The caller-owned fixture and canonical release lock are preserved.

## Fail-closed preflight

Before any apply mutation, the harness requires fixture records for:

- disk capacity, old baseline, new app, installed app, managed manifest,
  expected managed manifest, public feed, and gateway identity;
- strict-valid code-signing and Gatekeeper results for both app records;
- a strictly increasing app build and matching public feed/package commit;
- a managed manifest that is not newer or mismatched;
- no debug Jarvis process marker, package owner marker, or active canonical
  release lock.

The canonical lock is inspected only. This script never acquires, reclaims,
removes, or mutates it. Live-looking paths (`/Applications`, Jarvis
Application Support, and LaunchAgents) are rejected as fixture roots.

An optional `telegram-nonce.expected` plus matching
`telegram-nonce.observed` enables a read-only nonce proof. No Telegram send is
implemented.

## Proof layers

An apply run emits separate lines for installed app version/build, Sparkle
transition, expected package commit, managed-manifest reseed, and exact
`ai.jarvis.gateway` identity with `restart=exact-synthetic`. These claims are
not a claim that a public update or live runtime restart occurred; the output
also states those live operations are disabled.

## Synthetic tests

Run the deterministic test suite:

```bash
bash scripts/test-jarvis-sparkle-update-e2e.sh
```

The suite proves default read-only behavior, lock/process/signature/manifest
fail-closed gates, apply cleanup, lock preservation, and optional nonce
verification without live paths.
