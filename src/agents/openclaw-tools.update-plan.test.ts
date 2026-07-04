import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

describe("OpenClaw update_plan registration", () => {
  it("registers update_plan in the OpenClaw-owned tool set", () => {
    const tools = createOpenClawTools();

    expect(tools.map((tool) => tool.name)).toContain("update_plan");
  });

  it("exposes update_plan through the PI-backed coding tool assembly", () => {
    const tools = createOpenClawCodingTools();

    expect(tools.map((tool) => tool.name)).toContain("update_plan");
  });
});
