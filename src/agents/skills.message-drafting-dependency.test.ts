import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillsPrompt } from "./skills.js";
import {
  evaluateSkillEntry,
  resolveBundledAllowlist,
  shouldIncludeSkill,
} from "./skills/config.js";
import type { SkillEntry } from "./skills/types.js";

const referencingOwners = [
  "wacli",
  "telegram-user",
  "gog",
  "himalaya",
  "imsg",
  "bluebubbles",
  "slack",
  "discord",
  "cross-channel-triage",
] as const;

const tempDirs: string[] = [];

function makeBundledEntry(name: string): SkillEntry {
  return {
    skill: {
      name,
      description: `Bundled ${name}`,
      filePath: `/bundled/${name}/SKILL.md`,
      baseDir: `/bundled/${name}`,
      source: "openclaw-bundled",
      disableModelInvocation: false,
    },
    frontmatter: {},
  };
}

async function createBundledFixture(names: readonly string[]) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-dependency-"));
  const bundledSkillsDir = path.join(workspaceDir, ".bundled");
  tempDirs.push(workspaceDir);

  for (const name of names) {
    await writeSkill({
      dir: path.join(bundledSkillsDir, name),
      name,
      description: `Bundled ${name}`,
    });
  }

  return { workspaceDir, bundledSkillsDir };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("message-drafting bundled allowlist dependency", () => {
  it.each(referencingOwners)("%s closes over message-drafting", (owner) => {
    const config: OpenClawConfig = { skills: { allowBundled: [owner] } };

    expect(resolveBundledAllowlist(config)).toEqual([owner, "message-drafting"]);
  });

  it("exposes the dependency for a non-consumer custom allowlist", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
      "wacli",
      "message-drafting",
    ]);
    const config: OpenClawConfig = { skills: { allowBundled: ["wacli"] } };

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config,
    });

    expect(prompt).toContain("<name>wacli</name>");
    expect(prompt).toContain("<name>message-drafting</name>");
    expect(config.skills?.allowBundled).toEqual(["wacli"]);
  });

  it("keeps repeated resolver and evaluator calls in memory without broadening config", () => {
    const config: OpenClawConfig = { skills: { allowBundled: ["wacli"] } };
    Object.freeze(config.skills?.allowBundled);
    Object.freeze(config.skills);
    Object.freeze(config);
    const messageDrafting = makeBundledEntry("message-drafting");

    expect(resolveBundledAllowlist(config)).toEqual(["wacli", "message-drafting"]);
    expect(evaluateSkillEntry({ entry: messageDrafting, config }).blockedByAllowlist).toBe(false);
    expect(shouldIncludeSkill({ entry: messageDrafting, config })).toBe(true);
    expect(resolveBundledAllowlist(config)).toEqual(["wacli", "message-drafting"]);
    expect(config.skills?.allowBundled).toEqual(["wacli"]);
  });

  it("keeps an explicitly disabled message-drafting skill hidden", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
      "wacli",
      "message-drafting",
    ]);
    const config: OpenClawConfig = {
      skills: {
        allowBundled: ["wacli"],
        entries: { "message-drafting": { enabled: false } },
      },
    };
    const messageDrafting = makeBundledEntry("message-drafting");

    expect(resolveBundledAllowlist(config)).toEqual(["wacli", "message-drafting"]);
    expect(evaluateSkillEntry({ entry: messageDrafting, config }).disabled).toBe(true);
    expect(shouldIncludeSkill({ entry: messageDrafting, config })).toBe(false);

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config,
    });
    expect(prompt).toContain("<name>wacli</name>");
    expect(prompt).not.toContain("<name>message-drafting</name>");
  });

  it("leaves unrelated custom allowlists unchanged", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
      "custom-skill",
      "message-drafting",
    ]);
    const config: OpenClawConfig = { skills: { allowBundled: ["custom-skill"] } };

    expect(resolveBundledAllowlist(config)).toEqual(["custom-skill"]);

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config,
    });
    expect(prompt).toContain("<name>custom-skill</name>");
    expect(prompt).not.toContain("<name>message-drafting</name>");
  });

  it("keeps the __none__ sentinel restrictive", () => {
    const config: OpenClawConfig = {
      skills: { allowBundled: ["__none__", "wacli"] },
    };

    expect(resolveBundledAllowlist(config)).toEqual(["__none__", "wacli"]);
    expect(shouldIncludeSkill({ entry: makeBundledEntry("wacli"), config })).toBe(false);
    expect(shouldIncludeSkill({ entry: makeBundledEntry("message-drafting"), config })).toBe(false);
  });
});
