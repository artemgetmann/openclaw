import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWorkspaceSkillCommandSpecs,
  loadWorkspaceSkillEntries,
} from "../src/agents/skills.js";

const canonicalSkill = readFileSync(
  path.join(process.cwd(), "skills", "message-drafting", "SKILL.md"),
  "utf8",
);

const channelOwners = [
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

const canonicalPointer =
  "For recipient-facing message composition and cross-language review/send behavior, apply the canonical `message-drafting` skill.";

describe("message-drafting cross-language contract", () => {
  it("owns recipient-facing composition and approval-ready output", () => {
    expect(canonicalSkill).toContain(
      "Compose, draft, revise, shorten, translate, review, approve, or prepare",
    );
    expect(canonicalSkill).toContain("email, chat, and messaging channels");
    expect(canonicalSkill).toContain("message wording, tone");
    expect(canonicalSkill).toContain("approval");
  });

  it("pairs English review meaning with an Italian send payload", () => {
    const fixture = {
      conversationLanguage: "English",
      targetLanguage: "Italian",
      request: "Tell Marco in Italian that I will arrive on 18 July at 15:30.",
    };

    expect(fixture.conversationLanguage).not.toBe(fixture.targetLanguage);
    expect(canonicalSkill).toContain("English-speaking Jarvis conversation with an Italian");
    expect(canonicalSkill).toContain("English meaning first");
    expect(canonicalSkill).toContain("Italian message");
    expect(canonicalSkill).toContain("Meaning (<review language>)");
    expect(canonicalSkill).toContain("Ready to send (<target language>)");
    expect(canonicalSkill).toContain("facts, commitments, tone, names, dates, numbers,");
    expect(canonicalSkill).toContain("and links");
  });

  it("honors an Italian-only exception", () => {
    const fixture = {
      request: "Italian only: tell Marco I will arrive at 15:30.",
      expectedBlocks: 1,
    };

    expect(fixture.expectedBlocks).toBe(1);
    expect(canonicalSkill).toContain('target-language-only output, such as "Italian only"');
  });

  it("does not duplicate a same-language message", () => {
    const fixture = {
      conversationLanguage: "English",
      targetLanguage: "English",
      expectedBlocks: 1,
    };

    expect(fixture.conversationLanguage).toBe(fixture.targetLanguage);
    expect(canonicalSkill).toContain("send language matches the user's normal Jarvis language");
  });

  it("regenerates both aligned blocks after a revision", () => {
    const fixture = {
      request: "Shorten it and change arrival to 16:00.",
      expectedUpdatedBlocks: ["review", "target"],
    };

    expect(fixture.expectedUpdatedBlocks).toEqual(["review", "target"]);
    expect(canonicalSkill).toContain("regenerate both blocks");
    expect(canonicalSkill).toMatch(/keep\s+them aligned/);
  });

  it("sends only the approved Italian payload", () => {
    const fixture = {
      approval: "Approve the Italian version for sending.",
      outboundLanguage: "Italian",
      excludes: ["review block", "headings", "commentary"],
    };

    expect(fixture.outboundLanguage).toBe("Italian");
    expect(canonicalSkill).toContain("Approve the Italian version for sending?");
    expect(canonicalSkill).toContain("send only the exact");
    for (const excluded of fixture.excludes) {
      expect(canonicalSkill).toContain(excluded);
    }
  });

  it("offers alternatives only when explicitly requested and keeps each paired", () => {
    const defaultFixture = { request: "Draft a reply in Italian.", variants: 1 };
    const explicitFixture = {
      request: "Give me formal and casual Italian alternatives.",
      variants: 2,
    };

    expect(defaultFixture.variants).toBe(1);
    expect(explicitFixture.variants).toBeGreaterThan(1);
    expect(canonicalSkill).toContain("one final message by default");
    expect(canonicalSkill).toContain("multiple stylistic variants only when explicitly");
    expect(canonicalSkill).toContain("every variant must be its own aligned");
  });

  it("defines review language without assuming native language", () => {
    expect(canonicalSkill).toContain("language the user normally uses with Jarvis");
    expect(canonicalSkill).toContain("explicitly preferred another review language");
    expect(canonicalSkill).toContain("Never infer");
    expect(canonicalSkill).toContain("native language");
  });

  it("keeps raw translation and fluent target-only requests single-language", () => {
    expect(canonicalSkill).toContain(
      "explicit user preference says they are fluent and want target-only output",
    );
    expect(canonicalSkill).toContain("raw translation rather than a sendable recipient-facing");
  });

  it("loads automatically without exposing a user command", () => {
    const workspaceDir = path.join(process.cwd(), ".message-drafting-contract-workspace");
    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      bundledSkillsDir: path.join(process.cwd(), "skills"),
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });
    const entry = entries.find((candidate) => candidate.skill.name === "message-drafting");

    expect(canonicalSkill).toContain("user-invocable: false");
    expect(entry?.invocation?.userInvocable).toBe(false);
    expect(
      buildWorkspaceSkillCommandSpecs(workspaceDir, {
        entries: entry ? [entry] : [],
      }),
    ).not.toContainEqual(expect.objectContaining({ skillName: "message-drafting" }));
  });
});

describe("communication channel owners reference the canonical contract", () => {
  for (const owner of channelOwners) {
    it(`${owner} points to message-drafting`, () => {
      const ownerSkill = readFileSync(
        path.join(process.cwd(), "skills", owner, "SKILL.md"),
        "utf8",
      );

      expect(ownerSkill).toContain(canonicalPointer);
      expect(ownerSkill.match(/message-drafting/g)).toHaveLength(1);
    });
  }
});
