---
summary: "Manual logins for browser automation + X/Twitter posting"
read_when:
  - You need to log into sites for browser automation
  - You want to post updates to X/Twitter
title: "Browser Login"
---

# Browser login + X/Twitter posting

## Manual login (recommended)

When a site requires login, use the **real live browser lane** first if it is available.

If the task depends on existing cookies or logged-in sessions, prefer the
**user-live** browser profile over the isolated `openclaw` browser. If that lane is
not available, surface the blocker instead of silently switching to a clean
browser that will just ask for login again.

Do **not** give the model your credentials. Automated logins often trigger anti‑bot defenses and can lock the account.

Back to the main browser docs: [Browser](/tools/browser).

## Which Chrome profile is used?

OpenClaw can use two browser lanes:

- `openclaw`: a dedicated Chrome profile (orange-tinted UI) isolated from your daily browser
- `user-live`: your actual live Chrome session with your real tabs/extensions/login state

For agent browser tool calls:

- Prefer `profile="openclaw"` by default for public browsing, clean isolated runs, or anything that does not require your real browser state.
- Use `profile="user-live"` only when the task truly depends on your actual signed-in browser session, existing tabs, or installed extensions.
- If `profile="user-live"` is required for the task and is unavailable, stop and report the blocker instead of silently switching to `openclaw`.
- If you have multiple Chrome profiles, create or use an explicit `existing-session` profile instead of guessing.

Two easy ways to access it:

1. **Ask the agent to open the browser** and then log in yourself if needed.
2. **Open it via CLI**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

If you have multiple profiles, configure the source Chrome profile once instead
of having the agent guess. The default managed profile remains `openclaw`.

## X/Twitter: recommended flow

- **Read/search/threads:** prefer the live **user-live** browser lane.
- **Post updates:** prefer the live **user-live** browser lane.

## Sandboxing + host browser access

Sandboxed browser sessions are **more likely** to trigger bot detection. For X/Twitter (and other strict sites), prefer the **host** browser.

If the agent is sandboxed, the browser tool defaults to the sandbox. To allow host control:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Then target the host browser:

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

Or disable sandboxing for the agent that posts updates.
