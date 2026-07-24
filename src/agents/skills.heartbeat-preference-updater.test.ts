import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkspaceSkillsPrompt, loadWorkspaceSkillEntries } from "./skills.js";

const tempDirs: string[] = [];

async function createTempWorkspaceDir() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-skill-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("heartbeat-preference-updater bundled skill", () => {
  it("loads as an always-available natural-language config preference", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const bundledSkillsDir = path.join(process.cwd(), "skills");
    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir,
    });
    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir,
    });
    const entry = entries.find(
      (candidate) => candidate.skill.name === "heartbeat-preference-updater",
    );

    expect(entry).toBeDefined();
    expect(entry?.skill.source).toBe("openclaw-bundled");
    expect(entry?.metadata?.always).toBe(true);
    expect(entry?.invocation?.userInvocable).toBe(false);
    expect(entry?.skill.description).toContain("don't nudge me before 11");
    expect(entry?.skill.description).toContain("config.patch");
    expect(prompt).toContain("heartbeat-preference-updater");
    expect(prompt).toContain("weekends");
  });
});
