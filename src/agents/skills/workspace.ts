import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatSkillsForPrompt, type Skill } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import { resolveSandboxPath } from "../sandbox-paths.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { resolveBundledAllowlist, shouldExposeSkillToModel, shouldIncludeSkill } from "./config.js";
import { normalizeSkillFilter, resolveSkillFilter } from "./filter.js";
import {
  parseFrontmatter,
  resolveOpenClawMetadata,
  resolveSkillInvocationPolicy,
  resolveSkillKey,
} from "./frontmatter.js";
import { loadSkillsFromDirWithFrontmatterFallback } from "./loader.js";
import { resolvePluginSkillDirs } from "./plugin-skills.js";
import { serializeByKey } from "./serialize.js";
import { isSharedBundledSkillMirrorDir } from "./shared-personal-mirror.js";
import type {
  ParsedSkillFrontmatter,
  SkillEligibilityContext,
  SkillCommandSpec,
  SkillEntry,
  SkillSnapshot,
} from "./types.js";

const fsp = fs.promises;
const skillsLogger = createSubsystemLogger("skills");
const skillCommandDebugOnce = new Set<string>();

/**
 * Replace the user's home directory prefix with `~` in skill file paths
 * to reduce system prompt token usage.
 *
 * Keep runtime-owned skills absolute. They are frequently read immediately on
 * live turns, and we have seen model-side `~` expansion or path guessing
 * produce malformed paths for app-owned/product skills. For symlink-backed
 * workspace skills, prefer a shorter canonical absolute path when one exists.
 * It remains directly readable while recovering prompt budget otherwise spent
 * repeating a long app-support workspace prefix for every skill.
 *
 * Example compacted path:
 * `/Users/alice/.bun/.../skills/github/SKILL.md`
 *   → `~/.bun/.../skills/github/SKILL.md`
 */
function compactSkillPaths(skills: Skill[]): Skill[] {
  const home = os.homedir();
  if (!home) return skills;
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return skills.map((skill) => {
    if (skill.source === "openclaw-workspace" || skill.source === "workspace") {
      try {
        const canonicalPath = fs.realpathSync.native(skill.filePath);
        if (canonicalPath.length < skill.filePath.length) {
          return { ...skill, filePath: canonicalPath };
        }
      } catch {
        // A prompt snapshot can outlive a removed skill. Preserve the original
        // location so this display-only optimization never breaks generation.
      }
      return skill;
    }
    return {
      ...skill,
      filePath:
        // Product-managed and bundled skills are runtime-owned. Preserve exact
        // paths so model-side file reads do not depend on shell-style `~`
        // expansion or reconstructed product paths.
        skill.source === "openclaw-product-managed" || skill.source === "openclaw-bundled"
          ? skill.filePath
          : skill.filePath.startsWith(prefix)
            ? "~/" + skill.filePath.slice(prefix.length)
            : skill.filePath,
    };
  });
}

function debugSkillCommandOnce(
  messageKey: string,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (skillCommandDebugOnce.has(messageKey)) {
    return;
  }
  skillCommandDebugOnce.add(messageKey);
  skillsLogger.debug(message, meta);
}

function filterSkillEntries(
  entries: SkillEntry[],
  config?: OpenClawConfig,
  skillFilter?: string[],
  eligibility?: SkillEligibilityContext,
  opts?: { includeMissingSetupForModel?: boolean },
): SkillEntry[] {
  const includeEntry = opts?.includeMissingSetupForModel
    ? shouldExposeSkillToModel
    : shouldIncludeSkill;
  let filtered = entries.filter((entry) => includeEntry({ entry, entries, config, eligibility }));
  // If skillFilter is provided, only include skills in the filter list.
  if (skillFilter !== undefined) {
    const normalized = resolveSkillFilter(skillFilter, config, entries) ?? [];
    const label = normalized.length > 0 ? normalized.join(", ") : "(none)";
    skillsLogger.debug(`Applying skill filter: ${label}`);
    filtered =
      normalized.length > 0
        ? filtered.filter((entry) => normalized.includes(entry.skill.name))
        : [];
    skillsLogger.debug(
      `After skill filter: ${filtered.map((entry) => entry.skill.name).join(", ") || "(none)"}`,
    );
  }
  return filtered;
}

const SKILL_COMMAND_MAX_LENGTH = 32;
const SKILL_COMMAND_FALLBACK = "skill";
// Discord command descriptions must be ≤100 characters
const SKILL_COMMAND_DESCRIPTION_MAX_LENGTH = 100;

const DEFAULT_MAX_CANDIDATES_PER_ROOT = 300;
const DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE = 200;
const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 30_000;
const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000;
const CRITICAL_PRODUCT_POLICY_SKILL = "goal-mode";

function resolvePromptSourcePriority(source?: string): number {
  switch (source) {
    case "openclaw-workspace":
      return 0;
    case "agents-skills-project":
      return 1;
    case "openclaw-product-managed":
      return 2;
    case "openclaw-managed":
      return 3;
    case "openclaw-bundled":
      return 4;
    case "openclaw-extra":
      return 5;
    default:
      return 6;
  }
}

