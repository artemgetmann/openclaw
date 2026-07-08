# Codex / ACPX backend-native skill exposure investigation

Date: 2026-07-08

## Question

Patch 5 from the skill inventory fidelity investigation asked whether OpenClaw can expose skills to Codex/ACPX through a backend-native mechanism instead of relying only on the prompt-injected `<available_skills>` block.

Plain language: can Codex receive OpenClaw skills the way Claude CLI can receive a temporary skills/plugin directory, so long skill catalogs do not depend entirely on prompt budget?

## Short answer

Yes in principle for Codex, but not directly through the current ACPX prompt API.

Codex CLI has a native plugin system. Installed Codex plugins can carry a `skills/` directory containing AgentSkills-style `SKILL.md` files, referenced from `.codex-plugin/plugin.json` via a `"skills": "./skills/"` field.

ACPX, however, currently exposes prompts to Codex as text plus image blocks. It does not expose a first-class `skills`, `resources`, `pluginDir`, or `marketplace` field through OpenClaw's ACP runtime interface. So the viable design is not "pass skills to ACPX with an extra flag". The viable design is "generate/register an OpenClaw Codex plugin or marketplace, then run Codex/ACPX sessions against that configured Codex environment."

## Evidence

### Current OpenClaw ACP runtime shape

`src/acp/runtime/types.ts` defines the outbound runtime turn payload as:

- `text: string`
- optional `attachments?: AcpRuntimeTurnAttachment[]`
- `AcpRuntimeTurnAttachment` is only `{ mediaType: string; data: string }`

There is no field for skill catalogs, resource manifests, plugin directories, or mounted instruction folders.

`extensions/acpx/src/runtime.ts` serializes turns by writing either plain `input.text` or JSON blocks containing text/image entries to ACPX stdin. The implementation only forwards image attachments as `{ type: "image", mimeType, data }` blocks.

### ACPX CLI surface

The local ACPX help exposes:

- prompt/session commands
- model/permission/tool flags
- `-f/--file` for prompt text
- session config controls

It does not expose an obvious `--skills`, `--plugin-dir`, `--marketplace`, or resource-mount flag for prompt turns.

### Codex CLI plugin surface

Local Codex CLI (`codex-cli 0.142.4`) exposes:

- `codex plugin list`
- `codex plugin add`
- `codex plugin marketplace add`

`codex plugin marketplace add` supports local paths and Git marketplace sources. `codex plugin add` installs a plugin from a configured marketplace.

Installed Codex plugins on this machine include manifests like:

```json
{
  "name": "github",
  "version": "0.1.6",
  "description": "Inspect repositories, triage pull requests and issues, debug CI, and publish changes through a hybrid GitHub connector and CLI workflow.",
  "skills": "./skills/",
  "apps": "./.app.json",
  "mcpServers": "./.mcp.json"
}
```

The plugin folder contains `skills/<skill-name>/SKILL.md` entries. The bundled Documents plugin has the same shape:

```json
{
  "name": "documents",
  "version": "26.630.12135",
  "description": "Create and edit document artifacts in Codex, including Word files and Google Docs.",
  "skills": "./skills/"
}
```

So Codex has a native skills mechanism, but it is packaged as Codex plugins/marketplaces, not as an ACPX prompt argument.

## Architecture options

### Option 0: Do nothing beyond PR #1112

Keep using prompt-side protection:

- larger prompt budget
- compact catalog fallback
- current-turn relevance ranking
- targeted discovery fallback

This is enough for the reported Build in Public/X incident and should not block PR #1112.

Risk: at much larger catalogs, prompt-only discovery remains a scaling pressure.

### Option 1: Documented manual Codex plugin projection

Create a documented operator flow:

1. Generate a local Codex marketplace under OpenClaw state/cache.
2. Generate one `openclaw-skills` plugin with:
   - `.codex-plugin/plugin.json`
   - `skills/` containing copied or symlinked OpenClaw skills
3. Ask operator/user to run:
   - `codex plugin marketplace add <generated-marketplace-path>`
   - `codex plugin add openclaw-skills@<marketplace>`

Pros:

- Low OpenClaw runtime complexity.
- Good first proof of Codex compatibility.

Cons:

- Mutates global `~/.codex/config.toml` / plugin state.
- Drift risk if OpenClaw skills change and projection is not regenerated.
- Bad fit for ephemeral OpenClaw/ACPX sessions.

Recommendation: useful only as a prototype/manual proof, not product default.

### Option 2: OpenClaw-managed ephemeral Codex config/profile

