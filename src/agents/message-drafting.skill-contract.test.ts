import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONSUMER_DEFAULT_BUNDLED_SKILLS } from "./consumer-default-bundled-skills.js";
import { buildWorkspaceSkillCommandSpecs, loadWorkspaceSkillEntries } from "./skills.js";

const repoRoot = process.cwd();
const skillPath = path.join(repoRoot, "skills", "message-drafting", "SKILL.md");
const skill = readFileSync(skillPath, "utf8");

describe("message-drafting authored contract", () => {
  // These are text-contract checks: they prove the bundled instructions, not
  // probabilistic model compliance with those instructions.
  it("defines the paired English-review and Italian-send presentation", () => {
    const reviewHeading = "Meaning for your review (English):";
    const sendHeading = "Exact message to send (Italian):";

    expect(skill).toContain("present one conceptual message as an aligned pair");
    expect(skill.indexOf(reviewHeading)).toBeGreaterThan(-1);
    expect(skill.indexOf(sendHeading)).toBeGreaterThan(skill.indexOf(reviewHeading));
    expect(skill).toContain("the blocks are not stylistic\nalternatives");
  });

  it("allows explicit Italian-only output", () => {
    expect(skill).toContain("the user explicitly requests target-language-only output");
  });

  it("uses one block when review and send languages match", () => {
    expect(skill).toContain("the review and target languages are the same");
  });

  it("requires revisions and shortening to update both blocks", () => {
    expect(skill).toMatch(
      /revises, shortens, softens, strengthens, or corrects a paired\s+draft, update both blocks together/,
    );
  });

  it("approves and sends only the exact target-language payload", () => {
    expect(skill).toContain("Ready to send this exact\nItalian text to <recipient>?");
    expect(skill).toMatch(
      /After approval, pass only the recipient-ready target-language block to the send\s+tool/,
    );
    expect(skill).toContain("Never send the review-language block");
  });

  it("offers alternatives only when explicitly requested", () => {
    expect(skill).toMatch(
      /Do not offer stylistic alternatives\s+unless the user explicitly requests/,
    );
    expect(skill).toMatch(
      /Do not turn a revision request into multiple alternatives unless the user\s+explicitly asks/,
    );
  });

  it("preserves recipient-facing facts and commitments", () => {
    expect(skill).toContain("Preserve facts, commitments, tone, names, dates, numbers, and links.");
  });
});

describe("message-drafting integration contract", () => {
  const channelSkills = [
    "cross-channel-triage",
    "wacli",
    "telegram-user",
    "gog",
    "himalaya",
    "imsg",
    "bluebubbles",
    "slack",
    "discord",
  ];

  it.each(channelSkills)(
    "%s points recipient-facing composition to the canonical skill",
    (name) => {
      const channelSkill = readFileSync(path.join(repoRoot, "skills", name, "SKILL.md"), "utf8");

      expect(channelSkill).toContain("For recipient-facing composition");
      expect(channelSkill).toMatch(
        /read and follow the bundled\s+`message-drafting` skill by canonical name/,
      );
      expect(channelSkill).not.toContain("skills/message-drafting/SKILL.md");
    },
  );

  it("registers message-drafting as a consumer default bundled skill", () => {
    expect(CONSUMER_DEFAULT_BUNDLED_SKILLS).toContain("message-drafting");
    expect(CONSUMER_DEFAULT_BUNDLED_SKILLS.indexOf("message-drafting")).toBe(
      CONSUMER_DEFAULT_BUNDLED_SKILLS.indexOf("cross-channel-triage") + 1,
    );
  });

  it("loads automatically without exposing a user command", () => {
    const workspaceDir = path.join(repoRoot, ".message-drafting-contract-workspace");
    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      bundledSkillsDir: path.join(repoRoot, "skills"),
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });
    const entry = entries.find((candidate) => candidate.skill.name === "message-drafting");

    expect(skill).toContain("user-invocable: false");
    expect(entry?.invocation?.userInvocable).toBe(false);
    expect(
      buildWorkspaceSkillCommandSpecs(workspaceDir, {
        entries: entry ? [entry] : [],
      }),
    ).not.toContainEqual(expect.objectContaining({ skillName: "message-drafting" }));
  });
});
