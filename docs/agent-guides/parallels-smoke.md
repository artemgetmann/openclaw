# Parallels smoke runs

## General

- Prefer the repo automation entrypoints:
  - `pnpm test:parallels:macos`
  - `pnpm test:parallels:windows`
  - `pnpm test:parallels:linux`
- Pass `--json` when you want machine-readable summaries.
- Smoke runs should verify gateway health with `openclaw gateway status --deep --require-rpc` when the installed version supports it.
- On stable `2026.3.12`, a pre-upgrade `latest-ref-fail` is an expected baseline, not automatically a regression.

## macOS

- Use the fresh snapshot closest to `macOS 26.3.1 fresh`.
- Use `prlctl exec` for deterministic commands, but prefer an interactive guest shell for shell-sensitive behavior.
- Discord roundtrip smoke is opt-in and should use env-backed tokens only.

## Windows

- Use `prlctl exec --current-user`.
- Prefer explicit `npm.cmd` and `openclaw.cmd`.
- Use PowerShell only as the transport layer.

## Linux

- Fresh snapshot bootstrap may need:
  - `apt-get -o Acquire::Check-Date=false update`
  - install `curl` and `ca-certificates`
- Do not assume a usable `systemd --user` session on the current snapshot.
- For Linux smoke, gateway checks may need a direct foreground run instead of detached automation.
