import crypto from "node:crypto";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openBoundaryFile } from "../infra/boundary-file-read.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { resolveBundledSkillsDir } from "./skills/bundled-dir.js";
import { parseFrontmatter, resolveOpenClawMetadata } from "./skills/frontmatter.js";
import { resolveWorkspaceTemplateDir } from "./workspace-templates.js";

export function resolveDefaultAgentWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const home = resolveRequiredHomeDir(env, homedir);
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(home, ".openclaw", `workspace-${profile}`);
  }
  return path.join(home, ".openclaw", "workspace");
}

export const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();
export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
export const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";
const DAILY_MEMORY_DIRNAME = "memory";
const WORKSPACE_STATE_DIRNAME = ".openclaw";
const WORKSPACE_STATE_FILENAME = "workspace-state.json";
const WORKSPACE_STATE_VERSION = 1;
const WORKSPACE_SKILL_MARKER_FILENAME = ".openclaw-skill.json";
const WORKSPACE_SKILL_MANAGED_SOURCE = "openclaw-bundled";

const workspaceTemplateCache = new Map<string, Promise<string>>();
let gitAvailabilityPromise: Promise<boolean> | null = null;
const MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES = 2 * 1024 * 1024;
const workspaceLogger = createSubsystemLogger("workspace");

// File content cache keyed by stable file identity to avoid stale reads.
const workspaceFileCache = new Map<string, { content: string; identity: string }>();

/**
 * Read workspace files via boundary-safe open and cache by inode/dev/size/mtime identity.
 */
type WorkspaceGuardedReadResult =
  | { ok: true; content: string }
  | { ok: false; reason: "path" | "validation" | "io"; error?: unknown };

