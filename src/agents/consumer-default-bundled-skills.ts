import type { OpenClawConfig } from "../config/config.js";

export const CONSUMER_DEFAULT_BUNDLED_SKILLS = [
  "consumer-setup",
  "timezone-preference-updater",
  "checkpoint",
  "monitor-router",
  "cross-channel-triage",
  "apple-notes",
  "apple-reminders",
  "media-editor",
  "elevenlabs-creative",
  "screen-record",
  "gog",
  "goplaces",
  "himalaya",
  "jarvis-gui-control",
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

export function buildConsumerBundledSkillAllowlist(config: OpenClawConfig): string[] {
  const existingAllowlist = config.skills?.allowBundled;
  if (existingAllowlist?.includes("__none__")) {
    return [...existingAllowlist];
  }
  const allowlist = existingAllowlist ? [...existingAllowlist] : [];
  const allowed = new Set(allowlist);

  for (const skillName of CONSUMER_DEFAULT_BUNDLED_SKILLS) {
    const explicitlyDisabled = config.skills?.entries?.[skillName]?.enabled === false;
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
  const repairableDefaultSkills = new Set([
    "jarvis-gui-control",
    "telegram-chat-management",
    "screen-record",
  ]);
  if (currentAllowlist.includes("__none__")) {
    return { config, changes: [] };
  }

  const current = new Set(currentAllowlist);
  const missingRepairableSkills = CONSUMER_DEFAULT_BUNDLED_SKILLS.filter((skillName) => {
    const explicitlyDisabled = config.skills?.entries?.[skillName]?.enabled === false;
    return repairableDefaultSkills.has(skillName) && !explicitlyDisabled && !current.has(skillName);
  });
  if (missingRepairableSkills.length === 0) {
    return { config, changes: [] };
  }

  const looksLikeGeneratedConsumerDefault = CONSUMER_DEFAULT_BUNDLED_SKILLS.every((skillName) => {
    if (repairableDefaultSkills.has(skillName)) {
      return true;
    }
    const explicitlyDisabled = config.skills?.entries?.[skillName]?.enabled === false;
    return explicitlyDisabled || current.has(skillName);
  });
  if (!looksLikeGeneratedConsumerDefault) {
    return { config, changes: [] };
  }

  const nextAllowlist = [...currentAllowlist];
  for (const skillName of missingRepairableSkills) {
    insertBundledSkillInDefaultOrder(nextAllowlist, skillName);
  }

  return {
    config: {
      ...config,
      skills: {
        ...config.skills,
        allowBundled: nextAllowlist,
      },
    },
    changes: missingRepairableSkills.map((skillName) => `skills.allowBundled += ${skillName}`),
  };
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
