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
  const nextAllowlist = buildConsumerBundledSkillAllowlist(config);
  const currentAllowlist = config.skills?.allowBundled ?? [];
  if (
    currentAllowlist.length === nextAllowlist.length &&
    currentAllowlist.every((value, index) => value === nextAllowlist[index])
  ) {
    return { config, changes: [] };
  }

  const current = new Set(currentAllowlist);
  const added = nextAllowlist.filter((skillName) => !current.has(skillName));
  return {
    config: {
      ...config,
      skills: {
        ...config.skills,
        allowBundled: nextAllowlist,
      },
    },
    changes: added.map((skillName) => `skills.allowBundled += ${skillName}`),
  };
}
