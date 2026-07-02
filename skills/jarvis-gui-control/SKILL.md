---
name: jarvis-gui-control
description: Use for Jarvis macOS GUI-control tasks and GUI proof requests. Prefer this over Peekaboo for operating apps: use the installed `openclaw gui-control` CLI backed by OpenComputerUse, with hard stops for auth, payment, final purchase/booking, destructive delete, account/security settings, and software install/update.
metadata:
  {
    "openclaw":
      {
        "emoji": "🖥️",
        "displayName": "Jarvis GUI Control",
        "os": ["darwin"],
        "requires": { "bins": ["openclaw"] },
      },
  }
---

# Jarvis GUI Control

Use this skill when the user asks Jarvis to operate a visible macOS app, prove
GUI control, type into a local app, inspect native app state, or perform a
bounded local GUI workflow.

The primary control surface is the installed OpenClaw CLI:

```bash
openclaw gui-control --help
openclaw gui-control observe --runtime open-computer-use --app TextEdit --json
openclaw gui-control resolve-element --runtime open-computer-use --app TextEdit --intent text-input --json
openclaw gui-control set-value --runtime open-computer-use --app TextEdit --intent text-input --value "$TEXT" --approve-policy-risk --json
```

## Routing

- Prefer `openclaw gui-control --runtime open-computer-use` for GUI operation.
- Do not use Peekaboo as the first choice for normal GUI-operation requests.
  Use the `screen-record` skill and `openclaw screen record` for target-aware
  video proof. Peekaboo is for still screenshots, UI maps, diagnostics, or an
  explicit fallback after `openclaw gui-control` or `openclaw screen record` is
  unavailable or insufficient.
- Do not use benchmark scripts as product behavior. Benchmarks are proof tools,
  not the live assistant workflow.
- Do not use raw coordinates, AppleScript/JXA, browser plugins, or clipboard
  fallbacks as proof of Jarvis GUI-control capability.

## Workflow

1. Observe the target app before acting.
2. Resolve a real UI element by app/window, role, label, description, value, or
   fresh element ref.
3. Act through `openclaw gui-control --runtime open-computer-use` with structured JSON output.
4. Re-observe the app and verify the requested visible result.
5. For visual proof that depends on motion, sequence, or feel, record the target
   app/window through `openclaw screen record` instead of sending repeated
   screenshots.
6. Reply with the app used, whether clipboard was used, and the visible proof
   value that was verified.

For simple text-entry proof in TextEdit:

```bash
openclaw gui-control observe --runtime open-computer-use --app TextEdit --json
openclaw gui-control set-value \
  --runtime open-computer-use \
  --app TextEdit \
  --intent text-input \
  --value "$TOKEN" \
  --approve-policy-risk \
  --json
openclaw gui-control observe --runtime open-computer-use --app TextEdit --json
```

## Safety

Founder-local trusted mode allows useful local GUI progress by default, but the
following are hard stops unless the user has explicitly approved the exact step:

- login, sign-in, password, passkey, OTP, CAPTCHA, or other auth steps
- payment, card entry, checkout, final purchase, final booking, or final order
- destructive delete/remove/erase actions
- account, privacy, security, permission, or profile-setting changes
- software install, update, relaunch-to-update, or package-manager mutation

If a command reports the wrong app/window, ambiguous target, stale element ref,
blocked policy risk, or missing post-state verification, stop and report the
blocker. Do not route around it with a lower-level automation tool.

## Locked Session

If GUI-control returns `Apple event error -10005: cgWindowNotFound` across
normal apps such as TextEdit, Finder, Telegram, Safari, or System Settings,
first suspect that the Mac session is locked or sleeping. Ask the user to
unlock or approve the existing unlock/keep-awake recovery flow before debugging
permissions, TCC, or app-specific adapters.
