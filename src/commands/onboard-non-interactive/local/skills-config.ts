import { buildConsumerBundledSkillAllowlist } from "../../../agents/consumer-default-bundled-skills.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
export {
  buildConsumerBundledSkillAllowlist,
  CONSUMER_DEFAULT_BUNDLED_SKILLS,
  repairConsumerDefaultBundledSkillAllowlist,
} from "../../../agents/consumer-default-bundled-skills.js";
import { ensureSharedPersonalSkillsManagedRoot } from "../../onboard-shared-skills-root.js";
import type { OnboardOptions } from "../../onboard-types.js";

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
