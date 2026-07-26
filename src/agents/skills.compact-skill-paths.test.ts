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
        source: "openclaw-workspace",
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

  it("uses a shorter canonical absolute path for symlink-backed workspace skills", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const targetDir = path.join(workspaceDir, "s");
      const targetSkillDir = path.join(targetDir, "shared-skill");
      const linkedSkillsDir = path.join(
        workspaceDir,
        "a-very-long-application-support-workspace-prefix",
        "skills",
      );
      await writeSkill({
        dir: targetSkillDir,
        name: "shared-skill",
        description: "Shared personal skill",
      });
      await fs.mkdir(path.dirname(linkedSkillsDir), { recursive: true });
      await fs.symlink(targetDir, linkedSkillsDir, "dir");

      const linkedFilePath = path.join(linkedSkillsDir, "shared-skill", "SKILL.md");
      const canonicalFilePath = await fs.realpath(linkedFilePath);
      const entry: SkillEntry = {
        skill: {
          name: "shared-skill",
          description: "Shared personal skill",
          filePath: linkedFilePath,
          baseDir: path.dirname(linkedFilePath),
          source: "openclaw-workspace",
          disableModelInvocation: false,
        },
        frontmatter: {},
      };

      const prompt = buildWorkspaceSkillsPrompt(workspaceDir, { entries: [entry] });

      expect(prompt).toContain(`<location>${canonicalFilePath}</location>`);
      expect(prompt).not.toContain(linkedFilePath);
      expect(prompt).not.toContain("<location>~/");
    });
  });

  it("keeps product-managed and bundled skill locations absolute under the home directory", () => {
    const home = os.homedir();
    const productPath = path.join(
      home,
      "Library",
      "Application Support",
      "Jarvis",
      ".jarvis",
      "product-skills",
      "telegram-user",
      "SKILL.md",
    );
    const bundledPath = path.join(
      home,
      "Library",
      "Application Support",
      "Jarvis",
      ".jarvis",
      "lib",
      "openclaw-bundled",
      "skills",
      "jarvis-computer-use",
      "SKILL.md",
    );
    const entries: SkillEntry[] = [
      {
        skill: {
          name: "telegram-user",
          description: "Telegram as me",
          filePath: productPath,
          baseDir: path.dirname(productPath),
          source: "openclaw-product-managed",
          disableModelInvocation: false,
        },
        frontmatter: {},
      },
      {
        skill: {
          name: "jarvis-computer-use",
          description: "Jarvis Computer Use",
          filePath: bundledPath,
          baseDir: path.dirname(bundledPath),
          source: "openclaw-bundled",
          disableModelInvocation: false,
        },
        frontmatter: {},
      },
    ];

    const prompt = buildWorkspaceSkillsPrompt(
      path.join(home, "Library", "Application Support", "Jarvis", ".jarvis", "workspace"),
      {
        entries,
      },
    );

    expect(prompt).toContain(productPath);
    expect(prompt).toContain(bundledPath);
    expect(prompt).not.toContain("<location>~/Library/Application Support/Jarvis");
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
