import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillsPrompt } from "./skills.js";
import { writeSkill } from "./skills.test-helpers.js";
import type { SkillEntry } from "./skills/types.js";

async function withTempWorkspace(run: (workspaceDir: string) => Promise<void>) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-"));
  try {
    await run(workspaceDir);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

describe("compactSkillPaths", () => {
  it("replaces home directory prefix with ~ for non-workspace skill locations", () => {
    const home = os.homedir();
    const entry: SkillEntry = {
      skill: {
        name: "managed-skill",
        description: "A managed skill for path compaction",
        filePath: path.join(home, ".openclaw", "skills", "managed-skill", "SKILL.md"),
        baseDir: path.join(home, ".openclaw", "skills", "managed-skill"),
        source: "managed",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };

    const prompt = buildWorkspaceSkillsPrompt("/tmp/openclaw-workspace", {
      entries: [entry],
    });

    expect(prompt).toContain("~/");
    expect(prompt).not.toContain(home + path.sep);
    expect(prompt).toContain("managed-skill");
    expect(prompt).toContain("A managed skill for path compaction");
  });

  it("keeps workspace skill locations absolute under the home directory", () => {
    const home = os.homedir();
    const filePath = path.join(home, ".openclaw", "workspace", "skills", "wacli", "SKILL.md");
    const entry: SkillEntry = {
      skill: {
        name: "wacli",
        description: "WhatsApp helper",
        filePath,
        baseDir: path.dirname(filePath),
        source: "workspace",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };

    const prompt = buildWorkspaceSkillsPrompt(path.join(home, ".openclaw", "workspace"), {
      entries: [entry],
    });

    expect(prompt).toContain(filePath);
    expect(prompt).not.toContain("<location>~/");
  });

  it("preserves paths outside home directory", async () => {
    // Skills outside ~ should keep their absolute paths
    await withTempWorkspace(async (workspaceDir) => {
      const skillDir = path.join(workspaceDir, "skills", "ext-skill");

      await writeSkill({
        dir: skillDir,
        name: "ext-skill",
        description: "External skill",
      });

      const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
        bundledSkillsDir: path.join(workspaceDir, ".bundled-empty"),
        managedSkillsDir: path.join(workspaceDir, ".managed-empty"),
      });

      // Should still contain a valid location tag
      expect(prompt).toMatch(/<location>[^<]+SKILL\.md<\/location>/);
    });
  });
});
