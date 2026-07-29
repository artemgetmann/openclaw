import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updateSessionStore } from "../config/sessions/store.js";
import {
  claimMonitorAuthorityAction,
  createMonitorAuthorityGrant,
  finalizeMonitorAuthorityAction,
  revokeMonitorAuthorityGrant,
} from "./authority.js";
import { createMonitorRecord, loadMonitorStore, saveMonitorStore } from "./store.js";
import {
  CODEX_THREAD_UNARCHIVE_RESUME_ACTION,
  type MonitorAuthorityGrant,
  type MonitorRecord,
} from "./types.js";

const tempDirs: string[] = [];
const monitorSessionKey = "agent:main:monitor:release";
const threadId = "thread-release-proof";
const prompt = "The release is available. Run the deferred verification now.";
const idempotencyKey = "release-2026-08-01:thread-release-proof";

function approvedGrant(nowMs = 1_000) {
  return {
    purposeKey: "mac-release:verify-mounted-login-item-fix",
    action: {
      kind: CODEX_THREAD_UNARCHIVE_RESUME_ACTION,
      threadId,
      prompt,
    },
    idempotencyKey,
    expiresAt: new Date(nowMs + 60_000).toISOString(),
    stopCondition: "Stop after the exact Codex continuation is accepted once.",
    maxExecutions: 1 as const,
  };
}

function authority(nowMs = 1_000): MonitorAuthorityGrant {
  const approved = approvedGrant(nowMs);
  return createMonitorAuthorityGrant({
    input: {
      purposeKey: approved.purposeKey,
      action: approved.action,
      idempotencyKey: approved.idempotencyKey,
      expiresAt: approved.expiresAt,
      stopCondition: approved.stopCondition,
    },
    goal: {
      id: "goal-release",
      objective: "Verify the mounted-volume fix in the next Mac release.",
      autonomy: {
        level: "act_within_scope",
        allowedActions: [CODEX_THREAD_UNARCHIVE_RESUME_ACTION],
        approvalRequired: ["Any other Codex thread or prompt."],
        authorityGrants: [approved],
      },
    },
    nowMs,
  });
}

async function createStore(overrides: Partial<MonitorRecord> = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-monitor-authority-"));
  tempDirs.push(dir);
  const storePath = path.join(dir, "monitors.json");
  const sessionStorePath = path.join(dir, "sessions.json");
  const grant = overrides.authority ?? authority();
  const goalAuthorityGrant = {
    purposeKey: grant.purposeKey,
    action: grant.action,
    idempotencyKey: grant.idempotencyKey,
    expiresAt: grant.expiresAt,
    stopCondition: grant.stopCondition,
    maxExecutions: grant.maxExecutions,
  };
  await updateSessionStore(sessionStorePath, (store) => {
    store["agent:main:telegram:direct:owner"] = {
      sessionId: "origin-session",
      updatedAt: 1_000,
      goal: {
        schemaVersion: 1,
        id: "goal-release",
        objective: "Verify the mounted-volume fix in the next Mac release.",
        status: "active",
        createdAt: 1_000,
        updatedAt: 1_000,
        tokenStart: 0,
        tokensUsed: 0,
        continuationTurns: 0,
        autonomy: {
          level: "act_within_scope",
          allowedActions: [CODEX_THREAD_UNARCHIVE_RESUME_ACTION],
          authorityGrants: [goalAuthorityGrant],
        },
      },
    };
  });
  const monitor = createMonitorRecord(
    {
      monitorId: "monitor-release",
      agentId: "main",
      instructions: "Watch for the next Mac release, then resume the exact verification thread.",
      originSessionKey: "agent:main:telegram:direct:owner",
      monitorSessionKey,
      sourceType: "github-release",
      sourceTarget: { repo: "artemgetmann/openclaw", channel: "mac" },
      cadence: { kind: "every", everyMs: 300_000 },
      stopCondition: grant.stopCondition,
      expiryAt: grant.expiresAt,
      actionPolicy: "notify_only",
      goal: {
        id: grant.goalId,
        objective: "Verify the mounted-volume fix in the next Mac release.",
        autonomy: {
          level: "act_within_scope",
          allowedActions: [CODEX_THREAD_UNARCHIVE_RESUME_ACTION],
          authorityGrants: [goalAuthorityGrant],
        },
      },
      authority: grant,
      cronJobId: "cron-release",
    },
    1_000,
  );
  await saveMonitorStore(storePath, {
    version: 1,
    monitors: [{ ...monitor, ...overrides }],
  });
  return { storePath, sessionStorePath };
}

