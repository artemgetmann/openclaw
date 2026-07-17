import type { OpenClawConfig } from "../../config/config.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { expandSkillDependencies } from "./dependencies.js";

export function normalizeSkillFilter(skillFilter?: ReadonlyArray<unknown>): string[] | undefined {
  if (skillFilter === undefined) {
    return undefined;
  }
  return normalizeStringEntries(skillFilter);
}

export function resolveSkillFilter(
  skillFilter?: ReadonlyArray<unknown>,
  config?: OpenClawConfig,
): string[] | undefined {
  const normalized = normalizeSkillFilter(skillFilter);
  if (normalized === undefined) {
    return undefined;
  }
  return normalized.includes("__none__")
    ? ["__none__"]
    : expandSkillDependencies(normalized, config);
}

export function normalizeSkillFilterForComparison(
  skillFilter?: ReadonlyArray<unknown>,
): string[] | undefined {
  const normalized = normalizeSkillFilter(skillFilter);
  if (normalized === undefined) {
    return undefined;
  }
  return Array.from(new Set(normalized)).toSorted();
}

export function matchesSkillFilter(
  cached?: ReadonlyArray<unknown>,
  next?: ReadonlyArray<unknown>,
): boolean {
  const cachedNormalized = normalizeSkillFilterForComparison(cached);
  const nextNormalized = normalizeSkillFilterForComparison(next);
  if (cachedNormalized === undefined || nextNormalized === undefined) {
    return cachedNormalized === nextNormalized;
  }
  if (cachedNormalized.length !== nextNormalized.length) {
    return false;
  }
  return cachedNormalized.every((entry, index) => entry === nextNormalized[index]);
}
