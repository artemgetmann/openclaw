import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig, SkillConfig } from "../../config/config.js";
import { evaluateEntryRequirementsForCurrentPlatform } from "../../shared/entry-status.js";
import {
  hasBinary,
  isConfigPathTruthyWithDefaults,
  resolveConfigPath,
  resolveRuntimePlatform,
} from "../../shared/config-eval.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { resolveSkillKey } from "./frontmatter.js";
import type { SkillEligibilityContext, SkillEntry } from "./types.js";

const DEFAULT_CONFIG_VALUES: Record<string, boolean> = {
  "browser.enabled": true,
  "browser.evaluateEnabled": true,
};

export { hasBinary, resolveConfigPath, resolveRuntimePlatform };

export function isConfigPathTruthy(config: OpenClawConfig | undefined, pathStr: string): boolean {
  return isConfigPathTruthyWithDefaults(config, pathStr, DEFAULT_CONFIG_VALUES);
}

export function resolveSkillConfig(
  config: OpenClawConfig | undefined,
  skillKey: string,
): SkillConfig | undefined {
  const skills = config?.skills?.entries;
  if (!skills || typeof skills !== "object") {
    return undefined;
  }
  const entry = (skills as Record<string, SkillConfig | undefined>)[skillKey];
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  return entry;
}

function normalizeAllowlist(input: unknown): string[] | undefined {
  if (!input) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = normalizeStringEntries(input);
  return normalized.length > 0 ? normalized : undefined;
}

const BUNDLED_SOURCES = new Set(["openclaw-bundled"]);

function isBundledSkill(entry: SkillEntry): boolean {
  return BUNDLED_SOURCES.has(entry.skill.source);
}

export function resolveBundledAllowlist(config?: OpenClawConfig): string[] | undefined {
  return normalizeAllowlist(config?.skills?.allowBundled);
}

export function isBundledSkillAllowed(entry: SkillEntry, allowlist?: string[]): boolean {
  if (!allowlist || allowlist.length === 0) {
    return true;
  }
  if (!isBundledSkill(entry)) {
    return true;
  }
  const key = resolveSkillKey(entry.skill, entry);
  return allowlist.includes(key) || allowlist.includes(entry.skill.name);
}

function isRelativeSkillBin(bin: string): boolean {
  return bin.startsWith("./") || bin.startsWith("../");
}

function hasRelativeSkillBin(entry: SkillEntry, bin: string): boolean {
  if (!isRelativeSkillBin(bin)) {
    return false;
  }

  const candidate = path.resolve(entry.skill.baseDir, bin);
  const relative = path.relative(entry.skill.baseDir, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }

  try {
    fs.accessSync(candidate, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveSkillHasLocalBin(entry: SkillEntry): (bin: string) => boolean {
  return (bin) => hasRelativeSkillBin(entry, bin) || hasBinary(bin);
}

type SkillEntryEvaluation = {
  skillKey: string;
  skillConfig?: SkillConfig;
  disabled: boolean;
  blockedByAllowlist: boolean;
  emoji?: string;
  homepage?: string;
  requirements: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  configChecks: ReturnType<typeof evaluateEntryRequirementsForCurrentPlatform>["configChecks"];
  requirementsSatisfied: boolean;
  eligible: boolean;
};

export function evaluateSkillEntry(params: {
  entry: SkillEntry;
  config?: OpenClawConfig;
  eligibility?: SkillEligibilityContext;
}): SkillEntryEvaluation {
  const { entry, config, eligibility } = params;
  const skillKey = resolveSkillKey(entry.skill, entry);
  const skillConfig = resolveSkillConfig(config, skillKey);
  const allowBundled = normalizeAllowlist(config?.skills?.allowBundled);
  const disabled = skillConfig?.enabled === false;
  const blockedByAllowlist = !isBundledSkillAllowed(entry, allowBundled);

  // Shared-core decides whether a skill is usable at all. Overlay-owned defaults
  // and visibility can still sit on top, but they should not fork this semantic
  // evaluation or status/prompt drift comes back immediately.
  const { emoji, homepage, required, missing, requirementsSatisfied, configChecks } =
    evaluateEntryRequirementsForCurrentPlatform({
      always: entry.metadata?.always === true,
      entry,
      hasLocalBin: resolveSkillHasLocalBin(entry),
      remote: eligibility?.remote,
      isEnvSatisfied: (envName) =>
        Boolean(
          process.env[envName] ||
            skillConfig?.env?.[envName] ||
            (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
        ),
      isConfigSatisfied: (configPath) => isConfigPathTruthy(config, configPath),
    });

  return {
    skillKey,
    skillConfig,
    disabled,
    blockedByAllowlist,
    emoji,
    homepage,
    requirements: required,
    missing,
    configChecks,
    requirementsSatisfied,
    eligible: !disabled && !blockedByAllowlist && requirementsSatisfied,
  };
}

export function shouldIncludeSkill(params: {
  entry: SkillEntry;
  config?: OpenClawConfig;
  eligibility?: SkillEligibilityContext;
}): boolean {
  return evaluateSkillEntry(params).eligible;
}
