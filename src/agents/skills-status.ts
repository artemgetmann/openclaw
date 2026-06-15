import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { evaluateEntryRequirementsForCurrentPlatform } from "../shared/entry-status.js";
import type { RequirementConfigCheck, Requirements } from "../shared/requirements.js";
import { CONFIG_DIR } from "../utils.js";
import {
  hasBinary,
  hasRelativeSkillBin,
  isBundledSkillAllowed,
  isConfigPathTruthy,
  loadWorkspaceSkillEntries,
  resolveBundledAllowlist,
  resolveSkillConfig,
  resolveSkillsInstallPreferences,
  type SkillEntry,
  type SkillEligibilityContext,
  type SkillInstallSpec,
  type SkillsInstallPreferences,
} from "./skills.js";
import { resolveBundledSkillsContext } from "./skills/bundled-context.js";

export type SkillStatusConfigCheck = RequirementConfigCheck;

export type SkillInstallOption = {
  id: string;
  kind: SkillInstallSpec["kind"];
  label: string;
  bins: string[];
  toolVersions?: SkillToolVersionStatus[];
};

export type SkillToolVersionStatus = {
  bin: string;
  installed: boolean;
  command: string[];
  version?: string;
  minVersion?: string;
  recommendedVersion?: string;
  satisfiesMinVersion?: boolean;
  satisfiesRecommendedVersion?: boolean;
  error?: string;
};

export type SkillStatusEntry = {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  filePath: string;
  baseDir: string;
  skillKey: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: Requirements;
  missing: Requirements;
  configChecks: SkillStatusConfigCheck[];
  install: SkillInstallOption[];
  shadowedBundledSkill?: SkillShadowDiagnostic;
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatusEntry[];
};

export type SkillShadowDiagnostic = {
  kind: "bundled-shadow";
  source: string;
  activePath: string;
  bundledPath: string;
  reason: string;
};

function resolveSkillKey(entry: SkillEntry): string {
  return entry.metadata?.skillKey ?? entry.skill.name;
}

function selectPreferredInstallSpec(
  install: SkillInstallSpec[],
  prefs: SkillsInstallPreferences,
): { spec: SkillInstallSpec; index: number } | undefined {
  if (install.length === 0) {
    return undefined;
  }

  const indexed = install.map((spec, index) => ({ spec, index }));
  const findKind = (kind: SkillInstallSpec["kind"]) =>
    indexed.find((item) => item.spec.kind === kind);

  const brewSpec = findKind("brew");
  const nodeSpec = findKind("node");
  const goSpec = findKind("go");
  const uvSpec = findKind("uv");
  const downloadSpec = findKind("download");
  const brewAvailable = hasBinary("brew");

  // Table-driven preference chain; first match wins.
  const pickers: Array<() => { spec: SkillInstallSpec; index: number } | undefined> = [
    () => (prefs.preferBrew && brewAvailable ? brewSpec : undefined),
    () => uvSpec,
    () => nodeSpec,
    // Only prefer brew when available to avoid guaranteed failure on Linux/Docker.
    () => (brewAvailable ? brewSpec : undefined),
    () => goSpec,
    // Prefer download over an unavailable brew spec.
    () => downloadSpec,
    // Last resort: surface descriptive brew-missing error instead of "no installer found".
    () => brewSpec,
    () => indexed[0],
  ];

  for (const pick of pickers) {
    const selected = pick();
    if (selected) {
      return selected;
    }
  }

  return undefined;
}

