import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveBundledSkillsDir } from "./bundled-dir.js";

const SHARED_SKILL_MARKER_FILENAME = ".openclaw-skill.json";
const SHARED_SKILL_MANAGED_SOURCE = "openclaw-bundled";

type SharedSkillMarker = {
  version: 1;
  source: typeof SHARED_SKILL_MANAGED_SOURCE;
  bundledTreeHash: string;
  updatedAt: string;
};

export type SharedBundledSkillMirrorStatus =
  | "current"
  | "copied"
  | "updated"
  | "forced"
  | "adopted"
  | "removed"
  | "skipped-local"
  | "missing-source"
  | "failed";

export type SharedBundledSkillMirrorEntry = {
  name: string;
  status: SharedBundledSkillMirrorStatus;
  sourceDir?: string;
  targetDir: string;
  bundledTreeHash?: string;
  targetTreeHash?: string;
  message?: string;
};

export type SharedBundledSkillMirrorResult = {
  sourceDir?: string;
  targetDir: string;
  entries: SharedBundledSkillMirrorEntry[];
};

function assertSafeSkillName(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`invalid skill name: ${JSON.stringify(name)}`);
  }
}

export function resolveSharedPersonalSkillsDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".agents", "skills");
}

function markerPath(skillDir: string): string {
  return path.join(skillDir, SHARED_SKILL_MARKER_FILENAME);
}

function ignoredSkillTreeEntry(name: string): boolean {
  return name === SHARED_SKILL_MARKER_FILENAME || name === ".clawhub" || name === "node_modules";
}

export function hashSharedSkillDirectory(skillDir: string): string | undefined {
  const hash = crypto.createHash("sha256");
  const files: Array<{ absolutePath: string; relativePath: string }> = [];

  const visit = (currentDir: string, relativeDir = ""): void => {
    const entries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .filter((entry) => !ignoredSkillTreeEntry(entry.name))
      .toSorted((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        files.push({ absolutePath, relativePath: `${relativePath}\0symlink` });
        continue;
      }
      if (entry.isFile()) {
        files.push({ absolutePath, relativePath });
      }
    }
  };

  try {
    visit(skillDir);
    for (const file of files) {
      hash.update(file.relativePath);
      hash.update("\0");
      const lstat = fs.lstatSync(file.absolutePath);
      hash.update(
        lstat.isSymbolicLink()
          ? fs.readlinkSync(file.absolutePath)
          : fs.readFileSync(file.absolutePath),
      );
      hash.update("\0");
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

function readSharedSkillMarker(skillDir: string): SharedSkillMarker | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(markerPath(skillDir), "utf8"),
    ) as Partial<SharedSkillMarker>;
    if (
      parsed?.version === 1 &&
      parsed.source === SHARED_SKILL_MANAGED_SOURCE &&
      typeof parsed.bundledTreeHash === "string" &&
      parsed.bundledTreeHash.trim().length > 0
    ) {
      return {
        version: 1,
        source: SHARED_SKILL_MANAGED_SOURCE,
        bundledTreeHash: parsed.bundledTreeHash,
        updatedAt:
          typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      };
    }
  } catch {
    // Missing or malformed markers mean the destination is user-owned.
  }
  return undefined;
}

export function isSharedBundledSkillMirrorDir(skillDir: string): boolean {
  return Boolean(readSharedSkillMarker(skillDir));
}

