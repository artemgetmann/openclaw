# OpenClaw Consumer Packaging Contract

This doc is the source of truth for consumer mac packaging.

## Contract

- Consumer mac packages must be bundled-first and self-contained for the normal path.
- The normal consumer package must not depend on `openclaw.ai`, `openclaw.bot`, `npm install -g openclaw@latest`, upstream GitHub checkout, or `brew`-driven bootstrap.
- Legacy bootstrap is only a temporary development escape hatch. It must be explicitly opted into and never treated as the default consumer release path.

## Required modes

- `OPENCLAW_CONSUMER_PACKAGING_CONTRACT=bundled`
- `OPENCLAW_CONSUMER_BUNDLED_RUNTIME_READY=1`

Use the legacy path only when you are intentionally working on the transitional lane:

- `OPENCLAW_CONSUMER_PACKAGING_CONTRACT=legacy-bootstrap`
- `OPENCLAW_CONSUMER_LEGACY_BOOTSTRAP_OK=1`

## Guardrail

- If the consumer packaging contract is missing, packaging must fail closed.
- If a package is marked `bundled`, it must not carry the old external installer source hook.
- If a package is marked `legacy-bootstrap`, the script must say so explicitly and require an intentional opt-in.

## Why this exists

The consumer app is not supposed to drift back to generic upstream install assumptions by accident. If someone packages a consumer app, they must make the source-of-truth choice explicit first.
