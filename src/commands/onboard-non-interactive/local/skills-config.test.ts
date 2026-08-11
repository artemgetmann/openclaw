import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeSkill } from "../../../agents/skills.e2e-test-helpers.js";
import { buildWorkspaceSkillsPrompt } from "../../../agents/skills.js";
import { shouldIncludeSkill } from "../../../agents/skills/config.js";
import type { SkillEntry } from "../../../agents/skills/types.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";

vi.mock("../../onboard-shared-skills-root.js", () => ({
  ensureSharedPersonalSkillsManagedRoot: vi.fn(),
}));

import {
  applyNonInteractiveSkillsConfig,
  buildConsumerBundledSkillAllowlist,
  CONSUMER_DEFAULT_BUNDLED_SKILLS,
  repairConsumerDefaultBundledSkillAllowlist,
} from "./skills-config.js";

const runtime = {
  error: vi.fn(),
  exit: vi.fn(),
} as unknown as RuntimeEnv;

const jarvisComputerUseEntry: SkillEntry = {
  skill: {
    name: "jarvis-computer-use",
    description: "Jarvis Computer Use",
    filePath: "/bundled/jarvis-computer-use/SKILL.md",
    baseDir: "/bundled/jarvis-computer-use",
    source: "openclaw-bundled",
    disableModelInvocation: false,
  },
  frontmatter: {},
};

function apply(nextConfig: OpenClawConfig, opts: Partial<OnboardOptions> = {}) {
  return applyNonInteractiveSkillsConfig({
    nextConfig,
    opts: opts as OnboardOptions,
    runtime,
  });
}

