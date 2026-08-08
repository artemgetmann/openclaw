import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkspaceSkillsPrompt } from "../agents/skills.js";
import { rollbackSharedPersonalSkillsManagedRoot } from "./onboard-shared-skills-rollback.js";
import { ensureSharedPersonalSkillsManagedRoot } from "./onboard-shared-skills-root.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-shared-skills-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`,
  );
}

describe("ensureSharedPersonalSkillsManagedRoot", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0, tempDirs.length)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("links an absent managed skills root for a fresh install", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");

    const result = ensureSharedPersonalSkillsManagedRoot({ homeDir, stateDir });

    expect(result.status).toBe("linked");
    expect(await fs.realpath(result.managedSkillsDir)).toBe(
      await fs.realpath(result.sharedSkillsDir),
    );
    await expect(fs.readFile(result.receiptPath!, "utf8")).resolves.toContain('"status": "linked"');
  });

  it("replaces an empty managed skills directory and remains idempotent", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");
    await fs.mkdir(path.join(stateDir, "skills"), { recursive: true });

    const first = ensureSharedPersonalSkillsManagedRoot({ homeDir, stateDir });
    const second = ensureSharedPersonalSkillsManagedRoot({ homeDir, stateDir });

    expect(first.status).toBe("linked");
    expect(second.status).toBe("already-linked");
    expect(second.receiptPath).toBeUndefined();
  });

  it("migrates unique legacy skills, retains an inactive backup, and links the canonical root", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");
    const managedSkillsDir = path.join(stateDir, "skills");
    await writeSkill(managedSkillsDir, "legacy-only", "legacy body");

    const result = ensureSharedPersonalSkillsManagedRoot({ homeDir, stateDir });

    expect(result.status).toBe("migrated");
    expect(await fs.realpath(managedSkillsDir)).toBe(await fs.realpath(result.sharedSkillsDir));
    await expect(
      fs.readFile(path.join(result.sharedSkillsDir, "legacy-only", "SKILL.md"), "utf8"),
    ).resolves.toContain("legacy body");
    await expect(
      fs.stat(path.join(result.backupDir!, "legacy-only", "SKILL.md")),
    ).resolves.toBeTruthy();
    await expect(fs.readFile(result.receiptPath!, "utf8")).resolves.toContain(
      '"status": "migrated"',
    );
  });

  it("makes a migrated canonical skill visible through the unchanged managed loader seam", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");
    const workspaceDir = path.join(homeDir, "workspace");
    const bundledDir = path.join(homeDir, "bundled");
    await writeSkill(path.join(stateDir, "skills"), "legacy-only", "migration visibility proof");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(bundledDir, { recursive: true });

    const migration = ensureSharedPersonalSkillsManagedRoot({ homeDir, stateDir });
    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: migration.managedSkillsDir,
      bundledSkillsDir: bundledDir,
    });

    expect(migration.status).toBe("migrated");
    expect(prompt).toContain("legacy-only");
    expect(prompt).toContain("migration visibility proof");
  });

  it("deduplicates identical same-name skills without overwriting the canonical body", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");
    const managedSkillsDir = path.join(stateDir, "skills");
    const sharedSkillsDir = path.join(homeDir, ".agents", "skills");
    await writeSkill(managedSkillsDir, "same", "identical");
    await writeSkill(sharedSkillsDir, "same", "identical");
    const before = await fs.readFile(path.join(sharedSkillsDir, "same", "SKILL.md"), "utf8");

    const result = ensureSharedPersonalSkillsManagedRoot({ homeDir, stateDir });

    expect(result.status).toBe("migrated");
    expect(result.inventory).toEqual([
      expect.objectContaining({ name: "same", action: "identical" }),
    ]);
    await expect(fs.readFile(path.join(sharedSkillsDir, "same", "SKILL.md"), "utf8")).resolves.toBe(
      before,
    );
  });

  it("keeps a conflicting legacy root active and records both content hashes", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");
    const managedSkillsDir = path.join(stateDir, "skills");
    const sharedSkillsDir = path.join(homeDir, ".agents", "skills");
    await writeSkill(managedSkillsDir, "conflict", "legacy");
    await writeSkill(sharedSkillsDir, "conflict", "canonical");

    const result = ensureSharedPersonalSkillsManagedRoot({ homeDir, stateDir });

    expect(result.status).toBe("compatibility-conflict");
    expect((await fs.lstat(managedSkillsDir)).isSymbolicLink()).toBe(false);
    expect(result.inventory).toEqual([
      expect.objectContaining({
        name: "conflict",
        action: "conflict",
        sourceHash: expect.any(String),
        targetHash: expect.any(String),
      }),
    ]);
    await expect(
      fs.readFile(path.join(managedSkillsDir, "conflict", "SKILL.md"), "utf8"),
    ).resolves.toContain("legacy");
  });

  it("keeps the legacy loader when the root contains unknown user content", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");
    const managedSkillsDir = path.join(stateDir, "skills");
    await fs.mkdir(managedSkillsDir, { recursive: true });
    await fs.writeFile(path.join(managedSkillsDir, "notes.txt"), "do not hide me");

    const result = ensureSharedPersonalSkillsManagedRoot({ homeDir, stateDir });

    expect(result.status).toBe("compatibility-unknown-content");
    expect(result.unknownEntries).toEqual(["notes.txt"]);
    await expect(fs.readFile(path.join(managedSkillsDir, "notes.txt"), "utf8")).resolves.toBe(
      "do not hide me",
    );
  });

  it("preserves a broken foreign managed-root symlink", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");
    const managedSkillsDir = path.join(stateDir, "skills");
    const foreignTarget = path.join(homeDir, "missing-legacy-skills");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.symlink(foreignTarget, managedSkillsDir, "dir");

    const result = ensureSharedPersonalSkillsManagedRoot({ homeDir, stateDir });

    expect(result.status).toBe("compatibility-foreign-link");
    expect(await fs.readlink(managedSkillsDir)).toBe(foreignTarget);
  });

  it("inventories a non-empty legacy workspace while preserving its scoped loader", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");
    const workspaceSkillsDir = path.join(stateDir, "workspace", "skills");
    await writeSkill(workspaceSkillsDir, "workspace-only", "workspace body");

    const result = ensureSharedPersonalSkillsManagedRoot({
      homeDir,
      stateDir,
      managedSkillsDir: workspaceSkillsDir,
      preserveNonEmpty: true,
    });

    expect(result.status).toBe("compatibility-legacy-root");
    expect(result.inventory).toMatchObject([{ name: "workspace-only", action: "copy" }]);
    expect((await fs.lstat(workspaceSkillsDir)).isDirectory()).toBe(true);
    await expect(
      fs.readFile(path.join(workspaceSkillsDir, "workspace-only", "SKILL.md"), "utf8"),
    ).resolves.toContain("workspace body");
    await expect(
      fs.stat(path.join(homeDir, ".agents", "skills", "workspace-only")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back copied skills and restores the original root after a partial cutover failure", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");
    const managedSkillsDir = path.join(stateDir, "skills");
    await writeSkill(managedSkillsDir, "legacy-only", "legacy body");

    const result = ensureSharedPersonalSkillsManagedRoot({
      homeDir,
      stateDir,
      beforeLink: () => {
        throw new Error("fixture link failure");
      },
    });

    expect(result.status).toBe("rolled-back");
    expect((await fs.lstat(managedSkillsDir)).isDirectory()).toBe(true);
    await expect(
      fs.stat(path.join(managedSkillsDir, "legacy-only", "SKILL.md")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(homeDir, ".agents", "skills", "legacy-only")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores a completed migration only from its exact unchanged receipt", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");
    const managedSkillsDir = path.join(stateDir, "skills");
    await writeSkill(managedSkillsDir, "legacy-only", "legacy body");
    const migrated = ensureSharedPersonalSkillsManagedRoot({ homeDir, stateDir });

    const rolledBack = rollbackSharedPersonalSkillsManagedRoot(migrated.receiptPath!, {
      homeDir,
      stateDir,
    });

    expect(rolledBack.status).toBe("rolled-back");
    expect((await fs.lstat(managedSkillsDir)).isDirectory()).toBe(true);
    await expect(
      fs.readFile(path.join(managedSkillsDir, "legacy-only", "SKILL.md"), "utf8"),
    ).resolves.toContain("legacy body");
    await expect(
      fs.stat(path.join(homeDir, ".agents", "skills", "legacy-only")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a forged rollback receipt before changing the active canonical link", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");
    const managedSkillsDir = path.join(stateDir, "skills");
    await writeSkill(managedSkillsDir, "legacy-only", "legacy body");
    const migrated = ensureSharedPersonalSkillsManagedRoot({ homeDir, stateDir });
    const receipt = JSON.parse(await fs.readFile(migrated.receiptPath!, "utf8")) as {
      introducedSkills: Array<{ name: string; hash: string }>;
    };
    receipt.introducedSkills[0].name = "../escape";
    await fs.writeFile(migrated.receiptPath!, `${JSON.stringify(receipt, null, 2)}\n`);

    expect(() =>
      rollbackSharedPersonalSkillsManagedRoot(migrated.receiptPath!, { homeDir, stateDir }),
    ).toThrow(/unsafe introduced skill/i);
    expect((await fs.lstat(managedSkillsDir)).isSymbolicLink()).toBe(true);
    await expect(fs.stat(migrated.backupDir!)).resolves.toBeTruthy();
  });

  it("refuses rollback after a canonical skill changed post-migration", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");
    const managedSkillsDir = path.join(stateDir, "skills");
    await writeSkill(managedSkillsDir, "legacy-only", "legacy body");
    const migrated = ensureSharedPersonalSkillsManagedRoot({ homeDir, stateDir });
    await fs.appendFile(
      path.join(migrated.sharedSkillsDir, "legacy-only", "SKILL.md"),
      "\npost-migration edit\n",
    );

    expect(() =>
      rollbackSharedPersonalSkillsManagedRoot(migrated.receiptPath!, { homeDir, stateDir }),
    ).toThrow(/changed after migration/i);
    expect((await fs.lstat(managedSkillsDir)).isSymbolicLink()).toBe(true);
    await expect(fs.stat(migrated.backupDir!)).resolves.toBeTruthy();
  });
});
