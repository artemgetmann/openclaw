---
summary: "Skills config schema and examples"
read_when:
  - Adding or modifying skills config
  - Adjusting bundled allowlist or install behavior
title: "Skills Config"
---

# Skills Config

All skills-related configuration lives under `skills` in `~/.openclaw/openclaw.json`.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" }, // or plaintext string
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## Fields

- `allowBundled`: optional allowlist for **bundled** skills only. When set, only
  bundled skills in the list are model-visible or eligible (managed/workspace
  skills unaffected).

Skills are model-facing. Missing auth, config, or local helper binaries can make
a skill not ready to execute, but OpenClaw still includes the skill in the
model-facing prompt so the model can route to setup or explain what is missing.
Explicit `enabled: false`, bundled allowlist blocking, and unsupported OS still
hide the skill.

- `load.extraDirs`: additional skill directories to scan (lowest precedence).
  For personal skills shared across agents, keep the real folders in
  `~/.agents/skills`. Skills onboarding creates that directory and symlinks the
  active OpenClaw managed root (`$OPENCLAW_STATE_DIR/skills`) to it when safe.
- `load.watch`: watch skill folders and refresh the skills snapshot (default: true).
- `load.watchDebounceMs`: debounce for skill watcher events in milliseconds (default: 250).
- `install.preferBrew`: prefer brew installers when available (default: true).
- `install.nodeManager`: node installer preference (`npm` | `pnpm` | `yarn` | `bun`, default: npm).
  This only affects **skill installs**; the Gateway runtime should still be Node
  (Bun not recommended for WhatsApp/Telegram).
- `entries.<skillKey>`: per-skill overrides.

Per-skill fields:

- `enabled`: set `false` to disable a skill even if it’s bundled/installed.
- `env`: environment variables injected for the agent run (only if not already set).
- `apiKey`: optional convenience for skills that declare a primary env var.
  Supports plaintext string or SecretRef object (`{ source, provider, id }`).

## Notes

- Keys under `entries` map to the skill name by default. If a skill defines
  `metadata.openclaw.skillKey`, use that key instead.
- Changes to skills are picked up on the next agent turn when the watcher is enabled.
- Workspace skill symlinks that resolve outside the workspace root are blocked
  for safety. If you want OpenClaw, Codex, and Claude Code to share skills, keep
  the real folders under `~/.agents/skills` and symlink each tool's skills root
  to that directory. OpenClaw skills onboarding handles its managed root
  automatically when the target is missing or empty. For OpenClaw, that managed
  root is `~/.openclaw/skills` for the legacy runtime or
  `~/Library/Application Support/OpenClaw/.openclaw/skills` for the app-owned
  runtime. Packaged Jarvis runtimes use the same pattern under the Jarvis app
  support state root.

Bundled skills are owned by the installed package. Keep package-shipped skills
in `skills/*`; keep personal cross-agent skills in `~/.agents/skills`.
Jarvis/OpenClaw mirrors bundled skills into `~/.agents/skills` with
`.openclaw-skill.json` markers so Codex and other local agents can see the same
official skills without maintaining a second copy by hand. Use
`openclaw skills sync-shared` to refresh the mirror manually; packaged Jarvis
startup and skills onboarding run it automatically. If a mirrored skill was
locally edited, sync leaves it untouched and reports it as a local override.
Use `openclaw skills sync-shared --force <skill-name>` only when the bundled
copy should replace that named local override. If the local copy is better,
promote its change back into `skills/<skill-name>` first, then sync.

### Sandboxed skills + env vars

When a session is **sandboxed**, skill processes run inside Docker. The sandbox
does **not** inherit the host `process.env`.

Use one of:

- `agents.defaults.sandbox.docker.env` (or per-agent `agents.list[].sandbox.docker.env`)
- bake the env into your custom sandbox image

Global `env` and `skills.entries.<skill>.env/apiKey` apply to **host** runs only.
