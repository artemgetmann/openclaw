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
      selectedReviewLanguage: "English",
      targetLanguage: "English",
      expectedBlocks: 1,
    };

    expect(fixture.selectedReviewLanguage).toBe(fixture.targetLanguage);
    expect(canonicalSkill).toContain("target language matches the selected review language");
  });

  it("does not duplicate when a conversation-wide review language matches target", () => {
    const fixture = {
      conversationInstruction: "From now on, use Italian as my review language.",
      selectedReviewLanguage: "Italian",
      targetLanguage: "Italian",
      expectedBlocks: 1,
    };

    expect(fixture.conversationInstruction).toContain("From now on");
    expect(fixture.selectedReviewLanguage).toBe(fixture.targetLanguage);
    expect(fixture.expectedBlocks).toBe(1);
    expect(canonicalSkill).toContain('"from now on" may');
    expect(canonicalSkill).toMatch(/later drafts in\s+the current conversation/);
    expect(canonicalSkill).toContain("target language matches the selected review language");
  });

  it("retains a one-time review language when revising the same draft", () => {
    const fixture = {
      initialRequest: "Use German for review this time and draft the message in Italian.",
      followUp: "Shorten it.",
      selectedReviewLanguage: "German",
      retainedReviewLanguage: "German",
      targetLanguage: "Italian",
      expectedUpdatedBlocks: ["review", "target"],
    };

    expect(fixture.initialRequest).toContain("this time");
    expect(fixture.followUp).not.toContain("review language");
    expect(fixture.retainedReviewLanguage).toBe(fixture.selectedReviewLanguage);
    expect(fixture.retainedReviewLanguage).not.toBe(fixture.targetLanguage);
    expect(fixture.expectedUpdatedBlocks).toEqual(["review", "target"]);
    expect(canonicalSkill).toMatch(
      /retain its previously selected\s+review language, including a one-time selection/,
    );
    expect(canonicalSkill).toMatch(
      /unless the current revision\s+explicitly changes or corrects the review language/,
    );
    expect(canonicalSkill).toMatch(
      /If the selected review and target languages still differ, regenerate both\s+blocks/,
    );
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
    expect(canonicalSkill).toMatch(/Provide\s+multiple stylistic variants only when explicitly/);
    expect(canonicalSkill).toMatch(/every variant must be\s+its own aligned/);
  });

  it("defines review language without assuming native language", () => {
    expect(canonicalSkill).toContain("established language of the current conversation");
    expect(canonicalSkill).toContain("Never infer");
    expect(canonicalSkill).toContain("native language");
  });

  it("defines review-language precedence and lets the current request win", () => {
    expect(canonicalSkill).toMatch(
      /explicit review-language instruction in the current request[\s\S]*most recent explicit conversation-wide review-language instruction[\s\S]*established language of the current conversation[\s\S]*language of the user's unquoted/,
    );
    expect(canonicalSkill).toContain(
      "An explicit current-request instruction wins for that draft.",
    );
    expect(canonicalSkill).toContain("invite correction");
    expect(canonicalSkill).toContain("proceed with the draft");
    expect(canonicalSkill).toMatch(
      /When the target language differs from the selected review language, present one\s+aligned pair/,
    );
  });

  it("uses the most recent conversation-wide review-language instruction", () => {
    const fixture = {
      priorInstructions: [
        "From now on, use English as my review language.",
        "Always use Spanish as my review language.",
      ],
      currentRequest: "Draft a reply in Italian.",
      expectedReviewLanguage: "Spanish",
    };

    expect(fixture.priorInstructions.at(-1)).toContain(fixture.expectedReviewLanguage);
    expect(fixture.currentRequest).not.toContain("review language");
    expect(canonicalSkill).toContain(
      "The most recent explicit conversation-wide review-language instruction",
    );
    expect(canonicalSkill).toContain("the most recent such instruction wins");
  });

  it("resolves first-request code-switch fallback from directive clauses", () => {
    const unquotedFixture = {
      request: 'Draft this in French: "Bonjour Marco." Keep it brief.',
      unquotedDirectiveLanguage: "English",
      expectedReviewLanguage: "English",
    };
    const mixedFixture = {
      request: 'Scrivi una risposta in francese. Keep it warm. "Bonjour Marco."',
      firstCompleteDirectiveClause: "Scrivi una risposta in francese.",
      expectedReviewLanguage: "Italian",
    };

    expect(unquotedFixture.unquotedDirectiveLanguage).toBe(unquotedFixture.expectedReviewLanguage);
    expect(mixedFixture.firstCompleteDirectiveClause).toContain("Scrivi");
    expect(mixedFixture.expectedReviewLanguage).toBe("Italian");
    expect(canonicalSkill).toMatch(
      /language of the user's unquoted\s+drafting or directive clause/,
    );
    expect(canonicalSkill).toContain("excluding quoted or clearly delimited recipient");
    expect(canonicalSkill).toMatch(
      /directive text is genuinely mixed, use the language of its first\s+complete directive clause/,
    );
    expect(canonicalSkill).toContain("invite correction, and proceed with the draft");
  });

  it("keeps durable wording conversation-local", () => {
    expect(canonicalSkill).toContain('"this time" as one-time');
    expect(canonicalSkill).toContain('"always" or');
    expect(canonicalSkill).toContain('"from now on" may');
    expect(canonicalSkill).toContain("conversation-wide review-language instruction");
    expect(canonicalSkill).toContain("later drafts in");
    expect(canonicalSkill).toContain("the current conversation");
    expect(canonicalSkill).toMatch(
      /Durable persistence is\s+deferred to an owner-verified profile or memory path/,
    );
  });

  it("rejects inferred code-switch signals but preserves explicit instructions", () => {
    expect(canonicalSkill).toContain("Never infer the review language from nationality");
    expect(canonicalSkill).toContain("locale, timezone, profile data");
    expect(canonicalSkill).toMatch(/fact of a single\s+code-switched message/);
    expect(canonicalSkill).toContain("Mere code-switching is not preference");
    expect(canonicalSkill).toMatch(
      /fallback above selects a review language only for the current\s+draft/,
    );
    expect(canonicalSkill).toContain("An explicit review-language instruction remains explicit");
    expect(canonicalSkill).toMatch(/when it appears\s+in a code-switched message/);
  });

  it("never reads or writes owner profile preferences", () => {
    expect(canonicalSkill).toMatch(/This skill must\s+not read or write/);
    expect(canonicalSkill).toContain("`USER.md`");
    expect(canonicalSkill).toContain("or any profile or memory file");
    expect(canonicalSkill).not.toMatch(/^\d+\.\s+.*`USER\.md`/m);
    expect(canonicalSkill).toContain("group, shared, non-owner, or ambiguous context");
    expect(canonicalSkill).toContain("never consult or apply owner");
    expect(canonicalSkill).not.toContain("Write it under");
    expect(canonicalSkill).not.toContain("lazily created `Communication Preferences`");
  });

  it("collapses to one block when corrected review language matches target", () => {
    const fixture = {
      initialRequest: "Use German for review this time and draft the message in Italian.",
      correction: "Use Italian as the review language instead.",
      initialReviewLanguage: "German",
      correctedReviewLanguage: "Italian",
      targetLanguage: "Italian",
      expectedUpdatedBlocks: ["target"],
    };

    expect(fixture.initialReviewLanguage).not.toBe(fixture.targetLanguage);
    expect(fixture.correction).toContain("Italian as the review language");
    expect(fixture.correctedReviewLanguage).toBe(fixture.targetLanguage);
    expect(fixture.expectedUpdatedBlocks).toEqual(["target"]);
    expect(canonicalSkill).toContain("explicitly changes or corrects the review language");
    expect(canonicalSkill).toContain("Then recompute the output");
    expect(canonicalSkill).toContain("If they match, emit only the target-ready message.");
    expect(canonicalSkill).toMatch(
      /Nothing is sent until the\s+updated target-language message is approved\./,
    );
  });

  it("keeps raw translation and fluent target-only requests single-language", () => {
    expect(canonicalSkill).toContain(
      "user explicitly says in the current conversation that they are fluent and",
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
