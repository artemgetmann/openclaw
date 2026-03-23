---
summary: "Manual logins for browser automation + X/Twitter posting"
read_when:
  - You need to log into sites for browser automation
  - You want to post updates to X/Twitter
title: "Browser Login"
---

# Browser login + X/Twitter posting

## Manual login (recommended)

When a site requires login, use the **signed-in user browser lane** first if it is available.

If the task depends on existing cookies or logged-in sessions, prefer the
**user** browser profile over the isolated `openclaw` browser. If that lane is
not available, surface the blocker instead of silently switching to a clean
browser that will just ask for login again.

Do **not** give the model your credentials. Automated logins often trigger anti‑bot defenses and can lock the account.

Back to the main browser docs: [Browser](/tools/browser).

## Which Chrome profile is used?

OpenClaw can use two browser lanes:

- `user`: your signed-in Chrome lane when existing cookies/session matter
- `openclaw`: a dedicated Chrome profile (orange-tinted UI) isolated from your daily browser

For agent browser tool calls:

- Prefer `profile="user"` for signed-in sites, hostile sites, and flows where existing cookies/session matter.
- Use `profile="openclaw"` for public browsing, clean isolated runs, or as an explicit fallback.
- If `profile="user"` is required for the task and is unavailable, stop and report the blocker instead of silently switching to `openclaw`.
- If you have multiple user-browser profiles, specify the profile explicitly instead of guessing.

Two easy ways to access it:

1. **Ask the agent to open the browser** and then log in yourself.
2. **Open it via CLI**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

If you have multiple profiles, pass `--browser-profile <name>` (the default is `openclaw`).

## X/Twitter: recommended flow

- **Read/search/threads:** prefer the signed-in **user** browser lane.
- **Post updates:** prefer the signed-in **user** browser lane.

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
