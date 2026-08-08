import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashSharedSkillDirectory } from "../agents/skills/shared-personal-mirror.js";
import { resolveConfigDir } from "../utils.js";

export type SharedSkillsRootStatus =
  | "linked"
  | "already-linked"
  | "migrated"
  | "compatibility-conflict"
  | "compatibility-foreign-link"
  | "compatibility-legacy-root"
  | "compatibility-non-directory"
  | "compatibility-unknown-content"
  | "rolled-back"
  | "rollback-failed";

export type PersonalSkillInventoryEntry = {
  name: string;
  sourceHash: string;
  targetHash?: string;
  action: "copy" | "identical" | "conflict";
};

export type SharedSkillsRootReceipt = {
  version: 1;
  transactionId: string;
  generatedAt: string;
  status: SharedSkillsRootStatus | "prepared";
  sharedSkillsDir: string;
  managedSkillsDir: string;
  backupDir?: string;
  rollbackPreservedDir?: string;
  introducedSkills: Array<{ name: string; hash: string }>;
  inventory: PersonalSkillInventoryEntry[];
  unknownEntries: string[];
  message?: string;
};

export type SharedSkillsRootResult = {
  status: SharedSkillsRootStatus;
  sharedSkillsDir: string;
  managedSkillsDir: string;
  receiptPath?: string;
  backupDir?: string;
  rollbackPreservedDir?: string;
  inventory: PersonalSkillInventoryEntry[];
  unknownEntries: string[];
  message?: string;
};

type ReconcileFs = Pick<
  typeof fs,
  | "cpSync"
  | "existsSync"
  | "lstatSync"
  | "mkdirSync"
  | "readFileSync"
  | "readdirSync"
  | "readlinkSync"
  | "realpathSync"
  | "renameSync"
  | "rmdirSync"
  | "rmSync"
  | "symlinkSync"
  | "writeFileSync"
>;

type ReconcileOptions = {
  homeDir?: string;
  stateDir?: string;
  managedSkillsDir?: string;
  preserveNonEmpty?: boolean;
  now?: () => Date;
  fs?: ReconcileFs;
  /** Test seam for proving rollback after the source root has moved. */
  beforeLink?: () => void;
};

