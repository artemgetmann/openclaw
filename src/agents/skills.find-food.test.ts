import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONSUMER_DEFAULT_BUNDLED_SKILLS } from "./consumer-default-bundled-skills.js";
import { buildWorkspaceSkillStatus } from "./skills-status.js";
import { buildWorkspaceSkillsPrompt, loadWorkspaceSkillEntries } from "./skills.js";

const tempDirs: string[] = [];

async function createTempWorkspaceDir() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-find-food-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("find-food bundled skill", () => {
  it("is a visible consumer default with parsed product metadata", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const bundledSkillsDir = path.join(process.cwd(), "skills");
    const config = {
      skills: { allowBundled: [...CONSUMER_DEFAULT_BUNDLED_SKILLS] },
    };
    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir,
    });

    expect(CONSUMER_DEFAULT_BUNDLED_SKILLS).toContain("find-food");

    const entry = entries.find((candidate) => candidate.skill.name === "find-food");
    expect(entry).toBeDefined();
    expect(entry?.skill.source).toBe("openclaw-bundled");
    expect(entry?.metadata?.displayName).toBe("Find Something to Eat");
    expect(entry?.invocation?.userInvocable).toBe(true);
    expect(entry?.invocation?.disableModelInvocation).toBe(false);
    expect(entry?.skill.description).toContain("what should I eat?");
    expect(entry?.skill.description).toContain("menu photo");
    expect(entry?.skill.description).toContain("restaurant or cafe nearby");

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      config,
      entries,
    });
    const skillPath = path.join(bundledSkillsDir, "find-food", "SKILL.md");
    expect(prompt).toContain("find-food");
    expect(prompt).toContain("compare delivery options");
    // Bundled paths stay absolute so app-managed runtimes can resolve them
    // even when the runtime itself lives under the user's home directory.
    expect(prompt).toContain(skillPath);

    const report = buildWorkspaceSkillStatus(workspaceDir, { entries });
    const skill = report.skills.find((candidate) => candidate.name === "find-food");
    expect(skill?.displayName).toBe("Find Something to Eat");
    expect(skill?.eligible).toBe(true);
  });
});
