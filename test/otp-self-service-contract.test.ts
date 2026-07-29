import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("OTP self-service contract", () => {
  it("keeps retrieval separate from sensitive entry and unsafe secret transport", () => {
    const skill = fs.readFileSync(
      path.join(process.cwd(), "skills/jarvis-computer-use/SKILL.md"),
      "utf8",
    );
    const normalized = skill.replace(/\s+/g, " ");

    expect(normalized).toContain("do not immediately ask the user to relay an OTP");
    expect(normalized).toContain("already-connected read-capable source");
    expect(normalized).toContain("read-only health or auth probe");
    expect(normalized).toContain("one unique fresh candidate");
    expect(normalized).toContain("Retrieving a code does not authorize entering or submitting it");
    expect(normalized).toContain("argv, shell, logs, memory, or ordinary tool parameters");
    expect(normalized).toContain("ask the user to enter it locally");
  });
});