async function writeSharedSkillMarker(skillDir: string, bundledTreeHash: string): Promise<void> {
  const marker: SharedSkillMarker = {
    version: 1,
    source: SHARED_SKILL_MANAGED_SOURCE,
    bundledTreeHash,
    updatedAt: new Date().toISOString(),
  };
  await fsp.writeFile(markerPath(skillDir), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

function listSkillNames(rootDir: string): string[] {
  try {
    return fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => fs.existsSync(path.join(rootDir, name, "SKILL.md")))
      .toSorted((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function copySkillMirror(params: {
  name: string;
  sourceDir: string;
  targetDir: string;
  bundledTreeHash: string;
}): Promise<void> {
  assertSafeSkillName(params.name);
  await fsp.rm(params.targetDir, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(params.targetDir), { recursive: true });
  await fsp.cp(params.sourceDir, params.targetDir, { recursive: true, force: true });
  await writeSharedSkillMarker(params.targetDir, params.bundledTreeHash);
}

async function removeCleanManagedMirror(params: {
  name: string;
  targetDir: string;
  targetTreeHash?: string;
  marker: SharedSkillMarker;
}): Promise<SharedBundledSkillMirrorEntry> {
  if (params.targetTreeHash !== params.marker.bundledTreeHash) {
    return {
      name: params.name,
      targetDir: params.targetDir,
      targetTreeHash: params.targetTreeHash,
      status: "skipped-local",
      message: "Local edits detected in a retired bundled skill mirror; left it untouched.",
    };
  }

  await fsp.rm(params.targetDir, { recursive: true, force: true });
  return {
    name: params.name,
    targetDir: params.targetDir,
    targetTreeHash: params.targetTreeHash,
    status: "removed",
    message: "Removed retired clean bundled skill mirror.",
  };
}

export async function syncBundledSkillsToSharedPersonalRoot(
  params: {
    bundledSkillsDir?: string;
    sharedSkillsDir?: string;
    pruneRemoved?: boolean;
    forceSkillNames?: string[];
  } = {},
): Promise<SharedBundledSkillMirrorResult> {
  const sourceDir = params.bundledSkillsDir ?? resolveBundledSkillsDir() ?? undefined;
  const targetDir = params.sharedSkillsDir ?? resolveSharedPersonalSkillsDir();
  const entries: SharedBundledSkillMirrorEntry[] = [];
  const forceSkillNames = new Set(params.forceSkillNames ?? []);
  for (const name of forceSkillNames) {
    assertSafeSkillName(name);
  }

  await fsp.mkdir(targetDir, { recursive: true });

  if (!sourceDir || !fs.existsSync(sourceDir)) {
    return {
      sourceDir,
      targetDir,
      entries: [
        {
          name: "(bundled-skills)",
          targetDir,
          status: "missing-source",
          message: "Bundled skills directory is unavailable.",
        },
      ],
    };
  }

  const sourceSkillNames = listSkillNames(sourceDir);
  const sourceSkillSet = new Set(sourceSkillNames);
  for (const name of forceSkillNames) {
    if (!sourceSkillSet.has(name)) {
      entries.push({
        name,
        targetDir: path.join(targetDir, name),
        status: "missing-source",
        message: "Cannot force sync because no bundled skill with this name exists.",
      });
    }
  }

  for (const name of sourceSkillNames) {
    const sourceSkillDir = path.join(sourceDir, name);
    const targetSkillDir = path.join(targetDir, name);
    const bundledTreeHash = hashSharedSkillDirectory(sourceSkillDir);
    if (!bundledTreeHash) {
      entries.push({
        name,
        sourceDir: sourceSkillDir,
        targetDir: targetSkillDir,
        status: "failed",
        message: "Unable to hash bundled skill.",
      });
      continue;
    }

    const targetExists = fs.existsSync(path.join(targetSkillDir, "SKILL.md"));
    if (!targetExists) {
      try {
        await copySkillMirror({
          name,
          sourceDir: sourceSkillDir,
          targetDir: targetSkillDir,
          bundledTreeHash,
        });
        entries.push({
          name,
          sourceDir: sourceSkillDir,
          targetDir: targetSkillDir,
          bundledTreeHash,
          status: "copied",
        });
      } catch (err) {
        entries.push({
          name,
          sourceDir: sourceSkillDir,
          targetDir: targetSkillDir,
          bundledTreeHash,
          status: "failed",
          message: String(err),
        });
      }
      continue;
    }

    const marker = readSharedSkillMarker(targetSkillDir);
    const targetTreeHash = hashSharedSkillDirectory(targetSkillDir);
    if (!marker) {
      if (targetTreeHash === bundledTreeHash) {
        await writeSharedSkillMarker(targetSkillDir, bundledTreeHash);
        entries.push({
          name,
          sourceDir: sourceSkillDir,
          targetDir: targetSkillDir,
          bundledTreeHash,
          targetTreeHash,
          status: "adopted",
          message: "Existing matching skill adopted as a managed bundled mirror.",
        });
      } else {
        if (forceSkillNames.has(name)) {
          try {
            await copySkillMirror({
              name,
              sourceDir: sourceSkillDir,
              targetDir: targetSkillDir,
              bundledTreeHash,
            });
            entries.push({
              name,
              sourceDir: sourceSkillDir,
              targetDir: targetSkillDir,
              bundledTreeHash,
              targetTreeHash,
              status: "forced",
              message: "Forced bundled skill mirror over an unmarked local override.",
            });
          } catch (err) {
            entries.push({
              name,
              sourceDir: sourceSkillDir,
              targetDir: targetSkillDir,
              bundledTreeHash,
              targetTreeHash,
              status: "failed",
              message: String(err),
            });
          }
          continue;
        }
        entries.push({
          name,
          sourceDir: sourceSkillDir,
          targetDir: targetSkillDir,
          bundledTreeHash,
          targetTreeHash,
          status: "skipped-local",
          message: "Existing local skill has no OpenClaw bundled marker; left it untouched.",
        });
      }
      continue;
    }

    if (targetTreeHash === bundledTreeHash) {
      if (marker.bundledTreeHash !== bundledTreeHash) {
        await writeSharedSkillMarker(targetSkillDir, bundledTreeHash);
      }
      entries.push({
        name,
        sourceDir: sourceSkillDir,
        targetDir: targetSkillDir,
        bundledTreeHash,
        targetTreeHash,
        status: "current",
      });
      continue;
    }

    if (targetTreeHash !== marker.bundledTreeHash) {
      if (forceSkillNames.has(name)) {
        try {
          await copySkillMirror({
            name,
            sourceDir: sourceSkillDir,
            targetDir: targetSkillDir,
            bundledTreeHash,
          });
          entries.push({
            name,
            sourceDir: sourceSkillDir,
            targetDir: targetSkillDir,
            bundledTreeHash,
            targetTreeHash,
            status: "forced",
            message: "Forced bundled skill mirror over local edits.",
          });
        } catch (err) {
          entries.push({
            name,
            sourceDir: sourceSkillDir,
            targetDir: targetSkillDir,
            bundledTreeHash,
            targetTreeHash,
            status: "failed",
            message: String(err),
          });
        }
        continue;
      }
      entries.push({
        name,
        sourceDir: sourceSkillDir,
        targetDir: targetSkillDir,
        bundledTreeHash,
        targetTreeHash,
        status: "skipped-local",
        message: "Local edits detected in managed bundled mirror; left it untouched.",
      });
      continue;
    }

    try {
      await copySkillMirror({
        name,
        sourceDir: sourceSkillDir,
        targetDir: targetSkillDir,
        bundledTreeHash,
      });
      entries.push({
        name,
        sourceDir: sourceSkillDir,
        targetDir: targetSkillDir,
        bundledTreeHash,
        targetTreeHash,
        status: "updated",
      });
    } catch (err) {
      entries.push({
        name,
        sourceDir: sourceSkillDir,
        targetDir: targetSkillDir,
        bundledTreeHash,
        targetTreeHash,
        status: "failed",
        message: String(err),
      });
    }
  }

  if (params.pruneRemoved ?? true) {
    for (const name of listSkillNames(targetDir)) {
      if (sourceSkillSet.has(name)) {
        continue;
      }
      const targetSkillDir = path.join(targetDir, name);
      const marker = readSharedSkillMarker(targetSkillDir);
      if (!marker) {
        continue;
      }
      const targetTreeHash = hashSharedSkillDirectory(targetSkillDir);
      try {
        entries.push(
          await removeCleanManagedMirror({
            name,
            targetDir: targetSkillDir,
            targetTreeHash,
            marker,
          }),
        );
      } catch (err) {
        entries.push({
          name,
          targetDir: targetSkillDir,
          targetTreeHash,
          status: "failed",
          message: String(err),
        });
      }
    }
  }

  return { sourceDir, targetDir, entries };
}
