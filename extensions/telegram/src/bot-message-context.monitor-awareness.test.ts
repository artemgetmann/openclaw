import { describe, expect, it } from "vitest";
import type { MonitorRecord } from "../../../src/monitor/types.js";
import { buildTelegramMonitorAwarenessNote } from "./bot-message-context.session.js";

function monitor(overrides: Partial<MonitorRecord>): MonitorRecord {
  return {
    monitorId: "monitor-1",
    agentId: "main",
    name: "Chloe / Arte Mont Kiara",
    originSessionKey: "agent:main:telegram:direct:123",
    monitorSessionKey: "agent:main:monitor:monitor-1",
    sourceType: "whatsapp",
    sourceTarget: { contact: "Chloe", topic: "Arte Mont Kiara" },
    cadence: { kind: "at", at: "2099-01-01T00:00:00.000Z" },
    actionPolicy: "notify_draft",
    status: "active",
    lastCheckpoint: {
      summary: "Chloe replied that 25 days may be possible at RM2,800 all-in.",
      suggestedNextStep: "Ask for same-day viewing and confirm deposit and Wi-Fi.",
      rawRef: "artifact://wacli/chloe-arte",
    },
    cronJobId: "job-1",
    createdAtMs: 100,
    updatedAtMs: 200,
    ...overrides,
  };
}

describe("buildTelegramMonitorAwarenessNote", () => {
  it("adds compact active monitor context for the current Telegram session", () => {
    const note = buildTelegramMonitorAwarenessNote({
      sessionKey: "agent:main:telegram:direct:123",
      monitors: [monitor({})],
    });

    expect(note).toContain("[Active monitor context]");
    expect(note).toContain("Chloe / Arte Mont Kiara");
    expect(note).toContain("25 days may be possible");
    expect(note).toContain("Ask for same-day viewing");
  });

  it("ignores inactive monitors and monitors from other sessions", () => {
    const note = buildTelegramMonitorAwarenessNote({
      sessionKey: "agent:main:telegram:direct:123",
      monitors: [
        monitor({ status: "stopped" }),
        monitor({
          monitorId: "monitor-2",
          originSessionKey: "agent:main:telegram:direct:999",
        }),
      ],
    });

    expect(note).toBeUndefined();
  });
});
