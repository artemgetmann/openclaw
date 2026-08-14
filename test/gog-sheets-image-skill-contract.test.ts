import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readGogSkill(): string {
  return readFileSync(path.join(process.cwd(), "skills", "gog", "SKILL.md"), "utf8");
}

describe("Google Sheets image-in-cell skill contract", () => {
  it("routes same-spreadsheet copies through the native Sheets operation", () => {
    const skill = readGogSkill();

    // The live failure started when an image value looked empty through the
    // values API and the agent incorrectly concluded that UI copy was required.
    expect(skill).toContain("A true image-in-cell is a distinct image value");
    expect(skill).toContain("gog sheets copy-paste");
    expect(skill).toContain("--type NORMAL --json --no-input");
    expect(skill).toContain("prefer the server-side Sheets operation");
  });

  it("fails closed until the exact destination image is verified", () => {
    const skill = readGogSkill();

    // A successful mutation receipt is only transport proof. The destination
    // still needs type-aware or visual evidence before the agent can say done.
    expect(skill).toMatch(/never clear it\s+first/);
    expect(skill).toContain("disposable staging cell");
    expect(skill).toContain("Verify the exact destination before reporting success");
    expect(skill).toContain("SpreadsheetApp.ValueType.IMAGE");
    expect(skill).toMatch(/An empty values-API result is\s+neither success nor failure/);
    expect(skill).toMatch(/must not claim\s+success/);
  });

  it("keeps image types and fallback boundaries explicit", () => {
    const skill = readGogSkill();

    // Cell formulas, true cell-image values, and floating images have different
    // APIs. Conflating them would recreate the unsafe clipboard fallback.
    expect(skill).toContain("`=IMAGE(...)` formulas");
    expect(skill).toMatch(/An over-grid image is a\s+separate object/);
    expect(skill).toContain("Do not use managed-browser or Computer Use clipboard shortcuts");
    expect(skill).toContain("Drive export to XLSX");
    expect(skill).toContain("fallback after native Sheets and purpose-built Apps Script paths");
  });
});
