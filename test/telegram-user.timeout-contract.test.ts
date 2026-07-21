import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readBundledSkill(name: string): string {
  return readFileSync(path.join(process.cwd(), "skills", name, "SKILL.md"), "utf8");
}

describe("Telegram-as-me timeout contract", () => {
  it("keeps the agent wrapper alive longer than the CLI backend deadline", () => {
    const skill = readBundledSkill("telegram-user");

    expect(skill).toContain("at least 330");
    expect(skill).toContain("180 seconds installing dependencies");
    expect(skill).toContain("poll that same process");
  });

  it("requires verification before retrying an indeterminate send", () => {
    const skill = readBundledSkill("telegram-user");

    expect(skill).toContain("Telegram or local state is unknown");
    expect(skill).toMatch(/Do not\s+blindly retry/);
  });
});