OpenClaw generates the Codex plugin projection and launches Codex/ACPX against an OpenClaw-owned Codex home/profile/config, not the user's global Codex config.

High-level flow:

1. Resolve OpenClaw eligible skills using the same skill loader as normal runtime.
2. Generate a deterministic projection under OpenClaw state/cache, e.g.:

   ```text
   $OPENCLAW_STATE_DIR/acp/codex-plugins/openclaw-skills/
     marketplace.json
     plugins/openclaw-skills/.codex-plugin/plugin.json
     plugins/openclaw-skills/skills/<skill>/SKILL.md
   ```

3. Copy skill folders or generate symlinks if Codex accepts them safely.
4. Use an OpenClaw-owned Codex config/profile that enables the generated plugin.
5. Configure ACPX's Codex agent command to use that profile/config.
6. Regenerate when skill snapshot hash changes.

Pros:

- Backend-native Codex skill discovery.
- Does not rely on prompt budget for the full catalog.
- Avoids mutating the user's personal Codex plugin config.
- Can be made deterministic and cacheable.

Cons:

- Requires careful Codex config/profile isolation.
- Need to verify whether Codex plugin marketplace/plugin config can be fully overridden through `-c`, `$CODEX_HOME`, `--profile`, or an ACPX agent command wrapper.
- Need lifecycle management: cache invalidation, cleanup, and stale skill projection checks.

Recommendation: best product architecture if we decide patch 5 is worth implementing.

### Option 3: Extend OpenClaw ACP runtime types with `skillCatalog/resources`

Add fields to `AcpRuntimeEnsureInput` or `AcpRuntimeTurnInput` such as:

```ts
type AcpRuntimeSkillCatalog = {
  format: "agentskills";
  entries: Array<{ name: string; path: string; description?: string }>;
};
```

Then each backend adapter decides what to do:

- Claude adapter: materialize plugin/skill dir.
- Codex/ACPX adapter: materialize Codex plugin projection.
- Generic adapters: ignore or prompt-summarize.

Pros:

- Clean OpenClaw abstraction.
- Avoids hardcoding skill handling into every caller.

Cons:

- Bigger protocol/API change.
- Still requires Codex projection implementation under the ACPX adapter.

Recommendation: good final shape after proving Option 2.

## Proposed next steps

Do not implement patch 5 as part of PR #1112. Treat it as a separate, staged project.

### Phase 1: Proof of Codex plugin projection

Create a tiny local fixture plugin from 2-3 OpenClaw skills and verify Codex sees/uses them.

Acceptance criteria:

- Generated plugin has valid `.codex-plugin/plugin.json` with `skills` path.
- Codex can list/install/enable it from a local marketplace.
- A Codex run can route to a projected skill without the skill being included in the prompt inventory.
- No mutation of user global Codex config unless explicitly done in an isolated temporary `CODEX_HOME`.

### Phase 2: OpenClaw projection generator

Add a generator that takes `SkillSnapshot` / resolved skill entries and writes a Codex plugin projection.

Acceptance criteria:

- deterministic output path by skill snapshot hash
- avoids copying secrets or runtime-only env values
- handles duplicate skill names using existing OpenClaw precedence
- preserves relative files referenced by `SKILL.md`
- rejects unsafe symlinks or materializes them safely
- tests cover manifest generation and skill folder projection

### Phase 3: ACPX/Codex integration

Wire the generated plugin into Codex sessions launched through ACPX, preferably using an OpenClaw-owned Codex config/profile or wrapper command.

Acceptance criteria:

- does not mutate normal `~/.codex/config.toml` by default
- works for one-shot and persistent ACPX sessions
- regenerates only when skill snapshot hash changes
- degrades cleanly to prompt-based skills if Codex plugin support is unavailable
- status/doctor reports whether native Codex skill projection is active

### Phase 4: Generalize ACP runtime capability

Only after Codex proof works, add a backend capability abstraction so the runtime can advertise something like:

```ts
skills: ["prompt", "native-plugin"];
```

or accept a normalized skill catalog in `AcpRuntimeEnsureInput`.

## Recommendation

Patch 5 is valuable, but it is not urgent for the incident fixed by PR #1112.

The right move is:

1. Land PR #1112 first.
2. Run a separate proof-of-concept for Codex plugin projection using isolated `CODEX_HOME`.
3. If the proof works, implement Option 2 behind a feature flag.
4. Only then generalize the ACP runtime API.

Do not implement a generic `skills` field in ACPX before proving Codex can consume the generated plugin cleanly. That would be architecture cosplay.