function isSelectedSkillForPrompt(
  entry: SkillEntry,
  config?: OpenClawConfig,
  selectedSkillNames?: ReadonlySet<string>,
): boolean {
  const skillKey = resolveSkillKey(entry.skill, entry);
  return (
    selectedSkillNames?.has(entry.skill.name) ||
    selectedSkillNames?.has(skillKey) ||
    Boolean(config?.skills?.entries?.[skillKey] ?? config?.skills?.entries?.[entry.skill.name])
  );
}

function resolvePromptEntryPriority(
  entry: SkillEntry,
  config?: OpenClawConfig,
  selectedSkillNames?: ReadonlySet<string>,
): number {
  // A configured or agent-filtered skill is a deliberate runtime capability.
  // In consumer workspaces, the workspace skill folder can contain broad
  // personal inventory, so selected skills must survive overflow trimming.
  if (isSelectedSkillForPrompt(entry, config, selectedSkillNames)) {
    return 0;
  }

  // `goal-mode` is the sole product policy skill that must remain routable when
  // the prompt inventory is trimmed. Keep this exception source-specific: a
  // workspace override still wins during merge, and every other product-managed
  // skill retains the established source ranking below workspace inventory.
  if (
    entry.skill.name === CRITICAL_PRODUCT_POLICY_SKILL &&
    entry.skill.source === "openclaw-product-managed"
  ) {
    return 1;
  }
  if (entry.skill.source === "openclaw-workspace") {
    return 2;
  }
  if (entry.skill.source === "agents-skills-project") {
    return 3;
  }
  return 4 + resolvePromptSourcePriority(entry.skill.source);
}

function rankSkillsForPrompt(
  entries: SkillEntry[],
  config?: OpenClawConfig,
  skillFilter?: string[],
  inventory: SkillEntry[] = entries,
): Skill[] {
  // Prompt limits trim from the front. Explicit and dependency-expanded
  // selections must survive truncation or natural-language routing cannot
  // choose skills the model never sees. Duplicate-name workspace overrides
  // already win in the merge map before this ranking runs. Keep the full
  // inventory for skillKey resolution after disabled entries leave `entries`.
  const selectedSkillNames = new Set([
    ...(resolveBundledAllowlist(config, inventory) ?? []),
    ...(resolveSkillFilter(skillFilter, config, inventory) ?? []),
  ]);
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const sourceDelta =
        resolvePromptEntryPriority(a.entry, config, selectedSkillNames) -
        resolvePromptEntryPriority(b.entry, config, selectedSkillNames);
      if (sourceDelta !== 0) {
        return sourceDelta;
      }
      return a.index - b.index;
    })
    .map(({ entry }) => entry.skill);
}

function resolveProtectedSkillNames(
  entries: SkillEntry[],
  config?: OpenClawConfig,
  skillFilter?: string[],
  inventory: SkillEntry[] = entries,
): Set<string> {
  const selectedSkillNames = new Set([
    ...(resolveBundledAllowlist(config, inventory) ?? []),
    ...(resolveSkillFilter(skillFilter, config, inventory) ?? []),
  ]);
  return new Set(
    entries
      .filter((entry) => resolvePromptEntryPriority(entry, config, selectedSkillNames) <= 1)
      .map((entry) => entry.skill.name),
  );
}

const SKILL_MATCH_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "before",
  "can",
  "for",
  "from",
  "have",
  "into",
  "its",
  "not",
  "that",
  "the",
  "their",
  "this",
  "use",
  "user",
  "when",
  "with",
  "you",
  "your",
]);

/**
 * Normalize routing text without trying to become a full search engine.
 *
 * The lightweight plural folding is intentional: user prompts often say
 * "priorities" while a skill name says "priority". Keeping this resolver
 * deterministic avoids a model call before the model-facing prompt exists.
 */
function normalizeSkillMatchTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => {
      if (token.length > 4 && token.endsWith("ies")) {
        return `${token.slice(0, -3)}y`;
      }
      if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) {
        return token.slice(0, -1);
      }
      return token;
    })
    .filter((token) => token.length >= 3 && !SKILL_MATCH_STOP_WORDS.has(token));
}

function countTokenOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

function collectAdjacentPhrases(tokens: string[]): Set<string> {
  const phrases = new Set<string>();
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    phrases.add(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return phrases;
}

function containsTokenSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  return haystack.some((_, start) =>
    needle.every((token, offset) => haystack[start + offset] === token),
  );
}

