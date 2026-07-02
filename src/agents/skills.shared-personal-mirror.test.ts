import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import {
  hashSharedSkillDirectory,
  syncBundledSkillsToSharedPersonalRoot,
} from "./skills/shared-personal-mirror.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-shared-skill-mirror-"));
  tempDirs.push(dir);
  return dir;
}

async function readSkillBody(skillDir: string): Promise<string> {
  return fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
}

describe("syncBundledSkillsToSharedPersonalRoot", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0, tempDirs.length)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("copies bundled skills into the shared personal skills root with markers", async () => {
    const root = await tempDir();
    const bundledSkillsDir = path.join(root, "bundled");
    const sharedSkillsDir = path.join(root, "shared");
    await writeSkill({
      dir: path.join(bundledSkillsDir, "telegram-user"),
      name: "telegram-user",
      description: "Telegram as me",
      body: "# Telegram User\n",
    });
    await writeSkill({
      dir: path.join(bundledSkillsDir, "wacli"),
      name: "wacli",
      description: "WhatsApp as me",
      body: "# Wacli\n",
    });

    const result = await syncBundledSkillsToSharedPersonalRoot({
      bundledSkillsDir,
      sharedSkillsDir,
    });

    expect(result.entries.map((entry) => [entry.name, entry.status])).toEqual([
      ["telegram-user", "copied"],
      ["wacli", "copied"],
    ]);
    await expect(readSkillBody(path.join(sharedSkillsDir, "telegram-user"))).resolves.toContain(
      "# Telegram User",
    );
    await expect(
      fs.readFile(path.join(sharedSkillsDir, "telegram-user", ".openclaw-skill.json"), "utf8"),
    ).resolves.toContain('"source": "openclaw-bundled"');
  });

  it("updates clean managed mirrors when the bundled skill changes", async () => {
    const root = await tempDir();
    const bundledSkillsDir = path.join(root, "bundled");
    const sharedSkillsDir = path.join(root, "shared");
    const bundledSkillDir = path.join(bundledSkillsDir, "telegram-user");
    const sharedSkillDir = path.join(sharedSkillsDir, "telegram-user");
    await writeSkill({
      dir: bundledSkillDir,
      name: "telegram-user",
      description: "Telegram as me",
      body: "# Before\n",
    });
    await syncBundledSkillsToSharedPersonalRoot({ bundledSkillsDir, sharedSkillsDir });

    await writeSkill({
      dir: bundledSkillDir,
      name: "telegram-user",
      description: "Telegram as me",
      body: "# After\n",
    });
    const result = await syncBundledSkillsToSharedPersonalRoot({
      bundledSkillsDir,
      sharedSkillsDir,
    });

    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "telegram-user", status: "updated" }),
      ]),
    );
    await expect(readSkillBody(sharedSkillDir)).resolves.toContain("# After");
  });

  it("skips local overrides instead of overwriting them", async () => {
    const root = await tempDir();
    const bundledSkillsDir = path.join(root, "bundled");
    const sharedSkillsDir = path.join(root, "shared");
    const sharedSkillDir = path.join(sharedSkillsDir, "telegram-user");
    await writeSkill({
      dir: path.join(bundledSkillsDir, "telegram-user"),
      name: "telegram-user",
      description: "Telegram as me",
      body: "# Bundled\n",
    });
    await writeSkill({
      dir: sharedSkillDir,
      name: "telegram-user",
      description: "Local override",
      body: "# Local\n",
    });

    const result = await syncBundledSkillsToSharedPersonalRoot({
      bundledSkillsDir,
      sharedSkillsDir,
    });

    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "telegram-user", status: "skipped-local" }),
      ]),
    );
    await expect(readSkillBody(sharedSkillDir)).resolves.toContain("# Local");
  });

  it("overwrites a local override only when that skill is explicitly forced", async () => {
    const root = await tempDir();
    const bundledSkillsDir = path.join(root, "bundled");
    const sharedSkillsDir = path.join(root, "shared");
    const sharedSkillDir = path.join(sharedSkillsDir, "telegram-user");
    await writeSkill({
      dir: path.join(bundledSkillsDir, "telegram-user"),
      name: "telegram-user",
      description: "Telegram as me",
      body: "# Bundled\n",
    });
    await writeSkill({
      dir: sharedSkillDir,
      name: "telegram-user",
      description: "Local override",
      body: "# Local\n",
    });

    const result = await syncBundledSkillsToSharedPersonalRoot({
      bundledSkillsDir,
      sharedSkillsDir,
      forceSkillNames: ["telegram-user"],
    });

    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "telegram-user", status: "forced" }),
      ]),
    );
    await expect(readSkillBody(sharedSkillDir)).resolves.toContain("# Bundled");
  });

  it("adopts existing matching copies and ignores the marker when hashing", async () => {
    const root = await tempDir();
    const bundledSkillsDir = path.join(root, "bundled");
    const sharedSkillsDir = path.join(root, "shared");
    const bundledSkillDir = path.join(bundledSkillsDir, "wacli");
    const sharedSkillDir = path.join(sharedSkillsDir, "wacli");
    await writeSkill({
      dir: bundledSkillDir,
      name: "wacli",
      description: "WhatsApp as me",
      body: "# Wacli\n",
    });
    await fs.cp(bundledSkillDir, sharedSkillDir, { recursive: true });

    const result = await syncBundledSkillsToSharedPersonalRoot({
      bundledSkillsDir,
      sharedSkillsDir,
    });
    const hashBefore = hashSharedSkillDirectory(sharedSkillDir);
    await fs.writeFile(
      path.join(sharedSkillDir, ".openclaw-skill.json"),
      '{"version":1,"source":"openclaw-bundled","bundledTreeHash":"different","updatedAt":"now"}\n',
      "utf8",
    );

    expect(result.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "wacli", status: "adopted" })]),
    );
    expect(hashSharedSkillDirectory(sharedSkillDir)).toBe(hashBefore);
  });

  it("refreshes stale markers when the target already matches bundled content", async () => {
    const root = await tempDir();
    const bundledSkillsDir = path.join(root, "bundled");
    const sharedSkillsDir = path.join(root, "shared");
    const bundledSkillDir = path.join(bundledSkillsDir, "wacli");
    const sharedSkillDir = path.join(sharedSkillsDir, "wacli");
    await writeSkill({
      dir: bundledSkillDir,
      name: "wacli",
      description: "WhatsApp as me",
      body: "# Wacli\n",
    });
    await fs.cp(bundledSkillDir, sharedSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(sharedSkillDir, ".openclaw-skill.json"),
      '{"version":1,"source":"openclaw-bundled","bundledTreeHash":"stale","updatedAt":"now"}\n',
      "utf8",
    );

    const result = await syncBundledSkillsToSharedPersonalRoot({
      bundledSkillsDir,
      sharedSkillsDir,
    });

    expect(result.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "wacli", status: "current" })]),
    );
    await expect(
      fs.readFile(path.join(sharedSkillDir, ".openclaw-skill.json"), "utf8"),
    ).resolves.not.toContain('"bundledTreeHash": "stale"');
  });
});
