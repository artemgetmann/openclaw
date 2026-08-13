import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashSharedSkillDirectory } from "../agents/skills/shared-personal-mirror.js";
import { resolveConfigDir } from "../utils.js";
import {
  resolveSharedPersonalSkillsDir,
  type SharedSkillsRootReceipt,
  type SharedSkillsRootResult,
  type SharedSkillsRootStatus,
} from "./onboard-shared-skills-root.js";

type RollbackOptions = {
  homeDir?: string;
  stateDir?: string;
};

function formatError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "unknown error";
}

function atomicWriteJson(targetPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, targetPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function parseReceipt(params: {
  receiptPath: string;
  receiptDir: string;
  sharedSkillsDir: string;
  managedSkillsDir: string;
  stateDir: string;
}): SharedSkillsRootReceipt {
  const resolvedReceiptPath = path.resolve(params.receiptPath);
  if (path.dirname(resolvedReceiptPath) !== path.resolve(params.receiptDir)) {
    throw new Error("rollback receipt must come from the active Jarvis receipt directory");
  }
  const receiptStat = fs.lstatSync(resolvedReceiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) {
    throw new Error("rollback receipt must be a regular file, not a symlink");
  }

  const value = JSON.parse(fs.readFileSync(resolvedReceiptPath, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("malformed personal skills migration receipt");
  }
  const receipt = value as Partial<SharedSkillsRootReceipt>;
  if (
    receipt.version !== 1 ||
    (receipt.status !== "migrated" && receipt.status !== "prepared") ||
    typeof receipt.transactionId !== "string" ||
    !/^\d{17}-[a-f0-9]{10}$/.test(receipt.transactionId) ||
    typeof receipt.generatedAt !== "string" ||
    !Array.isArray(receipt.introducedSkills) ||
    !Array.isArray(receipt.inventory) ||
    !Array.isArray(receipt.unknownEntries)
  ) {
    throw new Error("receipt does not describe a recoverable personal skills migration");
  }
  const expectedBackupDir = path.join(
    params.stateDir,
    "personal-skills-migration",
    "backups",
    receipt.transactionId,
    "skills",
  );
  if (
    receipt.sharedSkillsDir !== params.sharedSkillsDir ||
    receipt.managedSkillsDir !== params.managedSkillsDir ||
    receipt.backupDir !== expectedBackupDir ||
    path.basename(resolvedReceiptPath) !== `${receipt.transactionId}.json`
  ) {
    throw new Error("migration receipt paths do not match the active Jarvis state");
  }
  for (const entry of receipt.introducedSkills) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test((entry as { name?: string }).name ?? "") ||
      !/^[a-f0-9]{64}$/.test((entry as { hash?: string }).hash ?? "")
    ) {
      throw new Error("migration receipt contains an unsafe introduced skill entry");
    }
  }
  return receipt as SharedSkillsRootReceipt;
}

/** Restore the exact legacy root recorded by one validated migration receipt. */
export function rollbackSharedPersonalSkillsManagedRoot(
  receiptPath: string,
  options: RollbackOptions = {},
): SharedSkillsRootResult {
  const homeDir = options.homeDir ?? os.homedir();
  const stateDir = options.stateDir ?? resolveConfigDir(process.env, () => homeDir);
  const sharedSkillsDir = resolveSharedPersonalSkillsDir(homeDir);
  const managedSkillsDir = path.join(stateDir, "skills");
  const receiptDir = path.join(stateDir, "personal-skills-migration", "receipts");
  const receipt = parseReceipt({
    receiptPath,
    receiptDir,
    sharedSkillsDir,
    managedSkillsDir,
    stateDir,
  });

  let managedRootPresent = false;
  try {
    const managedStat = fs.lstatSync(managedSkillsDir);
    managedRootPresent = true;
    if (
      !managedStat.isSymbolicLink() ||
      fs.realpathSync(managedSkillsDir) !== fs.realpathSync(sharedSkillsDir)
    ) {
      throw new Error("managed skills root no longer matches the migration receipt");
    }
  } catch (error) {
    if (managedRootPresent || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (!fs.existsSync(receipt.backupDir!)) {
    throw new Error("migration backup is missing; refusing destructive rollback");
  }
  for (const introduced of receipt.introducedSkills) {
    if (hashSharedSkillDirectory(path.join(sharedSkillsDir, introduced.name)) !== introduced.hash) {
      throw new Error(`canonical skill changed after migration: ${introduced.name}`);
    }
  }

  if (managedRootPresent) {
    fs.rmSync(managedSkillsDir, { force: true });
  }
  try {
    fs.renameSync(receipt.backupDir!, managedSkillsDir);
  } catch (error) {
    // Recreate the non-destructive canonical link when restoring the legacy
    // directory fails. The backup remains untouched for a later recovery.
    fs.symlinkSync(sharedSkillsDir, managedSkillsDir, "dir");
    throw new Error(`failed to restore migration backup: ${formatError(error)}`, { cause: error });
  }

  const rollbackPreservedDir = path.join(
    stateDir,
    "personal-skills-migration",
    "rollback-preserved",
    receipt.transactionId,
  );
  let cleanupError: unknown;
  for (const introduced of receipt.introducedSkills.toReversed()) {
    try {
      const canonicalSkillDir = path.join(sharedSkillsDir, introduced.name);
      if (hashSharedSkillDirectory(canonicalSkillDir) !== introduced.hash) {
        throw new Error(`canonical skill changed during rollback: ${introduced.name}`);
      }
      // Never delete a migrated body during rollback. Rename it atomically out
      // of the active catalog and retain it beside the receipt. If an editor
      // races after the hash check, those bytes move into recovery instead of
      // being lost; the restored legacy root remains the active copy.
      fs.mkdirSync(rollbackPreservedDir, { recursive: true });
      fs.renameSync(canonicalSkillDir, path.join(rollbackPreservedDir, introduced.name));
    } catch (error) {
      cleanupError ??= error;
    }
  }

  const rollbackStatus: SharedSkillsRootStatus = cleanupError ? "rollback-failed" : "rolled-back";
  const rolledBack: SharedSkillsRootReceipt = {
    ...receipt,
    generatedAt: new Date().toISOString(),
    status: rollbackStatus,
    rollbackPreservedDir,
    message: cleanupError
      ? `Legacy root restored, but copied canonical quarantine failed: ${formatError(cleanupError)}`
      : `Legacy managed skills root restored; migrated copies preserved at ${rollbackPreservedDir}.`,
  };
  atomicWriteJson(receiptPath, rolledBack);
  atomicWriteJson(path.join(receiptDir, "latest.json"), rolledBack);
  return {
    status: rollbackStatus,
    sharedSkillsDir,
    managedSkillsDir,
    receiptPath,
    backupDir: rolledBack.backupDir,
    rollbackPreservedDir,
    inventory: rolledBack.inventory,
    unknownEntries: rolledBack.unknownEntries,
    message: rolledBack.message,
  };
}
