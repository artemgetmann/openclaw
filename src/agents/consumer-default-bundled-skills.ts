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
  if (currentAllowlist.includes("__none__")) {
    return { config, changes: [] };
  }

  const defaultSkills = new Set<string>(CONSUMER_DEFAULT_BUNDLED_SKILLS);
  const current = new Set(currentAllowlist);
  const hasEnoughDefaultSkillsToLookGenerated = currentAllowlist.length >= 3;
  const looksLikeGeneratedConsumerDefault =
    hasEnoughDefaultSkillsToLookGenerated &&
    currentAllowlist.every((skillName) => defaultSkills.has(skillName));
  if (!looksLikeGeneratedConsumerDefault) {
    return { config, changes: [] };
  }

  const nextAllowlist = [...currentAllowlist];
  const added: string[] = [];
  for (const skillName of CONSUMER_DEFAULT_BUNDLED_SKILLS) {
    const explicitlyDisabled = config.skills?.entries?.[skillName]?.enabled === false;
    if (explicitlyDisabled || current.has(skillName)) {
      continue;
    }
    const insertBeforePeekaboo = skillName === "jarvis-gui-control";
    const peekabooIndex = nextAllowlist.indexOf("peekaboo");
    if (insertBeforePeekaboo && peekabooIndex >= 0) {
      nextAllowlist.splice(peekabooIndex, 0, skillName);
    } else {
      nextAllowlist.push(skillName);
    }
    current.add(skillName);
    added.push(skillName);
  }

  if (added.length === 0) {
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
    changes: [`skills.allowBundled += ${added.join(",")}`],
  };
}
