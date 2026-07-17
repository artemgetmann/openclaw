import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const communicationSkills = [
  { name: "telegram-user", channelAnchor: "Telegram `date`" },
  { name: "wacli", channelAnchor: "wacli timestamps" },
  { name: "himalaya", channelAnchor: "email Date header" },
  { name: "gog", channelAnchor: "Gmail message timestamps" },
  { name: "imsg", channelAnchor: "imsg history timestamps" },
  { name: "bluebubbles", channelAnchor: "BlueBubbles message timestamps" },
  { name: "slack", channelAnchor: "Slack message timestamp" },
  { name: "discord", channelAnchor: "Discord source timestamp" },
] as const;

describe("communication skills temporal grounding contracts", () => {
  for (const { name, channelAnchor } of communicationSkills) {
    it(`${name} grounds actionable conversational context in source time`, () => {
      const skillPath = path.join(process.cwd(), "skills", name, "SKILL.md");
      const skill = readFileSync(skillPath, "utf8");

      expect(skill).toContain(channelAnchor);
      expect(skill).toMatch(/source\s+timestamp/);
      expect(skill).toContain("today, tomorrow, yesterday, and weekdays");
      expect(skill).toContain("trusted current time");
      expect(skill).toContain("absolute source date");
      expect(skill).toContain("timing is unknown");
      expect(skill).toContain("recovery or reschedule draft");
    });
  }
});
