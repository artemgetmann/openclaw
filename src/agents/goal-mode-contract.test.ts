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
    expect(systemPrompt).toContain("skip casual sends");
    expect(systemPrompt).toContain("never create one without approval unless already authorized");
    const normalizedContract = goalModeContract.replace(/\s+/g, " ");
    const requiredContract = [
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
