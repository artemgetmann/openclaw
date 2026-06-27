import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runStartupReconciler } from "./startup-reconciler.js";

async function makeTempRoot(name: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${name}-`));
}

async function writeExecutable(filePath: string, body: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body, "utf8");
  await fs.chmod(filePath, 0o755);
}

async function hashSkillDirectory(skillDir: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const files: Array<{ fullPath: string; relativePath: string }> = [];

  async function visit(currentDir: string, relativeRoot = "") {
    const entries = (await fs.readdir(currentDir, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .toSorted((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.join(relativeRoot, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath, relativePath);
      } else if (entry.isFile()) {
        files.push({ fullPath, relativePath });
      }
    }
  }

  await visit(skillDir);
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(await fs.readFile(file.fullPath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function writeManifest(params: {
  packageRoot: string;
  skills?: Record<string, unknown>;
  managedTools?: unknown[];
}) {
  await fs.writeFile(
    path.join(params.packageRoot, "capabilities.manifest.json"),
    `${JSON.stringify(
      {
        format: 1,
        skills: params.skills ?? {},
        managedTools: params.managedTools ?? [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("startup reconciler", () => {
  it("reads the manifest and syncs managed product skills when packaged hashes differ", async () => {
    const root = await makeTempRoot("startup-reconciler-skills");
    const packageRoot = path.join(root, "package");
    const stateDir = path.join(root, "state");
    const packagedSkill = path.join(packageRoot, "skills", "gog");
    const managedSkill = path.join(stateDir, "product-skills", "gog");
    await fs.mkdir(packagedSkill, { recursive: true });
    await fs.writeFile(
      path.join(packagedSkill, "SKILL.md"),
      '---\nname: gog\nmetadata: {"openclaw":{"displayName":"Google Workspace"}}\n---\n# New\n',
      "utf8",
    );
    await fs.mkdir(managedSkill, { recursive: true });
    await fs.writeFile(path.join(managedSkill, "SKILL.md"), "# Old\n", "utf8");
    const packagedHash = await hashSkillDirectory(packagedSkill);
    await writeManifest({
      packageRoot,
      skills: { gog: { sha256: packagedHash, files: 1, displayName: "Google Workspace" } },
    });

    const messages: string[] = [];
    const result = await runStartupReconciler({
      packageRoot,
      stateDir,
      log: { info: (message) => messages.push(message), warn: (message) => messages.push(message) },
    });

    expect(result.status).toBe("reconciled");
    if (result.status !== "reconciled") {
      throw new Error("expected reconciled result");
    }
    await expect(fs.readFile(path.join(managedSkill, "SKILL.md"), "utf8")).resolves.toContain(
      "# New",
    );
    expect(result.report.skills[0]).toMatchObject({
      name: "gog",
      displayName: "Google Workspace",
      packagedHash,
      status: "updated",
    });
    expect(messages).toContain("Updated Google Workspace skill from packaged Jarvis runtime.");
  });

  it("updates the Jarvis-managed Google Workspace CLI when a satisfying local copy exists", async () => {
    const root = await makeTempRoot("startup-reconciler-tool");
    const packageRoot = path.join(root, "package");
    const stateDir = path.join(root, "state");
    const localBin = path.join(root, "local-bin");
    await fs.mkdir(packageRoot, { recursive: true });
    await writeExecutable(path.join(localBin, "gog"), "#!/bin/sh\necho gog v0.31.0\n");
    await writeManifest({
      packageRoot,
      managedTools: [
        {
          skillName: "gog",
          installId: "brew",
          bins: ["gog"],
          versionCommand: ["gog", "--version"],
          versionRegex: "v?(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)",
          recommendedVersion: "0.31.0",
        },
      ],
    });

    const messages: string[] = [];
    const result = await runStartupReconciler({
      packageRoot,
      stateDir,
      env: { ...process.env, PATH: localBin },
      log: { info: (message) => messages.push(message), warn: (message) => messages.push(message) },
    });

    expect(result.status).toBe("reconciled");
    const managedGog = path.join(stateDir, "bin", "gog");
    const version = spawnSync(managedGog, ["--version"], { encoding: "utf8" });
    expect(version.stdout.trim()).toBe("gog v0.31.0");
    if (result.status !== "reconciled") {
      throw new Error("expected reconciled result");
    }
    expect(result.report.tools[0]).toMatchObject({
      skillName: "gog",
      displayName: "Google Workspace",
      bin: "gog",
      recommendedVersion: "0.31.0",
      sourceVersion: "0.31.0",
      status: "updated",
    });
    expect(messages).toContain("Updated Jarvis-managed Google Workspace CLI to v0.31.0.");
  });

  it("writes current status without noisy notifications when skills and tools are already current", async () => {
    const root = await makeTempRoot("startup-reconciler-quiet");
    const packageRoot = path.join(root, "package");
    const stateDir = path.join(root, "state");
    const packagedSkill = path.join(packageRoot, "skills", "gog");
    const managedSkill = path.join(stateDir, "product-skills", "gog");
    await fs.mkdir(packagedSkill, { recursive: true });
    await fs.writeFile(path.join(packagedSkill, "SKILL.md"), "# Current\n", "utf8");
    await fs.mkdir(path.dirname(managedSkill), { recursive: true });
    await fs.cp(packagedSkill, managedSkill, { recursive: true });
    await writeExecutable(path.join(stateDir, "bin", "gog"), "#!/bin/sh\necho gog v0.31.0\n");
    const packagedHash = await hashSkillDirectory(packagedSkill);
    await writeManifest({
      packageRoot,
      skills: { gog: { sha256: packagedHash, files: 1, displayName: "Google Workspace" } },
      managedTools: [
        {
          skillName: "gog",
          installId: "brew",
          bins: ["gog"],
          versionCommand: ["gog", "--version"],
          versionRegex: "v?(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)",
          recommendedVersion: "0.31.0",
        },
      ],
    });

    const messages: string[] = [];
    const result = await runStartupReconciler({
      packageRoot,
      stateDir,
      env: { ...process.env, PATH: "" },
      log: { info: (message) => messages.push(message), warn: (message) => messages.push(message) },
    });

    expect(result.status).toBe("reconciled");
    if (result.status !== "reconciled") {
      throw new Error("expected reconciled result");
    }
    expect(result.report.notifications).toEqual([]);
    expect(result.report.skills[0]?.status).toBe("current");
    expect(result.report.tools[0]?.status).toBe("current");
    expect(messages).toEqual([]);
    await expect(
      fs.readFile(path.join(stateDir, "startup-reconciler", "status.json"), "utf8"),
    ).resolves.toContain('"status": "current"');
  });

  it("never invokes Homebrew or global install commands while updating managed CLI copies", async () => {
    const root = await makeTempRoot("startup-reconciler-no-brew");
    const packageRoot = path.join(root, "package");
    const stateDir = path.join(root, "state");
    const localBin = path.join(root, "local-bin");
    await fs.mkdir(packageRoot, { recursive: true });
    await writeExecutable(path.join(localBin, "brew"), "#!/bin/sh\nexit 99\n");
    await writeExecutable(path.join(localBin, "gog"), "#!/bin/sh\necho gog v0.31.0\n");
    await writeManifest({
      packageRoot,
      managedTools: [
        {
          skillName: "gog",
          installId: "brew",
          bins: ["gog"],
          versionCommand: ["gog", "--version"],
          versionRegex: "v?(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)",
          recommendedVersion: "0.31.0",
        },
      ],
    });
    const commands: string[][] = [];

    const result = await runStartupReconciler({
      packageRoot,
      stateDir,
      env: { ...process.env, PATH: localBin },
      runVersionCommand: (command) => {
        commands.push(command);
        if (path.basename(command[0] ?? "") === "brew") {
          throw new Error("Homebrew must not run");
        }
        return { ok: true, output: "gog v0.31.0" };
      },
      log: { info: () => {}, warn: () => {} },
    });

    expect(result.status).toBe("reconciled");
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => path.basename(command[0] ?? "") !== "brew")).toBe(true);
    await expect(fs.access(path.join(stateDir, "bin", "gog"))).resolves.toBeUndefined();
  });

  it("keeps user-owned managed skills root untouched", async () => {
    const root = await makeTempRoot("startup-reconciler-user-skills");
    const packageRoot = path.join(root, "package");
    const stateDir = path.join(root, "state");
    const packagedSkill = path.join(packageRoot, "skills", "gog");
    const userSkillsDir = path.join(root, "agents-skills");
    await fs.mkdir(packagedSkill, { recursive: true });
    await fs.writeFile(path.join(packagedSkill, "SKILL.md"), "# Packaged\n", "utf8");
    await fs.mkdir(path.join(userSkillsDir, "gog"), { recursive: true });
    await fs.writeFile(path.join(userSkillsDir, "gog", "SKILL.md"), "# User owned\n", "utf8");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.symlink(userSkillsDir, path.join(stateDir, "skills"), "dir");
    const packagedHash = await hashSkillDirectory(packagedSkill);
    await writeManifest({
      packageRoot,
      skills: { gog: { sha256: packagedHash, files: 1, displayName: "Google Workspace" } },
    });

    const result = await runStartupReconciler({
      packageRoot,
      stateDir,
      log: { info: () => {}, warn: () => {} },
    });

    expect(result.status).toBe("reconciled");
    await expect(
      fs.readFile(path.join(userSkillsDir, "gog", "SKILL.md"), "utf8"),
    ).resolves.toContain("# User owned");
    await expect(
      fs.readFile(path.join(stateDir, "product-skills", "gog", "SKILL.md"), "utf8"),
    ).resolves.toContain("# Packaged");
  });

  it("keeps the first managed CLI startup proof scoped to Google Workspace", async () => {
    const root = await makeTempRoot("startup-reconciler-gog-only");
    const packageRoot = path.join(root, "package");
    const stateDir = path.join(root, "state");
    const localBin = path.join(root, "local-bin");
    await fs.mkdir(packageRoot, { recursive: true });
    await writeExecutable(path.join(localBin, "himalaya"), "#!/bin/sh\necho himalaya 1.0.0\n");
    await writeManifest({
      packageRoot,
      managedTools: [
        {
          skillName: "himalaya",
          installId: "brew",
          bins: ["himalaya"],
          versionCommand: ["himalaya", "--version"],
          recommendedVersion: "1.0.0",
        },
      ],
    });

    const result = await runStartupReconciler({
      packageRoot,
      stateDir,
      env: { ...process.env, PATH: localBin },
      log: { info: () => {}, warn: () => {} },
    });

    expect(result.status).toBe("reconciled");
    if (result.status !== "reconciled") {
      throw new Error("expected reconciled result");
    }
    expect(result.report.tools).toEqual([]);
    await expect(fs.access(path.join(stateDir, "bin", "himalaya"))).rejects.toThrow();
  });
});