function directoryIsEmpty(fsImpl: ReconcileFs, dir: string): boolean {
  try {
    return fsImpl.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

function pathExistsWithoutFollowingLinks(fsImpl: ReconcileFs, targetPath: string): boolean {
  try {
    fsImpl.lstatSync(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function symlinkAlreadyTargets(fsImpl: ReconcileFs, linkPath: string, targetDir: string): boolean {
  try {
    return fsImpl.realpathSync(linkPath) === fsImpl.realpathSync(targetDir);
  } catch {
    return false;
  }
}

function assertSafeSkillName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`unsafe personal skill name: ${JSON.stringify(name)}`);
  }
}

function atomicWriteJson(fsImpl: ReconcileFs, targetPath: string, value: unknown): void {
  fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fsImpl.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fsImpl.renameSync(temporaryPath, targetPath);
  } finally {
    fsImpl.rmSync(temporaryPath, { force: true });
  }
}

function writeReceipt(params: {
  fs: ReconcileFs;
  receiptDir: string;
  receipt: SharedSkillsRootReceipt;
}): string {
  const receiptPath = path.join(params.receiptDir, `${params.receipt.transactionId}.json`);
  atomicWriteJson(params.fs, receiptPath, params.receipt);
  atomicWriteJson(params.fs, path.join(params.receiptDir, "latest.json"), params.receipt);
  return receiptPath;
}

function resultFromReceipt(
  receipt: SharedSkillsRootReceipt,
  receiptPath?: string,
): SharedSkillsRootResult {
  if (receipt.status === "prepared") {
    throw new Error("cannot return a prepared personal skills receipt");
  }
  return {
    status: receipt.status,
    sharedSkillsDir: receipt.sharedSkillsDir,
    managedSkillsDir: receipt.managedSkillsDir,
    receiptPath,
    backupDir: receipt.backupDir,
    rollbackPreservedDir: receipt.rollbackPreservedDir,
    inventory: receipt.inventory,
    unknownEntries: receipt.unknownEntries,
    message: receipt.message,
  };
}

function inventoryManagedRoot(params: {
  fs: ReconcileFs;
  managedSkillsDir: string;
  sharedSkillsDir: string;
}): { inventory: PersonalSkillInventoryEntry[]; unknownEntries: string[] } {
  const inventory: PersonalSkillInventoryEntry[] = [];
  const unknownEntries: string[] = [];
  const entries = params.fs
    .readdirSync(params.managedSkillsDir, { withFileTypes: true })
    .toSorted((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const sourceSkillDir = path.join(params.managedSkillsDir, entry.name);
    if (!entry.isDirectory() || !params.fs.existsSync(path.join(sourceSkillDir, "SKILL.md"))) {
      // Replacing the whole managed root would hide unknown user content. Keep
      // the legacy loader active until the user moves or removes it explicitly.
      // Top-level symlink skills are never materialized: doing so could turn a
      // loader-rejected external path into an active canonical skill.
      unknownEntries.push(entry.name);
      continue;
    }

    try {
      assertSafeSkillName(entry.name);
    } catch {
      unknownEntries.push(entry.name);
      continue;
    }

    const sourceHash = hashSharedSkillDirectory(sourceSkillDir);
    if (!sourceHash) {
      unknownEntries.push(entry.name);
      continue;
    }
    const targetSkillDir = path.join(params.sharedSkillsDir, entry.name);
    const targetHash = params.fs.existsSync(path.join(targetSkillDir, "SKILL.md"))
      ? hashSharedSkillDirectory(targetSkillDir)
      : undefined;
    inventory.push({
      name: entry.name,
      sourceHash,
      targetHash,
      action:
        targetHash === undefined ? "copy" : targetHash === sourceHash ? "identical" : "conflict",
    });
  }

  return { inventory, unknownEntries };
}

export function resolveSharedPersonalSkillsDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".agents", "skills");
}

/**
 * Adopt one canonical personal skills root without deleting or overwriting a
 * legacy managed root.
 *
 * The transaction is intentionally conservative: it inventories every direct
 * child before copying anything, stages and verifies every unique skill, keeps
 * the old root as an inactive rollback backup, and restores that root if the
 * final symlink cannot be created. Conflicts or unknown entries keep the legacy
 * loader path active; startup can retry after the user resolves them.
 */
