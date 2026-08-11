import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONSUMER_DEFAULT_BUNDLED_SKILLS } from "./consumer-default-bundled-skills.js";
import { parseFrontmatter } from "./skills/frontmatter.js";

describe("session-logs skill contract", () => {
  const skillPath = path.join(process.cwd(), "skills", "session-logs", "SKILL.md");
  const skillContents = fs.readFileSync(skillPath, "utf8");

  it("ships as a valid consumer default", () => {
    // Parse the actual bundled owner so malformed metadata cannot silently hide
    // the default capability from newly generated consumer configurations.
    const frontmatter = parseFrontmatter(skillContents);

    expect(frontmatter.name).toBe("session-logs");
    expect(frontmatter.description).toContain("active agent's own session history");
    expect(CONSUMER_DEFAULT_BUNDLED_SKILLS).toContain("session-logs");
  });

  it("keeps own-history recovery narrow and private by default", () => {
    // These phrases encode the user-visible privacy boundary: current indexed
    // history is useful, while deleted remnants, other agents, and tool payloads
    // remain outside an ordinary prior-conversation lookup.
    expect(skillContents).toContain("Use this skill only when the user asks");
    expect(skillContents).toContain("Never enumerate the state directory's `agents/` children");
    expect(skillContents).toContain("Search only transcripts referenced by its current entries");
    expect(skillContents).toContain("Exclude `*.deleted.*`, `*.reset.*`");
    expect(skillContents).toContain("Exclude `toolResult`, tool calls, thinking");
    expect(skillContents).toContain("Never paste a full transcript");
    expect(skillContents).toContain("Return the smallest relevant excerpts");
  });
});
