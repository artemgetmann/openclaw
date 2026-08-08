import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildTemporaryCodexSkillInjectionArgs,
  getPersonalSkillVisibilityStatus,
  runWithTemporaryCodexSkill,
  setPersonalSkillVisibility,
} from "./skills/personal-skill-runtime.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-runtime-"));
  tempDirs.push(dir);
  return dir;
}

describe("personal skill runtime visibility", () => {
  let homeDir: string;
  let stateDir: string;
  let sharedSkillsDir: string;
  let managedSkillsDir: string;
  let skillFile: string;
  let codexConfigPath: string;
  let config: OpenClawConfig;
  let writeJarvisConfig: ReturnType<typeof vi.fn<(next: OpenClawConfig) => Promise<void>>>;

  beforeEach(async () => {
    homeDir = await tempDir();
    stateDir = path.join(homeDir, "state");
    sharedSkillsDir = path.join(homeDir, ".agents", "skills");
    managedSkillsDir = path.join(stateDir, "skills");
    skillFile = path.join(sharedSkillsDir, "demo", "SKILL.md");
    codexConfigPath = path.join(homeDir, ".codex", "config.toml");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(skillFile, "---\nname: demo\ndescription: fixture\n---\n");
    await fs.mkdir(path.dirname(managedSkillsDir), { recursive: true });
    await fs.symlink(sharedSkillsDir, managedSkillsDir, "dir");
    await fs.mkdir(path.dirname(codexConfigPath), { recursive: true });
    await fs.writeFile(codexConfigPath, 'model = "test"\n');
    config = { unrelated: { preserved: true } } as OpenClawConfig;
    writeJarvisConfig = vi.fn(async (next: OpenClawConfig) => {
      config = next;
    });
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0, tempDirs.length)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  function status() {
    return getPersonalSkillVisibilityStatus({
      name: "demo",
      config,
      homeDir,
      stateDir,
      codexConfigPath,
    });
  }

  async function set(visibility: "shared" | "codex" | "jarvis") {
    return await setPersonalSkillVisibility("demo", visibility, {
      config,
      writeJarvisConfig,
      homeDir,
      stateDir,
      codexConfigPath,
    });
  }

  it("defaults a canonical personal skill to shared", () => {
    expect(status()).toMatchObject({
      visibility: "shared",
      codexEnabled: true,
      jarvisEnabled: true,
      skillFile,
    });
  });

  it("supports every visibility transition idempotently without copying the body", async () => {
    for (const visibility of ["codex", "jarvis", "shared"] as const) {
      const first = await set(visibility);
      expect(first.visibility).toBe(visibility);
      expect(status().visibility).toBe(visibility);
      const before = {
        skill: await fs.readFile(skillFile),
        codex: await fs.readFile(codexConfigPath),
        config: structuredClone(config),
      };
      const writesBefore = writeJarvisConfig.mock.calls.length;

      await set(visibility);

      expect(await fs.readFile(skillFile)).toEqual(before.skill);
      expect(await fs.readFile(codexConfigPath)).toEqual(before.codex);
      expect(config).toEqual(before.config);
      expect(writeJarvisConfig.mock.calls.length).toBe(writesBefore);
    }
    expect((config as { unrelated?: unknown }).unrelated).toEqual({ preserved: true });
  });

  it("fails closed for malformed, duplicate, and hidden-from-both state", async () => {
    const disabledBlock = `\n[[skills.config]]\npath = ${JSON.stringify(skillFile)}\nenabled = false\n`;
    await fs.writeFile(codexConfigPath, `${disabledBlock}${disabledBlock}`);
    expect(() => status()).toThrow(/duplicate Codex/i);

    await fs.writeFile(codexConfigPath, disabledBlock);
    config = { skills: { entries: { demo: { enabled: false } } } };
    expect(() => status()).toThrow(/disabled in both/i);

    await fs.writeFile(codexConfigPath, `[[skills.config]]\npath = ${JSON.stringify(skillFile)}\n`);
    config = {};
    expect(() => status()).toThrow(/lacks boolean enabled/i);

    await fs.writeFile(
      codexConfigPath,
      `[[skills.config]]\npath = ${JSON.stringify(skillFile)}\nenabled = "false"\n`,
    );
    expect(() => status()).toThrow(/malformed Codex skills.config enabled field/i);
  });

  it("recognizes existing Codex literal-string visibility entries", async () => {
    await fs.writeFile(
      codexConfigPath,
      `[[skills.config]]\npath = '${skillFile}'\nenabled = false\n`,
    );

    expect(status().visibility).toBe("jarvis");
  });

  it("rolls the Codex exclusion back when the Jarvis config write fails", async () => {
    await set("codex");
    const before = await fs.readFile(codexConfigPath, "utf8");
    writeJarvisConfig.mockRejectedValueOnce(new Error("fixture Jarvis write failure"));

    await expect(set("jarvis")).rejects.toThrow(/fixture Jarvis write failure/);

    await expect(fs.readFile(codexConfigPath, "utf8")).resolves.toBe(before);
    expect(config.skills?.entries?.demo?.enabled).toBe(false);
  });

  it("preserves a symlinked Codex config while atomically updating its target", async () => {
    const targetPath = path.join(homeDir, "dotfiles", "codex-config.toml");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.rename(codexConfigPath, targetPath);
    await fs.symlink(targetPath, codexConfigPath);

    await set("jarvis");

    expect((await fs.lstat(codexConfigPath)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toContain(JSON.stringify(skillFile));
  });

  it("preserves a dangling Codex config symlink and creates its intended target", async () => {
    const targetPath = path.join(homeDir, "dotfiles", "missing-codex-config.toml");
    await fs.rm(codexConfigPath);
    await fs.symlink(targetPath, codexConfigPath);

    await set("jarvis");

    expect((await fs.lstat(codexConfigPath)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toContain(JSON.stringify(skillFile));
  });

  it("rejects product-managed mirrors and unresolved legacy managed roots", async () => {
    await fs.writeFile(
      path.join(sharedSkillsDir, "demo", ".openclaw-skill.json"),
      JSON.stringify({
        version: 1,
        source: "openclaw-bundled",
        bundledTreeHash: "fixture",
        updatedAt: new Date(0).toISOString(),
      }),
    );
    expect(() => status()).toThrow(/product-managed bundled mirror/i);

    await fs.rm(path.join(sharedSkillsDir, "demo", ".openclaw-skill.json"));
    await fs.rm(managedSkillsDir);
    await fs.mkdir(managedSkillsDir, { recursive: true });
    expect(() => status()).toThrow(/legacy managed skills root/i);
  });

  it("rejects higher-precedence Jarvis skills with the same name", async () => {
    const workspaceDir = path.join(homeDir, "workspace");
    const shadowFile = path.join(workspaceDir, "skills", "alias-folder", "SKILL.md");
    await fs.mkdir(path.dirname(shadowFile), { recursive: true });
    await fs.writeFile(shadowFile, "---\nname: demo\ndescription: shadow\n---\n");

    expect(() =>
      getPersonalSkillVisibilityStatus({
        name: "demo",
        config,
        homeDir,
        stateDir,
        codexConfigPath,
        workspaceDir,
      }),
    ).toThrow(/shadowed by a higher-precedence skill/i);

    await fs.rm(path.join(workspaceDir, "skills"), { recursive: true });
    await fs.symlink(sharedSkillsDir, path.join(workspaceDir, "skills"), "dir");
    expect(
      getPersonalSkillVisibilityStatus({
        name: "demo",
        config,
        homeDir,
        stateDir,
        codexConfigPath,
        workspaceDir,
      }).visibility,
    ).toBe("shared");
  });

  it("detects higher-precedence loader fallback names", async () => {
    const workspaceDir = path.join(homeDir, "workspace");
    const shadowFile = path.join(workspaceDir, "skills", "demo", "SKILL.md");
    await fs.mkdir(path.dirname(shadowFile), { recursive: true });
    await fs.writeFile(shadowFile, "---\ndescription: fallback shadow\n---\n");

    expect(() =>
      getPersonalSkillVisibilityStatus({
        name: "demo",
        config,
        homeDir,
        stateDir,
        codexConfigPath,
        workspaceDir,
      }),
    ).toThrow(/shadowed by a higher-precedence skill/i);
  });

  it("rejects a canonical skill directory symlink that escapes the shared root", async () => {
    const externalSkillDir = path.join(homeDir, "external", "demo");
    await fs.mkdir(externalSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(externalSkillDir, "SKILL.md"),
      "---\nname: demo\ndescription: escaped\n---\n",
    );
    await fs.rm(path.dirname(skillFile), { recursive: true });
    await fs.symlink(externalSkillDir, path.dirname(skillFile), "dir");

    expect(() => status()).toThrow(/resolves outside the shared root/i);
  });

  it("rejects a canonical personal skill whose effective Jarvis key differs", async () => {
    await fs.writeFile(
      skillFile,
      [
        "---",
        "name: demo",
        "description: fixture",
        `metadata: '${JSON.stringify({ openclaw: { skillKey: "actual-key" } })}'`,
        "---",
        "",
      ].join("\n"),
    );

    expect(() => status()).toThrow(/folder, frontmatter name, and skillKey must all match/i);
    expect(writeJarvisConfig).not.toHaveBeenCalled();
  });

  it("builds bounded Codex injection and leaves persistent catalogs unchanged", async () => {
    await set("jarvis");
    const otherSkillFile = path.join(sharedSkillsDir, "other", "SKILL.md");
    await fs.mkdir(path.dirname(otherSkillFile), { recursive: true });
    await fs.writeFile(otherSkillFile, "---\nname: other\ndescription: other\n---\n");
    await fs.appendFile(
      codexConfigPath,
      `\n[[skills.config]]\npath = ${JSON.stringify(otherSkillFile)}\nenabled = false\n`,
    );
    const beforeCodex = await fs.readFile(codexConfigPath);
    const beforeConfig = structuredClone(config);
    let temporaryHome = "";
    const spawnCodex = vi.fn().mockImplementation((_command, _args, options) => {
      temporaryHome = options.env.CODEX_HOME;
      const temporaryConfig = fsSync.readFileSync(path.join(temporaryHome, "config.toml"), "utf8");
      expect(temporaryConfig).not.toContain(JSON.stringify(skillFile));
      expect(temporaryConfig).toContain(JSON.stringify(otherSkillFile));
      expect(temporaryConfig).toContain("enabled = false");
      return { status: 17 };
    });

    const exitCode = runWithTemporaryCodexSkill({
      name: "demo",
      args: ["exec", "probe"],
      homeDir,
      stateDir,
      codexConfigPath,
      spawnCodex,
    });

    expect(exitCode).toBe(17);
    expect(spawnCodex).toHaveBeenCalledWith(
      "codex",
      buildTemporaryCodexSkillInjectionArgs(skillFile, ["exec", "probe"]),
      {
        stdio: "inherit",
        env: expect.objectContaining({
          CODEX_HOME: expect.stringContaining("openclaw-codex-skill-"),
        }),
      },
    );
    await expect(fs.stat(temporaryHome)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(codexConfigPath)).toEqual(beforeCodex);
    expect(config).toEqual(beforeConfig);
  });
});