function scoreSkillForUserPrompt(params: {
  skill: Skill;
  queryTokens: string[];
  querySet: ReadonlySet<string>;
  queryPhrases: ReadonlySet<string>;
}): { explicitMatch: boolean; score: number } {
  const { skill, queryTokens, querySet, queryPhrases } = params;
  const nameTokens = normalizeSkillMatchTokens(skill.name);
  const descriptionTokens = normalizeSkillMatchTokens(skill.description ?? "");
  const nameSet = new Set(nameTokens);
  const descriptionSet = new Set(descriptionTokens);
  const explicitMatch = containsTokenSequence(queryTokens, nameTokens);
  let score = 0;

  const nameOverlap = countTokenOverlap(nameSet, querySet);
  const descriptionOverlap = countTokenOverlap(descriptionSet, querySet);
  score += nameOverlap * 500;
  score += descriptionOverlap * 25;

  if (nameTokens.length > 0 && nameOverlap === nameSet.size) {
    score += 2_000;
  } else if (nameOverlap >= 2) {
    score += 750;
  }

  // Adjacent phrases such as "builder priority" and "build in public" carry
  // more routing intent than isolated generic words.
  for (const phrase of collectAdjacentPhrases(nameTokens)) {
    if (queryPhrases.has(phrase)) {
      score += 1_000;
    }
  }
  for (const phrase of collectAdjacentPhrases(descriptionTokens)) {
    if (queryPhrases.has(phrase)) {
      score += 100;
    }
  }

  return { explicitMatch, score };
}

function rankSkillsForPromptByUserPrompt(
  skills: Skill[],
  userPrompt?: string,
  protectedSkillNames: ReadonlySet<string> = new Set(),
): Skill[] {
  if (!userPrompt?.trim()) {
    return skills;
  }
  const queryTokens = normalizeSkillMatchTokens(userPrompt);
  if (queryTokens.length === 0) {
    return skills;
  }
  const querySet = new Set(queryTokens);
  const queryPhrases = collectAdjacentPhrases(queryTokens);
  return skills
    .map((skill, index) => {
      const relevance = scoreSkillForUserPrompt({
        skill,
        queryTokens,
        querySet,
        queryPhrases,
      });
      return {
        skill,
        index,
        ...relevance,
        protected: protectedSkillNames.has(skill.name),
      };
    })
    .sort(
      (left, right) =>
        Number(right.protected) - Number(left.protected) ||
        (left.protected
          ? left.index - right.index
          : Number(right.explicitMatch) - Number(left.explicitMatch) || right.score - left.score) ||
        left.index - right.index,
    )
    .map(({ skill }) => skill);
}

function sanitizeSkillCommandName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const trimmed = normalized.slice(0, SKILL_COMMAND_MAX_LENGTH);
  return trimmed || SKILL_COMMAND_FALLBACK;
}

function resolveUniqueSkillCommandName(base: string, used: Set<string>): string {
  const normalizedBase = base.toLowerCase();
  if (!used.has(normalizedBase)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `_${index}`;
    const maxBaseLength = Math.max(1, SKILL_COMMAND_MAX_LENGTH - suffix.length);
    const trimmedBase = base.slice(0, maxBaseLength);
    const candidate = `${trimmedBase}${suffix}`;
    const candidateKey = candidate.toLowerCase();
    if (!used.has(candidateKey)) {
      return candidate;
    }
  }
  const fallback = `${base.slice(0, Math.max(1, SKILL_COMMAND_MAX_LENGTH - 2))}_x`;
  return fallback;
}

type ResolvedSkillsLimits = {
  maxCandidatesPerRoot: number;
  maxSkillsLoadedPerSource: number;
  maxSkillsInPrompt: number;
  maxSkillsPromptChars: number;
  maxSkillFileBytes: number;
};

function resolveSkillsLimits(config?: OpenClawConfig): ResolvedSkillsLimits {
  const limits = config?.skills?.limits;
  return {
    maxCandidatesPerRoot: limits?.maxCandidatesPerRoot ?? DEFAULT_MAX_CANDIDATES_PER_ROOT,
    maxSkillsLoadedPerSource:
      limits?.maxSkillsLoadedPerSource ?? DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE,
    maxSkillsInPrompt: limits?.maxSkillsInPrompt ?? DEFAULT_MAX_SKILLS_IN_PROMPT,
    maxSkillsPromptChars: limits?.maxSkillsPromptChars ?? DEFAULT_MAX_SKILLS_PROMPT_CHARS,
    maxSkillFileBytes: limits?.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES,
  };
}

function listChildDirectories(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(entry.name);
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            dirs.push(entry.name);
          }
        } catch {
          // ignore broken symlinks
        }
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

function tryRealpath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function warnEscapedSkillPath(params: {
  source: string;
  rootDir: string;
  candidatePath: string;
  candidateRealPath: string;
}) {
  skillsLogger.warn("Skipping skill path that resolves outside its configured root.", {
    source: params.source,
    rootDir: params.rootDir,
    path: params.candidatePath,
    realPath: params.candidateRealPath,
  });
}

function resolveContainedSkillPath(params: {
  source: string;
  rootDir: string;
  rootRealPath: string;
  candidatePath: string;
}): string | null {
  const candidateRealPath = tryRealpath(params.candidatePath);
  if (!candidateRealPath) {
    return null;
  }
  if (isPathInside(params.rootRealPath, candidateRealPath)) {
    return candidateRealPath;
  }
  warnEscapedSkillPath({
    source: params.source,
    rootDir: params.rootDir,
    candidatePath: path.resolve(params.candidatePath),
    candidateRealPath,
  });
  return null;
}

