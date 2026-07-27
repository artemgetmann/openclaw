import type { OpenClawConfig } from "../../config/config.js";
import { resolveSkillKey } from "./frontmatter.js";
import type { SkillEntry } from "./types.js";

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

function dependenciesFor(skillName: string, entries?: SkillEntry[]): readonly string[] {
  // Dependencies are a generic capability contract owned by each skill's
  // metadata. Looking up both canonical and effective keys keeps aliases usable
  // without creating a second hardcoded routing table.
  const entry = entries?.find(
    (candidate) =>
      candidate.skill.name === skillName ||
      resolveSkillKey(candidate.skill, candidate) === skillName,
  );
  return entry?.metadata?.dependencies ?? [];
}

export function expandSkillDependencies(
  skillNames: string[],
  config?: OpenClawConfig,
  entries?: SkillEntry[],
): string[] {
  if (skillNames.length === 0 || skillNames.includes("__none__")) {
    return skillNames;
  }

  // Traverse declared dependencies so channel -> drafting -> personal tone
  // works for allowlists and autonomous-run filters alike. Selected
  // dependencies receive protected prompt priority, preserving full trigger
  // descriptions when large catalogs compact their unselected tail.
  const expanded = [...skillNames];
  const seen = new Set(expanded);
  for (let index = 0; index < expanded.length; index += 1) {
    const source = expanded[index];
    if (!isSkillEnabled(source, config, entries)) {
      continue;
    }
    for (const dependency of dependenciesFor(source, entries)) {
      if (seen.has(dependency)) {
        continue;
      }
      seen.add(dependency);
      expanded.push(dependency);
    }
  }
  return expanded;
}
