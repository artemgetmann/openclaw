import { describe, expect, it } from "vitest";
import { buildMonitorBootstrapPrompt } from "./session.js";

describe("monitor bootstrap contract", () => {
  it("preserves goal autonomy when watched-surface delivery is unavailable", () => {
    const prompt = buildMonitorBootstrapPrompt({
      instructions: "Keep the ticket moving.",
      sourceType: "custom-service",
      sourceTarget: { thread: "ticket-1" },
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "auto_send",
      goal: {
        id: "goal-1",
        objective: "Resolve the ticket.",
        autonomy: {
          level: "act_within_scope",
          allowedActions: ["use the service skill to post approved follow-ups"],
          approvalRequired: ["change the requested outcome"],
        },
      },
      watchDeliveryConfigured: false,
      originSessionKey: "agent:main:main",
    });

    expect(prompt).toContain("Goal autonomy: act_within_scope.");
    expect(prompt).toContain("Only the delivery adapter is unavailable");
    expect(prompt).toContain("Use an available normal tool or skill path");
    expect(prompt).toContain("preserve every approval-required boundary");
    expect(prompt).toContain("notificationEvent set to unchanged");
    expect(prompt).toContain("deadline_passed");
  });
});
