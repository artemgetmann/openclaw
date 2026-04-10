import { describe, expect, it } from "vitest";
import { buildMonitorWakeMessage } from "./wake.js";

describe("buildMonitorWakeMessage", () => {
  it("tells the waking agent to reactivate on new actionable inbound after prior completion", () => {
    const message = buildMonitorWakeMessage({
      nowIso: "2026-04-10T04:30:13.436Z",
      wakeReason: "cron:test",
      monitor: {
        monitorId: "monitor-1",
        agentId: "main",
        originSessionKey: "agent:main:main",
        monitorSessionKey: "agent:main:monitor:monitor-1",
        sourceType: "whatsapp",
        sourceTarget: { target: "+971507664706" },
        cadence: { kind: "every", everyMs: 300_000 },
        stopCondition: "Stop when the WhatsApp negotiation E2E sequence is complete.",
        actionPolicy: "notify_draft",
        status: "active",
        lastCheckpoint: {
          negotiationComplete: true,
          latestInboundText: "Ok 8pm fine wtv",
        },
        cronJobId: "cron-1",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    });

    expect(message).toContain(
      "If fresh source inspection finds a new actionable inbound after an earlier completion marker, treat the monitor as active again and continue the task.",
    );
    expect(message).toContain(
      "Do not keep or re-mark the monitor completed solely because lastCheckpoint says an earlier negotiation was complete.",
    );
  });
});
