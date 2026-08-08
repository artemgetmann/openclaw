import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { parseFrontmatter, resolveOpenClawMetadata } from "./frontmatter.js";
import { isSharedBundledSkillMirrorDir } from "./shared-personal-mirror.js";

export type PersonalSkillVisibility = "shared" | "codex" | "jarvis";

export type PersonalSkillVisibilityStatus = {
  name: string;
  visibility: PersonalSkillVisibility;
  skillFile: string;
  sharedSkillsDir: string;
  managedSkillsDir: string;
  codexConfigPath: string;
  codexEnabled: boolean;
  jarvisEnabled: boolean;
};

type RuntimePaths = {
  name: string;
  skillFile: string;
  sharedSkillsDir: string;
  managedSkillsDir: string;
  codexConfigPath: string;
};

type VisibilityOptions = {
  homeDir?: string;
  stateDir: string;
  codexConfigPath?: string;
  workspaceDir?: string;
  fs?: typeof fs;
};

type SetVisibilityOptions = VisibilityOptions & {
  config: OpenClawConfig;
  writeJarvisConfig: (config: OpenClawConfig) => Promise<void>;
};

const CODEX_SKILL_TABLE = /^\s*\[\[skills\.config\]\]\s*(?:#.*)?$/;
const ANY_TOML_TABLE = /^\s*\[+[^\]]+\]+\s*(?:#.*)?$/;
const CODEX_PATH_FIELD = /^\s*path\s*=\s*(?:("(?:[^"\\]|\\.)*")|'([^']*)')\s*(?:#.*)?$/;
const CODEX_ENABLED_FIELD = /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/;

function assertSafeSkillName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`invalid personal skill name: ${JSON.stringify(name)}`);
  }
}

function readCodexConfig(fsImpl: typeof fs, configPath: string): string {
  try {
    return fsImpl.readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function readSkillIdentity(
  fsImpl: typeof fs,
  skillFile: string,
  fallbackName?: string,
): {
  name: string;
  skillKey: string;
} {
  const frontmatter = parseFrontmatter(fsImpl.readFileSync(skillFile, "utf8"));
  const name = frontmatter.name?.trim() || fallbackName;
  if (!name) {
    throw new Error(`personal skill lacks a frontmatter name: ${skillFile}`);
  }
  const skillKey = resolveOpenClawMetadata(frontmatter)?.skillKey?.trim() || name;
  return { name, skillKey };
}

function findHigherPrecedenceShadow(params: {
  fs: typeof fs;
  roots: string[];
  canonicalReal: string;
  name: string;
}): string | undefined {
  for (const root of params.roots) {
    if (!params.fs.existsSync(root)) {
      continue;
    }
    for (const entry of params.fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const candidate = path.join(root, entry.name, "SKILL.md");
      if (!params.fs.existsSync(candidate)) {
        continue;
      }
      try {
        // The app-owned legacy workspace may itself be reconciled to the
        // canonical root. That is the same body discovered twice, not a shadow.
        if (params.fs.realpathSync(candidate) === params.canonicalReal) {
          continue;
        }
        if (readSkillIdentity(params.fs, candidate, entry.name).name === params.name) {
          return candidate;
        }
      } catch {
        // Malformed skills are ignored by the loader and cannot shadow the
        // validated canonical body.
      }
    }
  }
  return undefined;
}

function resolveRuntimePaths(params: VisibilityOptions & { name: string }): RuntimePaths {
  const fsImpl = params.fs ?? fs;
  const homeDir = params.homeDir ?? os.homedir();
  assertSafeSkillName(params.name);
  const sharedSkillsDir = path.join(homeDir, ".agents", "skills");
  const managedSkillsDir = path.join(params.stateDir, "skills");
  const skillDir = path.join(sharedSkillsDir, params.name);
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fsImpl.existsSync(skillFile) || !fsImpl.lstatSync(skillFile).isFile()) {
    throw new Error(`unknown canonical personal skill: ${params.name}`);
  }
  const sharedRootReal = fsImpl.realpathSync(sharedSkillsDir);
  const skillReal = fsImpl.realpathSync(skillFile);
  const relativeSkillPath = path.relative(sharedRootReal, skillReal);
  if (
    relativeSkillPath === ".." ||
    relativeSkillPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeSkillPath)
  ) {
    throw new Error(`canonical personal skill resolves outside the shared root: ${params.name}`);
  }
  const identity = readSkillIdentity(fsImpl, skillFile);
  if (identity.name !== params.name || identity.skillKey !== params.name) {
    throw new Error(
      `canonical personal skill folder, frontmatter name, and skillKey must all match: ${params.name}`,
    );
  }
  if (isSharedBundledSkillMirrorDir(skillDir)) {
    throw new Error(
      `${params.name} is a product-managed bundled mirror, not a personal skill visibility target`,
    );
  }
  const canonicalReal = fsImpl.realpathSync(skillFile);
  const shadow = findHigherPrecedenceShadow({
    fs: fsImpl,
    roots: [
      path.join(params.stateDir, "product-skills"),
      ...(params.workspaceDir
        ? [
            path.join(params.workspaceDir, ".agents", "skills"),
            path.join(params.workspaceDir, "skills"),
          ]
        : []),
    ],
    canonicalReal,
    name: params.name,
  });
  if (shadow) {
    // Jarvis eligibility is keyed by skill name after loader precedence is
    // resolved. Refuse a misleading personal visibility change when Jarvis
    // would actually load a product/project/workspace body with the same name.
    throw new Error(`canonical personal skill is shadowed by a higher-precedence skill: ${shadow}`);
  }
  try {
    if (
      !fsImpl.lstatSync(managedSkillsDir).isSymbolicLink() ||
      fsImpl.realpathSync(managedSkillsDir) !== fsImpl.realpathSync(sharedSkillsDir)
    ) {
      throw new Error("managed root is not canonical");
    }
  } catch {
    throw new Error(
      "Jarvis is using a legacy managed skills root; resolve its migration receipt before changing cross-runtime visibility",
    );
  }
  return {
    name: params.name,
    skillFile,
    sharedSkillsDir,
    managedSkillsDir,
    codexConfigPath: params.codexConfigPath ?? path.join(homeDir, ".codex", "config.toml"),
  };
}

