import { describe, expect, it } from "vitest";
import {
  createMonitorIdentityKey,
  createMonitorRecord,
  findActiveMonitorByIdentity,
} from "./store.js";
import type { MonitorRecord, MonitorStoreFile } from "./types.js";
import { CODEX_THREAD_UNARCHIVE_RESUME_ACTION } from "./types.js";

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
  it("stores a normalized operational disclosure and notification defaults", () => {
    const monitor = createMonitorRecord(
      {
        agentId: "main",
        instructions: "  Monitor the support thread and draft the next response.  ",
        originSessionKey: "agent:main:main",
        monitorSessionKey: "agent:main:monitor:new",
        purpose: "  Watch the support thread until resolved.  ",
        sourceType: "gmail",
        sourceTarget: { account: "me@example.com", threadId: "thread-1" },
        cadence: { kind: "every", everyMs: 300_000 },
        stopCondition: "Stop when support confirms resolution.",
        expiryAt: "2026-07-11T00:00:00.000Z",
        goal: { id: "goal-1", objective: "Resolve support." },
        cronJobId: "cron-new",
      },
      100,
    );

    expect(monitor).toMatchObject({
      instructions: "Monitor the support thread and draft the next response.",
      notificationPolicy: {
        unchangedNoticeAfterChecks: 3,
        unchangedReminderIntervalMs: 43_200_000,
      },
      notificationState: { consecutiveUnchangedChecks: 0 },
      disclosure: {
        purpose: "Watch the support thread until resolved.",
        checkCadence: { kind: "every", everyMs: 300_000 },
        noChangeCadence: { noticeAfterChecks: 3, reminderIntervalMs: 43_200_000 },
        expiryAt: "2026-07-11T00:00:00.000Z",
        stopCondition: "Stop when support confirms resolution.",
        autonomy: { level: "observe_only" },
        actionPolicy: "notify_draft",
      },
    });
  });

  it("keeps the short disclosure purpose separate from execution instructions", () => {
    const monitor = createMonitorRecord(
      {
        agentId: "main",
        instructions: "Draft the customer reply without sending it.",
        originSessionKey: "agent:main:main",
        monitorSessionKey: "agent:main:monitor:short-purpose",
        name: "Customer reply",
        purpose: "Customer reply",
        sourceType: "gmail",
        sourceTarget: { account: "me@example.com", threadId: "thread-1" },
        cadence: { kind: "every", everyMs: 300_000 },
        cronJobId: "cron-short-purpose",
      },
      100,
    );

    expect(monitor.name).toBe("Customer reply");
    expect(monitor.disclosure?.purpose).toBe("Customer reply");
  });

  it("discloses missing expiry and stop condition explicitly", () => {
    const monitor = createMonitorRecord(
      {
        agentId: "main",
        instructions: "Report whether the support reply arrives.",
        originSessionKey: "agent:main:main",
        monitorSessionKey: "agent:main:monitor:no-expiry",
        sourceType: "whatsapp",
        sourceTarget: { target: "support" },
        cadence: { kind: "every", everyMs: 60_000 },
        cronJobId: "cron-no-expiry",
      },
      100,
    );

    expect(monitor.disclosure).toMatchObject({
      expiryAt: null,
      stopCondition: null,
    });
  });

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

  it("dedupes durable authority by stable purpose and exact action scope, not display name", () => {
    const grant = {
      schemaVersion: 1 as const,
      grantId: "grant-1",
      goalId: "goal-1",
      purposeKey: "mac-release:verify-login-item-fix",
      action: {
        kind: CODEX_THREAD_UNARCHIVE_RESUME_ACTION,
        threadId: "thread-1",
        prompt: "Run the deferred proof.",
      },
      idempotencyKey: "release-1",
      expiresAt: "2026-08-01T00:00:00.000Z",
      stopCondition: "Resume once.",
      maxExecutions: 1 as const,
      grantedAtMs: 1,
      execution: { status: "available" as const, executions: 0 },
      audit: [{ event: "granted" as const, atMs: 1 }],
    };
    const first = createMonitorIdentityKey({
      agentId: "main",
      sourceType: "github-release",
      sourceTarget: { repo: "artemgetmann/openclaw", version: "next" },
      actionPolicy: "notify_only",
      purposeLabel: "Old display name",
      authority: grant,
    });
    const renamed = createMonitorIdentityKey({
      agentId: "main",
      sourceType: "rss",
      sourceTarget: { feed: "releases" },
      actionPolicy: "notify_draft",
      purposeLabel: "New display name",
      authority: {
        ...grant,
        grantId: "retry-created-grant",
        idempotencyKey: "caller-generated-retry-key",
      },
    });
    const otherThread = createMonitorIdentityKey({
      agentId: "main",
      sourceType: "github-release",
      sourceTarget: { repo: "artemgetmann/openclaw", version: "next" },
      authority: {
        ...grant,
        action: { ...grant.action, threadId: "thread-2" },
      },
    });

    expect(renamed).toBe(first);
    expect(otherThread).not.toBe(first);
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