function filterLoadedSkillsInsideRoot(params: {
  skills: Skill[];
  source: string;
  rootDir: string;
  rootRealPath: string;
}): Skill[] {
  return params.skills.filter((skill) => {
    const baseDirRealPath = resolveContainedSkillPath({
      source: params.source,
      rootDir: params.rootDir,
      rootRealPath: params.rootRealPath,
      candidatePath: skill.baseDir,
    });
    if (!baseDirRealPath) {
      return false;
    }
    const skillFileRealPath = resolveContainedSkillPath({
      source: params.source,
      rootDir: params.rootDir,
      rootRealPath: params.rootRealPath,
      candidatePath: skill.filePath,
    });
    return Boolean(skillFileRealPath);
  });
}

function resolveNestedSkillsRoot(
  dir: string,
  opts?: {
    maxEntriesToScan?: number;
  },
): { baseDir: string; note?: string } {
  const nested = path.join(dir, "skills");
  try {
    if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) {
      return { baseDir: dir };
    }
  } catch {
    return { baseDir: dir };
  }

  // Heuristic: if `dir/skills/*/SKILL.md` exists for any entry, treat `dir/skills` as the real root.
  // Note: don't stop at 25, but keep a cap to avoid pathological scans.
  const nestedDirs = listChildDirectories(nested);
  const scanLimit = Math.max(0, opts?.maxEntriesToScan ?? 100);
  const toScan = scanLimit === 0 ? [] : nestedDirs.slice(0, Math.min(nestedDirs.length, scanLimit));

  for (const name of toScan) {
    const skillMd = path.join(nested, name, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      return { baseDir: nested, note: `Detected nested skills root at ${nested}` };
    }
  }
  return { baseDir: dir };
}

function unwrapLoadedSkills(loaded: unknown): Skill[] {
  if (Array.isArray(loaded)) {
    return loaded as Skill[];
  }
  if (loaded && typeof loaded === "object" && "skills" in loaded) {
    const skills = (loaded as { skills?: unknown }).skills;
    if (Array.isArray(skills)) {
      return skills as Skill[];
    }
  }
  return [];
}

function preserveSharedBundledMirrorSource(params: { skill: Skill; source: string }): Skill {
  if (params.source !== "openclaw-managed") {
    return params.skill;
  }
  if (!isSharedBundledSkillMirrorDir(params.skill.baseDir)) {
    return params.skill;
  }
  // Mirrored package skills live under the managed personal root so Codex and
  // Jarvis share one filesystem copy. At runtime they must still behave like
  // bundled skills, otherwise `skills.allowBundled` can be bypassed.
  return { ...params.skill, source: "openclaw-bundled" };
}

function loadSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    productManagedSkillsDir?: string;
    bundledSkillsDir?: string;
  },
): SkillEntry[] {
  const limits = resolveSkillsLimits(opts?.config);

  const loadSkills = (params: { dir: string; source: string }): Skill[] => {
    const rootDir = path.resolve(params.dir);
    const rootRealPath = tryRealpath(rootDir) ?? rootDir;
    const resolved = resolveNestedSkillsRoot(params.dir, {
      maxEntriesToScan: limits.maxCandidatesPerRoot,
    });
    const baseDir = resolved.baseDir;
    const baseDirRealPath = resolveContainedSkillPath({
      source: params.source,
      rootDir,
      rootRealPath,
      candidatePath: baseDir,
    });
    if (!baseDirRealPath) {
      return [];
    }

    // If the root itself is a skill directory, just load it directly (but enforce size cap).
    const rootSkillMd = path.join(baseDir, "SKILL.md");
    if (fs.existsSync(rootSkillMd)) {
      const rootSkillRealPath = resolveContainedSkillPath({
        source: params.source,
        rootDir,
        rootRealPath: baseDirRealPath,
        candidatePath: rootSkillMd,
      });
      if (!rootSkillRealPath) {
        return [];
      }
      try {
        const size = fs.statSync(rootSkillRealPath).size;
        if (size > limits.maxSkillFileBytes) {
          skillsLogger.warn("Skipping skills root due to oversized SKILL.md.", {
            dir: baseDir,
            filePath: rootSkillMd,
            size,
            maxSkillFileBytes: limits.maxSkillFileBytes,
          });
          return [];
        }
      } catch {
        return [];
      }

      const loaded = loadSkillsFromDirWithFrontmatterFallback({
        dir: baseDir,
        source: params.source,
      });
      return filterLoadedSkillsInsideRoot({
        skills: unwrapLoadedSkills(loaded),
        source: params.source,
        rootDir,
        rootRealPath: baseDirRealPath,
      }).map((skill) => preserveSharedBundledMirrorSource({ skill, source: params.source }));
    }

    const childDirs = listChildDirectories(baseDir);
    const suspicious = childDirs.length > limits.maxCandidatesPerRoot;

    const maxCandidates = Math.max(0, limits.maxSkillsLoadedPerSource);
    const limitedChildren = childDirs.slice().sort().slice(0, maxCandidates);

    if (suspicious) {
      skillsLogger.warn("Skills root looks suspiciously large, truncating discovery.", {
        dir: params.dir,
        baseDir,
        childDirCount: childDirs.length,
        maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
        maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
      });
    } else if (childDirs.length > maxCandidates) {
      skillsLogger.warn("Skills root has many entries, truncating discovery.", {
        dir: params.dir,
        baseDir,
        childDirCount: childDirs.length,
        maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
      });
    }

    const loadedSkills: Skill[] = [];

    // Only consider immediate subfolders that look like skills (have SKILL.md) and are under size cap.
    for (const name of limitedChildren) {
      const skillDir = path.join(baseDir, name);
      const skillDirRealPath = resolveContainedSkillPath({
        source: params.source,
        rootDir,
        rootRealPath: baseDirRealPath,
        candidatePath: skillDir,
      });
      if (!skillDirRealPath) {
        continue;
      }
      const skillMd = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillMd)) {
        continue;
      }
      const skillMdRealPath = resolveContainedSkillPath({
        source: params.source,
        rootDir,
        rootRealPath: baseDirRealPath,
        candidatePath: skillMd,
      });
      if (!skillMdRealPath) {
        continue;
      }
      try {
        const size = fs.statSync(skillMdRealPath).size;
        if (size > limits.maxSkillFileBytes) {
          skillsLogger.warn("Skipping skill due to oversized SKILL.md.", {
            skill: name,
            filePath: skillMd,
            size,
            maxSkillFileBytes: limits.maxSkillFileBytes,
          });
          continue;
        }
      } catch {
        continue;
      }

      const loaded = loadSkillsFromDirWithFrontmatterFallback({
        dir: skillDir,
        source: params.source,
      });
      loadedSkills.push(
        ...filterLoadedSkillsInsideRoot({
          skills: unwrapLoadedSkills(loaded),
          source: params.source,
          rootDir,
          rootRealPath: baseDirRealPath,
        }).map((skill) => preserveSharedBundledMirrorSource({ skill, source: params.source })),
      );

      if (loadedSkills.length >= limits.maxSkillsLoadedPerSource) {
        break;
      }
    }

    if (loadedSkills.length > limits.maxSkillsLoadedPerSource) {
      return loadedSkills
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, limits.maxSkillsLoadedPerSource);
    }

    return loadedSkills;
  };

  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const productManagedSkillsDir =
    opts?.productManagedSkillsDir ?? path.join(CONFIG_DIR, "product-skills");
  const workspaceSkillsDir = path.resolve(workspaceDir, "skills");
  const bundledSkillsDir = opts?.bundledSkillsDir ?? resolveBundledSkillsDir();
  const extraDirsRaw = opts?.config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => (typeof d === "string" ? d.trim() : ""))
    .filter(Boolean);
  const pluginSkillDirs = resolvePluginSkillDirs({
    workspaceDir,
    config: opts?.config,
  });
  const mergedExtraDirs = [...extraDirs, ...pluginSkillDirs];

  const bundledSkills = bundledSkillsDir
    ? loadSkills({
        dir: bundledSkillsDir,
        source: "openclaw-bundled",
      })
    : [];
  const extraSkills = mergedExtraDirs.flatMap((dir) => {
    const resolved = resolveUserPath(dir);
    return loadSkills({
      dir: resolved,
      source: "openclaw-extra",
    });
  });
  const managedSkills = loadSkills({
    dir: managedSkillsDir,
    source: "openclaw-managed",
  });
  const productManagedSkills = loadSkills({
    dir: productManagedSkillsDir,
    source: "openclaw-product-managed",
  });
  const projectAgentsSkillsDir = path.resolve(workspaceDir, ".agents", "skills");
  const projectAgentsSkills = loadSkills({
    dir: projectAgentsSkillsDir,
    source: "agents-skills-project",
  });
  const workspaceSkills = loadSkills({
    dir: workspaceSkillsDir,
    source: "openclaw-workspace",
  });

  const merged = new Map<string, Skill>();
  // Precedence: extra < bundled < user-managed < product-managed < project < workspace.
  // Personal cross-agent skills intentionally flow through the managed skills
  // root, typically via ~/.openclaw/skills -> ~/.agents/skills. That keeps one
  // user-owned source of truth instead of silently loading the same personal
  // skills from a second OpenClaw-only discovery path.
  for (const skill of extraSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of bundledSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of managedSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of productManagedSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of projectAgentsSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of workspaceSkills) {
    merged.set(skill.name, skill);
  }

  const skillEntries: SkillEntry[] = Array.from(merged.values()).map((skill) => {
    let frontmatter: ParsedSkillFrontmatter = {};
    try {
      const raw = fs.readFileSync(skill.filePath, "utf-8");
      frontmatter = parseFrontmatter(raw);
    } catch {
      // ignore malformed skills
    }
    return {
      skill,
      frontmatter,
      metadata: resolveOpenClawMetadata(frontmatter),
      invocation: resolveSkillInvocationPolicy(frontmatter),
    };
  });
  return skillEntries;
}

function escapeSkillPromptXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render a mixed-detail catalog.
 *
 * Relevant skills at the front keep descriptions. The remaining skills keep
 * their names and exact locations, so prompt pressure cannot make them
 * completely undiscoverable merely because their descriptions are long.
 */
function formatSkillsForHybridPrompt(skills: Skill[], detailedCount: number): string {
  if (skills.length === 0) {
    return "";
  }
  const lines = [
    "",
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description or name.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const [index, skill] of skills.entries()) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeSkillPromptXml(skill.name)}</name>`);
    if (index < detailedCount && skill.description?.trim()) {
      lines.push(
        `    <description>${escapeSkillPromptXml(skill.description.trim())}</description>`,
      );
    }
    lines.push(`    <location>${escapeSkillPromptXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function buildSkillsPromptLimitNote(params: {
  included: number;
  total: number;
  detailedCount: number;
}): string {
  const compactCount = params.included - params.detailedCount;
  if (params.included < params.total) {
    return `⚠️ Skills truncated: included ${params.included} of ${params.total} (${params.detailedCount} detailed, ${compactCount} compact). Run \`openclaw skills check\` to audit.`;
  }
  if (compactCount > 0) {
    return `⚠️ Skills catalog compacted: ${params.detailedCount} detailed, ${compactCount} name-and-location only, ${params.total} total. Match compact entries by name or exact location when descriptions are absent.`;
  }
  return "";
}

function renderSkillsPrompt(params: {
  skills: Skill[];
  total: number;
  detailedCount: number;
  remoteNote?: string;
}): string {
  const limitNote = buildSkillsPromptLimitNote({
    included: params.skills.length,
    total: params.total,
    detailedCount: params.detailedCount,
  });
  const catalog =
    params.detailedCount === params.skills.length
      ? formatSkillsForPrompt(params.skills)
      : formatSkillsForHybridPrompt(params.skills, params.detailedCount);
  return [params.remoteNote, limitNote, catalog].filter(Boolean).join("\n");
}

function applySkillsPromptLimits(params: {
  skills: Skill[];
  config?: OpenClawConfig;
  remoteNote?: string;
}): {
  skillsForPrompt: Skill[];
  detailedCount: number;
  truncated: boolean;
} {
  const limits = resolveSkillsLimits(params.config);
  const total = params.skills.length;
  const byCount = params.skills.slice(0, Math.max(0, limits.maxSkillsInPrompt));

  let skillsForPrompt = byCount;
  let detailedCount = skillsForPrompt.length;

  const fits = (skills: Skill[], detailCount: number): boolean => {
    const block = renderSkillsPrompt({
      skills,
      total,
      detailedCount: detailCount,
      remoteNote: params.remoteNote,
    });
    return block.length <= limits.maxSkillsPromptChars;
  };

  if (!fits(skillsForPrompt, detailedCount)) {
    // First preserve the count-limited catalog as names + locations, then use
    // the remaining budget for descriptions of the most relevant prefix.
    if (fits(skillsForPrompt, 0)) {
      let lo = 0;
      let hi = skillsForPrompt.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(skillsForPrompt, mid)) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      detailedCount = lo;
    } else {
      // Even names + locations overflow. Keep the largest compact prefix.
      // Current-turn relevance ranking runs before this step, so exact and
      // semantically strong matches remain at the front.
      detailedCount = 0;
      let lo = 0;
      let hi = skillsForPrompt.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(skillsForPrompt.slice(0, mid), 0)) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      skillsForPrompt = skillsForPrompt.slice(0, lo);
    }
  }

  const truncated = skillsForPrompt.length < total;
  return { skillsForPrompt, detailedCount, truncated };
}

function buildPromptFromRankedSkills(params: {
  skills: Skill[];
  config?: OpenClawConfig;
  remoteNote?: string;
}): string {
  const { skillsForPrompt, detailedCount } = applySkillsPromptLimits({
    skills: params.skills,
    config: params.config,
    remoteNote: params.remoteNote,
  });
  return renderSkillsPrompt({
    skills: skillsForPrompt,
    total: params.skills.length,
    detailedCount,
    remoteNote: params.remoteNote,
  });
}

function resolveLegacySnapshotRemoteNote(snapshot?: SkillSnapshot): string | undefined {
  if (snapshot?.remoteNote !== undefined) {
    return snapshot.remoteNote;
  }
  const firstLine = snapshot?.prompt
    ?.split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (
    !firstLine ||
    firstLine.startsWith("⚠️ Skills ") ||
    firstLine === "The following skills provide specialized instructions for specific tasks." ||
    firstLine.includes("<available_skills") ||
    firstLine.startsWith("<")
  ) {
    return undefined;
  }
  // Older snapshots stored the remote eligibility note only as the first
  // prompt line. Preserve that instruction while rebuilding the catalog.
  return firstLine;
}

