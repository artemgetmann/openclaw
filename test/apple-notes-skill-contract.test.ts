import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readAppleNotesSkill(): string {
  return readFileSync(path.join(process.cwd(), "skills", "apple-notes", "SKILL.md"), "utf8");
}

function readConsumerSetupSkill(): string {
  return readFileSync(path.join(process.cwd(), "skills", "consumer-setup", "SKILL.md"), "utf8");
}

describe("Apple Notes skill contract", () => {
  it("creates notes through memo's folder-scoped editor flow", () => {
    const skill = readAppleNotesSkill();

    // memo 0.5.2 treats --add as a flag, requires --folder, and opens an
    // editor for the note title and body. A positional title is rejected.
    expect(skill).toContain('memo notes -f "Folder Name" -a');
    expect(skill).toContain("Enter the title and body in the editor");
    expect(skill).not.toContain('memo notes -a "Note Title"');
  });

  it("keeps setup discoverable only for explicit Apple Notes opt-ins", () => {
    const consumerSetup = readConsumerSetupSkill();

    expect(consumerSetup).toContain("an explicitly enabled Apple Notes integration");
    expect(consumerSetup).toContain("### Apple Notes (explicit opt-in only)");
    expect(consumerSetup).toContain("`skills.entries.apple-notes.enabled` is explicitly `true`");
    expect(consumerSetup).toContain(
      "Do not create, edit, move, or delete a note merely to test setup.",
    );
  });
});
