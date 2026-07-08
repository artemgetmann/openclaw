import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { generateCodexSkillPluginProjection } from "./skills/codex-plugin-projection.js";

const tempDirs = createTrackedTempDirs();

async function writeSkillFixture(params: {
  root: string;
  dirName: string;
  name: string;
  description?: string;
}) {
  const skillDir = path.join(params.root, params.dirName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${params.name}`,
      `description: ${params.description ?? "Projected skill"}`,
      "---",
      "",
      `# ${params.name}`,
      "",
    ].join("\n"),
    "utf-8",
  );
  return {
    name: params.name,
    description: params.description ?? "Projected skill",
    baseDir: skillDir,
    filePath: path.join(skillDir, "SKILL.md"),
  };
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
}

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("generateCodexSkillPluginProjection", () => {
  it("writes a Codex plugin manifest with a native skills root", async () => {
    const sourceRoot = await tempDirs.make("openclaw-codex-skill-source-");
    const outDir = await tempDirs.make("openclaw-codex-skill-projection-");
    const skill = await writeSkillFixture({
      root: sourceRoot,
      dirName: "demo",
      name: "demo",
    });

    const result = await generateCodexSkillPluginProjection({
      outDir,
      skills: [skill],
    });

    expect(result.pluginManifestPath).toBe(
      path.join(outDir, "plugins", "openclaw-skills", ".codex-plugin", "plugin.json"),
    );
    const manifest = await readJson(result.pluginManifestPath);
    expect(manifest).toMatchObject({
      name: "openclaw-skills",
      skills: "./skills/",
    });
    expect(await readJson(path.join(outDir, "marketplace.json"))).toMatchObject({
      plugins: [
        {
          name: "openclaw-skills",
          source: { source: "local", path: "./plugins/openclaw-skills" },
        },
      ],
    });
  });

  it("copies SKILL.md and relative resource files from each skill folder", async () => {
    const sourceRoot = await tempDirs.make("openclaw-codex-skill-source-");
    const outDir = await tempDirs.make("openclaw-codex-skill-projection-");
    const skill = await writeSkillFixture({
      root: sourceRoot,
      dirName: "research",
      name: "research",
    });
    await fs.mkdir(path.join(skill.baseDir, "references"), { recursive: true });
    await fs.mkdir(path.join(skill.baseDir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(skill.baseDir, "references", "guide.md"), "# Guide\n", "utf-8");
    await fs.writeFile(path.join(skill.baseDir, "scripts", "run.mjs"), "export {}\n", "utf-8");
    await fs.writeFile(path.join(skill.baseDir, ".env"), "SECRET=do-not-copy\n", "utf-8");

    const result = await generateCodexSkillPluginProjection({
      outDir,
      skills: [skill],
    });
    const targetDir = result.projectedSkills[0]?.targetDir;

    await expect(fs.readFile(path.join(targetDir, "SKILL.md"), "utf-8")).resolves.toContain(
      "name: research",
    );
    await expect(
      fs.readFile(path.join(targetDir, "references", "guide.md"), "utf-8"),
    ).resolves.toBe("# Guide\n");
    await expect(fs.readFile(path.join(targetDir, "scripts", "run.mjs"), "utf-8")).resolves.toBe(
      "export {}\n",
    );
    await expect(fs.access(path.join(targetDir, ".env"))).rejects.toThrow();
  });

  it("projects duplicate and suspicious names into safe unique directories", async () => {
    const sourceRoot = await tempDirs.make("openclaw-codex-skill-source-");
    const outDir = await tempDirs.make("openclaw-codex-skill-projection-");
    const skills = [
      await writeSkillFixture({ root: sourceRoot, dirName: "one", name: "../Demo" }),
      await writeSkillFixture({ root: sourceRoot, dirName: "two", name: "demo" }),
      await writeSkillFixture({ root: sourceRoot, dirName: "three", name: "!!!" }),
      await writeSkillFixture({ root: sourceRoot, dirName: "four", name: "Demo" }),
    ];

    const result = await generateCodexSkillPluginProjection({
      outDir,
      skills,
    });

    expect(result.projectedSkills.map((skill) => skill.targetDirName)).toEqual([
      "demo",
      "demo-2",
      "skill",
      "demo-3",
    ]);
    for (const projected of result.projectedSkills) {
      await expect(fs.access(path.join(projected.targetDir, "SKILL.md"))).resolves.toBeUndefined();
      expect(projected.targetDir.startsWith(result.skillsRoot)).toBe(true);
    }
  });

  it("rejects a skill folder containing a symlink escape", async () => {
    const sourceRoot = await tempDirs.make("openclaw-codex-skill-source-");
    const outsideRoot = await tempDirs.make("openclaw-codex-skill-outside-");
    const outDir = await tempDirs.make("openclaw-codex-skill-projection-");
    const skill = await writeSkillFixture({
      root: sourceRoot,
      dirName: "escape",
      name: "escape",
    });
    const secretPath = path.join(outsideRoot, "secret.txt");
    await fs.writeFile(secretPath, "nope\n", "utf-8");
    await fs.symlink(secretPath, path.join(skill.baseDir, "leak.txt"));

    await expect(
      generateCodexSkillPluginProjection({
        outDir,
        skills: [skill],
      }),
    ).rejects.toThrow(/outside skill directory/);

    await expect(
      fs.readFile(
        path.join(outDir, "plugins", "openclaw-skills", "skills", "escape", "leak.txt"),
        "utf-8",
      ),
    ).rejects.toThrow();
  });
});
