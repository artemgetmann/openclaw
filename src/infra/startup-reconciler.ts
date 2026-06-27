import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";

const STATUS_FORMAT = 1;
const STATUS_RELATIVE_PATH = path.join("startup-reconciler", "status.json");
const TOOL_VERSION_TIMEOUT_MS = 2_000;
const STARTUP_MANAGED_TOOL_SKILLS = new Set(["gog"]);

const log = createSubsystemLogger("startup/reconciler");

type CapabilitiesManifest = {
  format?: unknown;
  skills?: Record<string, CapabilitySkill>;
  managedTools?: CapabilityTool[];
};

type CapabilitySkill = {
  sha256?: unknown;
  files?: unknown;
  displayName?: unknown;
};

type CapabilityTool = {
  skillName?: unknown;
  installId?: unknown;
  bins?: unknown;
  versionCommand?: unknown;
  versionRegex?: unknown;
  recommendedVersion?: unknown;
  label?: unknown;
};

type ReconcilerLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type ToolVersionRunner = (command: string[], env: NodeJS.ProcessEnv) => VersionProbeResult;

type VersionProbeResult = {
  ok: boolean;
  output: string;
  error?: string;
};

type StartupReconcilerOptions = {
  packageRoot?: string;
  manifestPath?: string;
  bundledSkillsDir?: string;
  stateDir?: string;
  managedProductSkillsDir?: string;
  managedBinDir?: string;
  env?: NodeJS.ProcessEnv;
  log?: ReconcilerLog;
  runVersionCommand?: ToolVersionRunner;
};

type SkillStatus = {
  name: string;
  displayName?: string;
  packagedHash: string;
  managedHash?: string;
  status: "current" | "updated" | "missing-packaged" | "failed";
  message?: string;
};

type ToolStatus = {
  skillName: string;
  displayName: string;
  bin: string;
  recommendedVersion?: string;
  managedPath: string;
  managedVersion?: string;
  sourcePath?: string;
  sourceVersion?: string;
  status: "current" | "updated" | "missing-source" | "no-recommendation" | "failed";
  message?: string;
};

export type StartupReconcilerStatus = {
  format: typeof STATUS_FORMAT;
  generatedAt: string;
  packageRoot?: string;
  manifestPath?: string;
  stateDir: string;
  managedProductSkillsDir: string;
  managedBinDir: string;
  skills: SkillStatus[];
  tools: ToolStatus[];
  notifications: string[];
};

export type StartupReconcilerResult =
  | { status: "skipped"; reason: "missing-package-root" | "missing-manifest" | "invalid-manifest" }
  | { status: "reconciled"; statusPath: string; report: StartupReconcilerStatus };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => asString(item)).filter((item): item is string => Boolean(item))
    : [];
}

function assertSafeName(name: string, label: string) {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new Error(`invalid ${label}: ${JSON.stringify(name)}`);
  }
}

function parseVersionParts(version: string): number[] {
  return version
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }
  return 0;
}

function extractVersion(output: string, versionRegex?: string): string | undefined {
  const pattern = versionRegex
    ? new RegExp(versionRegex)
    : /v?(\d+(?:\.\d+)+(?:[-.][0-9A-Za-z]+)?)/;
  const match = output.match(pattern);
  return match?.groups?.version ?? match?.[1];
}

function hashSkillDirectory(skillDir: string): string | undefined {
  const hash = crypto.createHash("sha256");
  const files: Array<{ fullPath: string; relativePath: string }> = [];

  const visit = (currentDir: string, relativeRoot = "") => {
    const entries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .toSorted((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.join(relativeRoot, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, relativePath);
      } else if (entry.isFile()) {
        files.push({ fullPath, relativePath });
      }
    }
  };

  try {
    visit(skillDir);
    for (const file of files) {
      hash.update(file.relativePath);
      hash.update("\0");
      hash.update(fs.readFileSync(file.fullPath));
      hash.update("\0");
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

function readManifest(manifestPath: string): CapabilitiesManifest | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
    return isRecord(parsed) ? (parsed as CapabilitiesManifest) : undefined;
  } catch {
    return undefined;
  }
}

function defaultVersionRunner(command: string[], env: NodeJS.ProcessEnv): VersionProbeResult {
  const [bin, ...args] = command;
  if (!bin) {
    return { ok: false, output: "", error: "empty command" };
  }
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    env,
    timeout: TOOL_VERSION_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
    error: result.error?.message,
  };
}

