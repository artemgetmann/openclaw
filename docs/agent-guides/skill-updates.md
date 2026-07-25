---
summary: "How to update OpenClaw/Jarvis skills without editing stale mirrors"
read_when:
  - Adding or modifying bundled skills
  - Editing repo-local .agents skills
  - Debugging skill drift between Codex, Jarvis, and OpenClaw
title: "Skill Updates"
---

# Skill Updates

Skill changes drift when agents patch whichever `SKILL.md` they can see first.
Pick the owner first, then edit only that owner.

## Pick The Owner

- Product/bundled skill:
  - owner: `skills/<skill-name>/SKILL.md`
  - use when Jarvis/OpenClaw should ship the behavior to every runtime
  - examples: `screen-record`, `telegram-user`, shared operator skills
- Repo-local selector or workflow skill:
  - owner: `.agents/skills/<skill-name>/SKILL.md`
  - use when this repository needs a local checklist or selector behavior
  - examples: `telegram-live-e2e`, repo-specific validation checklists
- Personal local skill:
  - owner: `~/.agents/skills/<skill-name>/SKILL.md`
  - use only for a user-local preference or override that should not ship with
    the product
- Runtime mirror:
  - path: `$OPENCLAW_STATE_DIR/product-skills/<skill-name>` or app-support
    equivalents
  - do not edit directly except for a declared emergency runtime patch

## Mirror Rules

Bundled skills are mirrored into `~/.agents/skills` so Codex and other local
agents can see the same official skills. Packaged Jarvis can also have a runtime
mirror under app-support state.

Those mirrors are downstream copies, not the source of truth. If a mirror has
the right behavior and the repo does not, port the behavior back to
`skills/<skill-name>`. If the repo bundled skill should win, run a named forced
sync instead of hand-editing both copies:

```bash
openclaw skills sync-shared --force <skill-name>
```

Do not patch both `skills/<skill-name>` and `~/.agents/skills/<skill-name>` in
the same PR unless the change is explicitly a migration or emergency repair.

## Repo-Local Shims

Some `.agents/skills/<skill-name>/SKILL.md` files are intentionally tiny shims
that point to `../../../skills/<skill-name>/SKILL.md`. Do not expand those shims
with copied instructions. Patch the bundled owner instead.

If `.agents/skills/<skill-name>` contains repo-specific instructions rather
than a shim, treat it as a repo-local skill and patch it there.

## Shipping Proof

Every external command or native runtime invoked by a shipped skill must be
declared in that skill's metadata. Use normal `requires`/`install` metadata for
commands that are setup-gated. Use a `packagedArtifacts` entry with
`requirement: "consumer-release"` when the default consumer experience requires
a local native payload to exist at package time. Do not make an embedded app a
`requires.bins` dependency unless packaging also exposes that exact command on
the runtime PATH; otherwise skill discovery will hide a capability that is
present inside the package.

Before claiming a skill update is live, prove the right layer:

- Repo truth: `git diff -- skills/<skill-name> .agents/skills/<skill-name>`
- Parser truth: run the relevant skill or CLI tests
- Mirror truth: `openclaw skills sync-shared --force <skill-name>` when the
  local shared mirror must update immediately
- Runtime truth: for Jarvis/runtime behavior, fast-forward the runtime checkout,
  restart or reseed the packaged runtime as required, then prove the live
  runtime commit separately from the PR merge

Final handoffs should name the owner path and the proof layer. "Patched the
skill" is not enough.
