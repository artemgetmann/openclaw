import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { ensureSharedPersonalSkillsManagedRoot } from "../../onboard-shared-skills-root.js";
import type { OnboardOptions } from "../../onboard-types.js";

export const CONSUMER_DEFAULT_BUNDLED_SKILLS = [
  "consumer-setup",
  "timezone-preference-updater",
  "checkpoint",
  "monitor-router",
  "apple-notes",
  "apple-reminders",
  "gog",
  "goplaces",
  "himalaya",
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

export function applyNonInteractiveSkillsConfig(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
}) {
  const { nextConfig, opts, runtime } = params;
  if (opts.skipSkills) {
    return nextConfig;
  }
  ensureSharedPersonalSkillsManagedRoot();

  const nodeManager = opts.nodeManager ?? "npm";
  if (!["npm", "pnpm", "bun"].includes(nodeManager)) {
    runtime.error("Invalid --node-manager (use npm, pnpm, or bun)");
    runtime.exit(1);
    return nextConfig;
  }
  return {
    ...nextConfig,
    skills: {
      ...nextConfig.skills,
      // Existing allowlists keep operator order while stale consumer configs get repaired.
      allowBundled: buildConsumerBundledSkillAllowlist(nextConfig),
      install: {
        ...nextConfig.skills?.install,
        nodeManager,
      },
    },
  };
}
