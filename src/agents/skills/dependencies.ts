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

export function expandSkillDependencies(skillNames: string[]): string[] {
  if (
    skillNames.length === 0 ||
    skillNames.includes("__none__") ||
    skillNames.includes("message-drafting") ||
    !skillNames.some((skillName) => MESSAGE_DRAFTING_REFERENCING_SKILLS.has(skillName))
  ) {
    return skillNames;
  }

  // Return a new effective list so config and agent-level filters remain an
  // exact record of the caller's explicit choices.
  return [...skillNames, "message-drafting"];
}
