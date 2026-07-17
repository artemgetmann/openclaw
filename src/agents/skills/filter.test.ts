import { describe, expect, it } from "vitest";
import {
  matchesSkillFilter,
  normalizeSkillFilter,
  normalizeSkillFilterForComparison,
  resolveSkillFilter,
} from "./filter.js";

const messageDraftingOwners = [
  "wacli",
  "telegram-user",
  "gog",
  "himalaya",
  "imsg",
  "bluebubbles",
  "slack",
  "discord",
  "cross-channel-triage",
] as const;

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

  it.each(messageDraftingOwners)(
    "%s closes over message-drafting in effective filters",
    (owner) => {
      const filter = [owner];

      expect(resolveSkillFilter(filter)).toEqual([owner, "message-drafting"]);
      expect(filter).toEqual([owner]);
    },
  );

  it("keeps empty, __none__, and unrelated effective filters restrictive", () => {
    expect(resolveSkillFilter([])).toEqual([]);
    expect(resolveSkillFilter(["__none__", "wacli"])).toEqual(["__none__"]);
    expect(resolveSkillFilter(["custom-skill"])).toEqual(["custom-skill"]);
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
    expect(matchesSkillFilter(undefined, undefined)).toBe(true);
    expect(matchesSkillFilter([], undefined)).toBe(false);
  });
});
