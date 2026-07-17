import { describe, expect, it } from "vitest";
import {
  matchesSkillFilter,
  normalizeSkillFilter,
  normalizeSkillFilterForComparison,
} from "./filter.js";

describe("skills/filter", () => {
  it("normalizes configured filters with trimming", () => {
    expect(normalizeSkillFilter([" weather ", "", "meme-factory"])).toEqual([
      "weather",
      "meme-factory",
    ]);
  });

  it("preserves explicit empty list as []", () => {
    expect(normalizeSkillFilter([])).toEqual([]);
    expect(normalizeSkillFilter(undefined)).toBeUndefined();
  });

  it("keeps runtime dependency expansion out of raw filter normalization", () => {
    expect(normalizeSkillFilter(["telegram-user"])).toEqual(["telegram-user"]);
    expect(normalizeSkillFilter(["peekaboo"])).toEqual(["peekaboo"]);
  });

  it("normalizes for comparison with dedupe + ordering", () => {
    expect(normalizeSkillFilterForComparison(["weather", "meme-factory", "weather"])).toEqual([
      "meme-factory",
      "weather",
    ]);
  });

  it("matches equivalent filters after normalization", () => {
    expect(matchesSkillFilter(["weather", "meme-factory"], [" meme-factory ", "weather"])).toBe(
      true,
    );
    expect(matchesSkillFilter(["telegram-user"], ["telegram-user", "message-drafting"])).toBe(
      false,
    );
    expect(matchesSkillFilter(undefined, undefined)).toBe(true);
    expect(matchesSkillFilter([], undefined)).toBe(false);
  });
});
