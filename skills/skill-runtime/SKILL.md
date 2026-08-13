---
name: skill-runtime
description: "Manage which personal skills are visible to Jarvis, Codex, or both. Use when the user says add this to your skills, add this to Jarvis, add this to Codex, add this to Codex and Jarvis, make a personal skill shared, change skill visibility, inspect skill visibility, create or make a skill without naming its target, reconcile legacy personal skills, or temporarily expose a Jarvis-only skill to Codex."
---

# Personal Skill Runtime

Keep one personal skill body at `~/.agents/skills/<skill>`. Never copy the body
to change which runtime sees it, and never hand-edit skill symlinks or runtime
configuration.

Interpret the target before authoring or installing:

- Treat "add this to your skills" as the current runtime only.
- Treat explicit "Codex" or "Jarvis" as that runtime only.
- Treat "Codex and Jarvis", "both", or "shared" as both runtimes.
- For targetless "make a skill" or "create a skill", ask exactly one short
  clarification: `Codex, Jarvis, or both?`

After the canonical skill exists and validates, use the product authority:

```bash
openclaw skills runtime status <skill>
openclaw skills runtime set <skill> shared|codex|jarvis
```

If an upgraded installation reports a legacy managed root, inspect the receipt
and conflict names. Keep the legacy root active until conflicts are resolved;
then run `openclaw skills runtime reconcile`. Never overwrite or delete either
version to force migration. Roll back only with the exact emitted receipt:

```bash
openclaw skills runtime rollback <receipt-path>
```

Rollback restores the legacy loader and preserves migrated copies in the
receipt's recovery directory; do not delete that recovery copy implicitly.

For one bounded Codex benchmark, inject a canonical skill into the child process
without changing persistent visibility:

```bash
openclaw skills runtime with codex <skill> -- exec --json '<prompt>'
```

Do not use personal visibility commands on bundled or product-managed skills.
