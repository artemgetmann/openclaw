import { describe, expect, it } from "vitest";
import { createGuiControlTool } from "./gui-control-tool.js";

describe("createGuiControlTool", () => {
  it("exposes secondary_action through the agent tool schema", () => {
    const tool = createGuiControlTool();
    const properties = tool.parameters.properties as Record<string, { enum?: string[] }>;

    expect(properties.action.enum).toContain("secondary_action");
    expect(Object.keys(properties)).toContain("secondaryAction");
  });
});
