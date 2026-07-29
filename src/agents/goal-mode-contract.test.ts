import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillsPrompt, loadWorkspaceSkillEntries } from "./skills.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("goal-mode autonomy contract", () => {
  it("routes the real skill and preserves the generic scenario matrix", async () => {
    const workspaceDir = path.resolve(".");
    const bundledSkillsDir = path.resolve("skills");
    const goalModePath = path.join(bundledSkillsDir, "goal-mode", "SKILL.md");
    const goalModeContract = await fs.readFile(goalModePath, "utf8");
    const entries = loadWorkspaceSkillEntries(workspaceDir, { bundledSkillsDir });
    const skillsPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      entries,
      skillFilter: ["goal-mode"],
    });
    const systemPrompt = buildAgentSystemPrompt({
      workspaceDir,
      toolNames: ["get_goal", "create_goal", "update_goal", "monitor"],
      skillsPrompt,
    });
    expect(systemPrompt).toContain("<name>goal-mode</name>");
    expect(systemPrompt).toContain("use the `goal-mode` skill from <available_skills>");
    expect(systemPrompt).toContain("delayed, multi-step external outcome");
    expect(systemPrompt).toContain("offer or use a `goal` in the same turn");
    expect(systemPrompt).toContain(
      "verify active skills/tools cover the required external actions",
    );
    expect(systemPrompt).toContain("goal/monitor tools alone provide continuation");
    expect(systemPrompt).toContain("offer tracking/planning only");
    expect(systemPrompt).toContain("Ask at most one high-value missing boundary");
    expect(systemPrompt).toContain("showing the complete proposed authority scope");
    expect(systemPrompt).toContain("proceed without asking again");
    expect(systemPrompt).toContain("include the reply or relevant content");
    expect(systemPrompt).toContain("Skip trivial one-shot work and casual sends");
    const normalizedContract = goalModeContract.replace(/\s+/g, " ");
    const requiredContract = [
      "Use the actual product term `goal` so the user learns the capability",
      "Should I set a goal and handle this autonomously within agreed limits?",
      "Before offering autonomous handling, verify that active skills and tools can perform the required external actions",
      "Goal and monitor tools provide durable continuation, not booking, messaging, payment, or account access",
      "offer a goal for tracking or planning only and state which step remains manual",
      "Ask at most one high-value guardrail question",
      "notify-only versus draft versus send-and-continue",
      "show the complete proposed scope",
      "Combine consent, scope confirmation, and the missing boundary in one question",
      "Infer only details that do not expand authority",
      "If the original request already clearly authorizes end-to-end handling and supplies sufficient limits, do not offer or ask again",
      "Do not ask whether to inspect or fetch information the user already asked to receive",
      "include the reply text or relevant content in the notification when available",
      "Do not offer a goal for trivial one-shot requests",
      "do not repeatedly ask permission for actions inside its limits",
      "Escalate only for out-of-scope, irreversible, costly, sensitive, or otherwise ungranted actions",
      "only 8 or 9, ask before anything paid",
      "push back on 7:30/7:45 automatically",
      "follow up with support autonomously on normal status questions",
      "ask before accepting store credit",
      '"buy under $15", purchase only inside that clear constraint',
      "ask before purchase/payment",
      "Do not ask before every normal follow-up inside the approved goal",
      "Ask only for a missing safety or continuation boundary",
      "When the outcome, allowed autonomous actions, approval-required actions, hard constraints, watched surface, stop condition, and expiry are already supplied or authorized, proceed without repeating them",
      "Do not offer on casual sends that have no meaningful next step",
    ];
    for (const clause of requiredContract) {
      expect(normalizedContract).toContain(clause);
    }
  });
});
