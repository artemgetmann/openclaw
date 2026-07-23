import { describe, expect, it } from "vitest";
import { resolveSkillsPromptForRun } from "./skills.js";
import type { SkillEntry } from "./skills/types.js";

function makeResolvedSkill(params: { name: string; description: string }) {
  return {
    name: params.name,
    description: params.description,
    filePath: `/app/skills/${params.name}/SKILL.md`,
    baseDir: `/app/skills/${params.name}`,
    source: "openclaw-workspace",
    disableModelInvocation: false,
  };
}

describe("resolveSkillsPromptForRun", () => {
  it("prefers snapshot prompt when available", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: { prompt: "SNAPSHOT", skills: [] },
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toBe("SNAPSHOT");
  });
  it("builds prompt from entries when snapshot is missing", () => {
    const entry: SkillEntry = {
      skill: {
        name: "demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        baseDir: "/app/skills/demo-skill",
        source: "openclaw-bundled",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      entries: [entry],
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("/app/skills/demo-skill/SKILL.md");
  });

  it("reranks a stored 124-skill snapshot for the current builder-priority request", () => {
    const genericSkills = Array.from({ length: 123 }, (_, index) =>
      makeResolvedSkill({
        name: `generic-skill-${String(index).padStart(3, "0")}`,
        description: `Generic capability ${index}. ${"x".repeat(320)}`,
      }),
    );
    const builderDescription =
      "Prioritize product and build work from messy Codex chats and produce a short boss-level priority report.";
    const builderSkill = makeResolvedSkill({
      name: "builder-priority-triage",
      description: builderDescription,
    });

    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt: "<available_skills><name>generic-skill-000</name></available_skills>",
        skills: [],
        remoteNote: "Remote eligibility note",
        resolvedSkills: [...genericSkills, builderSkill],
      },
      config: {
        skills: {
          limits: {
            maxSkillsInPrompt: 150,
            maxSkillsPromptChars: 30_000,
          },
        },
      },
      userPrompt:
        "Review these recent Codex chats and tell me what I should build next. Give me a short boss priority report.",
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("<name>builder-priority-triage</name>");
    expect(prompt).toContain("Remote eligibility note");
    expect(prompt).toContain(builderDescription);
    expect(prompt.indexOf("builder-priority-triage")).toBeLessThan(
      prompt.indexOf("generic-skill-000"),
    );
    expect(prompt).toContain("Skills catalog compacted");
  });

  it("reranks an explicitly requested X community skill ahead of prompt overflow", () => {
    const genericSkills = Array.from({ length: 123 }, (_, index) =>
      makeResolvedSkill({
        name: `generic-skill-${String(index).padStart(3, "0")}`,
        description: `Generic capability ${index}. ${"x".repeat(320)}`,
      }),
    );
    const xDescription =
      "Create and publish a post to the X Build in Public community using the correct community route.";

    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt: "<available_skills><name>generic-skill-000</name></available_skills>",
        skills: [],
        resolvedSkills: [
          ...genericSkills,
          makeResolvedSkill({
            name: "x-build-in-public-post",
            description: xDescription,
          }),
        ],
      },
      config: {
        skills: {
          limits: {
            maxSkillsInPrompt: 150,
            maxSkillsPromptChars: 30_000,
          },
        },
      },
      userPrompt: "Post this to the X Build in Public community.",
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("<name>x-build-in-public-post</name>");
    expect(prompt).toContain(xDescription);
    expect(prompt.indexOf("x-build-in-public-post")).toBeLessThan(
      prompt.indexOf("generic-skill-000"),
    );
  });

  it("keeps an exact skill-name match ahead of unbounded description overlap", () => {
    const noisyTokens = Array.from({ length: 500 }, (_, index) => `noise${index}`);
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt: "OLD",
        skills: [],
        protectedSkillNames: [],
        resolvedSkills: [
          makeResolvedSkill({
            name: "description-overlap",
            description: noisyTokens.join(" "),
          }),
          makeResolvedSkill({
            name: "target-skill",
            description: "Handle the explicitly requested target.",
          }),
        ],
      },
      config: {
        skills: {
          limits: {
            maxSkillsInPrompt: 1,
            maxSkillsPromptChars: 2_000,
          },
        },
      },
      userPrompt: `Use target-skill. Context: ${noisyTokens.join(" ")}`,
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("<name>target-skill</name>");
    expect(prompt).not.toContain("<name>description-overlap</name>");
  });

  it("keeps protected product skills ahead of current-turn relevance", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt: "OLD",
        skills: [],
        protectedSkillNames: ["goal-mode"],
        resolvedSkills: [
          makeResolvedSkill({
            name: "builder-priority-triage",
            description: "Prioritize build work.",
          }),
          {
            ...makeResolvedSkill({
              name: "goal-mode",
              description: "Maintain the active product goal contract.",
            }),
            source: "openclaw-product-managed",
          },
        ],
      },
      config: {
        skills: {
          limits: {
            maxSkillsInPrompt: 1,
            maxSkillsPromptChars: 2_000,
          },
        },
      },
      userPrompt: "Use builder priority triage for this build report.",
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("<name>goal-mode</name>");
    expect(prompt).not.toContain("<name>builder-priority-triage</name>");
  });

  it("does not treat short skill names as substrings inside longer words", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt: "OLD",
        skills: [],
        protectedSkillNames: [],
        resolvedSkills: [
          makeResolvedSkill({
            name: "sag",
            description: "Text to speech narration.",
          }),
          makeResolvedSkill({
            name: "usage-report",
            description: "Summarize usage and billing reports.",
          }),
        ],
      },
      config: {
        skills: {
          limits: {
            maxSkillsInPrompt: 1,
            maxSkillsPromptChars: 2_000,
          },
        },
      },
      userPrompt: "Summarize this usage report.",
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("<name>usage-report</name>");
    expect(prompt).not.toContain("<name>sag</name>");
  });

  it("preserves an intentionally empty protected set for workspace overrides", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt: "OLD",
        skills: [],
        protectedSkillNames: [],
        resolvedSkills: [
          {
            ...makeResolvedSkill({
              name: "goal-mode",
              description: "Workspace override without product protection.",
            }),
            source: "openclaw-workspace",
          },
          makeResolvedSkill({
            name: "builder-priority-triage",
            description: "Prioritize build work.",
          }),
        ],
      },
      config: {
        skills: {
          limits: {
            maxSkillsInPrompt: 1,
            maxSkillsPromptChars: 2_000,
          },
        },
      },
      userPrompt: "Use builder priority triage for this build report.",
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("<name>builder-priority-triage</name>");
    expect(prompt).not.toContain("<name>goal-mode</name>");
  });

  it("preserves remote execution guidance from legacy snapshot prompts", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt: [
          "Remote macOS node available (Mac Studio). Run macOS-only skills via nodes.run on that node.",
          "",
          "The following skills provide specialized instructions for specific tasks.",
          "<available_skills></available_skills>",
        ].join("\n"),
        skills: [],
        resolvedSkills: [
          makeResolvedSkill({
            name: "macos-automator",
            description: "Automate macOS applications.",
          }),
        ],
      },
      userPrompt: "Automate this macOS task.",
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("Remote macOS node available (Mac Studio)");
    expect(prompt).toContain("Run macOS-only skills via nodes.run");
  });
});