function workspaceFileIdentity(stat: syncFs.Stats, canonicalPath: string): string {
  return `${canonicalPath}|${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

async function readWorkspaceFileWithGuards(params: {
  filePath: string;
  workspaceDir: string;
}): Promise<WorkspaceGuardedReadResult> {
  const opened = await openBoundaryFile({
    absolutePath: params.filePath,
    rootPath: params.workspaceDir,
    boundaryLabel: "workspace root",
    maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  });
  if (!opened.ok) {
    workspaceFileCache.delete(params.filePath);
    return opened;
  }

  const identity = workspaceFileIdentity(opened.stat, opened.path);
  const cached = workspaceFileCache.get(params.filePath);
  if (cached && cached.identity === identity) {
    syncFs.closeSync(opened.fd);
    return { ok: true, content: cached.content };
  }

  try {
    const content = syncFs.readFileSync(opened.fd, "utf-8");
    workspaceFileCache.set(params.filePath, { content, identity });
    return { ok: true, content };
  } catch (error) {
    workspaceFileCache.delete(params.filePath);
    return { ok: false, reason: "io", error };
  } finally {
    syncFs.closeSync(opened.fd);
  }
}

function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return content;
  }
  const start = endIndex + "\n---".length;
  let trimmed = content.slice(start);
  trimmed = trimmed.replace(/^\s+/, "");
  return trimmed;
}

async function loadTemplate(name: string): Promise<string> {
  const cached = workspaceTemplateCache.get(name);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const templateDir = await resolveWorkspaceTemplateDir();
    const templatePath = path.join(templateDir, name);
    try {
      const content = await fs.readFile(templatePath, "utf-8");
      return stripFrontMatter(content);
    } catch {
      throw new Error(
        `Missing workspace template: ${name} (${templatePath}). Ensure docs/reference/templates are packaged.`,
      );
    }
  })();

  workspaceTemplateCache.set(name, pending);
  try {
    return await pending;
  } catch (error) {
    workspaceTemplateCache.delete(name);
    throw error;
  }
}

export type WorkspaceBootstrapFileName =
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_SOUL_FILENAME
  | typeof DEFAULT_TOOLS_FILENAME
  | typeof DEFAULT_IDENTITY_FILENAME
  | typeof DEFAULT_USER_FILENAME
  | typeof DEFAULT_HEARTBEAT_FILENAME
  | typeof DEFAULT_BOOTSTRAP_FILENAME
  | typeof DEFAULT_MEMORY_FILENAME
  | typeof DEFAULT_MEMORY_ALT_FILENAME
  | `memory/${string}.md`;

export type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
};

export type ExtraBootstrapLoadDiagnosticCode =
  | "invalid-bootstrap-filename"
  | "missing"
  | "security"
  | "io";

export type ExtraBootstrapLoadDiagnostic = {
  path: string;
  reason: ExtraBootstrapLoadDiagnosticCode;
  detail: string;
};

type WorkspaceSetupState = {
  version: typeof WORKSPACE_STATE_VERSION;
  bootstrapSeededAt?: string;
  setupCompletedAt?: string;
};

/** Set of recognized bootstrap filenames for runtime validation */
const VALID_BOOTSTRAP_NAMES: ReadonlySet<string> = new Set([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
]);

async function writeFileIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(filePath, content, {
      encoding: "utf-8",
      flag: "wx",
    });
    return true;
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "EEXIST") {
      throw err;
    }
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveWorkspaceStatePath(dir: string): string {
  return path.join(dir, WORKSPACE_STATE_DIRNAME, WORKSPACE_STATE_FILENAME);
}

type ManagedWorkspaceSkillMarker = {
  version: 1;
  source: typeof WORKSPACE_SKILL_MANAGED_SOURCE;
  bundledTreeHash: string;
  updatedAt: string;
};

function resolveWorkspaceSkillMarkerPath(skillDir: string): string {
  return path.join(skillDir, WORKSPACE_SKILL_MARKER_FILENAME);
}

function shouldIgnoreWorkspaceSkillTreeEntry(entryName: string): boolean {
  return entryName === ".clawhub" || entryName === WORKSPACE_SKILL_MARKER_FILENAME;
}

async function hashWorkspaceSkillTree(dir: string): Promise<string> {
  const hash = crypto.createHash("sha256");

  const walk = async (currentDir: string, relativeDir: string): Promise<void> => {
    let entries: Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }>;
    try {
      entries = (await fs.readdir(currentDir, {
        encoding: "utf8",
        withFileTypes: true,
      })) as Array<{
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
        isSymbolicLink(): boolean;
      }>;
    } catch {
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (shouldIgnoreWorkspaceSkillTreeEntry(entry.name)) {
        continue;
      }

      const entryRelativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`dir:${entryRelativePath}\n`);
        await walk(entryPath, entryRelativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        hash.update(`symlink:${entryRelativePath}\n`);
        try {
          hash.update(await fs.readlink(entryPath));
        } catch {
          // Ignore broken links while still keeping the traversal deterministic.
        }
        hash.update("\n");
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      hash.update(`file:${entryRelativePath}\n`);
      hash.update(await fs.readFile(entryPath));
      hash.update("\n");
    }
  };

  await walk(dir, "");
  return hash.digest("hex");
}

async function readManagedWorkspaceSkillMarker(
  skillDir: string,
): Promise<ManagedWorkspaceSkillMarker | null> {
  const markerPath = resolveWorkspaceSkillMarkerPath(skillDir);
  try {
    const raw = await fs.readFile(markerPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ManagedWorkspaceSkillMarker> | null;
    if (
      parsed &&
      parsed.version === 1 &&
      parsed.source === WORKSPACE_SKILL_MANAGED_SOURCE &&
      typeof parsed.bundledTreeHash === "string" &&
      parsed.bundledTreeHash.trim().length > 0 &&
      typeof parsed.updatedAt === "string" &&
      parsed.updatedAt.trim().length > 0
    ) {
      return {
        version: 1,
        source: WORKSPACE_SKILL_MANAGED_SOURCE,
        bundledTreeHash: parsed.bundledTreeHash,
        updatedAt: parsed.updatedAt,
      };
    }
    return null;
  } catch (error) {
    const anyErr = error as { code?: string };
    if (anyErr.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeManagedWorkspaceSkillMarker(
  skillDir: string,
  bundledTreeHash: string,
): Promise<void> {
  const markerPath = resolveWorkspaceSkillMarkerPath(skillDir);
  const payload: ManagedWorkspaceSkillMarker = {
    version: 1,
    source: WORKSPACE_SKILL_MANAGED_SOURCE,
    bundledTreeHash,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(markerPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf-8" });
}

function relativeRequiredBinsFromSkill(raw: string): string[] {
  const metadata = resolveOpenClawMetadata(parseFrontmatter(raw));
  return (metadata?.requires?.bins ?? [])
    .filter((bin): bin is string => typeof bin === "string" && bin.startsWith("./"))
    .toSorted();
}

function bundledShadowFrontmatterMatches(
  workspaceSkillRaw: string,
  bundledSkillRaw: string,
): boolean {
  const workspaceFrontmatter = parseFrontmatter(workspaceSkillRaw);
  const bundledFrontmatter = parseFrontmatter(bundledSkillRaw);
  const identityKeys = ["name", "description", "homepage", "metadata"] as const;
  return identityKeys.every(
    (key) => (workspaceFrontmatter[key] ?? "").trim() === (bundledFrontmatter[key] ?? "").trim(),
  );
}

async function hasMissingRelativeRequiredBins(
  skillDir: string,
  requiredBins: string[],
): Promise<boolean> {
  if (requiredBins.length === 0) {
    return false;
  }
  const missing = await Promise.all(
    requiredBins.map(async (bin) => !(await fileExists(path.join(skillDir, bin)))),
  );
  return missing.some(Boolean);
}

async function legacyWorkspaceSkillLooksBundled(params: {
  workspaceSkillDir: string;
  workspaceSkillPath: string;
  bundledSkillPath: string;
}): Promise<boolean> {
  let workspaceSkillRaw = "";
  let bundledSkillRaw = "";
  try {
    [workspaceSkillRaw, bundledSkillRaw] = await Promise.all([
      fs.readFile(params.workspaceSkillPath, "utf-8"),
      fs.readFile(params.bundledSkillPath, "utf-8"),
    ]);
  } catch {
    return false;
  }

  const workspaceRelativeBins = relativeRequiredBinsFromSkill(workspaceSkillRaw);
  if (await hasMissingRelativeRequiredBins(params.workspaceSkillDir, workspaceRelativeBins)) {
    return true;
  }

  const bundledRelativeBins = relativeRequiredBinsFromSkill(bundledSkillRaw);
  if (workspaceRelativeBins.length === 0 && bundledRelativeBins.length > 0) {
    return true;
  }
  if (workspaceRelativeBins.length === 0) {
    return false;
  }

  return (
    workspaceRelativeBins.length === bundledRelativeBins.length &&
    workspaceRelativeBins.every((bin, index) => bin === bundledRelativeBins[index])
  );
}

async function unmarkedWorkspaceSkillLooksBundled(params: {
  workspaceSkillPath: string;
  bundledSkillPath: string;
}): Promise<boolean> {
  let workspaceSkillRaw = "";
  let bundledSkillRaw = "";
  try {
    [workspaceSkillRaw, bundledSkillRaw] = await Promise.all([
      fs.readFile(params.workspaceSkillPath, "utf-8"),
      fs.readFile(params.bundledSkillPath, "utf-8"),
    ]);
  } catch {
    return false;
  }

  if (!bundledShadowFrontmatterMatches(workspaceSkillRaw, bundledSkillRaw)) {
    return false;
  }

  const workspaceRelativeBins = relativeRequiredBinsFromSkill(workspaceSkillRaw);
  const bundledRelativeBins = relativeRequiredBinsFromSkill(bundledSkillRaw);
  if (workspaceRelativeBins.length === 0) {
    return false;
  }

  return (
    workspaceRelativeBins.length === bundledRelativeBins.length &&
    workspaceRelativeBins.every((bin, index) => bin === bundledRelativeBins[index])
  );
}

async function refreshLegacyBundledWorkspaceSkills(workspaceDir: string): Promise<void> {
  const bundledSkillsDir = resolveBundledSkillsDir();
  if (!bundledSkillsDir) {
    return;
  }

  const workspaceSkillsDir = path.join(workspaceDir, "skills");
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = (await fs.readdir(workspaceSkillsDir, {
      encoding: "utf8",
      withFileTypes: true,
    })) as Array<{ name: string; isDirectory(): boolean }>;
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDir = path.join(workspaceSkillsDir, entry.name);
    const skillPath = path.join(skillDir, "SKILL.md");
    const legacyOriginPath = path.join(skillDir, ".clawhub", "origin.json");
    const bundledSkillDir = path.join(bundledSkillsDir, entry.name);
    const bundledSkillPath = path.join(bundledSkillDir, "SKILL.md");

    const [hasWorkspaceSkill, hasBundledSkill] = await Promise.all([
      fileExists(skillPath),
      fileExists(bundledSkillPath),
    ]);
    if (!hasWorkspaceSkill || !hasBundledSkill) {
      continue;
    }

    const managedMarker = await readManagedWorkspaceSkillMarker(skillDir);
    const hasLegacyOrigin = await fileExists(legacyOriginPath);
    const isManagedWorkspaceSkill =
      managedMarker !== null ||
      (hasLegacyOrigin &&
        (await legacyWorkspaceSkillLooksBundled({
          workspaceSkillDir: skillDir,
          workspaceSkillPath: skillPath,
          bundledSkillPath,
        }))) ||
      (!hasLegacyOrigin &&
        (await unmarkedWorkspaceSkillLooksBundled({
          workspaceSkillPath: skillPath,
          bundledSkillPath,
        })));
    if (!isManagedWorkspaceSkill) {
      continue;
    }

    const bundledTreeHash = await hashWorkspaceSkillTree(bundledSkillDir);
    const workspaceTreeHash = await hashWorkspaceSkillTree(skillDir);
    const treeMatchesBundled = workspaceTreeHash === bundledTreeHash;

    if (treeMatchesBundled) {
      if (!managedMarker || managedMarker.bundledTreeHash !== bundledTreeHash) {
        await writeManagedWorkspaceSkillMarker(skillDir, bundledTreeHash);
        await fs.rm(legacyOriginPath, { force: true }).catch(() => {});
      }
      continue;
    }

    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.cp(bundledSkillDir, skillDir, { recursive: true, force: true });
    await writeManagedWorkspaceSkillMarker(skillDir, bundledTreeHash);
    await fs.rm(legacyOriginPath, { force: true }).catch(() => {});
    workspaceLogger.info("Refreshed managed workspace skill from bundled tree.", {
      skill: entry.name,
      skillDir,
      bundledTreeHash,
      workspaceTreeHash,
    });
  }
}

function parseWorkspaceSetupState(raw: string): WorkspaceSetupState | null {
  try {
    const parsed = JSON.parse(raw) as {
      bootstrapSeededAt?: unknown;
      setupCompletedAt?: unknown;
      onboardingCompletedAt?: unknown;
    };
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const legacyCompletedAt =
      typeof parsed.onboardingCompletedAt === "string" ? parsed.onboardingCompletedAt : undefined;
    return {
      version: WORKSPACE_STATE_VERSION,
      bootstrapSeededAt:
        typeof parsed.bootstrapSeededAt === "string" ? parsed.bootstrapSeededAt : undefined,
      setupCompletedAt:
        typeof parsed.setupCompletedAt === "string" ? parsed.setupCompletedAt : legacyCompletedAt,
    };
  } catch {
    return null;
  }
}

async function readWorkspaceSetupState(statePath: string): Promise<WorkspaceSetupState> {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = parseWorkspaceSetupState(raw);
    if (
      parsed &&
      raw.includes('"onboardingCompletedAt"') &&
      !raw.includes('"setupCompletedAt"') &&
      parsed.setupCompletedAt
    ) {
      await writeWorkspaceSetupState(statePath, parsed);
    }
    return parsed ?? { version: WORKSPACE_STATE_VERSION };
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "ENOENT") {
      throw err;
    }
    return {
      version: WORKSPACE_STATE_VERSION,
    };
  }
}

async function readWorkspaceSetupStateForDir(dir: string): Promise<WorkspaceSetupState> {
  const statePath = resolveWorkspaceStatePath(resolveUserPath(dir));
  return await readWorkspaceSetupState(statePath);
}

export async function isWorkspaceSetupCompleted(dir: string): Promise<boolean> {
  const state = await readWorkspaceSetupStateForDir(dir);
  return typeof state.setupCompletedAt === "string" && state.setupCompletedAt.trim().length > 0;
}

async function writeWorkspaceSetupState(
  statePath: string,
  state: WorkspaceSetupState,
): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(tmpPath, payload, { encoding: "utf-8" });
    await fs.rename(tmpPath, statePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function hasGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isGitAvailable(): Promise<boolean> {
  if (gitAvailabilityPromise) {
    return gitAvailabilityPromise;
  }

  gitAvailabilityPromise = (async () => {
    try {
      const result = await runCommandWithTimeout(["git", "--version"], { timeoutMs: 2_000 });
      return result.code === 0;
    } catch {
      return false;
    }
  })();

  return gitAvailabilityPromise;
}

async function ensureGitRepo(dir: string, isBrandNewWorkspace: boolean) {
  if (!isBrandNewWorkspace) {
    return;
  }
  if (await hasGitRepo(dir)) {
    return;
  }
  if (!(await isGitAvailable())) {
    return;
  }
  try {
    await runCommandWithTimeout(["git", "init"], { cwd: dir, timeoutMs: 10_000 });
  } catch {
    // Ignore git init failures; workspace creation should still succeed.
  }
}

export async function ensureAgentWorkspace(params?: {
  dir?: string;
  ensureBootstrapFiles?: boolean;
}): Promise<{
  dir: string;
  agentsPath?: string;
  soulPath?: string;
  toolsPath?: string;
  identityPath?: string;
  userPath?: string;
  heartbeatPath?: string;
  bootstrapPath?: string;
}> {
  const rawDir = params?.dir?.trim() ? params.dir.trim() : DEFAULT_AGENT_WORKSPACE_DIR;
  const dir = resolveUserPath(rawDir);
  await fs.mkdir(dir, { recursive: true });
  await refreshLegacyBundledWorkspaceSkills(dir);

  if (!params?.ensureBootstrapFiles) {
    return { dir };
  }

  const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
  const soulPath = path.join(dir, DEFAULT_SOUL_FILENAME);
  const toolsPath = path.join(dir, DEFAULT_TOOLS_FILENAME);
  const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);
  const userPath = path.join(dir, DEFAULT_USER_FILENAME);
  const heartbeatPath = path.join(dir, DEFAULT_HEARTBEAT_FILENAME);
  const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);
  const statePath = resolveWorkspaceStatePath(dir);

  const isBrandNewWorkspace = await (async () => {
    const templatePaths = [agentsPath, soulPath, toolsPath, identityPath, userPath, heartbeatPath];
    const userContentPaths = [
      path.join(dir, "memory"),
      path.join(dir, DEFAULT_MEMORY_FILENAME),
      path.join(dir, ".git"),
    ];
    const paths = [...templatePaths, ...userContentPaths];
    const existing = await Promise.all(
      paths.map(async (p) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      }),
    );
    return existing.every((v) => !v);
  })();

  const agentsTemplate = await loadTemplate(DEFAULT_AGENTS_FILENAME);
  const soulTemplate = await loadTemplate(DEFAULT_SOUL_FILENAME);
  const toolsTemplate = await loadTemplate(DEFAULT_TOOLS_FILENAME);
  const identityTemplate = await loadTemplate(DEFAULT_IDENTITY_FILENAME);
  const userTemplate = await loadTemplate(DEFAULT_USER_FILENAME);
  const heartbeatTemplate = await loadTemplate(DEFAULT_HEARTBEAT_FILENAME);
  await writeFileIfMissing(agentsPath, agentsTemplate);
  await writeFileIfMissing(soulPath, soulTemplate);
  await writeFileIfMissing(toolsPath, toolsTemplate);
  await writeFileIfMissing(identityPath, identityTemplate);
  await writeFileIfMissing(userPath, userTemplate);
  await writeFileIfMissing(heartbeatPath, heartbeatTemplate);

  let state = await readWorkspaceSetupState(statePath);
  let stateDirty = false;
  const markState = (next: Partial<WorkspaceSetupState>) => {
    state = { ...state, ...next };
    stateDirty = true;
  };
  const nowIso = () => new Date().toISOString();

  let bootstrapExists = await fileExists(bootstrapPath);
  if (!state.bootstrapSeededAt && bootstrapExists) {
    markState({ bootstrapSeededAt: nowIso() });
  }

  if (!state.setupCompletedAt && state.bootstrapSeededAt && !bootstrapExists) {
    markState({ setupCompletedAt: nowIso() });
  }

  if (!state.bootstrapSeededAt && !state.setupCompletedAt && !bootstrapExists) {
    // Legacy migration path: if USER/IDENTITY diverged from templates, or if user-content
    // indicators exist, treat setup as complete and avoid recreating BOOTSTRAP for
    // already-configured workspaces.
    const [identityContent, userContent] = await Promise.all([
      fs.readFile(identityPath, "utf-8"),
      fs.readFile(userPath, "utf-8"),
    ]);
    const hasUserContent = await (async () => {
      const indicators = [
        path.join(dir, "memory"),
        path.join(dir, DEFAULT_MEMORY_FILENAME),
        path.join(dir, ".git"),
      ];
      for (const indicator of indicators) {
        try {
          await fs.access(indicator);
          return true;
        } catch {
          // continue
        }
      }
      return false;
    })();
    const legacySetupCompleted =
      identityContent !== identityTemplate || userContent !== userTemplate || hasUserContent;
    if (legacySetupCompleted) {
      markState({ setupCompletedAt: nowIso() });
    } else {
      const bootstrapTemplate = await loadTemplate(DEFAULT_BOOTSTRAP_FILENAME);
      const wroteBootstrap = await writeFileIfMissing(bootstrapPath, bootstrapTemplate);
      if (!wroteBootstrap) {
        bootstrapExists = await fileExists(bootstrapPath);
      } else {
        bootstrapExists = true;
      }
      if (bootstrapExists && !state.bootstrapSeededAt) {
        markState({ bootstrapSeededAt: nowIso() });
      }
    }
  }

  if (stateDirty) {
    await writeWorkspaceSetupState(statePath, state);
  }
  await ensureGitRepo(dir, isBrandNewWorkspace);

  return {
    dir,
    agentsPath,
    soulPath,
    toolsPath,
    identityPath,
    userPath,
    heartbeatPath,
    bootstrapPath,
  };
}

async function resolveMemoryBootstrapEntry(
  resolvedDir: string,
): Promise<{ name: WorkspaceBootstrapFileName; filePath: string } | null> {
  // Prefer MEMORY.md; fall back to memory.md only when absent.
  // Checking both and deduplicating via realpath is unreliable on case-insensitive
  // file systems mounted in Docker (e.g. macOS volumes), where both names pass
  // fs.access() but realpath does not normalise case through the mount layer,
  // causing the same content to be injected twice and wasting tokens.
  for (const name of [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME] as const) {
    const filePath = path.join(resolvedDir, name);
    try {
      await fs.access(filePath);
      return { name, filePath };
    } catch {
      // try next candidate
    }
  }
  return null;
}

function formatLocalDateKey(nowMs: number): string {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveRecentDailyMemoryEntryNames(nowMs: number): WorkspaceBootstrapFileName[] {
  const today = new Date(nowMs);
  const yesterday = new Date(nowMs);
  yesterday.setDate(yesterday.getDate() - 1);
  return [
    `${DAILY_MEMORY_DIRNAME}/${formatLocalDateKey(today.getTime())}.md`,
    `${DAILY_MEMORY_DIRNAME}/${formatLocalDateKey(yesterday.getTime())}.md`,
  ];
}

export async function loadWorkspaceBootstrapFiles(
  dir: string,
  opts?: {
    includeRecentDailyMemory?: boolean;
    nowMs?: number;
  },
): Promise<WorkspaceBootstrapFile[]> {
  const resolvedDir = resolveUserPath(dir);

  const entries: Array<{
    name: WorkspaceBootstrapFileName;
    filePath: string;
  }> = [
    {
      name: DEFAULT_AGENTS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME),
    },
    {
      name: DEFAULT_SOUL_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME),
    },
    {
      name: DEFAULT_TOOLS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME),
    },
    {
      name: DEFAULT_IDENTITY_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME),
    },
    {
      name: DEFAULT_USER_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME),
    },
    {
      name: DEFAULT_HEARTBEAT_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_HEARTBEAT_FILENAME),
    },
    {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME),
    },
  ];

  const memoryEntry = await resolveMemoryBootstrapEntry(resolvedDir);
  if (memoryEntry) {
    entries.push(memoryEntry);
  }
  if (opts?.includeRecentDailyMemory) {
    // Daily notes are dynamic and intentionally loaded only for trusted personal
    // sessions. We append today+yesterday here so the agent sees the same recent
    // memory window that AGENTS.md asks it to consult on startup.
    for (const relativeName of resolveRecentDailyMemoryEntryNames(opts.nowMs ?? Date.now())) {
      entries.push({
        name: relativeName,
        filePath: path.join(resolvedDir, relativeName),
      });
    }
  }

  const result: WorkspaceBootstrapFile[] = [];
  for (const entry of entries) {
    const loaded = await readWorkspaceFileWithGuards({
      filePath: entry.filePath,
      workspaceDir: resolvedDir,
    });
    if (loaded.ok) {
      result.push({
        name: entry.name,
        path: entry.filePath,
        content: loaded.content,
        missing: false,
      });
    } else {
      result.push({ name: entry.name, path: entry.filePath, missing: true });
    }
  }
  return result;
}

const MINIMAL_BOOTSTRAP_ALLOWLIST = new Set([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
]);

export function filterBootstrapFilesForSession(
  files: WorkspaceBootstrapFile[],
  sessionKey?: string,
): WorkspaceBootstrapFile[] {
  if (!sessionKey || (!isSubagentSessionKey(sessionKey) && !isCronSessionKey(sessionKey))) {
    return files;
  }
  return files.filter((file) => MINIMAL_BOOTSTRAP_ALLOWLIST.has(file.name));
}

export async function loadExtraBootstrapFiles(
  dir: string,
  extraPatterns: string[],
): Promise<WorkspaceBootstrapFile[]> {
  const loaded = await loadExtraBootstrapFilesWithDiagnostics(dir, extraPatterns);
  return loaded.files;
}

export async function loadExtraBootstrapFilesWithDiagnostics(
  dir: string,
  extraPatterns: string[],
): Promise<{
  files: WorkspaceBootstrapFile[];
  diagnostics: ExtraBootstrapLoadDiagnostic[];
}> {
  if (!extraPatterns.length) {
    return { files: [], diagnostics: [] };
  }
  const resolvedDir = resolveUserPath(dir);

  // Resolve glob patterns into concrete file paths
  const resolvedPaths = new Set<string>();
  for (const pattern of extraPatterns) {
    if (pattern.includes("*") || pattern.includes("?") || pattern.includes("{")) {
      try {
        const matches = fs.glob(pattern, { cwd: resolvedDir });
        for await (const m of matches) {
          resolvedPaths.add(m);
        }
      } catch {
        // glob not available or pattern error — fall back to literal
        resolvedPaths.add(pattern);
      }
    } else {
      resolvedPaths.add(pattern);
    }
  }

  const files: WorkspaceBootstrapFile[] = [];
  const diagnostics: ExtraBootstrapLoadDiagnostic[] = [];
  for (const relPath of resolvedPaths) {
    const filePath = path.resolve(resolvedDir, relPath);
    // Only load files whose basename is a recognized bootstrap filename
    const baseName = path.basename(relPath);
    if (!VALID_BOOTSTRAP_NAMES.has(baseName)) {
      diagnostics.push({
        path: filePath,
        reason: "invalid-bootstrap-filename",
        detail: `unsupported bootstrap basename: ${baseName}`,
      });
      continue;
    }
    const loaded = await readWorkspaceFileWithGuards({
      filePath,
      workspaceDir: resolvedDir,
    });
    if (loaded.ok) {
      files.push({
        name: baseName as WorkspaceBootstrapFileName,
        path: filePath,
        content: loaded.content,
        missing: false,
      });
      continue;
    }

    const reason: ExtraBootstrapLoadDiagnosticCode =
      loaded.reason === "path" ? "missing" : loaded.reason === "validation" ? "security" : "io";
    diagnostics.push({
      path: filePath,
      reason,
      detail:
        loaded.error instanceof Error
          ? loaded.error.message
          : typeof loaded.error === "string"
            ? loaded.error
            : reason,
    });
  }
  return { files, diagnostics };
}
