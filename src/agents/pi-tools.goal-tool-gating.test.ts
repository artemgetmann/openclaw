import { describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

describe("goal tool gating", () => {
  it("omits session goal tools when the caller disables goal ownership", () => {
    const toolNames = createOpenClawCodingTools({
      senderIsOwner: true,
      disableGoalTools: true,
    }).map((tool) => tool.name);

    expect(toolNames).not.toContain("get_goal");
    expect(toolNames).not.toContain("create_goal");
    expect(toolNames).not.toContain("update_goal");
    expect(toolNames).toContain("monitor");
  });

  it("keeps session goal tools by default for normal owner sessions", () => {
    const toolNames = createOpenClawCodingTools({ senderIsOwner: true }).map((tool) => tool.name);

    expect(toolNames).toContain("get_goal");
    expect(toolNames).toContain("create_goal");
    expect(toolNames).toContain("update_goal");
  });
});
