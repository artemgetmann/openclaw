import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkspaceSkillStatus } from "./skills-status.js";
import { loadWorkspaceSkillEntries } from "./skills.js";

const tempDirs: string[] = [];

async function createTempWorkspaceDir() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-what-can-you-do-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("what-can-you-do bundled skill", () => {
  it("loads as a bundled always-on skill and stays non-user-invocable", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(process.cwd(), "skills"),
    });

    const entry = entries.find((candidate) => candidate.skill.name === "what-can-you-do");
    expect(entry).toBeDefined();
    expect(entry?.metadata?.always).toBe(true);
    expect(entry?.invocation?.userInvocable).toBe(false);
    expect(entry?.skill.description).toContain("what can you do?");

    const report = buildWorkspaceSkillStatus(workspaceDir, { entries });
    const skill = report.skills.find((candidate) => candidate.name === "what-can-you-do");
    expect(skill?.eligible).toBe(true);
  });
});