export function buildWorkspaceSkillSnapshot(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions & { snapshotVersion?: number },
): SkillSnapshot {
  const { eligible, prompt, protectedSkillNames, resolvedSkills } =
    resolveWorkspaceSkillPromptState(workspaceDir, opts);
  const skillFilter = normalizeSkillFilter(opts?.skillFilter);
  const remoteNote = opts?.eligibility?.remote?.note?.trim();
  return {
    prompt,
    skills: eligible.map((entry) => ({
      name: entry.skill.name,
      primaryEnv: entry.metadata?.primaryEnv,
      requiredEnv: entry.metadata?.requires?.env?.slice(),
    })),
    ...(skillFilter === undefined ? {} : { skillFilter }),
    ...(remoteNote ? { remoteNote } : {}),
    protectedSkillNames: [...protectedSkillNames],
    resolvedSkills,
    version: opts?.snapshotVersion,
  };
}

export function buildWorkspaceSkillsPrompt(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions,
): string {
  return resolveWorkspaceSkillPromptState(workspaceDir, opts).prompt;
}

type WorkspaceSkillBuildOptions = {
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  productManagedSkillsDir?: string;
  bundledSkillsDir?: string;
  entries?: SkillEntry[];
  /** If provided, only include skills with these names */
  skillFilter?: string[];
  eligibility?: SkillEligibilityContext;
  /** Current user request used only to rank the model-facing prompt catalog. */
  userPrompt?: string;
};

function resolveWorkspaceSkillPromptState(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions,
): {
  eligible: SkillEntry[];
  prompt: string;
  protectedSkillNames: Set<string>;
  resolvedSkills: Skill[];
} {
  const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
  const eligible = filterSkillEntries(
    skillEntries,
    opts?.config,
    opts?.skillFilter,
    opts?.eligibility,
    { includeMissingSetupForModel: true },
  );
  const promptEntries = eligible.filter(
    (entry) => entry.invocation?.disableModelInvocation !== true,
  );
  const remoteNote = opts?.eligibility?.remote?.note?.trim();
  const resolvedSkills = rankSkillsForPrompt(
    promptEntries,
    opts?.config,
    opts?.skillFilter,
    skillEntries,
  );
  const protectedSkillNames = resolveProtectedSkillNames(
    promptEntries,
    opts?.config,
    opts?.skillFilter,
    skillEntries,
  );
  const prompt = buildPromptFromRankedSkills({
    skills: compactSkillPaths(
      rankSkillsForPromptByUserPrompt(resolvedSkills, opts?.userPrompt, protectedSkillNames),
    ),
    config: opts?.config,
    remoteNote,
  });
  return { eligible, prompt, protectedSkillNames, resolvedSkills };
}

export function resolveSkillsPromptForRun(params: {
  skillsSnapshot?: SkillSnapshot;
  entries?: SkillEntry[];
  config?: OpenClawConfig;
  workspaceDir: string;
  userPrompt?: string;
}): string {
  const resolvedSkills = params.skillsSnapshot?.resolvedSkills;
  if (resolvedSkills && resolvedSkills.length > 0 && params.userPrompt?.trim()) {
    const protectedSkillNames = new Set(
      params.skillsSnapshot?.protectedSkillNames ?? [
        CRITICAL_PRODUCT_POLICY_SKILL,
        ...Object.keys(params.config?.skills?.entries ?? {}),
        ...(params.config?.skills?.allowBundled ?? []),
      ],
    );
    return buildPromptFromRankedSkills({
      skills: compactSkillPaths(
        rankSkillsForPromptByUserPrompt(resolvedSkills, params.userPrompt, protectedSkillNames),
      ),
      config: params.config,
      remoteNote: resolveLegacySnapshotRemoteNote(params.skillsSnapshot),
    });
  }
  const snapshotPrompt = params.skillsSnapshot?.prompt?.trim();
  if (snapshotPrompt) {
    return snapshotPrompt;
  }
  if (params.entries && params.entries.length > 0) {
    const prompt = buildWorkspaceSkillsPrompt(params.workspaceDir, {
      entries: params.entries,
      config: params.config,
      userPrompt: params.userPrompt,
    });
    return prompt.trim() ? prompt : "";
  }
  return "";
}

export function loadWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    productManagedSkillsDir?: string;
    bundledSkillsDir?: string;
  },
): SkillEntry[] {
  return loadSkillEntries(workspaceDir, opts);
}

function resolveUniqueSyncedSkillDirName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  let fallbackIndex = 10_000;
  let fallback = `${base}-${fallbackIndex}`;
  while (used.has(fallback)) {
    fallbackIndex += 1;
    fallback = `${base}-${fallbackIndex}`;
  }
  used.add(fallback);
  return fallback;
}

function resolveSyncedSkillDestinationPath(params: {
  targetSkillsDir: string;
  entry: SkillEntry;
  usedDirNames: Set<string>;
}): string | null {
  const sourceDirName = path.basename(params.entry.skill.baseDir).trim();
  if (!sourceDirName || sourceDirName === "." || sourceDirName === "..") {
    return null;
  }
  const uniqueDirName = resolveUniqueSyncedSkillDirName(sourceDirName, params.usedDirNames);
  return resolveSandboxPath({
    filePath: uniqueDirName,
    cwd: params.targetSkillsDir,
    root: params.targetSkillsDir,
  }).resolved;
}