describe("applyNonInteractiveSkillsConfig", () => {
  it("adds broad consumer bundled skill defaults for fresh configs", () => {
    const next = apply({});

    expect(next.skills?.allowBundled).toEqual([...CONSUMER_DEFAULT_BUNDLED_SKILLS]);
    expect(next.skills?.allowBundled).toEqual(
      expect.arrayContaining([
        "consumer-setup",
        "timezone-preference-updater",
        "checkpoint",
        "goal-mode",
        "monitor-router",
        "message-drafting",
        "personal-tone-of-voice",
        "media-editor",
        "video-frames",
        "jarvis-computer-use",
        "screen-record",
        "find-food",
        "mcporter",
        "nano-banana-pro",
        "telegram-user",
        "telegram-chat-management",
        "nano-pdf",
        "what-can-you-do",
        "heartbeat-preference-updater",
        "skill-creator",
        "session-logs",
      ]),
    );
  });

  it("repairs stale bundled skill allowlists while preserving existing order", () => {
    const next = apply({ skills: { allowBundled: ["custom-skill", "checkpoint"] } });

    expect(next.skills?.allowBundled?.slice(0, 2)).toEqual(["custom-skill", "checkpoint"]);
    expect(next.skills?.allowBundled).toEqual([
      "custom-skill",
      "checkpoint",
      ...CONSUMER_DEFAULT_BUNDLED_SKILLS.filter((skillName) => skillName !== "checkpoint"),
    ]);
  });

  it("preserves explicit bundled skill disable sentinels", () => {
    const next = apply({ skills: { allowBundled: ["__none__"] } });

    expect(next.skills?.allowBundled).toEqual(["__none__"]);
  });

  it("does not add explicitly disabled bundled skills during repair", () => {
    const next = apply({
      skills: {
        allowBundled: ["custom-skill"],
        entries: {
          checkpoint: { enabled: false },
          "timezone-preference-updater": { enabled: false },
        },
      },
    });

    expect(next.skills?.allowBundled).toEqual([
      "custom-skill",
      ...CONSUMER_DEFAULT_BUNDLED_SKILLS.filter(
        (skillName) => skillName !== "checkpoint" && skillName !== "timezone-preference-updater",
      ),
    ]);
  });

  it("keeps fresh defaults exact except explicitly disabled bundled skills", () => {
    const next = apply({
      skills: {
        entries: {
          "monitor-router": { enabled: false },
        },
      },
    });

    expect(next.skills?.allowBundled).toEqual(
      CONSUMER_DEFAULT_BUNDLED_SKILLS.filter((skillName) => skillName !== "monitor-router"),
    );
    expect(next.skills?.allowBundled).toContain("timezone-preference-updater");
  });

  it("returns a mutable consumer bundled skill allowlist", () => {
    const allowlist = buildConsumerBundledSkillAllowlist({});

    allowlist.push("workspace-only");

    expect(allowlist).toEqual([...CONSUMER_DEFAULT_BUNDLED_SKILLS, "workspace-only"]);
    expect(CONSUMER_DEFAULT_BUNDLED_SKILLS).not.toContain("workspace-only");
  });

  it("repairs legacy generated consumer allowlists with newly bundled defaults", () => {
    const legacyGeneratedAllowlist = [
      "consumer-setup",
      "timezone-preference-updater",
      "apple-notes",
      "apple-reminders",
      "peekaboo",
      "summarize",
      "weather",
      "wacli",
      "mcporter",
      "nano-banana-pro",
      "telegram-user",
    ];

    const repaired = repairConsumerDefaultBundledSkillAllowlist({
      skills: { allowBundled: legacyGeneratedAllowlist },
    });

    expect(repaired.changes).toEqual([
      expect.stringContaining("skills.allowBundled += checkpoint,goal-mode"),
    ]);
    expect(repaired.config.skills?.allowBundled?.indexOf("jarvis-computer-use")).toBe(
      (repaired.config.skills?.allowBundled?.indexOf("peekaboo") ?? 0) - 1,
    );
    expect(repaired.config.skills?.allowBundled?.indexOf("telegram-user")).toBeGreaterThan(
      repaired.config.skills?.allowBundled?.indexOf("nano-banana-pro") ?? -1,
    );
    expect(repaired.config.skills?.allowBundled).toEqual(
      expect.arrayContaining([
        "checkpoint",
        "goal-mode",
        "monitor-router",
        "find-food",
        "jarvis-computer-use",
        "what-can-you-do",
        "heartbeat-preference-updater",
        "skill-creator",
        "session-logs",
      ]),
    );
    expect(repaired.config.skills?.allowBundled?.indexOf("find-food")).toBe(
      (repaired.config.skills?.allowBundled?.indexOf("goplaces") ?? 0) + 1,
    );
  });

  it("renames legacy Jarvis GUI Control allowlist entries without widening custom allowlists", () => {
    const repaired = repairConsumerDefaultBundledSkillAllowlist({
      skills: { allowBundled: ["jarvis-gui-control"] },
    });

    expect(repaired.changes).toEqual([
      "skills.allowBundled renamed jarvis-gui-control->jarvis-computer-use",
    ]);
    expect(repaired.config.skills?.allowBundled).toEqual(["jarvis-computer-use"]);
  });

  it("deduplicates old and new Jarvis Computer Use allowlist entries", () => {
    const repaired = repairConsumerDefaultBundledSkillAllowlist({
      skills: { allowBundled: ["peekaboo", "jarvis-gui-control", "jarvis-computer-use"] },
    });

    expect(repaired.config.skills?.allowBundled).toEqual(["peekaboo", "jarvis-computer-use"]);
  });

  it("migrates a legacy opt-out into the config key enforced by the skill loader", () => {
    const legacyOptOut: OpenClawConfig = {
      skills: {
        entries: {
          "jarvis-gui-control": {
            enabled: false,
            env: { LEGACY_TOKEN: "preserved" },
          },
        },
      },
    };

    const next = apply(legacyOptOut);

    expect(next.skills?.entries?.["jarvis-gui-control"]).toBeUndefined();
    expect(next.skills?.entries?.["jarvis-computer-use"]).toEqual({
      enabled: false,
      env: { LEGACY_TOKEN: "preserved" },
    });
    expect(shouldIncludeSkill({ entry: jarvisComputerUseEntry, config: next })).toBe(false);
  });

  it("lets explicit false win while merging legacy and current skill entry fields", () => {
    const repaired = repairConsumerDefaultBundledSkillAllowlist({
      skills: {
        allowBundled: [],
        entries: {
          "jarvis-gui-control": {
            enabled: false,
            env: { LEGACY_ONLY: "legacy", SHARED: "legacy" },
            config: { legacyOnly: true, shared: "legacy" },
          },
          "jarvis-computer-use": {
            enabled: true,
            env: { CURRENT_ONLY: "current", SHARED: "current" },
            config: { currentOnly: true, shared: "current" },
          },
        },
      },
    });

    expect(repaired.config.skills?.entries?.["jarvis-gui-control"]).toBeUndefined();
    expect(repaired.config.skills?.allowBundled).toEqual([]);
    expect(repaired.config.skills?.entries?.["jarvis-computer-use"]).toEqual({
      enabled: false,
      env: {
        LEGACY_ONLY: "legacy",
        CURRENT_ONLY: "current",
        SHARED: "current",
      },
      config: {
        legacyOnly: true,
        currentOnly: true,
        shared: "current",
      },
    });
    expect(shouldIncludeSkill({ entry: jarvisComputerUseEntry, config: repaired.config })).toBe(
      false,
    );
  });

  it("leaves the __none__ sentinel and legacy entries untouched during repair", () => {
    const config: OpenClawConfig = {
      skills: {
        allowBundled: ["__none__"],
        entries: { "jarvis-gui-control": { enabled: false } },
      },
    };

    const repaired = repairConsumerDefaultBundledSkillAllowlist(config);

    expect(repaired).toEqual({ config, changes: [] });
    expect(repaired.config).toBe(config);
  });

  it("does not repair custom bundled skill allowlists", () => {
    const repaired = repairConsumerDefaultBundledSkillAllowlist({
      skills: { allowBundled: ["custom-skill", "checkpoint"] },
    });

    expect(repaired.changes).toEqual([]);
    expect(repaired.config.skills?.allowBundled).toEqual(["custom-skill", "checkpoint"]);
  });

  it("preserves explicit opt-outs while adding new consumer defaults", () => {
    const next = apply({
      skills: {
        entries: {
          "what-can-you-do": { enabled: false },
          "session-logs": { enabled: false },
        },
      },
    });

    expect(next.skills?.allowBundled).not.toContain("what-can-you-do");
    expect(next.skills?.allowBundled).not.toContain("session-logs");
    expect(next.skills?.allowBundled).toEqual(
      expect.arrayContaining(["heartbeat-preference-updater", "skill-creator"]),
    );
  });

  it("exposes default operator skills to fresh consumer prompts without a model call", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-consumer-skills-"));
    const bundledDir = path.join(workspaceDir, ".bundled");

    await writeSkill({
      dir: path.join(bundledDir, "checkpoint"),
      name: "checkpoint",
      description: "Save or resume a local chat checkpoint.",
      body: "# Checkpoint\n",
    });
    await writeSkill({
      dir: path.join(bundledDir, "goal-mode"),
      name: "goal-mode",
      description: "Use when Jarvis should offer or run a durable goal.",
      body: "# Goal Mode\n",
    });
    await writeSkill({
      dir: path.join(bundledDir, "monitor-router"),
      name: "monitor-router",
      description: "Route monitor status questions and natural-language follow-ups.",
      body: "# Monitor Router\n",
    });
    await writeSkill({
      dir: path.join(bundledDir, "message-drafting"),
      name: "message-drafting",
      description: "Compose approval-ready recipient-facing messages.",
      body: "# Message Drafting\n",
    });
    await writeSkill({
      dir: path.join(bundledDir, "personal-tone-of-voice"),
      name: "personal-tone-of-voice",
      description: "Set up and apply a personal writing voice to external drafts.",
      body: "# Personal Tone of Voice\n",
    });
    await writeSkill({
      dir: path.join(bundledDir, "jarvis-computer-use"),
      name: "jarvis-computer-use",
      description: "Use for Jarvis Computer Use tasks and GUI proof requests.",
      body: "# Jarvis Computer Use\n",
    });
    await writeSkill({
      dir: path.join(bundledDir, "telegram-chat-management"),
      name: "telegram-chat-management",
      description: "Manage Telegram chats, topics, threads, handoffs, and send-as-me flows.",
      body: "# Telegram Chat Management\n",
    });

    const next = apply({});
    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir: bundledDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: next,
    });

    expect(prompt).toContain("Save or resume a local chat checkpoint.");
    expect(prompt).toContain("offer or run a durable goal");
    expect(prompt).toContain("Route monitor status questions");
    expect(prompt).toContain("<name>message-drafting</name>");
    expect(prompt).toContain("Compose approval-ready recipient-facing messages.");
    expect(prompt).toContain("<name>personal-tone-of-voice</name>");
    expect(prompt).toContain("apply a personal writing voice");
    expect(prompt).toContain("Jarvis Computer Use tasks");
    expect(prompt).toContain("Manage Telegram chats, topics, threads");
  });
});
