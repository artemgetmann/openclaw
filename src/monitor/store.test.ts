import { describe, expect, it } from "vitest";
import { createMonitorIdentityKey, findActiveMonitorByIdentity } from "./store.js";
import type { MonitorRecord, MonitorStoreFile } from "./types.js";

function monitorRecord(overrides: Partial<MonitorRecord> = {}): MonitorRecord {
  return {
    monitorId: "monitor-1",
    agentId: "main",
    name: "Customer reply",
    originSessionKey: "agent:main:main",
    monitorSessionKey: "agent:main:monitor:monitor-1",
    sourceType: "gmail",
    sourceTarget: { account: "me@example.com", threadId: "thread-1" },
    cadence: { kind: "every", everyMs: 300_000 },
    actionPolicy: "notify_draft",
    status: "active",
    cronJobId: "cron-job-1",
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

describe("monitor store identity", () => {
  it("normalizes sourceTarget object key order", () => {
    const firstKey = createMonitorIdentityKey({
      agentId: "main",
      sourceType: "gmail",
      sourceTarget: {
        account: "me@example.com",
        thread: { id: "thread-1", label: "inbox" },
      },
      actionPolicy: "notify_draft",
      purposeLabel: "Customer reply",
    });
    const secondKey = createMonitorIdentityKey({
      agentId: "main",
      sourceType: "gmail",
      sourceTarget: {
        thread: { label: "inbox", id: "thread-1" },
        account: "me@example.com",
      },
      actionPolicy: "notify_draft",
      purposeLabel: "Customer reply",
    });

    expect(secondKey).toBe(firstKey);
  });

  it("does not match stopped monitor history as an active duplicate", () => {
    const store: MonitorStoreFile = {
      version: 1,
      monitors: [monitorRecord({ status: "stopped" })],
    };

    expect(
      findActiveMonitorByIdentity(store, {
        agentId: "main",
        sourceType: "gmail",
        sourceTarget: { threadId: "thread-1", account: "me@example.com" },
        actionPolicy: "notify_draft",
        purposeLabel: "Customer reply",
      }),
    ).toBeUndefined();
  });

  it("matches degraded monitors as the same active duplicate", () => {
    const store: MonitorStoreFile = {
      version: 1,
      monitors: [monitorRecord({ status: "degraded" })],
    };

    expect(
      findActiveMonitorByIdentity(store, {
        agentId: "main",
        sourceType: "gmail",
        sourceTarget: { threadId: "thread-1", account: "me@example.com" },
        actionPolicy: "notify_draft",
        purposeLabel: "Customer reply",
      }),
    ).toMatchObject({ monitorId: "monitor-1", status: "degraded" });
  });
});
