import { afterEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinel } from "../infra/restart-sentinel.js";

type MockOutboundParams = {
  onError?: (err: unknown, payload: { text: string; mediaUrls: string[] }) => void;
};

type MockSystemEvent = { text: string; ts: number; contextKey?: string | null };

const mocks = vi.hoisted(() => ({
  resolveSessionAgentId: vi.fn(() => "agent-from-key"),
  consumeRestartSentinel: vi.fn(async () => ({
    payload: {
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "whatsapp",
        to: "+15550002",
        accountId: "acct-2",
      },
    },
  })),
  readRestartSentinel: vi.fn<() => Promise<RestartSentinel | null>>(async () => null),
  readRestartRecoveryMarker: vi.fn(async () => null),
  updateRestartSentinel: vi.fn(),
  formatRestartSentinelMessage: vi.fn(() => "restart message"),
  summarizeRestartSentinel: vi.fn(() => "restart summary"),
  resolveMainSessionKeyFromConfig: vi.fn(() => "agent:main:main"),
  parseSessionThreadInfo: vi.fn(() => ({ baseSessionKey: null, threadId: undefined })),
  loadSessionEntry: vi.fn(() => ({ cfg: {}, entry: {} })),
  resolveAnnounceTargetFromKey: vi.fn(() => null),
  deliveryContextFromSession: vi.fn(() => undefined),
  mergeDeliveryContext: vi.fn((a?: Record<string, unknown>, b?: Record<string, unknown>) => ({
    ...b,
    ...a,
  })),
  normalizeChannelId: vi.fn((channel: string) => channel),
  resolveOutboundTarget: vi.fn(() => ({ ok: true as const, to: "+15550002" })),
  deliverOutboundPayloads: vi.fn<(params?: MockOutboundParams) => Promise<unknown[]>>(
    async () => [],
  ),
  enqueueSystemEvent: vi.fn(),
  peekSystemEventEntries: vi.fn<(sessionKey: string) => MockSystemEvent[]>(() => []),
  requestHeartbeatNow: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveSessionAgentId: mocks.resolveSessionAgentId,
}));

vi.mock("../infra/restart-sentinel.js", () => ({
  consumeRestartSentinel: mocks.consumeRestartSentinel,
  readRestartSentinel: mocks.readRestartSentinel,
  readRestartRecoveryMarker: mocks.readRestartRecoveryMarker,
  updateRestartSentinel: mocks.updateRestartSentinel,
  formatRestartSentinelMessage: mocks.formatRestartSentinelMessage,
  summarizeRestartSentinel: mocks.summarizeRestartSentinel,
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: mocks.requestHeartbeatNow,
}));

vi.mock("../routing/session-key.js", () => ({
  scopedHeartbeatWakeOptions: (sessionKey: string, options: Record<string, unknown>) => ({
    ...options,
    sessionKey,
  }),
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKeyFromConfig: mocks.resolveMainSessionKeyFromConfig,
}));

vi.mock("../config/sessions/delivery-info.js", () => ({
  parseSessionThreadInfo: mocks.parseSessionThreadInfo,
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
}));

vi.mock("../agents/tools/sessions-send-helpers.js", () => ({
  resolveAnnounceTargetFromKey: mocks.resolveAnnounceTargetFromKey,
}));

vi.mock("../utils/delivery-context.js", () => ({
  deliveryContextFromSession: mocks.deliveryContextFromSession,
  mergeDeliveryContext: mocks.mergeDeliveryContext,
}));

vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
  peekSystemEventEntries: mocks.peekSystemEventEntries,
}));

const { resetRestartOperationRetryStateForTests, scheduleRestartSentinelWake } =
  await import("./server-restart-sentinel.js");

afterEach(() => {
  resetRestartOperationRetryStateForTests();
  vi.useRealTimers();
});

