import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
});
