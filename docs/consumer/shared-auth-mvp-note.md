# Shared Auth MVP Note

This is the consumer MVP operating path for founder-managed shared AI auth.

## Scope

- Use one canonical shared profile only: `openai-codex:default`
- Keep the current default model on `openai-codex/gpt-5.4`
- Treat this as a trusted-tester path only
- BYOK stays available as the fallback, not the default setup

## Runtime

- Consumer runtime root: `~/Library/Application Support/OpenClaw Consumer`
- Consumer state dir: `~/Library/Application Support/OpenClaw Consumer/.openclaw`
- Canonical config path: `~/Library/Application Support/OpenClaw Consumer/.openclaw/openclaw.json`
- Canonical auth store: `~/Library/Application Support/OpenClaw Consumer/.openclaw/agents/main/agent/auth-profiles.json`

Config and auth must resolve from the same consumer state root. If `OPENCLAW_CONFIG_PATH` points at the consumer runtime but `OPENCLAW_STATE_DIR` is missing or different, readiness can lie by reading auth from another runtime.

## Rotation

When shared auth breaks or expires:

1. Refresh or replace the credential stored under `openai-codex:default` in the consumer auth store.
2. Keep `auth.profiles["openai-codex:default"]` in `openclaw.json` aligned with that runtime.
3. Re-run the readiness probe before the next demo.

Example verification command:

```sh
STATE_DIR="$HOME/Library/Application Support/OpenClaw Consumer/.openclaw"
CFG="$STATE_DIR/openclaw.json"
OPENCLAW_STATE_DIR="$STATE_DIR" \
OPENCLAW_CONFIG_PATH="$CFG" \
pnpm openclaw models status --json --probe --probe-provider openai-codex --probe-profile openai-codex:default --probe-timeout 15000 --probe-concurrency 1 --probe-max-tokens 8
```

Ready means the canonical shared profile can answer a live probe for the default model. Anything else means demos should be treated as blocked until fixed.

## Fallback

If the shared auth cannot be repaired quickly, move the tester to BYOK. Do not rotate across a hidden pool of founder profiles to mask breakage. That makes the product look ready when it is not.
