import type { OpenClawConfig } from "../config/config.js";

export const CONSUMER_DEFAULT_BUNDLED_SKILLS = [
  "consumer-setup",
  "timezone-preference-updater",
  "checkpoint",
  "goal-mode",
  "monitor-router",
  "cross-channel-triage",
  "apple-notes",
  "apple-reminders",
  "media-editor",
  "video-frames",
  "elevenlabs-creative",
  "screen-record",
  "gog",
  "goplaces",
  "find-food",
  "himalaya",
  "jarvis-computer-use",
  "peekaboo",
  "summarize",
  "weather",
  "wacli",
  "mcporter",
  "nano-banana-pro",
  "telegram-user",
  "telegram-chat-management",
  "notion",
  "obsidian",
  "things-mac",
  "github",
  "slack",
  "discord",
  "openai-image-gen",
  "openai-whisper",
  "nano-pdf",
] as const;

export const LEGACY_CONSUMER_BUNDLED_SKILL_RENAMES: Readonly<Record<string, string>> = {
  "jarvis-gui-control": "jarvis-computer-use",
};

export function buildConsumerBundledSkillAllowlist(config: OpenClawConfig): string[] {
  const existingAllowlist = config.skills?.allowBundled;
  if (existingAllowlist?.includes("__none__")) {
    return [...existingAllowlist];
  }
  const allowlist = normalizeLegacyBundledSkillNames(existingAllowlist ?? [], config);
  const allowed = new Set(allowlist);

  for (const skillName of CONSUMER_DEFAULT_BUNDLED_SKILLS) {
    const explicitlyDisabled = isBundledSkillExplicitlyDisabled(config, skillName);
    if (explicitlyDisabled || allowed.has(skillName)) {
      continue;
    }
    allowlist.push(skillName);
    allowed.add(skillName);
  }

  return allowlist;
}

export function repairConsumerDefaultBundledSkillAllowlist(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const currentAllowlist = config.skills?.allowBundled ?? [];
  if (currentAllowlist.includes("__none__")) {
    return { config, changes: [] };
  }

  const normalizedAllowlist = normalizeLegacyBundledSkillNames(currentAllowlist, config);
  const renameChanged = !sameStringArray(currentAllowlist, normalizedAllowlist);
  const defaultSkills = new Set<string>(CONSUMER_DEFAULT_BUNDLED_SKILLS);
  const current = new Set(normalizedAllowlist);
  const hasEnoughDefaultSkillsToLookGenerated = normalizedAllowlist.length >= 3;
  const looksLikeGeneratedConsumerDefault =
    hasEnoughDefaultSkillsToLookGenerated &&
    normalizedAllowlist.every((skillName) => defaultSkills.has(skillName));

  if (!looksLikeGeneratedConsumerDefault) {
    if (!renameChanged) {
      return { config, changes: [] };
    }
    return {
      config: {
        ...config,
        skills: {
          ...config.skills,
          allowBundled: normalizedAllowlist,
        },
      },
      changes: ["skills.allowBundled renamed jarvis-gui-control->jarvis-computer-use"],
    };
  }

  const nextAllowlist = [...normalizedAllowlist];
  const added: string[] = [];
  for (const skillName of CONSUMER_DEFAULT_BUNDLED_SKILLS) {
    const explicitlyDisabled = isBundledSkillExplicitlyDisabled(config, skillName);
    if (explicitlyDisabled || current.has(skillName)) {
      continue;
    }
    insertBundledSkillInDefaultOrder(nextAllowlist, skillName);
    current.add(skillName);
    added.push(skillName);
  }

  if (added.length === 0 && !renameChanged) {
    return { config, changes: [] };
  }

  const changes = [];
  if (renameChanged) {
    changes.push("skills.allowBundled renamed jarvis-gui-control->jarvis-computer-use");
  }
  if (added.length > 0) {
    changes.push(`skills.allowBundled += ${added.join(",")}`);
  }

  return {
    config: {
      ...config,
      skills: {
        ...config.skills,
        allowBundled: nextAllowlist,
      },
    },
    changes,
  };
}

function normalizeLegacyBundledSkillNames(allowlist: string[], config: OpenClawConfig): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const skillName of allowlist) {
    const nextName = LEGACY_CONSUMER_BUNDLED_SKILL_RENAMES[skillName] ?? skillName;

    // A renamed allowlist entry is an implicit enable under the new key. Drop
    // that selection when the legacy key explicitly opted out, or the rename
    // would silently reverse the user's disabled setting at the next startup.
    if (isLegacyBundledSkillExplicitlyDisabled(config, nextName)) {
      continue;
    }
    if (seen.has(nextName)) {
      continue;
    }
    normalized.push(nextName);
    seen.add(nextName);
  }
  return normalized;
}

function isBundledSkillExplicitlyDisabled(config: OpenClawConfig, skillName: string): boolean {
  if (config.skills?.entries?.[skillName]?.enabled === false) {
    return true;
  }

  // Compatibility aliases must participate in selection until persisted user
  // configs have naturally migrated. Explicit false wins because enabling a
  // capability the user disabled is the risky direction for a product rename.
  return isLegacyBundledSkillExplicitlyDisabled(config, skillName);
}

function isLegacyBundledSkillExplicitlyDisabled(
  config: OpenClawConfig,
  currentSkillName: string,
): boolean {
  return Object.entries(LEGACY_CONSUMER_BUNDLED_SKILL_RENAMES).some(
    ([legacySkillName, renamedSkillName]) =>
      renamedSkillName === currentSkillName &&
      config.skills?.entries?.[legacySkillName]?.enabled === false,
  );
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function insertBundledSkillInDefaultOrder(allowlist: string[], skillName: string) {
  const defaultIndex = CONSUMER_DEFAULT_BUNDLED_SKILLS.indexOf(
    skillName as (typeof CONSUMER_DEFAULT_BUNDLED_SKILLS)[number],
  );
  if (defaultIndex < 0 || allowlist.includes(skillName)) {
    return;
  }
  for (const laterDefaultSkill of CONSUMER_DEFAULT_BUNDLED_SKILLS.slice(defaultIndex + 1)) {
    const insertionIndex = allowlist.indexOf(laterDefaultSkill);
    if (insertionIndex >= 0) {
      allowlist.splice(insertionIndex, 0, skillName);
      return;
    }
  }
  allowlist.push(skillName);
}
