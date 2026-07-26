---
name: jarvis-computer-use
description: "Use for Jarvis Computer Use tasks: operating visible macOS apps, proving GUI actions, typing into local apps, or inspecting native app state. Prefer this over Peekaboo for app operation: use the installed `openclaw gui-control` CLI backed by OpenComputerUse, with explicit one-action approval before credential use, payment, final purchase/booking, destructive delete, account/security settings, or software install/update."
metadata:
  {
    "openclaw":
      {
        "emoji": "🖥️",
        "displayName": "Jarvis Computer Use",
        "os": ["darwin"],
        "requires": { "bins": ["openclaw"] },
        "packagedArtifacts":
          [
            {
              "id": "open-computer-use",
              "kind": "macos-app",
              "requirement": "consumer-release",
              "path": "native/Open Computer Use.app",
              "executable": "Contents/MacOS/OpenComputerUse",
              "bundleIdentifier": "com.ifuryst.opencomputeruse",
              "version": "0.1.53",
              "architectures": ["arm64", "x86_64"],
              "sourceRepo": "https://github.com/artemgetmann/open-codex-computer-use.git",
              "sourceRef": "658d72ad5cfbab60bfb477a8b54fcac9dd659121",
              "buildCommand":
                [
                  "./scripts/build-open-computer-use-app.sh",
                  "--configuration",
                  "release",
                  "--arch",
                  "universal",
                ],
              "licenseSource": "LICENSE",
              "licensePath": "Contents/Resources/OpenComputerUse-LICENSE.txt",
              "receiptPath": "Contents/Resources/OpenClaw-Packaging-Receipt.json",
            },
          ],
      },
  }
---

# Jarvis Computer Use

Use this skill when the user asks Jarvis to use the computer: operate a visible
macOS app, prove GUI control, type into a local app, inspect native app state,
or perform a bounded local GUI workflow.

The primary control surface is the installed OpenClaw CLI:

```bash
openclaw gui-control --help
openclaw gui-control observe --runtime open-computer-use --app TextEdit --json
openclaw gui-control resolve-element --runtime open-computer-use --app TextEdit --intent text-input --json
openclaw gui-control set-value --runtime open-computer-use --app TextEdit --intent text-input --value "$TEXT" --approve-policy-risk --json
```

## Routing

- Prefer `openclaw gui-control --runtime open-computer-use` for GUI operation.
- Do not acquire `~/.codex/bin/cua-guard` for this path. That guard is only
  for the Codex-native Computer Use tool/plugin; Jarvis Computer Use is the
  product CLI surface and must remain usable even when Codex Computer Use has
  another owner.
- Do not use Peekaboo as the first choice for normal GUI-operation requests.
  Use the `screen-record` skill and `openclaw screen record` for target-aware
  video proof. Peekaboo is for still screenshots, UI maps, diagnostics, or an
  explicit fallback after `openclaw gui-control` or `openclaw screen record` is
  unavailable or insufficient.
- Do not use benchmark scripts as product behavior. Benchmarks are proof tools,
  not the live assistant workflow.
- Do not use raw coordinates, AppleScript/JXA, browser plugins, or clipboard
  fallbacks as proof of Jarvis Computer Use capability.

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

## Sensitive-action approval

Founder-local trusted mode allows useful local GUI progress by default. Ask for
explicit approval immediately before each of these sensitive actions:

- entering or submitting a password, passkey assertion, OTP/verification-code
  entry or submission, CAPTCHA, security-key assertion, or sign-in approval
  prompt
- payment, card entry, checkout, final purchase, final booking, or final order
- destructive delete/remove/erase actions
- account, privacy, security, permission, or profile-setting changes
- software install, update, relaunch-to-update, or package-manager mutation

Execute the exact visible action in one foreground invocation. For a sensitive
surface, the verifier pauses this command, sends an approval request to a
configured authenticated approver (the originating conversation for the native
tool path), and proceeds only after an authenticated `allow-once`:

```bash
openclaw gui-control click \
  --runtime open-computer-use \
  --app "<app>" \
  --ref "<fresh-ref>" \
  --reason "<exact approved action>" \
  --approve-policy-risk \
  --verify-text "<expected post-state>" \
  --json
```

`--approve-policy-risk` confirms only that the mutation is intentional; it is
not user authority. Sensitive approval stays inside this verifier invocation
and never becomes a model-controlled flag or reusable receipt. The verifier
re-observes before acting. If the app, window, control, action parameters, task
policy, or visible risk context changes, it fails closed and asks again on a
fresh invocation. Never infer approval from the original task, an earlier
approval, or approval of a neighboring control.

Reversible navigation before an authentication act is allowed. This includes
selecting a known signed-out account on an account chooser, using
`Try another way` to discover available methods, and dismissing an
unavailable-passkey dialog with `Close`, `Cancel`, or `Back`. This does not
silently authorize generic `Next` or `Continue` controls on a password, passkey,
OTP, CAPTCHA, security-key, or approval challenge; those controls may submit an
autofilled or already-entered credential and require their own explicit
sensitive-action approval.

If a command reports the wrong app/window, ambiguous target, stale element ref,
blocked policy risk, or missing post-state verification, stop and report the
blocker. Do not route around it with a lower-level automation tool.

## Locked Session

If GUI-control returns `Apple event error -10005: cgWindowNotFound` across
normal apps such as TextEdit, Finder, Telegram, Safari, or System Settings,
first suspect that the Mac session is locked or sleeping. Ask the user to
unlock or approve the existing unlock/keep-awake recovery flow before debugging
permissions, TCC, or app-specific adapters.

## Permission Recovery

- Preflight with a harmless Finder or TextEdit observation. If Accessibility or
  Screen Recording is missing, stop retrying the original GUI task.
- Use the exact bundled/dev app identity reported by `openclaw gui-control`. If
  the helper is custom or PATH-based, resolve its real containing app and bundle
  ID before any reset. If a permission is simply off, let the user enable it.
- Reset only a stale grant: System Settings already shows that exact app enabled
  while the runtime still reports it missing. Ask for explicit approval, use
  the reported `tccutil` command for the stale service, reopen the app, and have
  the user re-enable that exact permission in System Settings.
- Re-run the harmless observation before resuming the original task. Stable
  signing, bundle ID, and install path normally preserve grants across updates,
  but identity/path changes or a TCC reset can require approval again.
