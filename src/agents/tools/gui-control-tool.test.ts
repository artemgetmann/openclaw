import { describe, expect, it } from "vitest";
import { createGuiControlTool } from "./gui-control-tool.js";

describe("createGuiControlTool", () => {
  it("keeps secondary_action out of the agent tool until AgentDesktop supports it", () => {
    const tool = createGuiControlTool();
    const properties = tool.parameters.properties as Record<string, { enum?: string[] }>;

    expect(properties.action.enum).not.toContain("secondary_action");
    expect(Object.keys(properties)).not.toContain("secondaryAction");
  });

  it("keeps sensitive approval authority out of model-controlled parameters", () => {
    const tool = createGuiControlTool();
    const properties = tool.parameters.properties as Record<string, unknown>;

    expect(properties).toHaveProperty("approvedPolicyRisk");
    expect(properties).not.toHaveProperty("approvedSensitiveAction");
    expect(properties).not.toHaveProperty("approvedSensitiveScope");
    expect(properties).not.toHaveProperty("approvalId");
  });
});
