import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkspaceSkillsPrompt, loadWorkspaceSkillEntries } from "./skills.js";

const tempDirs: string[] = [];

async function createTempWorkspaceDir() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-timezone-skill-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("timezone-preference-updater bundled skill", () => {
  it("loads as a bundled model-facing skill for main and tester workspaces", async () => {
    const mainWorkspaceDir = await createTempWorkspaceDir();
    const testerWorkspaceDir = await createTempWorkspaceDir();
    const bundledSkillsDir = path.join(process.cwd(), "skills");

    const mainEntries = loadWorkspaceSkillEntries(mainWorkspaceDir, {
      managedSkillsDir: path.join(mainWorkspaceDir, ".managed"),
      bundledSkillsDir,
    });
    const testerPrompt = buildWorkspaceSkillsPrompt(testerWorkspaceDir, {
      managedSkillsDir: path.join(testerWorkspaceDir, ".managed"),
      bundledSkillsDir,
    });

    const entry = mainEntries.find(
      (candidate) => candidate.skill.name === "timezone-preference-updater",
    );

    expect(entry).toBeDefined();
    expect(entry?.skill.source).toBe("openclaw-bundled");
    expect(entry?.metadata?.always).toBe(true);
    expect(entry?.invocation?.userInvocable).toBe(false);
    expect(entry?.skill.description).toContain("I'm in Tokyo");
    expect(entry?.skill.description).toContain("agents.defaults.userTimezone");
    expect(entry?.skill.description).toContain("config.patch");

    expect(testerPrompt).toContain("timezone-preference-updater");
    expect(testerPrompt).toContain("my timezone is Singapore");
  });
});
