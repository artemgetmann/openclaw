import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSharedPersonalSkillsManagedRoot } from "./onboard-shared-skills-root.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-shared-skills-"));
  tempDirs.push(dir);
  return dir;
}

describe("ensureSharedPersonalSkillsManagedRoot", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0, tempDirs.length)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("links an absent OpenClaw managed skills root to ~/.agents/skills", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");

    const result = ensureSharedPersonalSkillsManagedRoot({ homeDir, stateDir });

    expect(result.status).toBe("linked");
    expect(await fs.realpath(result.managedSkillsDir)).toBe(
      await fs.realpath(result.sharedSkillsDir),
    );
  });

  it("replaces an empty managed skills directory with the shared skills link", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");
    await fs.mkdir(path.join(stateDir, "skills"), { recursive: true });

    const result = ensureSharedPersonalSkillsManagedRoot({ homeDir, stateDir });

    expect(result.status).toBe("linked");
    expect(await fs.realpath(result.managedSkillsDir)).toBe(
      await fs.realpath(result.sharedSkillsDir),
    );
  });

  it("leaves a non-empty managed skills directory untouched", async () => {
    const homeDir = await tempDir();
    const stateDir = path.join(homeDir, ".openclaw");
    const managedSkillsDir = path.join(stateDir, "skills");
    await fs.mkdir(path.join(managedSkillsDir, "existing"), { recursive: true });
    await fs.writeFile(path.join(managedSkillsDir, "existing", "SKILL.md"), "# Existing\n");

    const result = ensureSharedPersonalSkillsManagedRoot({ homeDir, stateDir });

    expect(result.status).toBe("skipped-non-empty");
    expect((await fs.lstat(managedSkillsDir)).isSymbolicLink()).toBe(false);
    await expect(
      fs.readFile(path.join(managedSkillsDir, "existing", "SKILL.md"), "utf8"),
    ).resolves.toContain("Existing");
  });
});
