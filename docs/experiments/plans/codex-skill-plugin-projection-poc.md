---
summary: "Patch 5 POC notes for projecting OpenClaw skills into a Codex-compatible plugin bundle"
read_when:
  - Investigating Codex backend-native skill exposure
  - Wiring OpenClaw skills into Codex native plugin loading
title: "Codex Skill Plugin Projection POC"
---

# Codex Skill Plugin Projection POC

Patch 5 keeps runtime behavior unchanged and adds only a reusable projection
generator.

## What exists

`generateCodexSkillPluginProjection` in
`src/agents/skills/codex-plugin-projection.ts` takes already-resolved OpenClaw
skills (`SkillEntry` or `Skill`-like filesystem entries) and writes a
filesystem-only Codex bundle:

```text
<out>/
  marketplace.json
  plugins/
    openclaw-skills/
      .codex-plugin/
        plugin.json
      skills/
        <safe-skill-dir>/
          SKILL.md
          ...
```

The Codex manifest uses the same skill-root shape as installed Codex plugin
examples:

```json
{
  "name": "openclaw-skills",
  "skills": "./skills/"
}
```

The projection copies skill folders instead of linking them. It allocates
deterministic safe target directory names, adds numeric suffixes for duplicates,
omits local `.env*` files, and rejects symlink escapes outside the source skill
directory. It does not read OpenClaw config values, resolve env overrides, run
`codex plugin add`, or mutate `~/.codex/config.toml`.

## Next integration step

The next runtime patch should create an isolated Codex home/profile for the ACP
Codex runner, generate the projection into that profile or a temporary
marketplace root, then point Codex at the local plugin without touching the
operator's global `~/.codex` state.

Keep the first integration narrow:

- Generate from the same resolved skills snapshot already used for prompt-side
  skill inventory.
- Use an isolated `CODEX_HOME` or equivalent Codex profile directory.
- Prove Codex sees `openclaw-skills` natively before removing prompt-side skill
  fallback.
- Keep prompt inventory as fallback until native Codex skill loading is proven
  across fresh and resumed ACP sessions.
