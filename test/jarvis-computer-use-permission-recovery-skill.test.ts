import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Jarvis Computer Use permission recovery skill", () => {
  it("preflights and verifies the exact bundled helper permission repair", () => {
    const skill = readFileSync(
      path.join(process.cwd(), "skills/jarvis-computer-use/SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("harmless Finder or TextEdit observation");
    expect(skill).toContain("exact bundled/dev app identity");
    expect(skill).toContain("resolve its real containing app and bundle");
    expect(skill).toContain("Reset only a stale grant");
    expect(skill).toContain("re-enable that exact permission");
    expect(skill).toContain("Ask for explicit approval");
    expect(skill).toContain("Re-run the harmless observation");
  });
});