function normalizeInstallOptions(
  entry: SkillEntry,
  prefs: SkillsInstallPreferences,
): SkillInstallOption[] {
  // If the skill is explicitly OS-scoped, don't surface install actions on unsupported platforms.
  // (Installers run locally; remote OS eligibility is handled separately.)
  const requiredOs = entry.metadata?.os ?? [];
  if (requiredOs.length > 0 && !requiredOs.includes(process.platform)) {
    return [];
  }

  const install = entry.metadata?.install ?? [];
  if (install.length === 0) {
    return [];
  }

  const platform = process.platform;
  const filtered = install.filter((spec) => {
    const osList = spec.os ?? [];
    return osList.length === 0 || osList.includes(platform);
  });
  if (filtered.length === 0) {
    return [];
  }

  const toOption = (spec: SkillInstallSpec, index: number): SkillInstallOption => {
    const id = (spec.id ?? `${spec.kind}-${index}`).trim();
    const bins = spec.bins ?? [];
    let label = (spec.label ?? "").trim();
    if (spec.kind === "node" && spec.package) {
      label = `Install ${spec.package} (${prefs.nodeManager})`;
    }
    if (!label) {
      if (spec.kind === "brew" && spec.formula) {
        label = `Install ${spec.formula} (brew)`;
      } else if (spec.kind === "node" && spec.package) {
        label = `Install ${spec.package} (${prefs.nodeManager})`;
      } else if (spec.kind === "go" && spec.module) {
        label = `Install ${spec.module} (go)`;
      } else if (spec.kind === "uv" && spec.package) {
        label = `Install ${spec.package} (uv)`;
      } else if (spec.kind === "download" && spec.url) {
        const url = spec.url.trim();
        const last = url.split("/").pop();
        label = `Download ${last && last.length > 0 ? last : url}`;
      } else {
        label = "Run installer";
      }
    }
    const toolVersions = resolveToolVersionStatuses(spec);
    return {
      id,
      kind: spec.kind,
      label,
      bins,
      ...(toolVersions.length > 0 ? { toolVersions } : {}),
    };
  };

  const allDownloads = filtered.every((spec) => spec.kind === "download");
  if (allDownloads) {
    return filtered.map((spec, index) => toOption(spec, index));
  }

  const preferred = selectPreferredInstallSpec(filtered, prefs);
  if (!preferred) {
    return [];
  }
  return [toOption(preferred.spec, preferred.index)];
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
  const namedVersion = match?.groups?.version;
  if (namedVersion) {
    return namedVersion;
  }
  return match?.[1];
}

function buildVersionCommand(spec: SkillInstallSpec, bin: string): string[] {
  const explicit = spec.versionCommand ?? [];
  if (explicit.length > 0) {
    return explicit;
  }
  return [bin, "--version"];
}

