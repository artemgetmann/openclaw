import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
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

  it("skips disabled-only owners but closes over another enabled owner", () => {
    const config: OpenClawConfig = {
      skills: { entries: { wacli: { enabled: false } } },
    };
    const disabledOnly = ["wacli"];
    const withEnabledOwner = ["wacli", "slack"];

    expect(resolveSkillFilter(disabledOnly, config)).toEqual(["wacli"]);
    expect(resolveSkillFilter(withEnabledOwner, config)).toEqual([
      "wacli",
      "slack",
      "message-drafting",
    ]);
    expect(normalizeSkillFilter(disabledOnly)).toEqual(["wacli"]);
    expect(normalizeSkillFilter(withEnabledOwner)).toEqual(["wacli", "slack"]);
  });

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
