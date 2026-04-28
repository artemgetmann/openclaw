import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWorkspaceSkillsPrompt } from "./skills.js";
import { writeSkill } from "./skills.test-helpers.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function buildSkillsPrompt(workspaceDir: string, managedDir: string, bundledDir: string): string {
  return buildWorkspaceSkillsPrompt(workspaceDir, {
    managedSkillsDir: managedDir,
    bundledSkillsDir: bundledDir,
  });
}

async function createWorkspaceSkillDirs() {
  const workspaceDir = await createTempDir("openclaw-");
  return {
    workspaceDir,
    managedDir: path.join(workspaceDir, ".managed"),
    bundledDir: path.join(workspaceDir, ".bundled"),
  };
}

describe("buildWorkspaceSkillsPrompt — .agents/skills/ directories", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0, tempDirs.length)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("loads project .agents/skills/ above managed and below workspace", async () => {
    const { workspaceDir, managedDir, bundledDir } = await createWorkspaceSkillDirs();

    await writeSkill({
      dir: path.join(managedDir, "shared-skill"),
      name: "shared-skill",
      description: "Managed version",
    });
    await writeSkill({
      dir: path.join(workspaceDir, ".agents", "skills", "shared-skill"),
      name: "shared-skill",
      description: "Project agents version",
    });

    // project .agents/skills/ wins over managed
    const prompt1 = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt1).toContain("Project agents version");
    expect(prompt1).not.toContain("Managed version");

    // workspace wins over project .agents/skills/
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "shared-skill"),
      name: "shared-skill",
      description: "Workspace version",
    });

    const prompt2 = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt2).toContain("Workspace version");
    expect(prompt2).not.toContain("Project agents version");
  });

  it("does not load personal ~/.agents/skills directly", async () => {
    const { workspaceDir, managedDir, bundledDir } = await createWorkspaceSkillDirs();
    const fakeHome = await createTempDir("openclaw-home-");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    await writeSkill({
      dir: path.join(managedDir, "shared-skill"),
      name: "shared-skill",
      description: "Managed version",
    });
    await writeSkill({
      dir: path.join(fakeHome, ".agents", "skills", "shared-skill"),
      name: "shared-skill",
      description: "Personal agents version",
    });

    const prompt1 = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt1).toContain("Managed version");
    expect(prompt1).not.toContain("Personal agents version");

    await writeSkill({
      dir: path.join(workspaceDir, ".agents", "skills", "shared-skill"),
      name: "shared-skill",
      description: "Project agents version",
    });

    const prompt2 = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt2).toContain("Project agents version");
    expect(prompt2).not.toContain("Managed version");
  });

  it("loads shared personal skills through the managed root symlink", async () => {
    const { workspaceDir, managedDir, bundledDir } = await createWorkspaceSkillDirs();
    const sharedRoot = await createTempDir("openclaw-shared-skills-");
    await writeSkill({
      dir: path.join(sharedRoot, "shared-personal"),
      name: "shared-personal",
      description: "Shared personal skill",
    });
    await fs.symlink(sharedRoot, managedDir, "dir");

    const prompt = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt).toContain("shared-personal");
    expect(prompt).toContain("Shared personal skill");
  });

  it("loads unique skills from managed, project .agents/skills, and workspace roots", async () => {
    const { workspaceDir, managedDir, bundledDir } = await createWorkspaceSkillDirs();

    await writeSkill({
      dir: path.join(managedDir, "managed-only"),
      name: "managed-only",
      description: "Managed only skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, ".agents", "skills", "project-only"),
      name: "project-only",
      description: "Project only skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "workspace-only"),
      name: "workspace-only",
      description: "Workspace only skill",
    });

    const prompt = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt).toContain("managed-only");
    expect(prompt).toContain("project-only");
    expect(prompt).toContain("workspace-only");
  });
});
