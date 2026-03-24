# Consumer Runtime Preflight

Run this before every consumer macOS GUI test:

```bash
pnpm consumer:preflight
```

If you are testing a named lane from another checkout, point it at that lane:

```bash
OPENCLAW_CONSUMER_INSTANCE_ID=agent-a pnpm consumer:preflight
```

## Why this exists

Consumer testing got messy because local state was lying:

- one worktree was launching the app
- another worktree owned the gateway
- a third runtime was polling the same Telegram bot token
- the UI then reported the wrong failure

This command makes the lane identity explicit before anyone opens the app.

## Hard rules

- One worktree equals one consumer instance.
- One Telegram bot token equals one active runtime.
- Do terminal preflight first, then GUI.

If you skip those rules, you get fake browser failures, Telegram `409 getUpdates`
conflicts, and auth confusion that has nothing to do with the screen in front of
you.

## What the command proves

`pnpm consumer:preflight` prints:

- `branch`
- `worktree`
- `instance_id`
- `runtime_root`
- `config_path`
- `gateway_port`
- `app_launchd_label`
- `gateway_launchd_label`
- `gateway_status`
- `default_model`
- `oauth_providers`
- `telegram_token_fingerprint`
- `telegram_token_collisions`
- `telegram_active_owner`

That is the minimum proof set for consumer setup debugging.

## How to read it

Healthy lane:

- `gateway_status=ok`
- `models_status=ok`
- `telegram_token_collisions=0`
- `consumer_preflight=ok`

Bad lane:

- `gateway_status=failed`
  - the app will not finish browser or AI readiness honestly
- `models_status=failed`
  - Telegram may be connected, but the agent will fail before reply
- `telegram_token_collisions>0`
  - another consumer runtime is configured with the same bot token
- multiple `telegram_active_owner=` lines with the same token fingerprint
  - you are about to recreate the same `getUpdates` circus

## Typical recovery moves

Wrong consumer lane:

```bash
OPENCLAW_CONSUMER_INSTANCE_ID=<lane> pnpm consumer:preflight
```

Wrong app window:

```bash
bash scripts/open-consumer-mac-app.sh --instance <lane> --replace
```

Telegram collision:

- close the other consumer runtime using that token, or
- assign a different tester bot to this lane

Auth drift:

```bash
OPENCLAW_CONSUMER_INSTANCE_ID=<lane> pnpm openclaw:local models auth login --provider openai-codex
```

## Agent workflow

Before consumer GUI testing:

1. Run `pnpm consumer:preflight`.
2. Confirm the lane identity matches your checkout.
3. Confirm gateway + auth are healthy.
4. Confirm Telegram ownership is clean.
5. Only then open the app.

If the screen and the preflight disagree, trust the preflight first and inspect
logs. The GUI has already proven it can lie when the wrong runtime owns the
state.
