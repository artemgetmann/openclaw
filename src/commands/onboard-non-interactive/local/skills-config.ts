import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";

export const CONSUMER_DEFAULT_BUNDLED_SKILLS = [
  "consumer-setup",
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

export function applyNonInteractiveSkillsConfig(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
}) {
  const { nextConfig, opts, runtime } = params;
  if (opts.skipSkills) {
    return nextConfig;
  }

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
      // Fresh consumer configs get a broad, useful model-facing skill surface.
      // Existing allowlists are respected because they are explicit operator policy.
      allowBundled: nextConfig.skills?.allowBundled ?? [...CONSUMER_DEFAULT_BUNDLED_SKILLS],
      install: {
        ...nextConfig.skills?.install,
        nodeManager,
      },
    },
  };
}
