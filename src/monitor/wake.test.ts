import { describe, expect, it } from "vitest";
import { buildMonitorWakeMessage } from "./wake.js";

describe("buildMonitorWakeMessage", () => {
  it("tells the waking agent to treat checkpoint data as baseline instead of final authority", () => {
    const message = buildMonitorWakeMessage({
      nowIso: "2026-04-10T04:30:13.436Z",
      wakeReason: "cron:test",
      monitor: {
        monitorId: "monitor-1",
        agentId: "main",
        originSessionKey: "agent:main:main",
        monitorSessionKey: "agent:main:monitor:monitor-1",
        sourceType: "gmail",
        sourceTarget: { account: "me@example.com", threadId: "thread-1" },
        cadence: { kind: "every", everyMs: 300_000 },
        stopCondition: "Stop when the thread is resolved.",
        actionPolicy: "notify_draft",
        status: "completed",
        lastCheckpoint: {
          resolved: true,
          latestInboundText: "Thanks, we're all set.",
        },
        cronJobId: "cron-1",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    });

    expect(message).toContain(
      "If fresh source inspection finds a new actionable change after an older resolved-looking checkpoint, keep the monitor active and continue the task.",
    );
    expect(message).toContain(
      "Do not keep or re-mark the monitor completed solely because older checkpoint data looked settled.",
    );
  });

  it("preserves the reopened-conversation regression contract for WhatsApp-like checkpoints", () => {
    const message = buildMonitorWakeMessage({
      nowIso: "2026-04-10T04:30:13.436Z",
      wakeReason: "cron:test",
      monitor: {
        monitorId: "monitor-2",
        agentId: "main",
        originSessionKey: "agent:main:main",
        monitorSessionKey: "agent:main:monitor:monitor-2",
        sourceType: "whatsapp",
        sourceTarget: { target: "+971507664706" },
        cadence: { kind: "every", everyMs: 300_000 },
        stopCondition: "Watch for new inbound and draft the next response.",
        actionPolicy: "notify_draft",
        status: "completed",
        lastCheckpoint: {
          negotiationComplete: true,
          latestInboundText: "Ok 8pm fine wtv",
        },
        cronJobId: "cron-2",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    });

    expect(message).toContain("Interpret lastCheckpoint as previous state, not final authority");
    expect(message).toContain(
      "If fresh source inspection finds a new actionable change after an older resolved-looking checkpoint, keep the monitor active and continue the task.",
    );
  });
});
