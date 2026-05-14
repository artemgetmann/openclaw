import { describe, expect, it, vi } from "vitest";
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
});
