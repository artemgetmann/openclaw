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

function isSkillEnabled(
  skillName: string,
  config?: OpenClawConfig,
  entries?: SkillEntry[],
): boolean {
  // Source skills may publish a different effective config key. Dependency
  // traversal must honor that merged key or a disabled adapter can leak policy
  // skills back into a scoped prompt.
  const effectiveEntry = entries?.find((entry) => entry.skill.name === skillName);
  const skillKey = effectiveEntry
    ? resolveSkillKey(effectiveEntry.skill, effectiveEntry)
    : skillName;
  return config?.skills?.entries?.[skillKey]?.enabled !== false;
}

function dependenciesFor(skillName: string): readonly string[] {
  if (MESSAGE_DRAFTING_REFERENCING_SKILLS.has(skillName)) {
    return ["message-drafting"];
  }
  if (skillName === "message-drafting") {
    return ["personal-tone-of-voice"];
  }
  return [];
}

export function expandSkillDependencies(
  skillNames: string[],
  config?: OpenClawConfig,
  entries?: SkillEntry[],
): string[] {
  if (skillNames.length === 0 || skillNames.includes("__none__")) {
    return skillNames;
  }

  // Traverse the tiny dependency graph so channel -> drafting -> personal tone
  // works for allowlists and autonomous-run filters alike. The input remains an
  // exact immutable record of the caller's explicit choices.
  const expanded = [...skillNames];
  const seen = new Set(expanded);
  for (let index = 0; index < expanded.length; index += 1) {
    const source = expanded[index];
    if (!isSkillEnabled(source, config, entries)) {
      continue;
    }
    for (const dependency of dependenciesFor(source)) {
      if (seen.has(dependency)) {
        continue;
      }
      seen.add(dependency);
      expanded.push(dependency);
    }
  }
  return expanded;
}
