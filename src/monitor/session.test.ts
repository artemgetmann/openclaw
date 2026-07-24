import { describe, expect, it } from "vitest";
import { buildMonitorBootstrapPrompt } from "./session.js";

describe("monitor bootstrap contract", () => {
  it("requires the actual requested draft for notify_draft completion", () => {
    const prompt = buildMonitorBootstrapPrompt({
      instructions: "Quote the matching inbound text and draft the next response for approval.",
      sourceType: "whatsapp",
      sourceTarget: { target: "+971552857036" },
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "notify_draft",
      watchDeliveryConfigured: false,
      originSessionKey: "agent:main:telegram:group:-1003783709877:topic:21581",
    });

    expect(prompt).toContain("explicitly requires a draft");
    expect(prompt).toContain("must include the actual draft text");
    expect(prompt).toContain("status-only completion is incomplete");
  });

  it("does not impose a draft requirement on notify_only", () => {
    const prompt = buildMonitorBootstrapPrompt({
      instructions: "Report whether a matching reply arrived.",
      sourceType: "whatsapp",
      sourceTarget: { target: "+971552857036" },
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "notify_only",
      watchDeliveryConfigured: false,
      originSessionKey: "agent:main:main",
    });

    expect(prompt).not.toContain("status-only completion is incomplete");
  });

  it("requires fresh external confirmation before completing an external outcome", () => {
    const prompt = buildMonitorBootstrapPrompt({
      instructions: "Keep coordinating until the appointment is confirmed.",
      sourceType: "custom-service",
      sourceTarget: { thread: "appointment-1" },
      cadence: { kind: "every", everyMs: 300_000 },
      stopCondition: "The counterparty confirms the appointment.",
      actionPolicy: "auto_send",
      watchDeliveryConfigured: true,
      originSessionKey: "agent:main:main",
    });

    expect(prompt).toContain("require fresh external evidence confirming that outcome");
    expect(prompt).toContain(
      "Your own outbound proposal, acceptance, or follow-up is not evidence that the external outcome was achieved",
    );
  });

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

  it("guides WhatsApp auto_send monitors through one safe wacli send", () => {
    const prompt = buildMonitorBootstrapPrompt({
      instructions: "Coordinate the exact allowed dinner time with this friend.",
      sourceType: "whatsapp",
      sourceTarget: { target: "74333133234289@lid" },
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "auto_send",
      watchDeliveryConfigured: true,
      originSessionKey: "agent:main:telegram:direct:user-1",
    });

    expect(prompt).toContain("WhatsApp-as-me watched-surface delivery is authorized");
    expect(prompt).toContain("use the wacli skill/CLI");
    expect(prompt).toContain("safe-send helper");
    expect(prompt).toContain("After a successful WhatsApp-as-me send");
    expect(prompt).toContain("return exactly NO_REPLY");
  });
});
