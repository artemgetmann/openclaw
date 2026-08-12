import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONSUMER_DEFAULT_BUNDLED_SKILLS } from "./consumer-default-bundled-skills.js";
import { parseFrontmatter } from "./skills/frontmatter.js";

describe("closeout and priority skills", () => {
  it.each(["plain-language", "builder-priority-triage"])(
    "ships %s as a valid Jarvis default",
    (skillName) => {
      const skillPath = path.join(process.cwd(), "skills", skillName, "SKILL.md");
      const frontmatter = parseFrontmatter(fs.readFileSync(skillPath, "utf8"));
      expect(frontmatter.name).toBe(skillName);
      expect(frontmatter.description?.trim()).toBeTruthy();
      expect(CONSUMER_DEFAULT_BUNDLED_SKILLS).toContain(skillName);
    },
  );
});
