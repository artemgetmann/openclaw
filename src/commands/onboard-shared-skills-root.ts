import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfigDir } from "../utils.js";

export type SharedSkillsRootStatus =
  | "linked"
  | "already-linked"
  | "skipped-non-empty"
  | "skipped-non-directory";

export type SharedSkillsRootResult = {
  status: SharedSkillsRootStatus;
  sharedSkillsDir: string;
  managedSkillsDir: string;
};

function directoryIsEmpty(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

function symlinkAlreadyTargets(linkPath: string, targetDir: string): boolean {
  try {
    const linkReal = fs.realpathSync(linkPath);
    const targetReal = fs.realpathSync(targetDir);
    return linkReal === targetReal;
  } catch {
    return false;
  }
}

export function resolveSharedPersonalSkillsDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".agents", "skills");
}

export function ensureSharedPersonalSkillsManagedRoot(params?: {
  homeDir?: string;
  stateDir?: string;
}): SharedSkillsRootResult {
  const homeDir = params?.homeDir ?? os.homedir();
  const stateDir = params?.stateDir ?? resolveConfigDir(process.env, () => homeDir);
  const sharedSkillsDir = resolveSharedPersonalSkillsDir(homeDir);
  const managedSkillsDir = path.join(stateDir, "skills");

  // The managed root is OpenClaw's stable loading point. Point it at the
  // cross-agent root when safe so users keep one personal skills directory.
  fs.mkdirSync(sharedSkillsDir, { recursive: true });
  fs.mkdirSync(path.dirname(managedSkillsDir), { recursive: true });

  if (fs.existsSync(managedSkillsDir)) {
    if (fs.lstatSync(managedSkillsDir).isSymbolicLink()) {
      return {
        status: symlinkAlreadyTargets(managedSkillsDir, sharedSkillsDir)
          ? "already-linked"
          : "skipped-non-empty",
        sharedSkillsDir,
        managedSkillsDir,
      };
    }

    const stat = fs.statSync(managedSkillsDir);
    if (!stat.isDirectory()) {
      return { status: "skipped-non-directory", sharedSkillsDir, managedSkillsDir };
    }
    if (!directoryIsEmpty(managedSkillsDir)) {
      return { status: "skipped-non-empty", sharedSkillsDir, managedSkillsDir };
    }
    fs.rmdirSync(managedSkillsDir);
  }

  fs.symlinkSync(sharedSkillsDir, managedSkillsDir, "dir");
  return { status: "linked", sharedSkillsDir, managedSkillsDir };
}
