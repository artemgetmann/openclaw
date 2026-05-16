---
name: timezone-preference-updater
description: Use when the user naturally says their location or timezone should change, for example "I'm in Tokyo", "my timezone is Singapore", "set my timezone to Asia/Singapore", or "use local timezone". Confirm before writing agents.defaults.userTimezone via gateway config.patch/config tools, never memory.
metadata: { "openclaw": { "always": true, "skillKey": "timezone-preference-updater" } }
user-invocable: false
---

# Timezone Preference Updater

Use this skill when the user asks, directly or indirectly, to change the timezone OpenClaw should use for user-local time.

## What To Change

Write only `agents.defaults.userTimezone`.

- Use an IANA timezone string [standard timezone ID] such as `Asia/Tokyo`, `Asia/Singapore`, or `America/New_York`.
- Use `"local"` only when the user wants OpenClaw to follow the host machine timezone.
- Do not store timezone or location preferences in memory.
- Do not edit runtime time injection code or files.

## Flow

1. Resolve the requested location/timezone to the smallest clear value.
   - Tokyo means `Asia/Tokyo`
   - Singapore means `Asia/Singapore`
   - "local timezone" or "follow this Mac" means `"local"`
2. If the location is ambiguous, ask a short clarification before doing anything.
3. Before changing config, ask for confirmation in plain language and include the current timezone when known.
   - Example: `I currently have your timezone as Asia/Makassar. Update it to Asia/Tokyo? This will restart the gateway so the new time context takes effect.`
4. If the live-chat gateway tool requires restart confirmation, record that confirmation request with `gateway` action `restart.request_confirmation`, then wait for the next user reply.
5. Only after the next user reply clearly confirms, use the gateway config tools:
   - `gateway` action `config.schema.lookup` with `path: "agents.defaults.userTimezone"`
   - `gateway` action `config.get` if a base hash is needed
   - `gateway` action `config.patch` with a partial patch like:

```json5
{ agents: { defaults: { userTimezone: "Asia/Singapore" } } }
```

Include a short `note` such as `Timezone updated to Asia/Singapore.` so the user gets a clear post-restart result.

## Location Pins

If the user shares a live location or location pin, do not silently change timezone. Infer a timezone only when it is clear, then ask before writing config.