export function ensureSharedPersonalSkillsManagedRoot(
  params: ReconcileOptions = {},
): SharedSkillsRootResult {
  const fsImpl = params.fs ?? fs;
  const homeDir = params.homeDir ?? os.homedir();
  const stateDir = params.stateDir ?? resolveConfigDir(process.env, () => homeDir);
  const now = params.now ?? (() => new Date());
  const sharedSkillsDir = resolveSharedPersonalSkillsDir(homeDir);
  const managedSkillsDir = params.managedSkillsDir ?? path.join(stateDir, "skills");
  const receiptDir = path.join(stateDir, "personal-skills-migration", "receipts");
  const generatedAt = now().toISOString();
  const transactionId = `${generatedAt.replace(/[^0-9]/g, "").slice(0, 17)}-${crypto
    .createHash("sha256")
    .update(`${managedSkillsDir}\0${sharedSkillsDir}\0${generatedAt}`)
    .digest("hex")
    .slice(0, 10)}`;

  fsImpl.mkdirSync(sharedSkillsDir, { recursive: true });
  fsImpl.mkdirSync(path.dirname(managedSkillsDir), { recursive: true });

  if (pathExistsWithoutFollowingLinks(fsImpl, managedSkillsDir)) {
    const managedLstat = fsImpl.lstatSync(managedSkillsDir);
    if (managedLstat.isSymbolicLink()) {
      if (symlinkAlreadyTargets(fsImpl, managedSkillsDir, sharedSkillsDir)) {
        return {
          status: "already-linked",
          sharedSkillsDir,
          managedSkillsDir,
          inventory: [],
          unknownEntries: [],
        };
      }
      const receipt: SharedSkillsRootReceipt = {
        version: 1,
        transactionId,
        generatedAt,
        status: "compatibility-foreign-link",
        sharedSkillsDir,
        managedSkillsDir,
        introducedSkills: [],
        inventory: [],
        unknownEntries: [],
        message: `Managed skills remains linked to ${fsImpl.readlinkSync(managedSkillsDir)}.`,
      };
      return resultFromReceipt(receipt, writeReceipt({ fs: fsImpl, receiptDir, receipt }));
    }
    if (!managedLstat.isDirectory()) {
      const receipt: SharedSkillsRootReceipt = {
        version: 1,
        transactionId,
        generatedAt,
        status: "compatibility-non-directory",
        sharedSkillsDir,
        managedSkillsDir,
        introducedSkills: [],
        inventory: [],
        unknownEntries: [path.basename(managedSkillsDir)],
        message: "Managed skills path is not a directory; left untouched.",
      };
      return resultFromReceipt(receipt, writeReceipt({ fs: fsImpl, receiptDir, receipt }));
    }
  }

  // existsSync follows symlinks and reports a broken legacy symlink as absent.
  // lstat keeps that user-owned path visible so we preserve it as a foreign
  // compatibility root instead of attempting an overlapping replacement.
  const managedExists = pathExistsWithoutFollowingLinks(fsImpl, managedSkillsDir);
  if (!managedExists || directoryIsEmpty(fsImpl, managedSkillsDir)) {
    const receipt: SharedSkillsRootReceipt = {
      version: 1,
      transactionId,
      generatedAt,
      status: "prepared",
      sharedSkillsDir,
      managedSkillsDir,
      introducedSkills: [],
      inventory: [],
      unknownEntries: [],
    };
    let receiptPath = writeReceipt({ fs: fsImpl, receiptDir, receipt });
    try {
      if (managedExists) {
        // rmdir is intentionally non-recursive. If user content appears after
        // the empty check, cutover fails instead of deleting the new content.
        fsImpl.rmdirSync(managedSkillsDir);
      }
      params.beforeLink?.();
      fsImpl.symlinkSync(sharedSkillsDir, managedSkillsDir, "dir");
      receipt.status = "linked";
    } catch (error) {
      if (managedExists && !fsImpl.existsSync(managedSkillsDir)) {
        fsImpl.mkdirSync(managedSkillsDir, { recursive: true });
      }
      receipt.status = "rolled-back";
      receipt.message = `Link creation failed; original empty state restored: ${String(error)}`;
    }
    receiptPath = writeReceipt({ fs: fsImpl, receiptDir, receipt });
    return resultFromReceipt(receipt, receiptPath);
  }

  const { inventory, unknownEntries } = inventoryManagedRoot({
    fs: fsImpl,
    managedSkillsDir,
    sharedSkillsDir,
  });
  const conflicts = inventory.filter((entry) => entry.action === "conflict");
  if (unknownEntries.length > 0 || conflicts.length > 0) {
    const receipt: SharedSkillsRootReceipt = {
      version: 1,
      transactionId,
      generatedAt,
      status:
        unknownEntries.length > 0 ? "compatibility-unknown-content" : "compatibility-conflict",
      sharedSkillsDir,
      managedSkillsDir,
      introducedSkills: [],
      inventory,
      unknownEntries,
      message:
        unknownEntries.length > 0
          ? "Legacy managed root contains unknown content; Jarvis keeps loading it unchanged."
          : `Same-name conflicts require review: ${conflicts.map((entry) => entry.name).join(", ")}.`,
    };
    return resultFromReceipt(receipt, writeReceipt({ fs: fsImpl, receiptDir, receipt }));
  }

  if (params.preserveNonEmpty) {
    const receipt: SharedSkillsRootReceipt = {
      version: 1,
      transactionId,
      generatedAt,
      status: "compatibility-legacy-root",
      sharedSkillsDir,
      managedSkillsDir,
      introducedSkills: [],
      inventory,
      unknownEntries,
      message:
        "Legacy workspace skills remain active as a scoped compatibility root; no bodies were copied or replaced.",
    };
    return resultFromReceipt(receipt, writeReceipt({ fs: fsImpl, receiptDir, receipt }));
  }

  const backupDir = path.join(
    stateDir,
    "personal-skills-migration",
    "backups",
    transactionId,
    "skills",
  );
  const stagingDir = path.join(sharedSkillsDir, `.openclaw-migration-${transactionId}`);
  const introducedSkills: Array<{ name: string; hash: string }> = [];
  const receipt: SharedSkillsRootReceipt = {
    version: 1,
    transactionId,
    generatedAt,
    status: "prepared",
    sharedSkillsDir,
    managedSkillsDir,
    backupDir,
    introducedSkills,
    inventory,
    unknownEntries,
  };
  let receiptPath = writeReceipt({ fs: fsImpl, receiptDir, receipt });
  let sourceMoved = false;
  let rollbackFailed = false;

  try {
    fsImpl.mkdirSync(stagingDir, { recursive: true });
    for (const entry of inventory.filter((candidate) => candidate.action === "copy")) {
      const sourceSkillDir = fsImpl.realpathSync(path.join(managedSkillsDir, entry.name));
      const stagedSkillDir = path.join(stagingDir, entry.name);
      fsImpl.cpSync(sourceSkillDir, stagedSkillDir, {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
      });
      const stagedHash = hashSharedSkillDirectory(stagedSkillDir);
      if (stagedHash !== entry.sourceHash) {
        throw new Error(`staged copy verification failed for ${entry.name}`);
      }
    }

    for (const entry of inventory.filter((candidate) => candidate.action === "copy")) {
      const stagedSkillDir = path.join(stagingDir, entry.name);
      const targetSkillDir = path.join(sharedSkillsDir, entry.name);
      if (fsImpl.existsSync(targetSkillDir)) {
        throw new Error(`canonical target appeared during migration: ${entry.name}`);
      }
      fsImpl.renameSync(stagedSkillDir, targetSkillDir);
      introducedSkills.push({ name: entry.name, hash: entry.sourceHash });
    }

    // Persist the exact introduced set before moving the legacy root. A hard
    // process exit after the following rename can then be recovered from this
    // prepared receipt even if the final canonical symlink was never created.
    receiptPath = writeReceipt({ fs: fsImpl, receiptDir, receipt });

    fsImpl.mkdirSync(path.dirname(backupDir), { recursive: true });
    fsImpl.renameSync(managedSkillsDir, backupDir);
    sourceMoved = true;
    params.beforeLink?.();
    fsImpl.symlinkSync(sharedSkillsDir, managedSkillsDir, "dir");
    receipt.status = "migrated";
    receiptPath = writeReceipt({ fs: fsImpl, receiptDir, receipt });
  } catch (error) {
    // Restore the active legacy root first. Removing copied canonical entries is
    // safe only while their verified bytes still match this transaction.
    try {
      if (sourceMoved && !fsImpl.existsSync(managedSkillsDir)) {
        fsImpl.renameSync(backupDir, managedSkillsDir);
        sourceMoved = false;
      }
    } catch {
      rollbackFailed = true;
    }
    for (const introduced of introducedSkills.toReversed()) {
      const targetSkillDir = path.join(sharedSkillsDir, introduced.name);
      try {
        if (hashSharedSkillDirectory(targetSkillDir) !== introduced.hash) {
          rollbackFailed = true;
          continue;
        }
        fsImpl.rmSync(targetSkillDir, { recursive: true, force: true });
      } catch {
        rollbackFailed = true;
      }
    }
    receipt.status = rollbackFailed ? "rollback-failed" : "rolled-back";
    receipt.message = `Migration failed${rollbackFailed ? " and needs manual recovery" : "; original root restored"}: ${String(error)}`;
  } finally {
    fsImpl.rmSync(stagingDir, { recursive: true, force: true });
  }

  receiptPath = writeReceipt({ fs: fsImpl, receiptDir, receipt });
  return resultFromReceipt(receipt, receiptPath);
}
