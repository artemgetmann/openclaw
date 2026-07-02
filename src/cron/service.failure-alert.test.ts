import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

type CronServiceParams = ConstructorParameters<typeof CronService>[0];
type SendCronFailureAlert = NonNullable<CronServiceParams["sendCronFailureAlert"]>;

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-failure-alert-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function createFailureAlertCron(params: {
  storePath: string;
  cronConfig?: CronServiceParams["cronConfig"];
  runIsolatedAgentJob: NonNullable<CronServiceParams["runIsolatedAgentJob"]>;
  runMonitorJob?: CronServiceParams["runMonitorJob"];
  sendCronFailureAlert: NonNullable<CronServiceParams["sendCronFailureAlert"]>;
}) {
  return new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    cronConfig: params.cronConfig,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: params.runIsolatedAgentJob,
    runMonitorJob: params.runMonitorJob,
    sendCronFailureAlert: params.sendCronFailureAlert,
  });
}

describe("CronService failure alerts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("alerts after configured consecutive failures and honors cooldown", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn<SendCronFailureAlert>(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "wrong model id",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 2,
          cooldownMs: 60_000,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "daily report",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: job.id }),
        channel: "telegram",
        to: "19098680",
        text: expect.stringContaining('Cron job "daily report" failed 2 times'),
      }),
    );

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Cron job "daily report" failed 4 times'),
      }),
    );

    cron.stop();
    await store.cleanup();
  });

  it("sends a sanitized first-failure alert for delivery-requested isolated agent jobs", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn<SendCronFailureAlert>(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "raw stack / provider key / internal path",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "Monitor Ten email replies",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run monitor" },
      delivery: { mode: "announce", channel: "telegram", to: "-1003783709877:topic:5335" },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: job.id }),
        channel: "telegram",
        to: "-1003783709877:topic:5335",
        mode: "announce",
        text: expect.stringContaining(
          'Cron job "Monitor Ten email replies" failed before it could complete.',
        ),
      }),
    );
    const alertPayload = sendCronFailureAlert.mock.calls[0]?.[0];
    expect(alertPayload?.text).not.toContain("raw stack / provider key / internal path");

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

    cron.stop();
    await store.cleanup();
  });

  it("sends a first-failure degraded alert for monitor auth failures and keeps retrying", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn<SendCronFailureAlert>(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
    }));
    const runMonitorJob = vi.fn(async () => ({
      status: "error" as const,
      error: "OAuth token refresh failed for openai-codex; provider returned refresh_token_reused.",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 2,
        },
      },
      runIsolatedAgentJob,
      runMonitorJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "Watch Trishnanda otitis externa medication advice",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "session:agent:main:monitor:e5993afc66a4a8dc8effcc4b",
      wakeMode: "next-heartbeat",
      payload: { kind: "monitorWake", monitorId: "e5993afc66a4a8dc8effcc4b" },
      delivery: { mode: "announce", channel: "telegram", to: "-1003783709877:topic:17607" },
    });

    await cron.run(job.id, "force");

    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: job.id }),
        channel: "telegram",
        to: "-1003783709877:topic:17607",
        mode: "announce",
        text: "Monitor degraded: auth expired; re-auth required. I will retry after re-auth.",
      }),
    );
    const updated = cron.getJob(job.id);
    expect(updated?.enabled).toBe(true);
    expect(updated?.state.lastErrorReason).toBe("auth_permanent");
    expect(updated?.state.nextRunAtMs).toEqual(expect.any(Number));

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

    cron.stop();
    await store.cleanup();
  });

  it("alerts once and disables orphaned monitorWake jobs when the monitor record is missing", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn<SendCronFailureAlert>(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
    }));
    const runMonitorJob = vi.fn(async () => ({
      status: "error" as const,
      error: "monitor not found: 427d252fd6f46b0dabd356f8",
      stopJob: true,
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 2,
        },
      },
      runIsolatedAgentJob,
      runMonitorJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "ApotekKU Pererenan ear drops media-aware reply",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "session:agent:main:monitor:427d252fd6f46b0dabd356f8",
      wakeMode: "next-heartbeat",
      payload: { kind: "monitorWake", monitorId: "427d252fd6f46b0dabd356f8" },
      delivery: { mode: "announce", channel: "telegram", to: "-1003783709877:topic:17607" },
    });

    await cron.run(job.id, "force");

    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: job.id }),
        channel: "telegram",
        to: "-1003783709877:topic:17607",
        mode: "announce",
        text: "Monitor degraded: monitor record is missing, so I stopped the orphaned schedule.",
      }),
    );
    const updated = cron.getJob(job.id);
    expect(updated?.enabled).toBe(false);
    expect(updated?.state.nextRunAtMs).toBeUndefined();
    expect(updated?.state.lastError).toBe("monitor not found: 427d252fd6f46b0dabd356f8");

    await cron.run(job.id, "due");
    expect(runMonitorJob).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

    cron.stop();
    await store.cleanup();
  });

  it("runs fallback after a raw model timeout payload and only sends sanitized alert when all attempts fail", async () => {
    const successStore = await makeStorePath();
    const failureStore = await makeStorePath();
    const successAlert = vi.fn(async () => undefined);
    const failureAlert = vi.fn<SendCronFailureAlert>(async () => undefined);
    const rawTimeout = "LLM request timed out.";

    const createFakeIsolatedRunner = (params: { fallbackSucceeds: boolean; attempts: string[] }) =>
      vi.fn(async () => {
        // Simulate the isolated cron agent's model fallback loop at the CronService
        // boundary: the primary attempt returns the raw fatal timeout payload,
        // then the fallback candidate either succeeds or exhausts the run.
        params.attempts.push("primary");
        params.attempts.push("fallback");
        if (params.fallbackSucceeds) {
          return {
            status: "ok" as const,
            summary: "fallback candidate completed",
            provider: "fallback-provider",
            model: "fallback-model",
          };
        }
        return {
          status: "error" as const,
          error: rawTimeout,
          provider: "fallback-provider",
          model: "fallback-model",
        };
      });

    const successAttempts: string[] = [];
    const failureAttempts: string[] = [];
    const successCron = createFailureAlertCron({
      storePath: successStore.storePath,
      runIsolatedAgentJob: createFakeIsolatedRunner({
        fallbackSucceeds: true,
        attempts: successAttempts,
      }),
      sendCronFailureAlert: successAlert,
    });
    const failureCron = createFailureAlertCron({
      storePath: failureStore.storePath,
      runIsolatedAgentJob: createFakeIsolatedRunner({
        fallbackSucceeds: false,
        attempts: failureAttempts,
      }),
      sendCronFailureAlert: failureAlert,
    });

    await successCron.start();
    await failureCron.start();
    try {
      const successJob = await successCron.add({
        name: "timeout fallback succeeds",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "run report" },
        delivery: { mode: "announce", channel: "telegram", to: "19098680" },
      });
      const failureJob = await failureCron.add({
        name: "timeout fallback fails",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "run report" },
        delivery: { mode: "announce", channel: "telegram", to: "19098680" },
      });

      await successCron.run(successJob.id, "force");
      expect(successAttempts).toEqual(["primary", "fallback"]);
      expect(successAlert).not.toHaveBeenCalled();
      expect(successCron.getJob(successJob.id)?.state.lastRunStatus).toBe("ok");

      await failureCron.run(failureJob.id, "force");
      expect(failureAttempts).toEqual(["primary", "fallback"]);
      expect(failureAlert).toHaveBeenCalledTimes(1);
      expect(failureAlert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: failureJob.id }),
          channel: "telegram",
          to: "19098680",
          mode: "announce",
          text: expect.stringContaining(
            'Cron job "timeout fallback fails" failed before it could complete.',
          ),
        }),
      );
      const failureAlertPayload = failureAlert.mock.calls[0]?.[0];
      expect(failureAlertPayload?.text).not.toContain(rawTimeout);
      expect(failureCron.getJob(failureJob.id)?.state.lastError).toBe(rawTimeout);
    } finally {
      successCron.stop();
      failureCron.stop();
      await successStore.cleanup();
      await failureStore.cleanup();
    }
  });

  it("does not send implicit first-failure alerts when explicitly disabled or delivery is off", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "provider timeout",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const disabledAlertJob = await cron.add({
      name: "disabled implicit alert",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run monitor" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
      failureAlert: false,
    });
    const noDeliveryJob = await cron.add({
      name: "no delivery",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run monitor" },
      delivery: { mode: "none" },
    });

    await cron.run(disabledAlertJob.id, "force");
    await cron.run(noDeliveryJob.id, "force");
    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });

  it("supports per-job failure alert override when global alerts are disabled", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "timeout",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: false,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "job with override",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      failureAlert: {
        after: 1,
        channel: "telegram",
        to: "12345",
        cooldownMs: 1,
      },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "12345",
      }),
    );

    cron.stop();
    await store.cleanup();
  });

  it("respects per-job failureAlert=false and suppresses alerts", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "auth error",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "disabled alert job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      failureAlert: false,
    });

    await cron.run(job.id, "force");
    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });

  it("threads failure alert mode/accountId and skips best-effort jobs", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "temporary upstream error",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "webhook",
          accountId: "global-account",
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const normalJob = await cron.add({
      name: "normal alert job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });
    const bestEffortJob = await cron.add({
      name: "best effort alert job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "19098680",
        bestEffort: true,
      },
    });

    await cron.run(normalJob.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "webhook",
        accountId: "global-account",
        to: undefined,
      }),
    );

    await cron.run(bestEffortJob.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

    cron.stop();
    await store.cleanup();
  });
});
