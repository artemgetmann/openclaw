import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  matchesSkillFilter,
  normalizeSkillFilter,
  normalizeSkillFilterForComparison,
  resolveSkillFilter,
} from "./filter.js";
import type { SkillEntry } from "./types.js";

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

function makeEntry(name: string, dependencies?: string[]): SkillEntry {
  return {
    skill: {
      name,
      description: name,
      filePath: `/bundled/${name}/SKILL.md`,
      baseDir: `/bundled/${name}`,
      source: "openclaw-bundled",
      disableModelInvocation: false,
    },
    frontmatter: {},
    ...(dependencies ? { metadata: { dependencies } } : {}),
  };
}

function makeDraftingEntries(owner?: string): SkillEntry[] {
  return [
    ...(owner ? [makeEntry(owner, ["message-drafting"])] : []),
    makeEntry("message-drafting", ["personal-tone-of-voice"]),
    makeEntry("personal-tone-of-voice"),
  ];
}

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
    "%s closes over drafting and personal tone in effective filters",
    (owner) => {
      const filter = [owner];

      expect(resolveSkillFilter(filter, undefined, makeDraftingEntries(owner))).toEqual([
        owner,
        "message-drafting",
        "personal-tone-of-voice",
      ]);
      expect(filter).toEqual([owner]);
    },
  );

  it("closes a direct drafting filter over personal tone", () => {
    const filter = ["message-drafting"];

    expect(resolveSkillFilter(filter, undefined, makeDraftingEntries())).toEqual([
      "message-drafting",
      "personal-tone-of-voice",
    ]);
    expect(filter).toEqual(["message-drafting"]);
  });

  it("skips disabled-only owners but closes over another enabled owner", () => {
    const config: OpenClawConfig = {
      skills: { entries: { wacli: { enabled: false } } },
    };
    const disabledOnly = ["wacli"];
    const withEnabledOwner = ["wacli", "slack"];
    const entries = [
      makeEntry("wacli", ["message-drafting"]),
      makeEntry("slack", ["message-drafting"]),
      ...makeDraftingEntries(),
    ];

    expect(resolveSkillFilter(disabledOnly, config, entries)).toEqual(["wacli"]);
    expect(resolveSkillFilter(withEnabledOwner, config, entries)).toEqual([
      "wacli",
      "slack",
      "message-drafting",
      "personal-tone-of-voice",
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
