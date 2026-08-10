import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSessionGoal, updateSessionStore } from "../config/sessions.js";
import { disableActiveCronJob } from "../cron/active-runtime.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { loadMonitorStore, resolveMonitorStorePath } from "../monitor/store.js";

type FakeCronRunResult = {
  status: "ok" | "error";
  error?: string;
  summary?: string;
  outputText?: string;
  delivered?: boolean;
};

const {
  enqueueSystemEventMock,
  requestHeartbeatNowMock,
  loadConfigMock,
  fetchWithSsrFGuardMock,
  runCronIsolatedAgentTurnMock,
  syncOriginContextIntoMonitorMock,
  resolveMonitorTranscriptPathMock,
} = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  requestHeartbeatNowMock: vi.fn(),
  loadConfigMock: vi.fn(),
  fetchWithSsrFGuardMock: vi.fn(),
  runCronIsolatedAgentTurnMock: vi.fn<(params: unknown) => Promise<FakeCronRunResult>>(
    async () => ({
      status: "ok",
      summary: "ok",
    }),
  ),
  syncOriginContextIntoMonitorMock: vi.fn(async () => ({ ok: true as const, imported: 0 })),
  resolveMonitorTranscriptPathMock: vi.fn(() => "/tmp/origin.jsonl"),
}));

function enqueueSystemEvent(...args: unknown[]) {
  return enqueueSystemEventMock(...args);
}

function requestHeartbeatNow(...args: unknown[]) {
  return requestHeartbeatNowMock(...args);
}

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent,
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));

vi.mock("../monitor/context-sync.js", () => ({
  MONITOR_RESULT_IDEMPOTENCY_PREFIX: "monitor-result:",
  recordMonitorOriginSyncCursor: vi.fn(),
  resolveMonitorTranscriptPath: resolveMonitorTranscriptPathMock,
  syncOriginContextIntoMonitor: syncOriginContextIntoMonitorMock,
}));

import { buildGatewayCronService, formatCronFailureMessage } from "./server-cron.js";
import { monitorHandlers } from "./server-methods/monitor.js";

function createCronConfig(name: string): OpenClawConfig {
  const tmpDir = path.join(os.tmpdir(), `${name}-${Date.now()}`);
  return {
    session: {
      mainKey: "main",
    },
    cron: {
      store: path.join(tmpDir, "cron.json"),
    },
  } as OpenClawConfig;
}

