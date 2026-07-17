import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("cross-channel-triage temporal grounding contract", () => {
  it("keeps actionable messages grounded to their source time", () => {
    const skillPath = path.join(process.cwd(), "skills", "cross-channel-triage", "SKILL.md");
    const skill = readFileSync(skillPath, "utf8");

    expect(skill).toContain("## Temporal Grounding");
    expect(skill).toMatch(/sender's timezone when known; otherwise use the user's timezone/);
    expect(skill).toContain("relative to when the source message was sent");
    expect(skill).toContain("absolute source date");
    expect(skill).toMatch(/recovery or\s+reschedule response/);
    expect(skill).toMatch(/flag the ambiguity\s+instead of guessing/);
  });
});
