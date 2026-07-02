import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeSkill } from "../../../agents/skills.e2e-test-helpers.js";
import { buildWorkspaceSkillsPrompt } from "../../../agents/skills.js";
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
} from "./skills-config.js";

const runtime = {
  error: vi.fn(),
  exit: vi.fn(),
} as unknown as RuntimeEnv;

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
        "monitor-router",
        "jarvis-gui-control",
        "screen-record",
        "mcporter",
        "nano-banana-pro",
        "telegram-user",
        "telegram-chat-management",
        "nano-pdf",
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

  it("exposes checkpoint and monitor-router to fresh consumer skill prompts without a model call", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-consumer-skills-"));
    const bundledDir = path.join(workspaceDir, ".bundled");

    await writeSkill({
      dir: path.join(bundledDir, "checkpoint"),
      name: "checkpoint",
      description: "Save or resume a local chat checkpoint.",
      body: "# Checkpoint\n",
    });
    await writeSkill({
      dir: path.join(bundledDir, "monitor-router"),
      name: "monitor-router",
      description: "Route monitor status questions and natural-language follow-ups.",
      body: "# Monitor Router\n",
    });
    await writeSkill({
      dir: path.join(bundledDir, "jarvis-gui-control"),
      name: "jarvis-gui-control",
      description: "Use for Jarvis macOS GUI-control tasks and GUI proof requests.",
      body: "# Jarvis GUI Control\n",
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
    expect(prompt).toContain("Route monitor status questions");
    expect(prompt).toContain("Jarvis macOS GUI-control tasks");
    expect(prompt).toContain("Manage Telegram chats, topics, threads");
  });
});