function isExecutable(filePath: string): boolean {
  try {
    return (
      fs.statSync(filePath).isFile() && fs.accessSync(filePath, fs.constants.X_OK) === undefined
    );
  } catch {
    return false;
  }
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((item) => {
    const normalized = path.resolve(item);
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function pathCandidatesForBin(params: {
  bin: string;
  packageRoot: string;
  managedBinDir: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const pathDirs = (params.env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);
  const managedBinDir = path.resolve(params.managedBinDir);

  // Packaged/runtime-local candidates come first. PATH candidates are read-only
  // sources only; the reconciler never runs package-manager install/update
  // commands because Jarvis must not mutate global user tooling on startup.
  return uniquePaths([
    path.join(params.packageRoot, "bin", params.bin),
    path.join(params.packageRoot, "tools", params.bin),
    path.join(params.packageRoot, "tools", params.bin, "bin", params.bin),
    path.join(params.packageRoot, "node_modules", ".bin", params.bin),
    ...pathDirs
      .filter((dir) => path.resolve(dir) !== managedBinDir)
      .map((dir) => path.join(dir, params.bin)),
  ]).filter(isExecutable);
}

function probeVersion(params: {
  command: string[];
  candidatePath?: string;
  versionRegex?: string;
  env: NodeJS.ProcessEnv;
  runVersionCommand: ToolVersionRunner;
}): { version?: string; error?: string } {
  const command =
    params.candidatePath && params.command.length > 0
      ? [params.candidatePath, ...params.command.slice(1)]
      : params.command;
  const result = params.runVersionCommand(command, params.env);
  if (!result.ok && !result.output) {
    return { error: result.error ?? "version command failed" };
  }
  const version = extractVersion(result.output, params.versionRegex);
  return version ? { version } : { error: "version command did not expose a parseable version" };
}

async function copyManagedExecutable(sourcePath: string, targetPath: string) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.copyFile(sourcePath, tempPath);
  await fsp.chmod(tempPath, 0o755);
  await fsp.rename(tempPath, targetPath);
}

async function syncManagedSkills(params: {
  manifest: CapabilitiesManifest;
  bundledSkillsDir: string;
  managedProductSkillsDir: string;
}): Promise<SkillStatus[]> {
  const skills = isRecord(params.manifest.skills) ? params.manifest.skills : {};
  const results: SkillStatus[] = [];

  for (const [name, skill] of Object.entries(skills).toSorted(([a], [b]) => a.localeCompare(b))) {
    assertSafeName(name, "skill name");
    const packagedHash = asString(skill?.sha256);
    if (!packagedHash) {
      continue;
    }
    const displayName = asString(skill?.displayName);
    const sourceDir = path.join(params.bundledSkillsDir, name);
    const targetDir = path.join(params.managedProductSkillsDir, name);
    if (!fs.existsSync(path.join(sourceDir, "SKILL.md"))) {
      results.push({
        name,
        displayName,
        packagedHash,
        status: "missing-packaged",
        message: `Packaged skill ${displayName ?? name} is missing from bundled skills.`,
      });
      continue;
    }

    const managedHash = hashSkillDirectory(targetDir);
    if (managedHash === packagedHash) {
      results.push({ name, displayName, packagedHash, managedHash, status: "current" });
      continue;
    }

    try {
      // Replace only the product-owned mirror. Do not write to stateDir/skills:
      // that root can be symlinked to ~/.agents/skills and is user-owned.
      await fsp.rm(targetDir, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(targetDir), { recursive: true });
      await fsp.cp(sourceDir, targetDir, { recursive: true, force: true });
      results.push({
        name,
        displayName,
        packagedHash,
        managedHash,
        status: "updated",
        message: `Updated ${displayName ?? name} skill from packaged Jarvis runtime.`,
      });
    } catch (err) {
      results.push({
        name,
        displayName,
        packagedHash,
        managedHash,
        status: "failed",
        message: `Failed to update ${displayName ?? name} skill: ${String(err)}`,
      });
    }
  }

  return results;
}

async function reconcileManagedTools(params: {
  manifest: CapabilitiesManifest;
  packageRoot: string;
  managedBinDir: string;
  env: NodeJS.ProcessEnv;
  runVersionCommand: ToolVersionRunner;
}): Promise<ToolStatus[]> {
  const tools = Array.isArray(params.manifest.managedTools) ? params.manifest.managedTools : [];
  const results: ToolStatus[] = [];

  for (const tool of tools) {
    const skillName = asString(tool.skillName);
    const bins = asStringArray(tool.bins);
    const versionCommand = asStringArray(tool.versionCommand);
    const recommendedVersion = asString(tool.recommendedVersion);
    if (!skillName || bins.length === 0) {
      continue;
    }
    // First runtime proof is Google Workspace. Keep the startup mutator narrow
    // until packaged managed-tool payloads exist for the rest of the manifest.
    if (!STARTUP_MANAGED_TOOL_SKILLS.has(skillName)) {
      continue;
    }
    const displayName =
      skillName === "gog" ? "Google Workspace" : (asString(tool.label) ?? skillName);
    const versionRegex = asString(tool.versionRegex);
    for (const bin of bins) {
      assertSafeName(bin, "tool bin");
      const managedPath = path.join(params.managedBinDir, bin);
      if (!recommendedVersion || versionCommand.length === 0) {
        results.push({
          skillName,
          displayName,
          bin,
          managedPath,
          recommendedVersion,
          status: "no-recommendation",
        });
        continue;
      }

      const managedProbe = isExecutable(managedPath)
        ? probeVersion({
            command: versionCommand,
            candidatePath: managedPath,
            versionRegex,
            env: params.env,
            runVersionCommand: params.runVersionCommand,
          })
        : {};
      if (managedProbe.version && compareVersions(managedProbe.version, recommendedVersion) >= 0) {
        results.push({
          skillName,
          displayName,
          bin,
          recommendedVersion,
          managedPath,
          managedVersion: managedProbe.version,
          status: "current",
        });
        continue;
      }

      let selected:
        | {
            path: string;
            version: string;
          }
        | undefined;
      for (const candidate of pathCandidatesForBin({
        bin,
        packageRoot: params.packageRoot,
        managedBinDir: params.managedBinDir,
        env: params.env,
      })) {
        const sourceProbe = probeVersion({
          command: versionCommand,
          candidatePath: candidate,
          versionRegex,
          env: params.env,
          runVersionCommand: params.runVersionCommand,
        });
        if (sourceProbe.version && compareVersions(sourceProbe.version, recommendedVersion) >= 0) {
          selected = { path: candidate, version: sourceProbe.version };
          break;
        }
      }

      if (!selected) {
        results.push({
          skillName,
          displayName,
          bin,
          recommendedVersion,
          managedPath,
          managedVersion: managedProbe.version,
          status: "missing-source",
          message: `${displayName} needs CLI v${recommendedVersion}, but no packaged or local ${bin} binary with that version was available.`,
        });
        continue;
      }

      try {
        await copyManagedExecutable(selected.path, managedPath);
        results.push({
          skillName,
          displayName,
          bin,
          recommendedVersion,
          managedPath,
          managedVersion: managedProbe.version,
          sourcePath: selected.path,
          sourceVersion: selected.version,
          status: "updated",
          message: `Updated Jarvis-managed ${displayName} CLI to v${selected.version}.`,
        });
      } catch (err) {
        results.push({
          skillName,
          displayName,
          bin,
          recommendedVersion,
          managedPath,
          managedVersion: managedProbe.version,
          sourcePath: selected.path,
          sourceVersion: selected.version,
          status: "failed",
          message: `Failed to update Jarvis-managed ${displayName} CLI: ${String(err)}`,
        });
      }
    }
  }

  return results;
}

function materialNotifications(report: StartupReconcilerStatus): string[] {
  return [
    ...report.skills
      .filter((item) => item.status === "updated" || item.status === "failed")
      .map((item) => item.message)
      .filter((item): item is string => Boolean(item)),
    ...report.tools
      .filter(
        (item) =>
          item.status === "updated" || item.status === "failed" || item.status === "missing-source",
      )
      .map((item) => item.message)
      .filter((item): item is string => Boolean(item)),
  ];
}

function notificationSignature(report: StartupReconcilerStatus): string {
  return JSON.stringify({
    skills: report.skills
      .filter((item) => item.status !== "current")
      .map((item) => [item.name, item.status, item.packagedHash, item.managedHash]),
    tools: report.tools
      .filter((item) => item.status !== "current")
      .map((item) => [
        item.skillName,
        item.bin,
        item.status,
        item.recommendedVersion,
        item.managedVersion,
        item.sourceVersion,
      ]),
  });
}

function readPreviousSignature(statusPath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as StartupReconcilerStatus;
    if (!isRecord(parsed)) {
      return undefined;
    }
    return notificationSignature(parsed);
  } catch {
    return undefined;
  }
}

async function writeStatus(statusPath: string, report: StartupReconcilerStatus) {
  await fsp.mkdir(path.dirname(statusPath), { recursive: true });
  await fsp.writeFile(statusPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function emitMaterialLogs(params: {
  previousSignature?: string;
  report: StartupReconcilerStatus;
  log: ReconcilerLog;
}) {
  const currentSignature = notificationSignature(params.report);
  if (currentSignature === params.previousSignature) {
    return;
  }
  for (const message of params.report.notifications) {
    if (message.includes("Failed") || message.includes("needs")) {
      params.log.warn?.(message);
    } else {
      params.log.info?.(message);
    }
  }
}

export async function runStartupReconciler(
  opts: StartupReconcilerOptions = {},
): Promise<StartupReconcilerResult> {
  const env = opts.env ?? process.env;
  const packageRoot =
    opts.packageRoot ??
    (await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })) ??
    undefined;
  if (!packageRoot) {
    return { status: "skipped", reason: "missing-package-root" };
  }

  const manifestPath = opts.manifestPath ?? path.join(packageRoot, "capabilities.manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return { status: "skipped", reason: "missing-manifest" };
  }
  const manifest = readManifest(manifestPath);
  if (!manifest || manifest.format !== STATUS_FORMAT) {
    return { status: "skipped", reason: "invalid-manifest" };
  }

  const stateDir = opts.stateDir ?? resolveStateDir(env);
  const managedProductSkillsDir =
    opts.managedProductSkillsDir ?? path.join(stateDir, "product-skills");
  const managedBinDir = opts.managedBinDir ?? path.join(stateDir, "bin");
  const bundledSkillsDir = opts.bundledSkillsDir ?? path.join(packageRoot, "skills");
  const runVersionCommand = opts.runVersionCommand ?? defaultVersionRunner;
  const statusPath = path.join(stateDir, STATUS_RELATIVE_PATH);
  const previousSignature = readPreviousSignature(statusPath);

  const skills = await syncManagedSkills({
    manifest,
    bundledSkillsDir,
    managedProductSkillsDir,
  });
  const tools = await reconcileManagedTools({
    manifest,
    packageRoot,
    managedBinDir,
    env,
    runVersionCommand,
  });
  const report: StartupReconcilerStatus = {
    format: STATUS_FORMAT,
    generatedAt: new Date().toISOString(),
    packageRoot,
    manifestPath,
    stateDir,
    managedProductSkillsDir,
    managedBinDir,
    skills,
    tools,
    notifications: [],
  };
  report.notifications = materialNotifications(report);

  await writeStatus(statusPath, report);
  emitMaterialLogs({ previousSignature, report, log: opts.log ?? log });
  return { status: "reconciled", statusPath, report };
}
