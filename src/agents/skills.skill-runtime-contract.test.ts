import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONSUMER_DEFAULT_BUNDLED_SKILLS } from "./consumer-default-bundled-skills.js";
import { buildWorkspaceSkillsPrompt } from "./skills.js";

const tempDirs: string[] = [];

describe("skill-runtime bundled product contract", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0, tempDirs.length)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("ships the user-facing target semantics as a Jarvis consumer default", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-skill-runtime-contract-"),
    );
    tempDirs.push(workspaceDir);

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir: path.resolve("skills"),
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: { skills: { allowBundled: [...CONSUMER_DEFAULT_BUNDLED_SKILLS] } },
      skillFilter: ["skill-runtime"],
    });
    const markdown = await fs.readFile(path.resolve("skills/skill-runtime/SKILL.md"), "utf8");

    expect(CONSUMER_DEFAULT_BUNDLED_SKILLS).toContain("skill-runtime");
    expect(prompt).toContain("<name>skill-runtime</name>");
    expect(prompt).toContain("add this to your skills");
    expect(markdown).toContain("Codex, Jarvis, or both?");
    expect(markdown).toContain("openclaw skills runtime set <skill> shared|codex|jarvis");
    expect(markdown).toContain("Never copy the body");
  });
});
