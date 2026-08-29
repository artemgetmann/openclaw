import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = process.cwd();

function readBundledSkill(name: string): string {
  return fs.readFileSync(path.join(repoRoot, "skills", name, "SKILL.md"), "utf8");
}

function parseFrontmatter(skill: string): Record<string, unknown> {
  const match = skill.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) {
    throw new Error("Skill is missing YAML frontmatter");
  }
  return parse(match[1]) as Record<string, unknown>;
}

describe("bundled message skill contracts", () => {
  it("keeps telegram-user valid for Codex skill discovery", () => {
    const skill = readBundledSkill("telegram-user");

    expect(parseFrontmatter(skill)).toMatchObject({ name: "telegram-user" });
  });

  it("routes generated Telegram sends through stdin instead of inline message text", () => {
    const telegramUser = readBundledSkill("telegram-user");
    const telegramChatManagement = readBundledSkill("telegram-chat-management");

    expect(telegramUser).toContain("--message-file -");
    expect(telegramUser).toContain("Codex `exec_command`");
    expect(telegramUser).toContain("private temporary UTF-8 file");
    expect(telegramChatManagement).toContain("--message-file <runtime-input>");
    expect(telegramChatManagement).toContain("private temporary UTF-8");
    expect(telegramUser).not.toMatch(/openclaw telegram-user send[^\n]*--message\s/);
    expect(telegramChatManagement).not.toMatch(/openclaw telegram-user send[^\n]*--message\s/);
  });

  it("routes generated WhatsApp sends through the owner-safe product command", () => {
    const skill = readBundledSkill("wacli");

    expect(skill).toContain("openclaw whatsapp-user send-text");
    expect(skill).toContain("--message-file -");
    expect(skill).toContain("Codex `exec_command`");
    expect(skill).toContain("private temporary UTF-8 file");
    expect(skill).not.toMatch(/openclaw whatsapp-user send-text[^\n]*--message\s/);
  });
});
