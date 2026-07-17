import type { OpenClawConfig } from "../../config/config.js";
import { resolveSkillKey } from "./frontmatter.js";
import type { SkillEntry } from "./types.js";

const MESSAGE_DRAFTING_REFERENCING_SKILLS = new Set([
  "wacli",
  "telegram-user",
  "gog",
  "himalaya",
  "imsg",
  "bluebubbles",
  "slack",
  "discord",
  "cross-channel-triage",
]);

export function expandSkillDependencies(
  skillNames: string[],
  config?: OpenClawConfig,
  entries?: SkillEntry[],
): string[] {
  // A disabled adapter cannot activate an otherwise hidden policy skill. Keep
  // scanning because another selected adapter may still be enabled.
  const hasEnabledReference = skillNames.some((skillName) => {
    if (!MESSAGE_DRAFTING_REFERENCING_SKILLS.has(skillName)) {
      return false;
    }
    const effectiveEntry = entries?.find((entry) => entry.skill.name === skillName);
    const skillKey = effectiveEntry
      ? resolveSkillKey(effectiveEntry.skill, effectiveEntry)
      : skillName;
    return config?.skills?.entries?.[skillKey]?.enabled !== false;
  });
  if (
    skillNames.length === 0 ||
    skillNames.includes("__none__") ||
    skillNames.includes("message-drafting") ||
    !hasEnabledReference
  ) {
    return skillNames;
  }

  // Return a new effective list so config and agent-level filters remain an
  // exact record of the caller's explicit choices.
  return [...skillNames, "message-drafting"];
}