describe("scheduleRestartSentinelWake", () => {
  it("forwards session context to outbound delivery", async () => {
    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        to: "+15550002",
        session: { key: "agent:main:main", agentId: "agent-from-key" },
      }),
    );
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  function installOperation(overrides?: {
    sessionKey?: string;
    expiresAt?: number;
    receipt?: "pending" | "delivering" | "delivered" | "skipped";
    continuation?: "pending" | "delivering" | "delivered" | "skipped";
  }) {
    const queuedContexts = new Set<string>();
    mocks.enqueueSystemEvent.mockImplementation(
      (_text: string, options: { contextKey?: string }) => {
        const contextKey = options.contextKey ?? "";
        if (queuedContexts.has(contextKey)) {
          return false;
        }
        queuedContexts.add(contextKey);
        return true;
      },
    );
    mocks.peekSystemEventEntries.mockImplementation(() =>
      [...queuedContexts].map((contextKey) => ({ text: "restart", ts: 1, contextKey })),
    );
    let state: RestartSentinel = {
      version: 1,
      payload: { kind: "restart", status: "requested", ts: 100 },
      operation: {
        id: "op-1",
        sessionKey:
          overrides && "sessionKey" in overrides ? overrides.sessionKey : "agent:main:main",
        channel: "telegram",
        to: "-100123",
        accountId: "acct-1",
        topicId: "42",
        reason: "apply update",
        note: "Restart requested",
        requestedAt: 100,
        expiresAt: overrides?.expiresAt ?? Date.now() + 60_000,
        recovery: { state: "waiting" },
        delivery: {
          receipt: overrides?.receipt ?? "pending",
          continuation: overrides?.continuation ?? "pending",
          updatedAt: 100,
        },
      },
    };
    mocks.readRestartSentinel.mockImplementation(async () => state);
    mocks.updateRestartSentinel.mockImplementation(
      async (update: (value: RestartSentinel) => RestartSentinel) => {
        state = update(state);
        return state;
      },
    );
    return () => state;
  }

  it("delivers one routed receipt and one safety-worded continuation", async () => {
    const readState = installOperation();
    mocks.deliverOutboundPayloads.mockClear();
    mocks.enqueueSystemEvent.mockClear();
    mocks.requestHeartbeatNow.mockClear();

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "+15550002",
        accountId: "acct-1",
        threadId: "42",
      }),
    );
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringMatching(/Reassess the current external state.*Never blindly repeat/s),
      expect.objectContaining({ sessionKey: "agent:main:main", contextKey: "restart:op-1" }),
    );
    expect(mocks.requestHeartbeatNow).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:main", reason: "restart-continuation" }),
    );
    expect(readState().operation?.delivery).toEqual(
      expect.objectContaining({ receipt: "delivered", continuation: "delivering" }),
    );
  });

  it("is idempotent when startup reconciliation runs twice", async () => {
    installOperation();
    mocks.deliverOutboundPayloads.mockClear();
    mocks.enqueueSystemEvent.mockClear();

    await scheduleRestartSentinelWake({ deps: {} as never });
    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("skips stale operations without delivery or continuation", async () => {
    const readState = installOperation({ expiresAt: Date.now() - 1 });
    mocks.deliverOutboundPayloads.mockClear();
    mocks.enqueueSystemEvent.mockClear();

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(readState().operation?.delivery).toEqual(
      expect.objectContaining({ receipt: "skipped", continuation: "skipped" }),
    );
  });

  it("does not create a continuation when no active session was recorded", async () => {
    installOperation({ sessionKey: undefined, continuation: "skipped" });
    mocks.enqueueSystemEvent.mockClear();
    mocks.requestHeartbeatNow.mockClear();

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeatNow).not.toHaveBeenCalled();
  });

  it("keeps receipt pending and does not continue when routed delivery fails", async () => {
    const readState = installOperation();
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("provider offline"));
    mocks.enqueueSystemEvent.mockClear();

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(readState().operation?.delivery.receipt).toBe("pending");
    expect(readState().operation?.delivery.lastError).toContain("provider offline");
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("keeps receipt pending when best-effort delivery reports a payload error", async () => {
    const readState = installOperation();
    mocks.deliverOutboundPayloads.mockImplementationOnce(async (params) => {
      params?.onError?.(new Error("provider rejected payload"), {
        text: "receipt",
        mediaUrls: [],
      });
      return [];
    });
    mocks.enqueueSystemEvent.mockClear();

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(readState().operation?.delivery.receipt).toBe("pending");
    expect(readState().operation?.delivery.lastError).toContain("provider rejected payload");
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("retries a transient receipt failure in-process", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T10:00:00.000Z"));
    const readState = installOperation();
    mocks.deliverOutboundPayloads.mockClear();
    mocks.deliverOutboundPayloads
      .mockRejectedValueOnce(new Error("provider temporarily offline"))
      .mockResolvedValueOnce([]);
    mocks.enqueueSystemEvent.mockClear();

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(readState().operation?.delivery.receipt).toBe("pending");
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
    expect(readState().operation?.delivery.receipt).toBe("delivered");
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ contextKey: "restart:op-1" }),
    );
  });

  it("stops retrying receipt delivery at the operation TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T10:00:00.000Z"));
    const readState = installOperation({ expiresAt: Date.now() + 1_500 });
    mocks.deliverOutboundPayloads.mockClear();
    mocks.deliverOutboundPayloads.mockRejectedValue(new Error("provider offline"));
    mocks.enqueueSystemEvent.mockClear();

    await scheduleRestartSentinelWake({ deps: {} as never });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(500);

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
    expect(readState().operation?.delivery).toEqual(
      expect.objectContaining({ receipt: "skipped", continuation: "skipped" }),
    );
  });
});
