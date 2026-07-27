import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillSnapshot, buildWorkspaceSkillsPrompt } from "./skills.js";
import {
  evaluateSkillEntry,
  resolveBundledAllowlist,
  shouldIncludeSkill,
} from "./skills/config.js";
import type { SkillEntry } from "./skills/types.js";

const referencingOwners = [
  "wacli",
  "telegram-user",
  "gog",
  "himalaya",
  "imsg",
  "bluebubbles",
  "slack",
  "discord",
  "cross-channel-triage",
] as const;

const tempDirs: string[] = [];

function fixtureDependencies(name: string): string[] | undefined {
  if (referencingOwners.includes(name as (typeof referencingOwners)[number])) {
    return ["message-drafting"];
  }
  return name === "message-drafting" ? ["personal-tone-of-voice"] : undefined;
}

function makeBundledEntry(name: string, skillKey?: string): SkillEntry {
  const dependencies = fixtureDependencies(name);
  return {
    skill: {
      name,
      description: `Bundled ${name}`,
      filePath: `/bundled/${name}/SKILL.md`,
      baseDir: `/bundled/${name}`,
      source: "openclaw-bundled",
      disableModelInvocation: false,
    },
    frontmatter: {},
    ...(skillKey || dependencies
      ? {
          metadata: {
            ...(skillKey ? { skillKey } : {}),
            ...(dependencies ? { dependencies } : {}),
          },
        }
      : {}),
  };
}

