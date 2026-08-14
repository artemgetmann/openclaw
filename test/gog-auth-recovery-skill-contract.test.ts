import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkspaceSkillEntries } from "../src/agents/skills/workspace.js";

function readBundledSkill(name: string): string {
  return readFileSync(path.join(process.cwd(), "skills", name, "SKILL.md"), "utf8");
}

describe("Google Workspace auth recovery skill contract", () => {
  it("keeps the complete recovery policy in consumer-setup", () => {
    const skill = readBundledSkill("consumer-setup");

    // These phrases guard the behavioral regression from the live incident:
    // recovery must neither guess an account nor leave Calendar unchecked.
    expect(skill).toContain("stop and ask");
    expect(skill).toContain("select every checkbox");
    expect(skill).toMatch(/verify all\s+expected boxes/);
    expect(skill).toContain("gog auth list --json");
    expect(skill).toContain("Gmail and Calendar");
  });

  it("keeps gog as a routing pointer instead of a duplicate playbook", () => {
    const skill = readBundledSkill("gog");

    // The CLI skill detects the auth state; the shared setup skill owns the
    // stateful account, consent, callback, and verification procedure.
    expect(skill).toContain("route to the shared `consumer-setup`");
    expect(skill).toContain("Do not duplicate or improvise that recovery flow here");
    expect(skill).not.toContain("select every checkbox");
    expect(skill).not.toMatch(/verify all\s+expected boxes/);
  });

  it("injects consumer-setup whenever the Google Workspace skill is selected", () => {
    const entries = loadWorkspaceSkillEntries(
      path.join(process.cwd(), ".gog-auth-recovery-contract-workspace"),
      {
        bundledSkillsDir: path.join(process.cwd(), "skills"),
        managedSkillsDir: path.join(process.cwd(), ".gog-auth-recovery-contract-managed"),
      },
    );

    // The live incident proved that a prose pointer alone was insufficient:
    // gog was loaded, but the recovery owner was never injected or read.
    expect(entries.find((entry) => entry.skill.name === "gog")?.metadata?.dependencies).toEqual([
      "message-drafting",
      "consumer-setup",
    ]);
  });

  it("requires one safe health recheck before macOS OAuth recovery", () => {
    const gog = readBundledSkill("gog");
    const setup = readBundledSkill("consumer-setup");

    for (const skill of [gog, setup]) {
      expect(skill).toContain("gog auth list --json");
      expect(skill).toMatch(/retry (?:the|that) exact\s+(?:read-only command|read) once/i);
      expect(skill).toMatch(/Never retry (?:a )?(?:send, write|sends or writes)/i);
    }
    expect(setup).toContain("-25299");
    expect(setup).toContain("degraded auth health");
  });
});
