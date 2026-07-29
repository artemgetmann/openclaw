import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("OTP self-service contract", () => {
  it("checks connection health without persisting OTP content through ordinary tools", () => {
    const skill = fs.readFileSync(
      path.join(process.cwd(), "skills/jarvis-computer-use/SKILL.md"),
      "utf8",
    );
    const normalized = skill.replace(/\s+/g, " ");

    expect(normalized).toContain("checking what is already authorized");
    expect(normalized).toContain("available capability inventory");
    expect(normalized).toContain("non-content read-only health or auth probe");
    expect(normalized).toContain("Do not open, read, or search OTP messages with ordinary");
    expect(normalized).toContain("first-class secret-safe path");
    expect(normalized).toContain("keep the value out of model context, transcripts, logs");
    expect(normalized).toContain("Retrieving a code does not authorize entering or submitting it");
    expect(normalized).toContain(
      "ask the user to enter the code locally without pasting it into chat",
    );
  });
});