type TestStore = Awaited<ReturnType<typeof createStore>>;

async function claim(
  store: TestStore,
  overrides: {
    threadId?: string;
    prompt?: string;
    idempotencyKey?: string;
    nowMs?: number;
  } = {},
) {
  return await claimMonitorAuthorityAction({
    storePath: store.storePath,
    sessionStorePath: store.sessionStorePath,
    monitorSessionKey,
    threadId,
    prompt,
    idempotencyKey,
    nowMs: 2_000,
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => await fs.promises.rm(dir, { recursive: true })),
  );
});

describe("durable monitor authority", () => {
  it("requires an active goal with the exact typed target and prompt grant", () => {
    expect(() =>
      createMonitorAuthorityGrant({
        input: {
          purposeKey: "release-proof",
          action: { kind: CODEX_THREAD_UNARCHIVE_RESUME_ACTION, threadId, prompt },
          idempotencyKey,
          expiresAt: "2026-08-01T00:00:00.000Z",
          stopCondition: "Resume once.",
        },
        goal: {
          id: "goal-1",
          objective: "Verify release.",
          autonomy: {
            level: "act_within_scope",
            allowedActions: [CODEX_THREAD_UNARCHIVE_RESUME_ACTION],
          },
        },
        nowMs: 1,
      }),
    ).toThrow(`exact approved ${CODEX_THREAD_UNARCHIVE_RESUME_ACTION} grant`);
  });

  it("rejects a monitor grant whose thread or prompt differs from persisted goal approval", () => {
    const approved = approvedGrant();
    expect(() =>
      createMonitorAuthorityGrant({
        input: {
          purposeKey: approved.purposeKey,
          action: { ...approved.action, threadId: "other-thread" },
          idempotencyKey: approved.idempotencyKey,
          expiresAt: approved.expiresAt,
          stopCondition: approved.stopCondition,
        },
        goal: {
          id: "goal-1",
          objective: "Verify release.",
          autonomy: { level: "act_within_scope", authorityGrants: [approved] },
        },
        nowMs: 1_000,
      }),
    ).toThrow(`exact approved ${CODEX_THREAD_UNARCHIVE_RESUME_ACTION} grant`);

    expect(() =>
      createMonitorAuthorityGrant({
        input: {
          purposeKey: approved.purposeKey,
          action: { ...approved.action, prompt: "Run different work." },
          idempotencyKey: approved.idempotencyKey,
          expiresAt: approved.expiresAt,
          stopCondition: approved.stopCondition,
        },
        goal: {
          id: "goal-1",
          objective: "Verify release.",
          autonomy: { level: "act_within_scope", authorityGrants: [approved] },
        },
        nowMs: 1_000,
      }),
    ).toThrow(`exact approved ${CODEX_THREAD_UNARCHIVE_RESUME_ACTION} grant`);
  });

  it("rejects a wrong thread, prompt, or idempotency key without consuming authority", async () => {
    const store = await createStore();

    await expect(claim(store, { threadId: "other-thread" })).rejects.toThrow(
      "target does not match",
    );
    await expect(claim(store, { prompt: "different work" })).rejects.toThrow(
      "prompt does not match",
    );
    await expect(claim(store, { idempotencyKey: "different-key" })).rejects.toThrow(
      "idempotency key does not match",
    );

    expect((await loadMonitorStore(store.storePath)).monitors[0]?.authority?.execution).toEqual({
      status: "available",
      executions: 0,
    });
  });

  it("persists consumption before mutation and makes restart/retry a no-op", async () => {
    const store = await createStore();

    await expect(claim(store)).resolves.toMatchObject({
      execute: true,
      status: "consumed",
    });
    const afterClaim = await loadMonitorStore(store.storePath);
    expect(afterClaim.monitors[0]).toMatchObject({
      status: "stopped",
      authority: {
        execution: { status: "consumed", executions: 1 },
      },
    });

    // Reloading from disk models a Gateway restart between claim and external
    // mutation. The exact retry observes consumed state and cannot run twice.
    await expect(claim(store)).resolves.toMatchObject({
      execute: false,
      status: "consumed",
    });
  });

  it("records successful completion and keeps later retries non-executing", async () => {
    const store = await createStore();
    const claimed = await claim(store);

    await expect(
      finalizeMonitorAuthorityAction({
        storePath: store.storePath,
        monitorSessionKey,
        grantId: claimed.grantId,
        outcome: "completed",
        externalRef: "turn-1",
        nowMs: 3_000,
      }),
    ).resolves.toMatchObject({
      execution: {
        status: "completed",
        executions: 1,
        externalRef: "turn-1",
      },
    });
    await expect(claim(store)).resolves.toMatchObject({
      execute: false,
      status: "completed",
    });
    expect((await loadMonitorStore(store.storePath)).monitors[0]?.status).toBe("completed");
  });

  it("records terminal failure without restoring reusable authority", async () => {
    const store = await createStore();
    const claimed = await claim(store);

    await finalizeMonitorAuthorityAction({
      storePath: store.storePath,
      monitorSessionKey,
      grantId: claimed.grantId,
      outcome: "failed",
      error: "thread unavailable",
      nowMs: 3_000,
    });

    await expect(claim(store)).resolves.toMatchObject({
      execute: false,
      status: "failed",
    });
    expect((await loadMonitorStore(store.storePath)).monitors[0]).toMatchObject({
      status: "stopped",
      authority: {
        execution: { status: "failed", executions: 1, error: "thread unavailable" },
      },
    });
  });

  it("fails closed for expired and revoked grants", async () => {
    const expiredGrant = authority();
    expiredGrant.expiresAt = new Date(1_500).toISOString();
    const expired = await createStore({ authority: expiredGrant });
    await expect(claim(expired)).rejects.toThrow("authority expired");
    expect((await loadMonitorStore(expired.storePath)).monitors[0]?.status).toBe("expired");

    const revokedGrant = authority();
    revokedGrant.revokedAtMs = 1_500;
    revokedGrant.audit.push({ event: "revoked", atMs: 1_500 });
    const revoked = await createStore({ authority: revokedGrant });
    await expect(claim(revoked)).rejects.toThrow("authority revoked");
    expect((await loadMonitorStore(revoked.storePath)).monitors[0]?.status).toBe("stopped");
  });

  it("rechecks the persisted goal immediately before consumption", async () => {
    const store = await createStore();
    await updateSessionStore(store.sessionStorePath, (sessions) => {
      const entry = sessions["agent:main:telegram:direct:owner"];
      if (entry?.goal) {
        entry.goal.status = "complete";
        entry.goal.completedAt = 1_500;
      }
    });

    await expect(claim(store)).rejects.toThrow("bound goal is no longer active or authorized");
    expect((await loadMonitorStore(store.storePath)).monitors[0]).toMatchObject({
      status: "stopped",
      authority: {
        revokedAtMs: 2_000,
        execution: { status: "failed", executions: 0 },
      },
    });
  });

  it("rechecks the persisted goal autonomy immediately before consumption", async () => {
    const store = await createStore();
    await updateSessionStore(store.sessionStorePath, (sessions) => {
      const entry = sessions["agent:main:telegram:direct:owner"];
      if (entry?.goal) {
        entry.goal.autonomy = { level: "observe_only" };
      }
    });

    await expect(claim(store)).rejects.toThrow("bound goal is no longer active or authorized");
    expect((await loadMonitorStore(store.storePath)).monitors[0]).toMatchObject({
      status: "stopped",
      authority: {
        revokedAtMs: 2_000,
        execution: { status: "failed", executions: 0 },
      },
    });
  });

  it("turns monitor stop into durable revocation before execution", () => {
    expect(revokeMonitorAuthorityGrant(authority(), 1_500)).toMatchObject({
      revokedAtMs: 1_500,
      execution: {
        status: "failed",
        executions: 0,
        error: "monitor stopped by user",
      },
      audit: [
        { event: "granted" },
        { event: "revoked", atMs: 1_500, reason: "monitor stopped by user" },
      ],
    });
  });
});
