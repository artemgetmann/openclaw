---
name: jarvis-gui-control
description: Use when asked to test or operate macOS apps through Jarvis GUI Control, OpenComputerUse, or the OpenClaw gui-control/gui-benchmark CLI. Proactively use for natural-language GUI tasks and GUI proof requests.
---

# Jarvis GUI Control

Canonical instructions live in the product-bundled skill when this skill is
loaded from the repository:

```text
../../../skills/jarvis-gui-control/SKILL.md
```

Read that file and follow it when the path exists. This repo-local skill exists
so dev agents and Codex select the same Jarvis GUI-control runbook that ships to
Jarvis users.

If this skill has been copied into an isolated worker workspace and the
canonical file is not reachable, use this portable fallback:

- Prefer `openclaw gui-control --runtime open-computer-use` for GUI operation
  and GUI proof.
- Do not use Peekaboo as the default GUI-operation proof path. Peekaboo is only
  for screenshots, video/capture artifacts, diagnostics, explicit Peekaboo
  requests, or fallback after GUI Control is unavailable.
- Do not use benchmark scripts as product behavior. They are proof tools, not
  live assistant workflows.
- Do not use raw coordinates, AppleScript/JXA, browser plugins, or clipboard
  fallback as proof of Jarvis GUI-control capability.
- Hard-stop unless the user explicitly approves the exact step: auth/login,
  payment/card/checkout/final purchase/final booking/final order, destructive
  delete/remove/erase, account/privacy/security/profile settings, and software
  install/update/relaunch-to-update/package-manager mutation.
- If `cgWindowNotFound` appears across ordinary apps, first suspect a locked or
  sleeping Mac session and ask for unlock/recovery approval before debugging
  app adapters or permissions.

Minimal TextEdit proof shape:

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