export async function syncSkillsToWorkspace(params: {
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
}) {
  const sourceDir = resolveUserPath(params.sourceWorkspaceDir);
  const targetDir = resolveUserPath(params.targetWorkspaceDir);
  if (sourceDir === targetDir) {
    return;
  }

  await serializeByKey(`syncSkills:${targetDir}`, async () => {
    const targetSkillsDir = path.join(targetDir, "skills");

    const entries = loadSkillEntries(sourceDir, {
      config: params.config,
      managedSkillsDir: params.managedSkillsDir,
      bundledSkillsDir: params.bundledSkillsDir,
    });

    await fsp.rm(targetSkillsDir, { recursive: true, force: true });
    await fsp.mkdir(targetSkillsDir, { recursive: true });

    const usedDirNames = new Set<string>();
    for (const entry of entries) {
      let dest: string | null = null;
      try {
        dest = resolveSyncedSkillDestinationPath({
          targetSkillsDir,
          entry,
          usedDirNames,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        skillsLogger.warn(`Failed to resolve safe destination for ${entry.skill.name}: ${message}`);
        continue;
      }
      if (!dest) {
        skillsLogger.warn(
          `Failed to resolve safe destination for ${entry.skill.name}: invalid source directory name`,
        );
        continue;
      }
      try {
        await fsp.cp(entry.skill.baseDir, dest, {
          recursive: true,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        skillsLogger.warn(`Failed to copy ${entry.skill.name} to sandbox: ${message}`);
      }
    }
  });
}

export function filterWorkspaceSkillEntries(
  entries: SkillEntry[],
  config?: OpenClawConfig,
): SkillEntry[] {
  return filterSkillEntries(entries, config);
}

export function buildWorkspaceSkillCommandSpecs(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
    reservedNames?: Set<string>;
  },
): SkillCommandSpec[] {
  const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
  const eligible = filterSkillEntries(
    skillEntries,
    opts?.config,
    opts?.skillFilter,
    opts?.eligibility,
  );
  const userInvocable = eligible.filter((entry) => entry.invocation?.userInvocable !== false);
  const used = new Set<string>();
  for (const reserved of opts?.reservedNames ?? []) {
    used.add(reserved.toLowerCase());
  }

  const specs: SkillCommandSpec[] = [];
  for (const entry of userInvocable) {
    const rawName = entry.skill.name;
    const base = sanitizeSkillCommandName(rawName);
    if (base !== rawName) {
      debugSkillCommandOnce(
        `sanitize:${rawName}:${base}`,
        `Sanitized skill command name "${rawName}" to "/${base}".`,
        { rawName, sanitized: `/${base}` },
      );
    }
    const unique = resolveUniqueSkillCommandName(base, used);
    if (unique !== base) {
      debugSkillCommandOnce(
        `dedupe:${rawName}:${unique}`,
        `De-duplicated skill command name for "${rawName}" to "/${unique}".`,
        { rawName, deduped: `/${unique}` },
      );
    }
    used.add(unique.toLowerCase());
    const rawDescription = entry.skill.description?.trim() || rawName;
    const description =
      rawDescription.length > SKILL_COMMAND_DESCRIPTION_MAX_LENGTH
        ? rawDescription.slice(0, SKILL_COMMAND_DESCRIPTION_MAX_LENGTH - 1) + "…"
        : rawDescription;
    const dispatch = (() => {
      const kindRaw = (
        entry.frontmatter?.["command-dispatch"] ??
        entry.frontmatter?.["command_dispatch"] ??
        ""
      )
        .trim()
        .toLowerCase();
      if (!kindRaw) {
        return undefined;
      }
      if (kindRaw !== "tool") {
        return undefined;
      }

      const toolName = (
        entry.frontmatter?.["command-tool"] ??
        entry.frontmatter?.["command_tool"] ??
        ""
      ).trim();
      if (!toolName) {
        debugSkillCommandOnce(
          `dispatch:missingTool:${rawName}`,
          `Skill command "/${unique}" requested tool dispatch but did not provide command-tool. Ignoring dispatch.`,
          { skillName: rawName, command: unique },
        );
        return undefined;
      }

      const argModeRaw = (
        entry.frontmatter?.["command-arg-mode"] ??
        entry.frontmatter?.["command_arg_mode"] ??
        ""
      )
        .trim()
        .toLowerCase();
      const argMode = !argModeRaw || argModeRaw === "raw" ? "raw" : null;
      if (!argMode) {
        debugSkillCommandOnce(
          `dispatch:badArgMode:${rawName}:${argModeRaw}`,
          `Skill command "/${unique}" requested tool dispatch but has unknown command-arg-mode. Falling back to raw.`,
          { skillName: rawName, command: unique, argMode: argModeRaw },
        );
      }

      return { kind: "tool", toolName, argMode: "raw" } as const;
    })();

    specs.push({
      name: unique,
      skillName: rawName,
      description,
      ...(dispatch ? { dispatch } : {}),
    });
  }
  return specs;
}