type CodexConfigBlock = {
  start: number;
  end: number;
  path?: string;
  enabled?: boolean;
};

function parseCodexSkillBlocks(text: string): { lines: string[]; blocks: CodexConfigBlock[] } {
  const lines = text.match(/.*(?:\r?\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  const starts = lines
    .map((line, index) => (CODEX_SKILL_TABLE.test(line.replace(/\r?\n$/, "")) ? index : -1))
    .filter((index) => index >= 0);
  const blocks: CodexConfigBlock[] = [];

  for (const start of starts) {
    let end = start + 1;
    while (end < lines.length && !ANY_TOML_TABLE.test(lines[end]!.replace(/\r?\n$/, ""))) {
      end += 1;
    }
    const paths: string[] = [];
    const enabledValues: boolean[] = [];
    for (const line of lines.slice(start + 1, end)) {
      const raw = line.replace(/\r?\n$/, "");
      const pathMatch = raw.match(CODEX_PATH_FIELD);
      if (pathMatch?.[1] || pathMatch?.[2] !== undefined) {
        try {
          paths.push(pathMatch[1] ? (JSON.parse(pathMatch[1]) as string) : pathMatch[2]!);
        } catch {
          throw new Error("malformed Codex skills.config path string");
        }
      } else if (/^\s*path\s*=/.test(raw)) {
        throw new Error("malformed Codex skills.config path field");
      }
      const enabledMatch = raw.match(CODEX_ENABLED_FIELD);
      if (enabledMatch?.[1]) {
        enabledValues.push(enabledMatch[1] === "true");
      } else if (/^\s*enabled\s*=/.test(raw)) {
        throw new Error("malformed Codex skills.config enabled field");
      }
    }
    if (paths.length > 1 || enabledValues.length > 1) {
      throw new Error("malformed Codex skills.config block");
    }
    blocks.push({ start, end, path: paths[0], enabled: enabledValues[0] });
  }
  return { lines, blocks };
}

export function readCodexPersonalSkillEnabled(text: string, skillFile: string): boolean {
  const { blocks } = parseCodexSkillBlocks(text);
  const matches = blocks.filter((block) => block.path === skillFile);
  if (matches.length > 1) {
    throw new Error("ambiguous duplicate Codex skill visibility entries");
  }
  const match = matches[0];
  if (!match) {
    return true;
  }
  if (match.enabled === undefined) {
    throw new Error("matching Codex skill visibility entry lacks boolean enabled");
  }
  return match.enabled;
}

export function renderCodexPersonalSkillEnabled(
  text: string,
  skillFile: string,
  enabled: boolean,
): string {
  // Parse and classify first. A duplicate or malformed matching entry must not
  // be normalized by accident because that would hide an ambiguous user state.
  readCodexPersonalSkillEnabled(text, skillFile);
  const { lines, blocks } = parseCodexSkillBlocks(text);
  const matchingIndexes = new Set<number>();
  for (const block of blocks) {
    if (block.path === skillFile) {
      for (let index = block.start; index < block.end; index += 1) {
        matchingIndexes.add(index);
      }
    }
  }
  let rendered = lines
    .filter((_line, index) => !matchingIndexes.has(index))
    .join("")
    .trimEnd();
  if (rendered.length > 0) {
    rendered += "\n";
  }
  if (!enabled) {
    rendered += [
      rendered.length > 0 ? "\n" : "",
      "[[skills.config]]\n",
      `path = ${JSON.stringify(skillFile)}\n`,
      "enabled = false\n",
    ].join("");
  }
  readCodexPersonalSkillEnabled(rendered, skillFile);
  return rendered;
}

function jarvisSkillEnabled(config: OpenClawConfig, name: string): boolean {
  const enabled = config.skills?.entries?.[name]?.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error(`malformed Jarvis visibility entry for ${name}`);
  }
  return enabled !== false;
}

function renderJarvisSkillEnabled(
  config: OpenClawConfig,
  name: string,
  enabled: boolean,
): OpenClawConfig {
  jarvisSkillEnabled(config, name);
  const entries = { ...config.skills?.entries };
  const current = { ...entries[name] };
  if (enabled) {
    delete current.enabled;
    if (Object.keys(current).length === 0) {
      delete entries[name];
    } else {
      entries[name] = current;
    }
  } else {
    entries[name] = { ...current, enabled: false };
  }
  return {
    ...config,
    skills: {
      ...config.skills,
      entries,
    },
  };
}

function classifyVisibility(
  codexEnabled: boolean,
  jarvisEnabled: boolean,
): PersonalSkillVisibility {
  if (codexEnabled && jarvisEnabled) return "shared";
  if (codexEnabled) return "codex";
  if (jarvisEnabled) return "jarvis";
  throw new Error("invalid personal skill visibility: disabled in both Codex and Jarvis");
}

function atomicCompareWrite(params: {
  fs: typeof fs;
  targetPath: string;
  expected: string;
  next: string;
}): void {
  if (params.expected === params.next) {
    return;
  }
  let writePath = params.targetPath;
  let expectedSymlinkTarget: string | undefined;
  try {
    if (params.fs.lstatSync(params.targetPath).isSymbolicLink()) {
      const linkedPath = params.fs.readlinkSync(params.targetPath);
      expectedSymlinkTarget = path.resolve(path.dirname(params.targetPath), linkedPath);
      try {
        writePath = params.fs.realpathSync(params.targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        // Preserve a dangling dotfiles link and atomically create its intended
        // target instead of renaming a regular file over the link itself.
        writePath = expectedSymlinkTarget;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const current = readCodexConfig(params.fs, writePath);
  if (current !== params.expected) {
    throw new Error(`concurrent Codex config change detected: ${params.targetPath}`);
  }
  params.fs.mkdirSync(path.dirname(writePath), { recursive: true });
  const mode = params.fs.existsSync(writePath) ? params.fs.statSync(writePath).mode & 0o777 : 0o600;
  const temporaryPath = path.join(
    path.dirname(writePath),
    `.${path.basename(writePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    params.fs.writeFileSync(temporaryPath, params.next, { encoding: "utf8", mode });
    if (
      expectedSymlinkTarget !== undefined &&
      path.resolve(path.dirname(params.targetPath), params.fs.readlinkSync(params.targetPath)) !==
        expectedSymlinkTarget
    ) {
      throw new Error(`concurrent Codex config symlink change detected: ${params.targetPath}`);
    }
    params.fs.renameSync(temporaryPath, writePath);
  } finally {
    params.fs.rmSync(temporaryPath, { force: true });
  }
}

export function getPersonalSkillVisibilityStatus(
  params: VisibilityOptions & {
    name: string;
    config: OpenClawConfig;
  },
): PersonalSkillVisibilityStatus {
  const fsImpl = params.fs ?? fs;
  const paths = resolveRuntimePaths(params);
  const codexEnabled = readCodexPersonalSkillEnabled(
    readCodexConfig(fsImpl, paths.codexConfigPath),
    paths.skillFile,
  );
  const jarvisEnabled = jarvisSkillEnabled(params.config, paths.name);
  return {
    ...paths,
    visibility: classifyVisibility(codexEnabled, jarvisEnabled),
    codexEnabled,
    jarvisEnabled,
  };
}

export async function setPersonalSkillVisibility(
  name: string,
  visibility: PersonalSkillVisibility,
  params: SetVisibilityOptions,
): Promise<PersonalSkillVisibilityStatus> {
  const fsImpl = params.fs ?? fs;
  const paths = resolveRuntimePaths({ ...params, name });
  const oldCodex = readCodexConfig(fsImpl, paths.codexConfigPath);
  const codexEnabled = visibility !== "jarvis";
  const jarvisEnabled = visibility !== "codex";
  const nextCodex = renderCodexPersonalSkillEnabled(oldCodex, paths.skillFile, codexEnabled);
  const nextJarvis = renderJarvisSkillEnabled(params.config, name, jarvisEnabled);
  let codexWritten = false;

  try {
    if (nextCodex !== oldCodex) {
      atomicCompareWrite({
        fs: fsImpl,
        targetPath: paths.codexConfigPath,
        expected: oldCodex,
        next: nextCodex,
      });
      codexWritten = true;
    }
    if (jarvisSkillEnabled(params.config, name) !== jarvisEnabled) {
      await params.writeJarvisConfig(nextJarvis);
    }
  } catch (error) {
    if (codexWritten) {
      // Roll back only while our exact output is still present. A concurrent
      // Codex edit wins over cleanup; silently overwriting it would be worse
      // than surfacing a recoverable partial visibility state.
      atomicCompareWrite({
        fs: fsImpl,
        targetPath: paths.codexConfigPath,
        expected: nextCodex,
        next: oldCodex,
      });
    }
    throw error;
  }

  return {
    ...paths,
    visibility,
    codexEnabled,
    jarvisEnabled,
  };
}

export function buildTemporaryCodexSkillInjectionArgs(skillFile: string, args: string[]): string[] {
  if (!path.isAbsolute(skillFile)) {
    throw new Error("temporary Codex skill path must be absolute");
  }
  if (args.length === 0) {
    throw new Error("missing Codex command after --");
  }
  return args;
}

function createTemporaryCodexHome(params: {
  fs: typeof fs;
  codexConfigPath: string;
  skillFile: string;
}): string {
  const sourceHome = path.dirname(params.codexConfigPath);
  const temporaryHome = params.fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-skill-"));
  try {
    if (params.fs.existsSync(sourceHome)) {
      for (const entry of params.fs.readdirSync(sourceHome, { withFileTypes: true })) {
        if (entry.name === path.basename(params.codexConfigPath)) {
          continue;
        }
        // Keep auth, plugins, and ordinary Codex state available without
        // copying or mutating them. The only materialized file is the bounded
        // config below; removing this directory never follows these symlinks.
        params.fs.symlinkSync(
          path.join(sourceHome, entry.name),
          path.join(temporaryHome, entry.name),
          entry.isDirectory() ? "dir" : "file",
        );
      }
    }
    const sourceConfig = readCodexConfig(params.fs, params.codexConfigPath);
    const temporaryConfig = renderCodexPersonalSkillEnabled(sourceConfig, params.skillFile, true);
    params.fs.writeFileSync(path.join(temporaryHome, "config.toml"), temporaryConfig, {
      encoding: "utf8",
      mode: 0o600,
    });
    return temporaryHome;
  } catch (error) {
    params.fs.rmSync(temporaryHome, { recursive: true, force: true });
    throw error;
  }
}

export function runWithTemporaryCodexSkill(
  params: VisibilityOptions & {
    name: string;
    args: string[];
    spawnCodex?: typeof spawnSync;
  },
): number {
  const fsImpl = params.fs ?? fs;
  const paths = resolveRuntimePaths(params);
  const temporaryHome = createTemporaryCodexHome({
    fs: fsImpl,
    codexConfigPath: paths.codexConfigPath,
    skillFile: paths.skillFile,
  });
  try {
    const result = (params.spawnCodex ?? spawnSync)(
      "codex",
      buildTemporaryCodexSkillInjectionArgs(paths.skillFile, params.args),
      {
        stdio: "inherit",
        env: { ...process.env, CODEX_HOME: temporaryHome },
      },
    );
    if (result.error) {
      throw result.error;
    }
    return result.status ?? 1;
  } finally {
    // The temporary config is process-scoped. Symlinked Codex state remains at
    // its original location; rm removes only the bounded home and its links.
    fsImpl.rmSync(temporaryHome, { recursive: true, force: true });
  }
}
