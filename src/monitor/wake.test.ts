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

  it("switches auto_send wakes into reply-only delivery guidance when watched-surface delivery is configured", () => {
    const message = buildMonitorWakeMessage({
      nowIso: "2026-04-10T04:30:13.436Z",
      wakeReason: "cron:test",
      watchDeliveryConfigured: true,
      monitor: {
        monitorId: "monitor-3",
        agentId: "main",
        originSessionKey: "agent:main:main",
        monitorSessionKey: "agent:main:monitor:monitor-3",
        sourceType: "whatsapp",
        sourceTarget: { target: "74333133234289@lid" },
        cadence: { kind: "every", everyMs: 300_000 },
        actionPolicy: "auto_send",
        status: "active",
        cronJobId: "cron-3",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    });

    expect(message).toContain(
      "Watched-surface delivery is authorized and configured for this wake.",
    );
    expect(message).toContain(
      "When the watched surface should be updated, prefer using the normal message tool against that watched target.",
    );
    expect(message).toContain(
      "If you intentionally do not use the message tool, return only the exact reply content to send on the watched surface.",
    );
    expect(message).toContain("return exactly NO_REPLY");
  });
});