async function createBundledFixture(names: readonly string[]) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-dependency-"));
  const bundledSkillsDir = path.join(workspaceDir, ".bundled");
  tempDirs.push(workspaceDir);

  for (const name of names) {
    await writeSkill({
      dir: path.join(bundledSkillsDir, name),
      name,
      description: `Bundled ${name}`,
      metadata: JSON.stringify({
        openclaw: { dependencies: fixtureDependencies(name) },
      }),
    });
  }

  return { workspaceDir, bundledSkillsDir };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("message-drafting bundled allowlist dependency", () => {
  it.each(referencingOwners)("%s closes over drafting and personal tone", (owner) => {
    const config: OpenClawConfig = { skills: { allowBundled: [owner] } };
    const entries = [
      makeBundledEntry(owner),
      makeBundledEntry("message-drafting"),
      makeBundledEntry("personal-tone-of-voice"),
    ];

    expect(resolveBundledAllowlist(config, entries)).toEqual([
      owner,
      "message-drafting",
      "personal-tone-of-voice",
    ]);
  });

  it("closes direct message drafting selection over personal tone", () => {
    const config: OpenClawConfig = {
      skills: { allowBundled: ["message-drafting"] },
    };

    expect(
      resolveBundledAllowlist(config, [
        makeBundledEntry("message-drafting"),
        makeBundledEntry("personal-tone-of-voice"),
      ]),
    ).toEqual(["message-drafting", "personal-tone-of-voice"]);
  });

  it("exposes the dependency for a non-consumer custom allowlist", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
      "wacli",
      "message-drafting",
      "personal-tone-of-voice",
    ]);
    const config: OpenClawConfig = { skills: { allowBundled: ["wacli"] } };

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config,
    });

    expect(prompt).toContain("<name>wacli</name>");
    expect(prompt).toContain("<name>message-drafting</name>");
    expect(prompt).toContain("<name>personal-tone-of-voice</name>");
    expect(config.skills?.allowBundled).toEqual(["wacli"]);
  });

  it.each(["allowBundled", "skillFilter"] as const)(
    "does not expose the dependency when %s selects only a disabled owner",
    async (selectionBoundary) => {
      const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
        "wacli",
        "message-drafting",
        "personal-tone-of-voice",
      ]);
      const config: OpenClawConfig = {
        skills: {
          entries: { wacli: { enabled: false } },
          ...(selectionBoundary === "allowBundled" ? { allowBundled: ["wacli"] } : {}),
        },
      };

      const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
        bundledSkillsDir,
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config,
        skillFilter: selectionBoundary === "skillFilter" ? ["wacli"] : undefined,
      });

      expect(prompt).not.toContain("<name>wacli</name>");
      expect(prompt).not.toContain("<name>message-drafting</name>");
      expect(prompt).not.toContain("<name>personal-tone-of-voice</name>");
      if (selectionBoundary === "allowBundled") {
        expect(resolveBundledAllowlist(config)).toEqual(["wacli"]);
      }
    },
  );

  it.each(["allowBundled", "skillFilter"] as const)(
    "keeps the dependency active through %s when another selected owner is enabled",
    async (selectionBoundary) => {
      const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
        "wacli",
        "slack",
        "message-drafting",
        "personal-tone-of-voice",
      ]);
      const selection = ["wacli", "slack"];
      const config: OpenClawConfig = {
        skills: {
          entries: { wacli: { enabled: false } },
          ...(selectionBoundary === "allowBundled" ? { allowBundled: selection } : {}),
        },
      };

      const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
        bundledSkillsDir,
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config,
        skillFilter: selectionBoundary === "skillFilter" ? selection : undefined,
      });

      expect(prompt).not.toContain("<name>wacli</name>");
      expect(prompt).toContain("<name>slack</name>");
      expect(prompt).toContain("<name>message-drafting</name>");
      expect(prompt).toContain("<name>personal-tone-of-voice</name>");
    },
  );

  it.each(["allowBundled", "skillFilter"] as const)(
    "uses an enabled effective skillKey override through %s",
    (selectionBoundary) => {
      const entries = [
        makeBundledEntry("wacli", "whatsapp-profile"),
        makeBundledEntry("message-drafting"),
        makeBundledEntry("personal-tone-of-voice"),
      ];
      const config: OpenClawConfig = {
        skills: {
          entries: {
            wacli: { enabled: false },
            "whatsapp-profile": { enabled: true },
          },
          ...(selectionBoundary === "allowBundled" ? { allowBundled: ["wacli"] } : {}),
        },
      };

      const prompt = buildWorkspaceSkillsPrompt("/unused", {
        entries,
        config,
        skillFilter: selectionBoundary === "skillFilter" ? ["wacli"] : undefined,
      });

      expect(prompt).toContain("<name>wacli</name>");
      expect(prompt).toContain("<name>message-drafting</name>");
      expect(prompt).toContain("<name>personal-tone-of-voice</name>");
      if (selectionBoundary === "allowBundled") {
        expect(resolveBundledAllowlist(config, entries)).toEqual([
          "wacli",
          "message-drafting",
          "personal-tone-of-voice",
        ]);
      }
    },
  );

  it.each(["allowBundled", "skillFilter"] as const)(
    "honors a disabled effective skillKey override through %s",
    (selectionBoundary) => {
      const entries = [
        makeBundledEntry("wacli", "whatsapp-profile"),
        makeBundledEntry("message-drafting"),
        makeBundledEntry("personal-tone-of-voice"),
      ];
      const config: OpenClawConfig = {
        skills: {
          entries: {
            wacli: { enabled: true },
            "whatsapp-profile": { enabled: false },
          },
          ...(selectionBoundary === "allowBundled" ? { allowBundled: ["wacli"] } : {}),
        },
      };

      const prompt = buildWorkspaceSkillsPrompt("/unused", {
        entries,
        config,
        skillFilter: selectionBoundary === "skillFilter" ? ["wacli"] : undefined,
      });

      expect(prompt).not.toContain("<name>wacli</name>");
      expect(prompt).not.toContain("<name>message-drafting</name>");
      expect(prompt).not.toContain("<name>personal-tone-of-voice</name>");
      if (selectionBoundary === "allowBundled") {
        expect(resolveBundledAllowlist(config, entries)).toEqual(["wacli"]);
      }
    },
  );

  it("closes scoped prompt and snapshot filters without mutating the requested filter", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
      "wacli",
      "message-drafting",
      "personal-tone-of-voice",
      "custom-skill",
    ]);
    const skillFilter = ["wacli"];
    const options = {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      skillFilter,
    };

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, options);
    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, options);
    const repeatedPrompt = buildWorkspaceSkillsPrompt(workspaceDir, options);

    expect(prompt).toContain("<name>wacli</name>");
    expect(prompt).toContain("<name>message-drafting</name>");
    expect(prompt).toContain("<name>personal-tone-of-voice</name>");
    expect(prompt).not.toContain("<name>custom-skill</name>");
    expect(snapshot.skills.map((skill) => skill.name).toSorted()).toEqual([
      "message-drafting",
      "personal-tone-of-voice",
      "wacli",
    ]);
    expect(snapshot.skillFilter).toEqual(["wacli"]);
    expect(repeatedPrompt).toBe(prompt);
    expect(skillFilter).toEqual(["wacli"]);
  });

  it("keeps the owner and dependency ahead of 149 workspace skills when prompts truncate", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
      "wacli",
      "message-drafting",
      "personal-tone-of-voice",
    ]);
    const workspaceSkillNames = Array.from(
      { length: 149 },
      (_, index) => `workspace-${String(index).padStart(3, "0")}`,
    );
    await Promise.all(
      workspaceSkillNames.map((name) =>
        writeSkill({
          dir: path.join(workspaceDir, "skills", name),
          name,
          description: `Workspace ${name}`,
        }),
      ),
    );
    const config: OpenClawConfig = {
      skills: {
        allowBundled: ["wacli"],
        limits: {
          maxSkillsInPrompt: 150,
          maxSkillsPromptChars: 100_000,
        },
      },
    };

    const allowlistSnapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config,
    });
    const skillFilter = [...workspaceSkillNames, "wacli"];
    const filterSnapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: {
        skills: {
          limits: {
            maxSkillsInPrompt: 150,
            maxSkillsPromptChars: 100_000,
          },
        },
      },
      skillFilter,
    });

    for (const snapshot of [allowlistSnapshot, filterSnapshot]) {
      expect(snapshot.prompt).toContain("<name>wacli</name>");
      expect(snapshot.prompt).toContain("<name>message-drafting</name>");
      expect(snapshot.prompt).toContain("<name>personal-tone-of-voice</name>");
      expect(snapshot.prompt).toContain(
        "<description>Bundled personal-tone-of-voice</description>",
      );
      expect(snapshot.prompt).toContain("Skills truncated");
      expect(snapshot.prompt).not.toContain("<name>workspace-148</name>");
    }
    expect(config.skills?.allowBundled).toEqual(["wacli"]);
    expect(filterSnapshot.skillFilter).toEqual(skillFilter);
    expect(skillFilter).not.toContain("message-drafting");
    expect(skillFilter).not.toContain("personal-tone-of-voice");
  });

  it("keeps an explicitly disabled dependency hidden from scoped filters", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
      "wacli",
      "message-drafting",
      "personal-tone-of-voice",
    ]);

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      skillFilter: ["wacli"],
      config: {
        skills: {
          entries: { "message-drafting": { enabled: false } },
        },
      },
    });

    expect(prompt).toContain("<name>wacli</name>");
    expect(prompt).not.toContain("<name>message-drafting</name>");
    expect(prompt).not.toContain("<name>personal-tone-of-voice</name>");
  });

  it("keeps unrelated, __none__, and empty scoped filters restrictive", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
      "wacli",
      "message-drafting",
      "personal-tone-of-voice",
      "custom-skill",
    ]);
    const baseOptions = {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    };

    const unrelatedPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      ...baseOptions,
      skillFilter: ["custom-skill"],
    });
    const nonePrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      ...baseOptions,
      skillFilter: ["__none__", "wacli"],
    });
    const emptyPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      ...baseOptions,
      skillFilter: [],
    });

    expect(unrelatedPrompt).toContain("<name>custom-skill</name>");
    expect(unrelatedPrompt).not.toContain("<name>message-drafting</name>");
    expect(unrelatedPrompt).not.toContain("<name>personal-tone-of-voice</name>");
    expect(nonePrompt).toBe("");
    expect(emptyPrompt).toBe("");
  });

  it("keeps repeated resolver and evaluator calls in memory without broadening config", () => {
    const config: OpenClawConfig = { skills: { allowBundled: ["wacli"] } };
    Object.freeze(config.skills?.allowBundled);
    Object.freeze(config.skills);
    Object.freeze(config);
    const messageDrafting = makeBundledEntry("message-drafting");
    const personalTone = makeBundledEntry("personal-tone-of-voice");
    const entries = [makeBundledEntry("wacli"), messageDrafting, personalTone];

    expect(resolveBundledAllowlist(config, entries)).toEqual([
      "wacli",
      "message-drafting",
      "personal-tone-of-voice",
    ]);
    expect(evaluateSkillEntry({ entry: messageDrafting, entries, config }).blockedByAllowlist).toBe(
      false,
    );
    expect(shouldIncludeSkill({ entry: messageDrafting, entries, config })).toBe(true);
    expect(evaluateSkillEntry({ entry: personalTone, entries, config }).blockedByAllowlist).toBe(
      false,
    );
    expect(shouldIncludeSkill({ entry: personalTone, entries, config })).toBe(true);
    expect(resolveBundledAllowlist(config, entries)).toEqual([
      "wacli",
      "message-drafting",
      "personal-tone-of-voice",
    ]);
    expect(config.skills?.allowBundled).toEqual(["wacli"]);
  });

  it("keeps an explicitly disabled message-drafting skill hidden", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
      "wacli",
      "message-drafting",
      "personal-tone-of-voice",
    ]);
    const config: OpenClawConfig = {
      skills: {
        allowBundled: ["wacli"],
        entries: { "message-drafting": { enabled: false } },
      },
    };
    const messageDrafting = makeBundledEntry("message-drafting");
    const entries = [
      makeBundledEntry("wacli"),
      messageDrafting,
      makeBundledEntry("personal-tone-of-voice"),
    ];

    expect(resolveBundledAllowlist(config, entries)).toEqual(["wacli", "message-drafting"]);
    expect(evaluateSkillEntry({ entry: messageDrafting, entries, config }).disabled).toBe(true);
    expect(shouldIncludeSkill({ entry: messageDrafting, entries, config })).toBe(false);

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config,
    });
    expect(prompt).toContain("<name>wacli</name>");
    expect(prompt).not.toContain("<name>message-drafting</name>");
    expect(prompt).not.toContain("<name>personal-tone-of-voice</name>");
  });

  it("keeps an explicitly disabled personal tone skill hidden", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
      "wacli",
      "message-drafting",
      "personal-tone-of-voice",
    ]);
    const config: OpenClawConfig = {
      skills: {
        allowBundled: ["wacli"],
        entries: { "personal-tone-of-voice": { enabled: false } },
      },
    };
    const entries = [
      makeBundledEntry("wacli"),
      makeBundledEntry("message-drafting"),
      makeBundledEntry("personal-tone-of-voice"),
    ];

    expect(resolveBundledAllowlist(config, entries)).toEqual([
      "wacli",
      "message-drafting",
      "personal-tone-of-voice",
    ]);

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config,
    });
    expect(prompt).toContain("<name>wacli</name>");
    expect(prompt).toContain("<name>message-drafting</name>");
    expect(prompt).not.toContain("<name>personal-tone-of-voice</name>");
  });

  it("expands arbitrary metadata dependencies without named routing code", () => {
    const entries: SkillEntry[] = [
      { ...makeBundledEntry("alpha"), metadata: { dependencies: ["beta"] } },
      { ...makeBundledEntry("beta"), metadata: { dependencies: ["gamma"] } },
      makeBundledEntry("gamma"),
    ];

    expect(
      resolveBundledAllowlist(
        {
          skills: { allowBundled: ["alpha"] },
        },
        entries,
      ),
    ).toEqual(["alpha", "beta", "gamma"]);
  });

  it("expands dependencies when selection uses an effective skill key", () => {
    const drafting = makeBundledEntry("message-drafting", "drafting-profile");
    const entries = [drafting, makeBundledEntry("personal-tone-of-voice")];

    expect(
      resolveBundledAllowlist(
        {
          skills: { allowBundled: ["drafting-profile"] },
        },
        entries,
      ),
    ).toEqual(["drafting-profile", "personal-tone-of-voice"]);
  });

  it("leaves unrelated custom allowlists unchanged", async () => {
    const { workspaceDir, bundledSkillsDir } = await createBundledFixture([
      "custom-skill",
      "message-drafting",
      "personal-tone-of-voice",
    ]);
    const config: OpenClawConfig = { skills: { allowBundled: ["custom-skill"] } };

    expect(resolveBundledAllowlist(config)).toEqual(["custom-skill"]);

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config,
    });
    expect(prompt).toContain("<name>custom-skill</name>");
    expect(prompt).not.toContain("<name>message-drafting</name>");
    expect(prompt).not.toContain("<name>personal-tone-of-voice</name>");
  });

  it("keeps the __none__ sentinel restrictive", () => {
    const config: OpenClawConfig = {
      skills: { allowBundled: ["__none__", "wacli"] },
    };

    expect(resolveBundledAllowlist(config)).toEqual(["__none__", "wacli"]);
    expect(shouldIncludeSkill({ entry: makeBundledEntry("wacli"), config })).toBe(false);
    expect(shouldIncludeSkill({ entry: makeBundledEntry("message-drafting"), config })).toBe(false);
    expect(shouldIncludeSkill({ entry: makeBundledEntry("personal-tone-of-voice"), config })).toBe(
      false,
    );
  });
});
