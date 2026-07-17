import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillSnapshot, buildWorkspaceSkillsPrompt } from "./skills.js";
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

  it("closes scoped prompt and snapshot filters without mutating the requested filter", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
      "wacli",
      "message-drafting",
      "custom-skill",
    ]);
    const skillFilter = ["wacli"];
    const options = {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      skillFilter,
    };

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, options);
    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, options);
    const repeatedPrompt = buildWorkspaceSkillsPrompt(workspaceDir, options);

    expect(prompt).toContain("<name>wacli</name>");
    expect(prompt).toContain("<name>message-drafting</name>");
    expect(prompt).not.toContain("<name>custom-skill</name>");
    expect(snapshot.skills.map((skill) => skill.name).toSorted()).toEqual([
      "message-drafting",
      "wacli",
    ]);
    expect(snapshot.skillFilter).toEqual(["wacli"]);
    expect(repeatedPrompt).toBe(prompt);
    expect(skillFilter).toEqual(["wacli"]);
  });

  it("keeps the owner and dependency ahead of 149 workspace skills when prompts truncate", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
      "wacli",
      "message-drafting",
    ]);
    const workspaceSkillNames = Array.from(
      { length: 149 },
      (_, index) => `workspace-${String(index).padStart(3, "0")}`,
    );
    await Promise.all(
      workspaceSkillNames.map((name) =>
        writeSkill({
          dir: path.join(workspaceDir, "skills", name),
          name,
          description: `Workspace ${name}`,
        }),
      ),
    );
    const config: OpenClawConfig = {
      skills: {
        allowBundled: ["wacli"],
        limits: {
          maxSkillsInPrompt: 150,
          maxSkillsPromptChars: 100_000,
        },
      },
    };

    const allowlistSnapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config,
    });
    const skillFilter = [...workspaceSkillNames, "wacli"];
    const filterSnapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: {
        skills: {
          limits: {
            maxSkillsInPrompt: 150,
            maxSkillsPromptChars: 100_000,
          },
        },
      },
      skillFilter,
    });

    for (const snapshot of [allowlistSnapshot, filterSnapshot]) {
      expect(snapshot.prompt).toContain("<name>wacli</name>");
      expect(snapshot.prompt).toContain("<name>message-drafting</name>");
      expect(snapshot.prompt).toContain("Skills truncated");
      expect(snapshot.prompt).not.toContain("<name>workspace-148</name>");
    }
    expect(config.skills?.allowBundled).toEqual(["wacli"]);
    expect(filterSnapshot.skillFilter).toEqual(skillFilter);
    expect(skillFilter).not.toContain("message-drafting");
  });

  it("keeps an explicitly disabled dependency hidden from scoped filters", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
      "wacli",
      "message-drafting",
    ]);

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      skillFilter: ["wacli"],
      config: {
        skills: {
          entries: { "message-drafting": { enabled: false } },
        },
      },
    });

    expect(prompt).toContain("<name>wacli</name>");
    expect(prompt).not.toContain("<name>message-drafting</name>");
  });

  it("keeps unrelated, __none__, and empty scoped filters restrictive", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
      "wacli",
      "message-drafting",
      "custom-skill",
    ]);
    const baseOptions = {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    };

    const unrelatedPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      ...baseOptions,
      skillFilter: ["custom-skill"],
    });
    const nonePrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      ...baseOptions,
      skillFilter: ["__none__", "wacli"],
    });
    const emptyPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      ...baseOptions,
      skillFilter: [],
    });

    expect(unrelatedPrompt).toContain("<name>custom-skill</name>");
    expect(unrelatedPrompt).not.toContain("<name>message-drafting</name>");
    expect(nonePrompt).toBe("");
    expect(emptyPrompt).toBe("");
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
