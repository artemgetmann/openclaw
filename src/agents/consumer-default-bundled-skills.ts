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
  const repairableDefaultSkills = new Set(["jarvis-gui-control", "telegram-chat-management"]);
  if (currentAllowlist.includes("__none__")) {
    return { config, changes: [] };
  }

  const current = new Set(currentAllowlist);
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
  const changes: string[] = [];
  for (const skillName of CONSUMER_DEFAULT_BUNDLED_SKILLS) {
    const explicitlyDisabled = config.skills?.entries?.[skillName]?.enabled === false;
    if (!repairableDefaultSkills.has(skillName) || explicitlyDisabled || current.has(skillName)) {
      continue;
    }

    const defaultIndex = CONSUMER_DEFAULT_BUNDLED_SKILLS.indexOf(skillName);
    const nextKnownDefaultIndex = nextAllowlist.findIndex((candidate) => {
      const candidateDefaultIndex = CONSUMER_DEFAULT_BUNDLED_SKILLS.indexOf(
        candidate as (typeof CONSUMER_DEFAULT_BUNDLED_SKILLS)[number],
      );
      return candidateDefaultIndex > defaultIndex;
    });

    if (nextKnownDefaultIndex >= 0) {
      nextAllowlist.splice(nextKnownDefaultIndex, 0, skillName);
    } else {
      nextAllowlist.push(skillName);
    }
    current.add(skillName);
    changes.push(`skills.allowBundled += ${skillName}`);
  }

  if (changes.length === 0) {
    return { config, changes: [] };
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
