import type { OpenClawConfig } from "../config/config.js";

export const CONSUMER_DEFAULT_BUNDLED_SKILLS = [
  "consumer-setup",
  "timezone-preference-updater",
  "checkpoint",
  "goal-mode",
  "monitor-router",
  "cross-channel-triage",
  "message-drafting",
  "personal-tone-of-voice",
  "skill-runtime",
  "apple-notes",
  "apple-reminders",
  "documents",
  "pdf",
  "presentations",
  "spreadsheets",
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
  "tldr",
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
  "what-can-you-do",
  "heartbeat-preference-updater",
  "skill-creator",
  "session-logs",
] as const;

export const LEGACY_CONSUMER_BUNDLED_SKILL_RENAMES: Readonly<Record<string, string>> = {
  "jarvis-gui-control": "jarvis-computer-use",
};

// These were briefly shipped as consumer defaults even though they are
// personal Codex/Jarvis workflow tools. Keep their names only long enough to
// recognize and repair generated allowlists from that release.
const RETIRED_CONSUMER_DEFAULT_BUNDLED_SKILLS = new Set([
  "plain-language",
  "builder-priority-triage",
]);

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

  // Entry migration must happen before allowlist normalization. The loader
  // enforces `enabled` by the current skill key, while a missing/empty bundled
  // allowlist means unrestricted rather than disabled.
  const entryMigration = migrateLegacyConsumerBundledSkillEntries(config);
  const workingConfig = entryMigration.config;
  const normalizedAllowlist = normalizeLegacyBundledSkillNames(currentAllowlist, workingConfig);
  const renameChanged = !sameStringArray(currentAllowlist, normalizedAllowlist);
  const defaultSkills = new Set<string>(CONSUMER_DEFAULT_BUNDLED_SKILLS);
  const allowlistWithoutRetiredDefaults = normalizedAllowlist.filter(
    (skillName) => !RETIRED_CONSUMER_DEFAULT_BUNDLED_SKILLS.has(skillName),
  );
  const hasEnoughDefaultSkillsToLookGenerated = allowlistWithoutRetiredDefaults.length >= 3;
  const looksLikeGeneratedConsumerDefault =
    hasEnoughDefaultSkillsToLookGenerated &&
    allowlistWithoutRetiredDefaults.every((skillName) => defaultSkills.has(skillName));

  if (!looksLikeGeneratedConsumerDefault) {
    if (!renameChanged && entryMigration.changes.length === 0) {
      return { config, changes: [] };
    }
    return {
      config: renameChanged
        ? {
            ...workingConfig,
            skills: {
              ...workingConfig.skills,
              allowBundled: normalizedAllowlist,
            },
          }
        : workingConfig,
      changes: [
        ...entryMigration.changes,
        ...(renameChanged
          ? ["skills.allowBundled renamed jarvis-gui-control->jarvis-computer-use"]
          : []),
      ],
    };
  }

  // Only generated lists are product-owned. A custom list may intentionally
  // reference an externally installed skill with the same name, so preserve it.
  const retiredDefaultsRemoved = normalizedAllowlist.filter((skillName) =>
    RETIRED_CONSUMER_DEFAULT_BUNDLED_SKILLS.has(skillName),
  );
  const nextAllowlist = [...allowlistWithoutRetiredDefaults];
  const current = new Set(nextAllowlist);
  const added: string[] = [];
  for (const skillName of CONSUMER_DEFAULT_BUNDLED_SKILLS) {
    const explicitlyDisabled = isBundledSkillExplicitlyDisabled(workingConfig, skillName);
    if (explicitlyDisabled || current.has(skillName)) {
      continue;
    }
    insertBundledSkillInDefaultOrder(nextAllowlist, skillName);
    current.add(skillName);
    added.push(skillName);
  }

  if (
    added.length === 0 &&
    retiredDefaultsRemoved.length === 0 &&
    !renameChanged &&
    entryMigration.changes.length === 0
  ) {
    return { config, changes: [] };
  }

  const changes = [...entryMigration.changes];
  if (renameChanged) {
    changes.push("skills.allowBundled renamed jarvis-gui-control->jarvis-computer-use");
  }
  if (retiredDefaultsRemoved.length > 0) {
    changes.push(`skills.allowBundled -= ${retiredDefaultsRemoved.join(",")}`);
  }
  if (added.length > 0) {
    changes.push(`skills.allowBundled += ${added.join(",")}`);
  }

  return {
    config: {
      ...workingConfig,
      skills: {
        ...workingConfig.skills,
        allowBundled: nextAllowlist,
      },
    },
    changes,
  };
}

function migrateLegacyConsumerBundledSkillEntries(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const entries = config.skills?.entries;
  if (!entries) {
    return { config, changes: [] };
  }

  let nextEntries: typeof entries | undefined;
  const changes: string[] = [];
  for (const [legacySkillName, renamedSkillName] of Object.entries(
    LEGACY_CONSUMER_BUNDLED_SKILL_RENAMES,
  )) {
    const legacyEntry = entries[legacySkillName];
    if (!legacyEntry) {
      continue;
    }

    const renamedEntry = entries[renamedSkillName];
    const enabled =
      legacyEntry.enabled === false || renamedEntry?.enabled === false
        ? false
        : (renamedEntry?.enabled ?? legacyEntry.enabled);
    const mergedEntry = {
      ...legacyEntry,
      ...renamedEntry,
      ...(enabled === undefined ? {} : { enabled }),
      ...(legacyEntry.env || renamedEntry?.env
        ? { env: { ...legacyEntry.env, ...renamedEntry?.env } }
        : {}),
      ...(legacyEntry.config || renamedEntry?.config
        ? { config: { ...legacyEntry.config, ...renamedEntry?.config } }
        : {}),
    };

    // Canonical-key fields win ordinary conflicts, but either explicit false
    // wins `enabled`. A rename must never turn an operator opt-out back on.
    nextEntries ??= { ...entries };
    nextEntries[renamedSkillName] = mergedEntry;
    delete nextEntries[legacySkillName];
    changes.push(`skills.entries renamed ${legacySkillName}->${renamedSkillName}`);
  }

  if (!nextEntries) {
    return { config, changes: [] };
  }
  return {
    config: {
      ...config,
      skills: {
        ...config.skills,
        entries: nextEntries,
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
