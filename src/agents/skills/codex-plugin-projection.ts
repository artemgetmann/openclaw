import fs from "node:fs/promises";
import path from "node:path";
import type { Skill } from "@mariozechner/pi-coding-agent";
import { isPathInside } from "../../infra/path-guards.js";
import type { SkillEntry } from "./types.js";

const CODEX_PLUGIN_ID = "openclaw-skills";
const CODEX_PLUGIN_RELATIVE_DIR = path.join("plugins", CODEX_PLUGIN_ID);
const CODEX_SKILLS_RELATIVE_DIR = "skills";
const CODEX_SKILLS_MANIFEST_VALUE = "./skills/";

type ProjectableSkill = Pick<Skill, "name" | "description" | "filePath" | "baseDir">;

export type CodexSkillProjectionEntry = SkillEntry | ProjectableSkill;

export type ProjectedCodexSkill = {
  name: string;
  sourceDir: string;
  targetDirName: string;
  targetDir: string;
};

export type CodexSkillPluginProjectionResult = {
  marketplacePath: string;
  pluginRoot: string;
  pluginManifestPath: string;
  skillsRoot: string;
  projectedSkills: ProjectedCodexSkill[];
};

function unwrapSkill(entry: CodexSkillProjectionEntry): ProjectableSkill {
  return "skill" in entry ? entry.skill : entry;
}

function sanitizeSkillDirName(rawName: string): string {
  const normalized = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "skill";
}

function resolveUniqueSkillDirName(rawName: string, used: Set<string>): string {
  const base = sanitizeSkillDirName(rawName);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  for (let index = 2; index < 10_000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }

  throw new Error(
    `Could not allocate a unique Codex skill directory for ${JSON.stringify(rawName)}`,
  );
}

async function realpathOrThrow(filePath: string, label: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch (err) {
    throw new Error(`Cannot resolve ${label}: ${filePath} (${String(err)})`);
  }
}

function assertInsideSourceDir(params: { sourceRoot: string; candidate: string; label: string }) {
  if (!isPathInside(params.sourceRoot, params.candidate)) {
    throw new Error(
      `Refusing to project ${params.label} outside skill directory: ${params.candidate}`,
    );
  }
}

function isSensitiveLocalFile(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === ".env" || normalized.startsWith(".env.");
}

async function copySkillDirectory(params: { sourceRoot: string; targetRoot: string }) {
  await fs.mkdir(params.targetRoot, { recursive: true });
  const entries = await fs.readdir(params.sourceRoot, { withFileTypes: true });

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (isSensitiveLocalFile(entry.name)) {
      continue;
    }

    const sourcePath = path.join(params.sourceRoot, entry.name);
    const targetPath = path.join(params.targetRoot, entry.name);

    if (entry.isSymbolicLink()) {
      const realTarget = await realpathOrThrow(sourcePath, "skill symlink target");
      assertInsideSourceDir({
        sourceRoot: params.sourceRoot,
        candidate: realTarget,
        label: "symlink target",
      });
      // Do not reproduce symlinks in the projection. Codex should see a plain
      // bundle tree, and keeping links would make later install/copy behavior
      // depend on host-specific filesystem topology.
      const linkedStat = await fs.stat(sourcePath);
      if (linkedStat.isDirectory()) {
        await copySkillDirectory({ sourceRoot: realTarget, targetRoot: targetPath });
      } else if (linkedStat.isFile()) {
        await fs.copyFile(realTarget, targetPath);
      }
      continue;
    }

    if (entry.isDirectory()) {
      await copySkillDirectory({ sourceRoot: sourcePath, targetRoot: targetPath });
      continue;
    }

    if (entry.isFile()) {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function assertSkillSource(skill: ProjectableSkill): Promise<string> {
  const sourceRoot = await realpathOrThrow(skill.baseDir, "skill directory");
  const sourceStat = await fs.stat(sourceRoot);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Skill baseDir is not a directory: ${skill.baseDir}`);
  }

  const skillFile = await realpathOrThrow(skill.filePath, "SKILL.md");
  assertInsideSourceDir({ sourceRoot, candidate: skillFile, label: "SKILL.md" });
  if (path.basename(skillFile) !== "SKILL.md") {
    throw new Error(`Skill file must be named SKILL.md: ${skill.filePath}`);
  }

  return sourceRoot;
}

function buildCodexPluginManifest() {
  return {
    name: CODEX_PLUGIN_ID,
    version: "0.0.0-openclaw-projection",
    description: "Generated OpenClaw skill projection for Codex native skill loading.",
    author: { name: "OpenClaw" },
    license: "MIT",
    keywords: ["openclaw", "skills", "codex"],
    skills: CODEX_SKILLS_MANIFEST_VALUE,
    interface: {
      displayName: "OpenClaw Skills",
      shortDescription: "Generated OpenClaw skills for Codex",
      longDescription:
        "A generated filesystem-only projection of resolved OpenClaw skills for Codex native skill loading.",
      developerName: "OpenClaw",
      category: "Developer Tools",
      capabilities: ["Read"],
      defaultPrompt: ["Use the relevant OpenClaw skill for this task."],
    },
  };
}

function buildMarketplaceManifest() {
  return {
    name: "openclaw-generated",
    interface: {
      displayName: "OpenClaw Generated",
    },
    plugins: [
      {
        name: CODEX_PLUGIN_ID,
        source: {
          source: "local",
          path: `./${CODEX_PLUGIN_RELATIVE_DIR.replaceAll(path.sep, "/")}`,
        },
        category: "Developer Tools",
      },
    ],
  };
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

/**
 * Project already-resolved OpenClaw skills into a Codex-compatible local
 * plugin bundle. This intentionally writes only files copied from each skill
 * directory plus Codex metadata; it does not read OpenClaw config, credentials,
 * env overrides, or mutate the user's Codex profile.
 */
export async function generateCodexSkillPluginProjection(params: {
  outDir: string;
  skills: CodexSkillProjectionEntry[];
}): Promise<CodexSkillPluginProjectionResult> {
  const outDir = path.resolve(params.outDir);
  const pluginRoot = path.join(outDir, CODEX_PLUGIN_RELATIVE_DIR);
  const skillsRoot = path.join(pluginRoot, CODEX_SKILLS_RELATIVE_DIR);
  const pluginManifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const marketplacePath = path.join(outDir, "marketplace.json");

  // Recreate only projection-owned paths so repeated runs are deterministic
  // without making assumptions about other files the caller may keep under outDir.
  await fs.rm(pluginRoot, { recursive: true, force: true });
  await fs.mkdir(skillsRoot, { recursive: true });

  const usedTargetDirs = new Set<string>();
  const projectedSkills: ProjectedCodexSkill[] = [];

  for (const entry of params.skills) {
    const skill = unwrapSkill(entry);
    const sourceDir = await assertSkillSource(skill);
    const targetDirName = resolveUniqueSkillDirName(skill.name, usedTargetDirs);
    const targetDir = path.join(skillsRoot, targetDirName);

    await copySkillDirectory({ sourceRoot: sourceDir, targetRoot: targetDir });

    projectedSkills.push({
      name: skill.name,
      sourceDir,
      targetDirName,
      targetDir,
    });
  }

  await writeJson(pluginManifestPath, buildCodexPluginManifest());
  await writeJson(marketplacePath, buildMarketplaceManifest());

  return {
    marketplacePath,
    pluginRoot,
    pluginManifestPath,
    skillsRoot,
    projectedSkills,
  };
}
