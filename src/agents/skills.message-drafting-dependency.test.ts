import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillsPrompt } from "./skills.js";

const tempDirs: string[] = [];

async function createBundledSkills(names: string[]) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-message-drafting-"));
  tempDirs.push(workspaceDir);
  const bundledSkillsDir = path.join(workspaceDir, ".bundled");

  for (const name of names) {
    await writeSkill({
      dir: path.join(bundledSkillsDir, name),
      name,
      description: `${name} bundled skill`,
    });
  }
  return { workspaceDir, bundledSkillsDir };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("message-drafting bundled dependency", () => {
  const dependentSkills = [
    "cross-channel-triage",
    "wacli",
    "telegram-user",
    "gog",
    "himalaya",
    "imsg",
    "bluebubbles",
    "slack",
    "discord",
  ];

  it.each(dependentSkills)(
    "expands a custom %s allowlist without mutating config",
    async (dependentSkill) => {
      const { workspaceDir, bundledSkillsDir } = await createBundledSkills([
        dependentSkill,
        "message-drafting",
        "peekaboo",
      ]);
      const config: OpenClawConfig = {
        skills: { allowBundled: [dependentSkill] },
      };

      const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
        bundledSkillsDir,
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config,
        skillFilter: [dependentSkill],
      });

      expect(prompt).toContain(`<name>${dependentSkill}</name>`);
      expect(prompt).toContain("<name>message-drafting</name>");
      expect(prompt).not.toContain("<name>peekaboo</name>");
      expect(config.skills?.allowBundled).toEqual([dependentSkill]);
    },
  );

  it("does not expand an unrelated custom allowlist", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledSkills([
      "telegram-user",
      "message-drafting",
      "peekaboo",
    ]);

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: { skills: { allowBundled: ["peekaboo"] } },
    });

    expect(prompt).toContain("<name>peekaboo</name>");
    expect(prompt).not.toContain("<name>telegram-user</name>");
    expect(prompt).not.toContain("<name>message-drafting</name>");
  });

  it("preserves empty and unrelated per-agent skill filters", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledSkills([
      "telegram-user",
      "message-drafting",
      "peekaboo",
    ]);
    const config: OpenClawConfig = {
      skills: { allowBundled: ["telegram-user", "peekaboo"] },
    };

    const emptyPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config,
      skillFilter: [],
    });
    const unrelatedPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config,
      skillFilter: ["peekaboo"],
    });

    expect(emptyPrompt).toBe("");
    expect(unrelatedPrompt).toContain("<name>peekaboo</name>");
    expect(unrelatedPrompt).not.toContain("<name>telegram-user</name>");
    expect(unrelatedPrompt).not.toContain("<name>message-drafting</name>");
  });

  it("keeps message-drafting ahead of unrelated prompt overflow", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledSkills([
      "telegram-user",
      "message-drafting",
    ]);
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "workspace-overflow"),
      name: "workspace-overflow",
      description: "Unrelated workspace skill",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      skillFilter: ["telegram-user", "workspace-overflow"],
      config: {
        skills: {
          limits: {
            maxSkillsInPrompt: 2,
            maxSkillsPromptChars: 2_000,
          },
        },
      },
    });

    expect(prompt).toContain("<name>telegram-user</name>");
    expect(prompt).toContain("<name>message-drafting</name>");
    expect(prompt).not.toContain("<name>workspace-overflow</name>");
    expect(prompt).toContain("Skills truncated: included 2 of 3");
  });
});