describe("buildGatewayCronService", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
    runCronIsolatedAgentTurnMock.mockClear();
    syncOriginContextIntoMonitorMock.mockClear();
    resolveMonitorTranscriptPathMock.mockClear();
  });

  it("uses monitor terminology for monitorWake failure destinations", () => {
    expect(
      formatCronFailureMessage(
        {
          name: "Watch support replies",
          payload: { kind: "monitorWake", monitorId: "monitor-1" },
        },
        "source check timed out",
      ),
    ).toBe('Monitor "Watch support replies" failed: source check timed out');
    expect(
      formatCronFailureMessage(
        {
          name: "Daily report",
          payload: { kind: "agentTurn", message: "send report" },
        },
        "provider unavailable",
      ),
    ).toBe('Cron job "Daily report" failed: provider unavailable');
  });

  it("publishes the live scheduler seam for terminal monitor disablement", async () => {
    const cfg = createCronConfig("server-cron-active-runtime");
    loadConfigMock.mockReturnValue(cfg);
    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "terminal-monitor",
        enabled: true,
        schedule: { kind: "every", everyMs: 300_000 },
        sessionTarget: "session:agent:main:monitor:terminal",
        wakeMode: "now",
        payload: { kind: "monitorWake", monitorId: "monitor-terminal" },
      });

      await disableActiveCronJob(job.id);

      expect(state.cron.getJob(job.id)).toMatchObject({ enabled: false });
    } finally {
      state.cron.stop();
    }
  });

  it("routes main-target jobs to the scoped session for enqueue + wake", async () => {
    const cfg = createCronConfig("server-cron");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "canonicalize-session-key",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        sessionKey: "discord:channel:ops",
        payload: { kind: "systemEvent", text: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("blocks private webhook URLs via SSRF-guarded fetch", async () => {
    const cfg = createCronConfig("server-cron-ssrf");
    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockRejectedValue(
      new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
    );

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "ssrf-webhook-blocked",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: {
          mode: "webhook",
          to: "http://127.0.0.1:8080/cron-finished",
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "http://127.0.0.1:8080/cron-finished",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: expect.stringContaining('"action":"finished"'),
          signal: expect.any(AbortSignal),
        },
      });
    } finally {
      state.cron.stop();
    }
  });

  it("passes custom session targets through to isolated cron runs", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-custom-session-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "custom-session",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:project-alpha-monitor",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id }),
          sessionKey: "project-alpha-monitor",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("routes monitor wakes through the durable monitor session with manual reset semantics", async () => {
    const cfg = createCronConfig("server-cron-monitor");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    const monitorStorePath = path.join(path.dirname(cfg.cron!.store!), "monitors.json");
    await fs.mkdir(path.dirname(monitorStorePath), { recursive: true });
    await fs.writeFile(
      monitorStorePath,
      JSON.stringify({
        version: 1,
        monitors: [
          {
            monitorId: "monitor-1",
            agentId: "main",
            originSessionKey: "agent:main:telegram:direct:user-1",
            originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
            monitorSessionKey: "agent:main:monitor:monitor-1",
            sourceType: "gmail",
            sourceTarget: { account: "me@example.com", threadId: "thread-1" },
            cadence: { kind: "every", everyMs: 60_000 },
            actionPolicy: "notify_draft",
            status: "active",
            cronJobId: "cron-monitor-1",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
      "utf-8",
    );

    try {
      const job = await state.cron.add({
        name: "monitor wake",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:agent:main:monitor:monitor-1",
        wakeMode: "next-heartbeat",
        payload: { kind: "monitorWake", monitorId: "monitor-1" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          sessionKey: "agent:main:monitor:monitor-1",
          sessionDefaultResetMode: "manual",
          disableGoalTools: true,
          job: expect.objectContaining({
            sessionTarget: "session:agent:main:monitor:monitor-1",
            delivery: expect.objectContaining({
              mode: "announce",
              channel: "telegram",
              to: "user-1",
            }),
          }),
          message: expect.stringContaining("sourceType: gmail"),
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("preserves a goal-bound draft-only WhatsApp monitor through matched completion", async () => {
    const cfg = createCronConfig("server-cron-monitor-reply-regression");
    cfg.session = {
      ...cfg.session,
      store: path.join(path.dirname(cfg.cron!.store!), "sessions.json"),
    };
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    const originSessionKey = "agent:main:telegram:group:-1001234567890:topic:99";
    const canonicalOriginDelivery = {
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890:topic:99",
      accountId: "default",
    } as const;
    const watchedTarget = { target: "+15551234567", accountId: "personal" };
    const cadence = { kind: "every", everyMs: 300_000 } as const;
    const expiryAt = "2099-07-16T12:00:00.000Z";
    const instructions =
      "When the matching WhatsApp reply arrives, quote it and draft a concise confirmation for approval. Do not send it.";
    const enqueueRunSpy = vi.spyOn(state.cron, "enqueueRun");

    try {
      await updateSessionStore(cfg.session.store!, (store) => {
        store[originSessionKey] = { sessionId: "origin-session", updatedAt: 1 };
      });
      const goal = await createSessionGoal({
        sessionKey: originSessionKey,
        storePath: cfg.session.store!,
        objective: "Get the WhatsApp reply handled without sending before approval.",
        autonomy: {
          level: "act_within_scope",
          allowedActions: ["inspect the matching reply", "draft a response for approval"],
          approvalRequired: ["send the WhatsApp response"],
        },
      });

      const createRespond = vi.fn();
      await monitorHandlers["monitor.create"]({
        params: {
          instructions,
          agentId: "main",
          originSessionKey,
          // Creation must derive and persist the topic from the durable origin
          // session even when the transport supplies only the numeric chat.
          originDelivery: {
            mode: "announce",
            channel: "telegram",
            to: "-1001234567890",
            accountId: "default",
          },
          sourceType: "whatsapp",
          sourceTarget: watchedTarget,
          cadence,
          trigger: {
            kind: "local_listener",
            match: {
              sourceType: "whatsapp",
              sourceTarget: watchedTarget,
              matchKeys: ["target", "accountId"],
              eventTypes: ["message.created"],
            },
          },
          expiryAt,
          stopCondition: "A matching reply has been quoted and a draft is ready for approval.",
          actionPolicy: "notify_draft",
        },
        respond: createRespond as never,
        context: { cronStorePath: state.storePath, cron: state.cron } as never,
        client: null,
        req: { type: "req", id: "req-monitor-regression-create", method: "monitor.create" },
        isWebchatConnect: () => false,
      });

      expect(createRespond.mock.calls[0]?.[0]).toBe(true);
      const created = createRespond.mock.calls[0]?.[1] as
        | { monitorId: string; monitorSessionKey: string; cronJobId: string }
        | undefined;
      expect(created).toBeDefined();
      enqueueRunSpy.mockClear();

      const reloaded = await loadMonitorStore(
        resolveMonitorStorePath({ cronStorePath: state.storePath }),
      );
      expect(reloaded.monitors).toHaveLength(1);
      expect(reloaded.monitors[0]).toMatchObject({
        monitorId: created?.monitorId,
        monitorSessionKey: created?.monitorSessionKey,
        originSessionKey,
        originDelivery: canonicalOriginDelivery,
        instructions,
        sourceType: "whatsapp",
        sourceTarget: watchedTarget,
        cadence,
        expiryAt,
        actionPolicy: "notify_draft",
        goal: {
          id: goal.id,
          objective: goal.objective,
          autonomy: goal.autonomy,
        },
        status: "active",
      });
      expect(state.cron.getJob(created!.cronJobId)).toMatchObject({
        sessionTarget: `session:${created?.monitorSessionKey}`,
        delivery: canonicalOriginDelivery,
      });

      const nonmatchRespond = vi.fn();
      await monitorHandlers["monitor.routeEvent"]({
        params: {
          triggerKind: "local_listener",
          sourceType: "whatsapp",
          sourceTarget: { target: "+15550000000", accountId: "personal" },
          eventType: "message.created",
          idempotencyKey: "whatsapp:nonmatch:1",
          receivedAtMs: 1,
        },
        respond: nonmatchRespond as never,
        context: { cronStorePath: state.storePath, cron: state.cron } as never,
        client: null,
        req: {
          type: "req",
          id: "req-monitor-regression-nonmatch",
          method: "monitor.routeEvent",
        },
        isWebchatConnect: () => false,
      });

      expect(nonmatchRespond.mock.calls[0]?.[1]).toEqual({ matched: 0, wakes: [] });
      expect(enqueueRunSpy).not.toHaveBeenCalled();
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
      expect(
        (await loadMonitorStore(resolveMonitorStorePath({ cronStorePath: state.storePath })))
          .monitors[0]?.status,
      ).toBe("active");

      const completionRespond = vi.fn();
      runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
        // The runner is the mocked model/transport boundary. Its completion
        // uses the real gateway update path so terminal persistence and cron
        // shutdown remain part of this regression rather than test fixtures.
        await monitorHandlers["monitor.update"]({
          params: {
            monitorId: created!.monitorId,
            patch: {
              notificationEvent: "completion",
              lastCheckpoint: {
                evidence: "matching WhatsApp reply observed",
                draft: "Thanks for confirming. I will proceed as agreed.",
              },
            },
          },
          respond: completionRespond as never,
          context: { cronStorePath: state.storePath, cron: state.cron } as never,
          client: null,
          req: {
            type: "req",
            id: "req-monitor-regression-complete",
            method: "monitor.update",
          },
          isWebchatConnect: () => false,
        });
        return {
          status: "ok" as const,
          summary: "draft routed for approval",
          outputText: "Empower replied. Here is the draft for approval.",
          delivered: true,
        };
      });

      const matchRespond = vi.fn();
      await monitorHandlers["monitor.routeEvent"]({
        params: {
          triggerKind: "local_listener",
          sourceType: "whatsapp",
          sourceTarget: watchedTarget,
          eventType: "message.created",
          idempotencyKey: "whatsapp:match:2",
          receivedAtMs: 2,
        },
        respond: matchRespond as never,
        context: { cronStorePath: state.storePath, cron: state.cron } as never,
        client: null,
        req: {
          type: "req",
          id: "req-monitor-regression-match",
          method: "monitor.routeEvent",
        },
        isWebchatConnect: () => false,
      });

      expect(enqueueRunSpy).toHaveBeenCalledOnce();
      expect(enqueueRunSpy).toHaveBeenCalledWith(created?.cronJobId, "force");
      expect(matchRespond.mock.calls[0]?.[1]).toMatchObject({
        matched: 1,
        wakes: [
          {
            cronJobId: created?.cronJobId,
            monitorSessionKey: created?.monitorSessionKey,
            originSessionKey,
            originDelivery: canonicalOriginDelivery,
          },
        ],
      });

      await vi.waitFor(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledOnce());
      const wake = runCronIsolatedAgentTurnMock.mock.calls[0]?.[0] as
        | {
            sessionKey?: string;
            deliveryContract?: string;
            deliveryPromptMode?: string;
            message?: string;
            messageToolTarget?: unknown;
            job?: unknown;
          }
        | undefined;
      expect(wake).toMatchObject({
        sessionKey: created?.monitorSessionKey,
        deliveryContract: "cron-owned",
        deliveryPromptMode: "summary",
        job: {
          sessionTarget: `session:${created?.monitorSessionKey}`,
          delivery: canonicalOriginDelivery,
        },
      });
      expect(wake).not.toHaveProperty("messageToolTarget");
      expect(wake).toHaveProperty("deliveryContract", "cron-owned");
      expect(wake?.message).toContain("Authoritative original user task contract:");
      expect(wake?.message).toContain(instructions);
      expect(wake?.message).toContain(`goalId: ${goal.id}`);
      expect(wake?.message).toContain(`goalObjective: ${goal.objective}`);
      expect(wake?.message).toContain("must include the actual draft text");
      expect(wake?.message).toContain(`expiryAt: ${expiryAt}`);
      expect(syncOriginContextIntoMonitorMock).toHaveBeenCalledWith({
        cfg,
        monitor: expect.objectContaining({ monitorId: created?.monitorId, originSessionKey }),
        abortSignal: expect.any(AbortSignal),
      });
      expect(syncOriginContextIntoMonitorMock.mock.invocationCallOrder[0]).toBeLessThan(
        runCronIsolatedAgentTurnMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
      );
      expect(wake).toMatchObject({
        deliveryMirror: {
          agentId: "main",
          sessionKey: originSessionKey,
          idempotencyPrefix: `monitor-result:${created?.monitorId}:`,
        },
      });

      await vi.waitFor(async () => {
        const completed = await loadMonitorStore(
          resolveMonitorStorePath({ cronStorePath: state.storePath }),
        );
        expect(completed.monitors[0]).toMatchObject({
          status: "completed",
          lastWakeStatus: "completed",
          lastCheckpoint: {
            evidence: "matching WhatsApp reply observed",
            draft: "Thanks for confirming. I will proceed as agreed.",
          },
        });
        expect(state.cron.getJob(created!.cronJobId)?.enabled).toBe(false);
      });
      expect(completionRespond.mock.calls[0]?.[0]).toBe(true);
    } finally {
      enqueueRunSpy.mockRestore();
      state.cron.stop();
    }
  });

  it("marks monitor records degraded after runner errors and active again after recovery", async () => {
    const cfg = createCronConfig("server-cron-monitor-degraded");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    const monitorStorePath = path.join(path.dirname(cfg.cron!.store!), "monitors.json");
    await fs.mkdir(path.dirname(monitorStorePath), { recursive: true });
    await fs.writeFile(
      monitorStorePath,
      JSON.stringify({
        version: 1,
        monitors: [
          {
            monitorId: "monitor-degraded",
            agentId: "main",
            originSessionKey: "agent:main:telegram:direct:user-1",
            originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
            monitorSessionKey: "agent:main:monitor:monitor-degraded",
            sourceType: "gmail",
            sourceTarget: { account: "me@example.com", threadId: "thread-1" },
            cadence: { kind: "every", everyMs: 60_000 },
            actionPolicy: "notify_draft",
            status: "active",
            cronJobId: "cron-monitor-degraded",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
      "utf-8",
    );

    try {
      const job = await state.cron.add({
        name: "monitor wake degraded",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "session:agent:main:monitor:monitor-degraded",
        wakeMode: "next-heartbeat",
        payload: { kind: "monitorWake", monitorId: "monitor-degraded" },
      });

      runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
        status: "error",
        error:
          "OAuth token refresh failed for openai-codex; provider returned refresh_token_reused.",
      });
      await state.cron.run(job.id, "force");
      const degradedStore = JSON.parse(await fs.readFile(monitorStorePath, "utf-8")) as {
        monitors: Array<{ status: string; lastWakeStatus?: string }>;
      };
      expect(degradedStore.monitors[0]).toMatchObject({
        status: "degraded",
        lastWakeStatus: "degraded",
      });
      expect(state.cron.getJob(job.id)?.enabled).toBe(true);

      runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
        status: "ok",
        summary: "recovered",
      });
      await state.cron.run(job.id, "force");
      const recoveredStore = JSON.parse(await fs.readFile(monitorStorePath, "utf-8")) as {
        monitors: Array<{ status: string; lastWakeStatus?: string }>;
      };
      expect(recoveredStore.monitors[0]).toMatchObject({
        status: "active",
        lastWakeStatus: "active",
      });
    } finally {
      state.cron.stop();
    }
  });

  it("keeps goal tools available when a monitor wake is bound to an origin goal", async () => {
    const cfg = createCronConfig("server-cron-monitor-bound-goal-tools");
    cfg.session = {
      ...cfg.session,
      store: path.join(path.dirname(cfg.cron!.store!), "sessions.json"),
    };
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    const monitorStorePath = path.join(path.dirname(cfg.cron!.store!), "monitors.json");
    await fs.mkdir(path.dirname(monitorStorePath), { recursive: true });
    await fs.writeFile(
      cfg.session.store!,
      JSON.stringify({
        "agent:main:telegram:direct:user-1": {
          sessionId: "origin-session",
          updatedAt: 1,
          goal: {
            schemaVersion: 1,
            id: "goal-1",
            objective: "Get the refund confirmed.",
            status: "active",
            createdAt: 1,
            updatedAt: 1,
            tokenStart: 0,
            tokenStartFresh: true,
            tokensUsed: 0,
            continuationTurns: 0,
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      monitorStorePath,
      JSON.stringify({
        version: 1,
        monitors: [
          {
            monitorId: "monitor-bound-goal-tools",
            agentId: "main",
            originSessionKey: "agent:main:telegram:direct:user-1",
            originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
            monitorSessionKey: "agent:main:monitor:monitor-bound-goal-tools",
            sourceType: "gmail",
            sourceTarget: { account: "me@example.com", threadId: "thread-1" },
            cadence: { kind: "every", everyMs: 60_000 },
            actionPolicy: "notify_draft",
            goal: { id: "goal-1", objective: "Get the refund confirmed." },
            status: "active",
            cronJobId: "cron-monitor-bound-goal-tools",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
      "utf-8",
    );

    try {
      const job = await state.cron.add({
        name: "monitor wake bound goal tools",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:agent:main:monitor:monitor-bound-goal-tools",
        wakeMode: "next-heartbeat",
        payload: { kind: "monitorWake", monitorId: "monitor-bound-goal-tools" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:monitor:monitor-bound-goal-tools",
          disableGoalTools: false,
        }),
      );
      const sessions = JSON.parse(await fs.readFile(cfg.session.store!, "utf-8"));
      expect(sessions["agent:main:telegram:direct:user-1"].goal.continuationTurns).toBe(1);
    } finally {
      state.cron.stop();
    }
  });

  it("does not require channel delivery for CLI-origin monitor wakes", async () => {
    const cfg = createCronConfig("server-cron-monitor-cli");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    const monitorStorePath = path.join(path.dirname(cfg.cron!.store!), "monitors.json");
    await fs.mkdir(path.dirname(monitorStorePath), { recursive: true });
    await fs.writeFile(
      monitorStorePath,
      JSON.stringify({
        version: 1,
        monitors: [
          {
            monitorId: "monitor-cli",
            agentId: "main",
            originSessionKey: "agent:main:main",
            monitorSessionKey: "agent:main:monitor:monitor-cli",
            sourceType: "gmail",
            sourceTarget: { account: "me@example.com", threadId: "thread-cli" },
            cadence: { kind: "every", everyMs: 60_000 },
            actionPolicy: "notify_draft",
            status: "active",
            cronJobId: "cron-monitor-cli",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
      "utf-8",
    );

    try {
      const job = await state.cron.add({
        name: "monitor wake cli",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:agent:main:monitor:monitor-cli",
        wakeMode: "next-heartbeat",
        payload: { kind: "monitorWake", monitorId: "monitor-cli" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:monitor:monitor-cli",
          job: expect.not.objectContaining({
            delivery: expect.anything(),
          }),
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("keeps legacy WhatsApp auto_send wakes cron-owned after a safe CLI send", async () => {
    const cfg = createCronConfig("server-cron-monitor-auto-send");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    const monitorStorePath = path.join(path.dirname(cfg.cron!.store!), "monitors.json");
    await fs.mkdir(path.dirname(monitorStorePath), { recursive: true });
    await fs.writeFile(
      monitorStorePath,
      JSON.stringify({
        version: 1,
        monitors: [
          {
            monitorId: "monitor-auto-send",
            agentId: "main",
            originSessionKey: "agent:main:telegram:direct:user-1",
            originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
            watchDelivery: { mode: "announce", channel: "whatsapp", to: "74333133234289@lid" },
            monitorSessionKey: "agent:main:monitor:monitor-auto-send",
            sourceType: "whatsapp",
            sourceTarget: { target: "74333133234289@lid" },
            cadence: { kind: "every", everyMs: 60_000 },
            actionPolicy: "auto_send",
            status: "active",
            cronJobId: "cron-monitor-auto-send",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
      "utf-8",
    );

    try {
      const job = await state.cron.add({
        name: "monitor wake auto send",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:agent:main:monitor:monitor-auto-send",
        wakeMode: "next-heartbeat",
        payload: { kind: "monitorWake", monitorId: "monitor-auto-send" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:monitor:monitor-auto-send",
          deliveryContract: "cron-owned",
          deliveryPromptMode: "summary",
          job: expect.objectContaining({
            delivery: expect.objectContaining({
              mode: "announce",
              channel: "telegram",
              to: "user-1",
            }),
          }),
          message: expect.stringContaining("use the wacli skill/CLI"),
        }),
      );
      expect(runCronIsolatedAgentTurnMock.mock.calls[0]?.[0]).not.toHaveProperty(
        "messageToolTarget",
      );
      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(
            "If the next step needs user input or approval, send the approval question to originDelivery with the message tool, then return exactly NO_REPLY.",
          ),
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("keeps telegram-user auto_send monitor wakes cron-owned with tool-mediated guidance", async () => {
    const cfg = createCronConfig("server-cron-monitor-telegram-user-auto-send");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    const monitorStorePath = path.join(path.dirname(cfg.cron!.store!), "monitors.json");
    await fs.mkdir(path.dirname(monitorStorePath), { recursive: true });
    await fs.writeFile(
      monitorStorePath,
      JSON.stringify({
        version: 1,
        monitors: [
          {
            monitorId: "monitor-telegram-user-auto-send",
            agentId: "main",
            originSessionKey: "agent:main:telegram:direct:user-1",
            originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
            monitorSessionKey: "agent:main:monitor:monitor-telegram-user-auto-send",
            sourceType: "telegram-user",
            sourceTarget: { chat: "6783130823" },
            cadence: { kind: "every", everyMs: 60_000 },
            actionPolicy: "auto_send",
            status: "active",
            cronJobId: "cron-monitor-telegram-user-auto-send",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
      "utf-8",
    );

    try {
      const job = await state.cron.add({
        name: "monitor wake telegram user auto send",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:agent:main:monitor:monitor-telegram-user-auto-send",
        wakeMode: "next-heartbeat",
        payload: { kind: "monitorWake", monitorId: "monitor-telegram-user-auto-send" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:monitor:monitor-telegram-user-auto-send",
          deliveryContract: "cron-owned",
          deliveryPromptMode: "summary",
          job: expect.objectContaining({
            delivery: expect.objectContaining({
              mode: "announce",
              channel: "telegram",
              to: "user-1",
            }),
          }),
          message: expect.stringContaining("use the telegram-user skill/CLI"),
        }),
      );
      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(
            "do not ask the user unless you are considering accepting",
          ),
        }),
      );
      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.not.stringContaining(
            "auto_send was requested, but no watched-surface delivery target is configured.",
          ),
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("preserves monitor changes made during a monitor wake", async () => {
    const cfg = createCronConfig("server-cron-monitor-preserve-updates");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    const monitorStorePath = path.join(path.dirname(cfg.cron!.store!), "monitors.json");
    await fs.mkdir(path.dirname(monitorStorePath), { recursive: true });
    await fs.writeFile(
      monitorStorePath,
      JSON.stringify({
        version: 1,
        monitors: [
          {
            monitorId: "monitor-preserve",
            agentId: "main",
            originSessionKey: "agent:main:main",
            monitorSessionKey: "agent:main:monitor:monitor-preserve",
            sourceType: "synthetic",
            sourceTarget: { source: "proof" },
            cadence: { kind: "every", everyMs: 60_000 },
            actionPolicy: "notify_draft",
            status: "active",
            cronJobId: "cron-monitor-preserve",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
      "utf-8",
    );
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      const store = JSON.parse(await fs.readFile(monitorStorePath, "utf-8"));
      store.monitors[0] = {
        ...store.monitors[0],
        sourceTarget: { source: "proof", latestInbound: "confirmed" },
        lastCheckpoint: { evaluation: "done" },
        updatedAtMs: 2,
      };
      await fs.writeFile(monitorStorePath, JSON.stringify(store), "utf-8");
      return { status: "ok" as const, summary: "ok" };
    });

    try {
      const job = await state.cron.add({
        name: "monitor wake preserve",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:agent:main:monitor:monitor-preserve",
        wakeMode: "next-heartbeat",
        payload: { kind: "monitorWake", monitorId: "monitor-preserve" },
      });

      await state.cron.run(job.id, "force");

      const store = JSON.parse(await fs.readFile(monitorStorePath, "utf-8"));
      expect(store.monitors[0]).toMatchObject({
        sourceTarget: { source: "proof", latestInbound: "confirmed" },
        lastCheckpoint: { evaluation: "done" },
        lastWakeStatus: "active",
      });
      expect(typeof store.monitors[0].lastWakeAtMs).toBe("number");
    } finally {
      state.cron.stop();
    }
  });

  it("preserves a completion persisted during the wake and keeps cron disabled", async () => {
    const cfg = createCronConfig("server-cron-monitor-preserve-completion");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    const monitorStorePath = path.join(path.dirname(cfg.cron!.store!), "monitors.json");
    await fs.mkdir(path.dirname(monitorStorePath), { recursive: true });
    let jobId = "";
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      const store = JSON.parse(await fs.readFile(monitorStorePath, "utf-8"));
      store.monitors[0] = {
        ...store.monitors[0],
        status: "completed",
        lastCheckpoint: { evaluation: "done", evidence: "reply-confirmed" },
        updatedAtMs: 2,
      };
      await fs.writeFile(monitorStorePath, JSON.stringify(store), "utf-8");
      // This mirrors monitor.update's terminal transition: the persisted
      // completion owns the cron lifecycle before the wake runner returns.
      await state.cron.update(jobId, { enabled: false });
      return { status: "ok" as const, summary: "done" };
    });

    try {
      const job = await state.cron.add({
        name: "monitor wake preserve completion",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "session:agent:main:monitor:monitor-preserve-completion",
        wakeMode: "next-heartbeat",
        payload: { kind: "monitorWake", monitorId: "monitor-preserve-completion" },
      });
      jobId = job.id;
      await fs.writeFile(
        monitorStorePath,
        JSON.stringify({
          version: 1,
          monitors: [
            {
              monitorId: "monitor-preserve-completion",
              agentId: "main",
              originSessionKey: "agent:main:main",
              monitorSessionKey: "agent:main:monitor:monitor-preserve-completion",
              sourceType: "synthetic",
              sourceTarget: { source: "proof" },
              cadence: { kind: "every", everyMs: 60_000 },
              actionPolicy: "notify_draft",
              status: "active",
              cronJobId: job.id,
              createdAtMs: 1,
              updatedAtMs: 1,
            },
          ],
        }),
        "utf-8",
      );

      await state.cron.run(job.id, "force");

      const store = JSON.parse(await fs.readFile(monitorStorePath, "utf-8"));
      expect(store.monitors[0]).toMatchObject({
        status: "completed",
        lastWakeStatus: "completed",
        lastCheckpoint: { evaluation: "done", evidence: "reply-confirmed" },
      });
      expect(state.cron.getJob(job.id)?.enabled).toBe(false);
    } finally {
      state.cron.stop();
    }
  });

  it("stops a monitor when its bound origin goal is completed during the wake", async () => {
    const cfg = createCronConfig("server-cron-monitor-stops-on-goal-complete");
    cfg.session = {
      ...cfg.session,
      store: path.join(path.dirname(cfg.cron!.store!), "sessions.json"),
    };
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    const monitorStorePath = path.join(path.dirname(cfg.cron!.store!), "monitors.json");
    await fs.mkdir(path.dirname(monitorStorePath), { recursive: true });
    await fs.writeFile(
      monitorStorePath,
      JSON.stringify({
        version: 1,
        monitors: [
          {
            monitorId: "monitor-goal-complete",
            agentId: "main",
            originSessionKey: "agent:main:origin-goal",
            monitorSessionKey: "agent:main:monitor:monitor-goal-complete",
            sourceType: "synthetic",
            sourceTarget: { source: "proof" },
            cadence: { kind: "every", everyMs: 60_000 },
            actionPolicy: "notify_draft",
            goal: {
              id: "goal-1",
              objective: "Coordinate dinner.",
            },
            status: "active",
            cronJobId: "cron-monitor-goal-complete",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
      "utf-8",
    );
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      await fs.writeFile(
        cfg.session!.store!,
        JSON.stringify({
          "agent:main:origin-goal": {
            sessionId: "origin-session",
            updatedAt: 3,
            goal: {
              schemaVersion: 1,
              id: "goal-1",
              objective: "Coordinate dinner.",
              status: "complete",
              createdAt: 1,
              updatedAt: 3,
              tokenStart: 0,
              tokenStartFresh: true,
              tokensUsed: 0,
              continuationTurns: 0,
              completedAt: 3,
            },
          },
        }),
        "utf-8",
      );
      return { status: "ok" as const, summary: "done" };
    });

    try {
      const job = await state.cron.add({
        name: "monitor wake goal complete",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:agent:main:monitor:monitor-goal-complete",
        wakeMode: "next-heartbeat",
        payload: { kind: "monitorWake", monitorId: "monitor-goal-complete" },
      });

      await state.cron.run(job.id, "force");

      const monitorStore = JSON.parse(await fs.readFile(monitorStorePath, "utf-8"));
      expect(monitorStore.monitors[0]).toMatchObject({
        status: "stopped",
        lastWakeStatus: "stopped",
      });
      const jobs = await state.cron.list({ includeDisabled: true });
      expect(jobs.find((entry) => entry.id === job.id)?.enabled).toBe(false);
    } finally {
      state.cron.stop();
    }
  });

  it("skips the model when a monitor wakes after its bound goal is already complete", async () => {
    const cfg = createCronConfig("server-cron-monitor-skips-complete-goal");
    cfg.session = {
      ...cfg.session,
      store: path.join(path.dirname(cfg.cron!.store!), "sessions.json"),
    };
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    const monitorStorePath = path.join(path.dirname(cfg.cron!.store!), "monitors.json");
    await fs.mkdir(path.dirname(monitorStorePath), { recursive: true });
    await fs.writeFile(
      monitorStorePath,
      JSON.stringify({
        version: 1,
        monitors: [
          {
            monitorId: "monitor-already-complete",
            agentId: "main",
            originSessionKey: "agent:main:origin-complete",
            monitorSessionKey: "agent:main:monitor:monitor-already-complete",
            sourceType: "synthetic",
            sourceTarget: { source: "proof" },
            cadence: { kind: "every", everyMs: 60_000 },
            actionPolicy: "notify_draft",
            goal: {
              id: "goal-complete",
              objective: "Coordinate dinner.",
            },
            status: "active",
            cronJobId: "cron-monitor-already-complete",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
      "utf-8",
    );
    await fs.writeFile(
      cfg.session.store!,
      JSON.stringify({
        "agent:main:origin-complete": {
          sessionId: "origin-complete-session",
          updatedAt: 3,
          goal: {
            schemaVersion: 1,
            id: "goal-complete",
            objective: "Coordinate dinner.",
            status: "complete",
            createdAt: 1,
            updatedAt: 3,
            tokenStart: 0,
            tokenStartFresh: true,
            tokensUsed: 0,
            continuationTurns: 0,
            completedAt: 3,
          },
        },
      }),
      "utf-8",
    );

    try {
      const job = await state.cron.add({
        name: "monitor wake already complete",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:agent:main:monitor:monitor-already-complete",
        wakeMode: "next-heartbeat",
        payload: { kind: "monitorWake", monitorId: "monitor-already-complete" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
      const monitorStore = JSON.parse(await fs.readFile(monitorStorePath, "utf-8"));
      expect(monitorStore.monitors[0]).toMatchObject({
        status: "stopped",
        lastWakeStatus: "stopped",
      });
      const jobs = await state.cron.list({ includeDisabled: true });
      expect(jobs.find((entry) => entry.id === job.id)?.enabled).toBe(false);
    } finally {
      state.cron.stop();
    }
  });

  it("stops waking monitors already marked completed", async () => {
    const cfg = createCronConfig("server-cron-monitor-completed");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    const monitorStorePath = path.join(path.dirname(cfg.cron!.store!), "monitors.json");
    await fs.mkdir(path.dirname(monitorStorePath), { recursive: true });
    await fs.writeFile(
      monitorStorePath,
      JSON.stringify({
        version: 1,
        monitors: [
          {
            monitorId: "monitor-completed",
            agentId: "main",
            originSessionKey: "agent:main:main",
            monitorSessionKey: "agent:main:monitor:monitor-completed",
            sourceType: "gmail",
            sourceTarget: { account: "me@example.com", threadId: "thread-completed" },
            cadence: { kind: "every", everyMs: 60_000 },
            actionPolicy: "notify_draft",
            status: "completed",
            cronJobId: "cron-monitor-completed",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
      "utf-8",
    );

    try {
      const job = await state.cron.add({
        name: "monitor wake completed",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:agent:main:monitor:monitor-completed",
        wakeMode: "next-heartbeat",
        payload: { kind: "monitorWake", monitorId: "monitor-completed" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
      const jobs = await state.cron.list({ includeDisabled: true });
      expect(jobs.find((entry) => entry.id === job.id)?.enabled).toBe(false);
    } finally {
      state.cron.stop();
    }
  });
});