function resolveToolVersionStatuses(spec: SkillInstallSpec): SkillToolVersionStatus[] {
  if (!spec.minVersion && !spec.recommendedVersion && !spec.versionCommand && !spec.versionRegex) {
    return [];
  }

  const bins =
    spec.bins && spec.bins.length > 0
      ? spec.bins
      : spec.versionCommand?.[0]
        ? [spec.versionCommand[0]]
        : [];
  return bins.map((bin) => {
    const command = buildVersionCommand(spec, bin);
    const base = {
      bin,
      command,
      installed: hasBinary(bin),
      minVersion: spec.minVersion,
      recommendedVersion: spec.recommendedVersion,
    };
    if (!base.installed) {
      return base;
    }

    const result = spawnSync(command[0], command.slice(1), {
      encoding: "utf8",
      timeout: 2_000,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const version = output ? extractVersion(output, spec.versionRegex) : undefined;
    if (!version) {
      return {
        ...base,
        error: result.error?.message ?? "version command did not expose a parseable version",
      };
    }

    return {
      ...base,
      version,
      ...(spec.minVersion
        ? { satisfiesMinVersion: compareVersions(version, spec.minVersion) >= 0 }
        : {}),
      ...(spec.recommendedVersion
        ? { satisfiesRecommendedVersion: compareVersions(version, spec.recommendedVersion) >= 0 }
        : {}),
    };
  });
}

function buildSkillStatus(
  entry: SkillEntry,
  config?: OpenClawConfig,
  prefs?: SkillsInstallPreferences,
  eligibility?: SkillEligibilityContext,
  bundledContext?: { dir?: string; names: Set<string> },
): SkillStatusEntry {
  const skillKey = resolveSkillKey(entry);
  const skillConfig = resolveSkillConfig(config, skillKey);
  const disabled = skillConfig?.enabled === false;
  const allowBundled = resolveBundledAllowlist(config);
  const blockedByAllowlist = !isBundledSkillAllowed(entry, allowBundled);
  const always = entry.metadata?.always === true;
  const isEnvSatisfied = (envName: string) =>
    Boolean(
      process.env[envName] ||
      skillConfig?.env?.[envName] ||
      (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
    );
  const isConfigSatisfied = (pathStr: string) => isConfigPathTruthy(config, pathStr);
  const bundled =
    bundledContext?.names && bundledContext.names.size > 0
      ? bundledContext.names.has(entry.skill.name)
      : entry.skill.source === "openclaw-bundled";
  const hasLocalBin = (bin: string) => hasRelativeSkillBin(entry, bin) || hasBinary(bin);

  const { emoji, homepage, required, missing, requirementsSatisfied, configChecks } =
    evaluateEntryRequirementsForCurrentPlatform({
      always,
      entry,
      hasLocalBin,
      remote: eligibility?.remote,
      isEnvSatisfied,
      isConfigSatisfied,
    });
  const eligible = !disabled && !blockedByAllowlist && requirementsSatisfied;

  return {
    name: entry.skill.name,
    description: entry.skill.description,
    source: entry.skill.source,
    bundled,
    filePath: entry.skill.filePath,
    baseDir: entry.skill.baseDir,
    skillKey,
    primaryEnv: entry.metadata?.primaryEnv,
    emoji,
    homepage,
    always,
    disabled,
    blockedByAllowlist,
    eligible,
    requirements: required,
    missing,
    configChecks,
    install: normalizeInstallOptions(entry, prefs ?? resolveSkillsInstallPreferences(config)),
    shadowedBundledSkill: resolveShadowedBundledSkill(entry, bundledContext),
  };
}

const SHADOW_WARNING_SOURCES = new Set([
  "openclaw-workspace",
  "openclaw-managed",
  "agents-skills-project",
  "openclaw-extra",
]);

function safeRealpathSync(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function hashSkillDir(dir: string): string | undefined {
  const hash = crypto.createHash("sha256");
  let fileCount = 0;
  const maxFiles = 200;
  const maxBytes = 512 * 1024;

  const visit = (current: string, relativeRoot = "") => {
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .toSorted((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (fileCount >= maxFiles) {
        return;
      }
      const fullPath = path.join(current, entry.name);
      const relativePath = path.join(relativeRoot, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = fs.statSync(fullPath);
      if (stat.size > maxBytes) {
        continue;
      }
      fileCount += 1;
      hash.update(relativePath);
      hash.update("\0");
      hash.update(fs.readFileSync(fullPath));
      hash.update("\0");
    }
  };

  try {
    visit(dir);
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

function resolveShadowedBundledSkill(
  entry: SkillEntry,
  bundledContext?: { dir?: string; names: Set<string> },
): SkillShadowDiagnostic | undefined {
  if (!bundledContext?.dir || !bundledContext.names.has(entry.skill.name)) {
    return undefined;
  }
  if (!SHADOW_WARNING_SOURCES.has(entry.skill.source)) {
    return undefined;
  }

  const activePath = safeRealpathSync(entry.skill.baseDir);
  const bundledPath = safeRealpathSync(path.join(bundledContext.dir, entry.skill.name));
  if (activePath === bundledPath) {
    return undefined;
  }

  const activeHash = hashSkillDir(activePath);
  const bundledHash = hashSkillDir(bundledPath);
  if (activeHash && bundledHash && activeHash === bundledHash) {
    return undefined;
  }

  return {
    kind: "bundled-shadow",
    source: entry.skill.source,
    activePath,
    bundledPath,
    reason: "Active non-bundled skill shadows bundled skill with different contents.",
  };
}

export function buildWorkspaceSkillStatus(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    entries?: SkillEntry[];
    eligibility?: SkillEligibilityContext;
  },
): SkillStatusReport {
  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const bundledContext = resolveBundledSkillsContext();
  const skillEntries =
    opts?.entries ??
    loadWorkspaceSkillEntries(workspaceDir, {
      config: opts?.config,
      managedSkillsDir,
      bundledSkillsDir: bundledContext.dir,
    });
  const prefs = resolveSkillsInstallPreferences(opts?.config);
  return {
    workspaceDir,
    managedSkillsDir,
    skills: skillEntries.map((entry) =>
      buildSkillStatus(entry, opts?.config, prefs, opts?.eligibility, bundledContext),
    ),
  };
}
