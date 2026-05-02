# Fresh-User macOS App Smoke

Use this smoke when validating that a main-built `OpenClaw Consumer.app` can
start from clean user state without touching the current user's real OpenClaw
runtime.

```bash
scripts/smoke-consumer-fresh-user-mac-app.sh \
  --dmg "/Users/user/Programming_Projects/openclaw/OpenClaw Consumer.dmg" \
  --timeout 240 \
  --quit-existing-app
```

What it proves:

- the DMG contains the expected `OpenClaw Consumer` app bundle
- the app can bootstrap bundled runtime files into an isolated fake home
- the app creates fresh config, workspace, and log directories under that fake
  home
- an isolated gateway label and port become healthy
- first-run onboarding appears
- the real user's canonical OpenClaw config file is not modified

What it does not prove:

- a true separate macOS account login; that still needs admin/password-driven
  manual validation on this machine
- notarization or Gatekeeper acceptance
- the future `OpenClaw Consumer.app` to `OpenClaw.app` rename path

The script refuses to run while another `OpenClaw Consumer.app` with the same
bundle identity is already open unless `--quit-existing-app` is passed. That
flag only closes the conflicting app process; the smoke still keeps runtime and
config writes inside the fake home.
