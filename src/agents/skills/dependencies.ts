import type { OpenClawConfig } from "../../config/config.js";

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

export function expandSkillDependencies(skillNames: string[], config?: OpenClawConfig): string[] {
  // A disabled adapter cannot activate an otherwise hidden policy skill. Keep
  // scanning because another selected adapter may still be enabled.
  const hasEnabledReference = skillNames.some(
    (skillName) =>
      MESSAGE_DRAFTING_REFERENCING_SKILLS.has(skillName) &&
      config?.skills?.entries?.[skillName]?.enabled !== false,
  );
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
