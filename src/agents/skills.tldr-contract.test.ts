import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONSUMER_DEFAULT_BUNDLED_SKILLS } from "./consumer-default-bundled-skills.js";
import { parseFrontmatter, resolveSkillInvocationPolicy } from "./skills/frontmatter.js";

describe("tldr skill contract", () => {
  it("stays visible to users without allowing automatic model invocation", () => {
    // Read the shipped source so this test catches metadata drift in the actual
    // skill instead of proving a hand-built fixture that users never receive.
    const skillPath = path.join(process.cwd(), "skills", "tldr", "SKILL.md");
    const frontmatter = parseFrontmatter(fs.readFileSync(skillPath, "utf8"));

    expect(frontmatter.description?.trim()).toBe("Rewrite the last response in plain language.");
    expect(resolveSkillInvocationPolicy(frontmatter)).toEqual({
      userInvocable: true,
      disableModelInvocation: true,
    });
  });

  it("ships in the default Jarvis skill set", () => {
    // Bundled skills remain blocked when a consumer allowlist exists unless
    // they are explicitly included in the product default.
    expect(CONSUMER_DEFAULT_BUNDLED_SKILLS).toContain("tldr");
  });
});
