import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeSkill } from "../../../agents/skills.e2e-test-helpers.js";
import { buildWorkspaceSkillsPrompt } from "../../../agents/skills.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";
import {
  applyNonInteractiveSkillsConfig,
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
        "checkpoint",
        "monitor-router",
        "mcporter",
        "nano-banana-pro",
        "telegram-user",
        "nano-pdf",
      ]),
    );
  });

  it("preserves explicit bundled skill allowlists", () => {
    const next = apply({ skills: { allowBundled: ["__none__"] } });

    expect(next.skills?.allowBundled).toEqual(["__none__"]);
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

    const next = apply({});
    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir: bundledDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: next,
    });

    expect(prompt).toContain("Save or resume a local chat checkpoint.");
    expect(prompt).toContain("Route monitor status questions");
  });
});
