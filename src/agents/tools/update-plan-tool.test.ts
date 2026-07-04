import { describe, expect, it } from "vitest";
import { createUpdatePlanTool } from "./update-plan-tool.js";

async function runUpdatePlan(args: Record<string, unknown>) {
  const tool = createUpdatePlanTool();
  return await tool.execute("call-update-plan", args);
}

describe("update_plan tool", () => {
  it("returns structured details without writing files or textual output", async () => {
    const result = await runUpdatePlan({
      explanation: "Starting implementation.",
      plan: [
        { step: "Inspect current tool assembly", status: "completed" },
        { step: "Add update_plan", status: "in_progress" },
        { step: "Validate registration", status: "pending" },
      ],
    });

    expect(result).toEqual({
      content: [],
      details: {
        status: "updated",
        explanation: "Starting implementation.",
        plan: [
          { step: "Inspect current tool assembly", status: "completed" },
          { step: "Add update_plan", status: "in_progress" },
          { step: "Validate registration", status: "pending" },
        ],
      },
    });
  });

  it("rejects an empty plan", async () => {
    await expect(runUpdatePlan({ plan: [] })).rejects.toThrow("plan required");
  });

  it("rejects invalid step statuses", async () => {
    await expect(
      runUpdatePlan({
        plan: [{ step: "Invent another state", status: "blocked" }],
      }),
    ).rejects.toThrow("plan[0].status must be one of pending, in_progress, completed");
  });

  it("rejects more than one in-progress step", async () => {
    await expect(
      runUpdatePlan({
        plan: [
          { step: "First active step", status: "in_progress" },
          { step: "Second active step", status: "in_progress" },
        ],
      }),
    ).rejects.toThrow("plan can contain at most one in_progress step");
  });
});
