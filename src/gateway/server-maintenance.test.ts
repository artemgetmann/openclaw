import { afterEach, describe, expect, it, vi } from "vitest";
import { isTimeoutError } from "../agents/failover-error.js";
import type { HealthSummary } from "../commands/health.js";
import {
  createChatAbortControllerEntry,
  renewChatAbortControllerEntry,
  renewChatRunExpiry,
  type ChatAbortControllerEntry,
} from "./chat-abort.js";

const cleanOldMediaMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/store.js")>();
  return {
    ...actual,
    cleanOldMedia: cleanOldMediaMock,
  };
});

const MEDIA_CLEANUP_TTL_MS = 24 * 60 * 60_000;

function createMaintenanceTimerDeps() {
  return {
    broadcast: vi.fn(),
    nodeSendToAllSubscribed: () => {},
    getPresenceVersion: () => 1,
    getHealthVersion: () => 1,
    refreshGatewayHealthSnapshot: async () => ({ ok: true }) as HealthSummary,
    logHealth: { error: () => {} },
    dedupe: new Map(),
    chatAbortControllers: new Map(),
    chatRunState: { abortedRuns: new Map() },
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    removeChatRun: vi.fn(() => undefined),
    agentRunSeq: new Map(),
    nodeSendToSession: vi.fn(),
  };
}

function stopMaintenanceTimers(timers: {
  tickInterval: NodeJS.Timeout;
  healthInterval: NodeJS.Timeout;
  dedupeCleanup: NodeJS.Timeout;
  mediaCleanup: NodeJS.Timeout | null;
}) {
  clearInterval(timers.tickInterval);
  clearInterval(timers.healthInterval);
  clearInterval(timers.dedupeCleanup);
  if (timers.mediaCleanup) {
    clearInterval(timers.mediaCleanup);
  }
}

describe("startGatewayMaintenanceTimers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("logs and aborts expired chat runs with a timeout reason", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const runId = "run-timeout";
    const entry = createChatAbortControllerEntry({
      controller: new AbortController(),
      sessionId: "sess-timeout",
      sessionKey: "main",
      startedAtMs: -180_000,
      timeoutMs: 5_000,
      activitySource: "chat.send",
    });
    const logHealthError = vi.fn();
    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      logHealth: { error: logHealthError },
      chatAbortControllers: new Map([[runId, entry]]),
    });

    await vi.advanceTimersByTimeAsync(60_001);

    expect(logHealthError).toHaveBeenCalledTimes(1);
    expect(logHealthError.mock.calls[0]?.[0]).toContain(`runId=${runId}`);
    expect(logHealthError.mock.calls[0]?.[0]).toContain("sessionKey=main");
    expect(logHealthError.mock.calls[0]?.[0]).toContain("startedAtMs=-180000");
    expect(logHealthError.mock.calls[0]?.[0]).toContain("lastRenewedAtMs=-180000");
    expect(logHealthError.mock.calls[0]?.[0]).toContain("lastActivitySource=chat.send");
    expect(entry.controller.signal.aborted).toBe(true);
    expect(isTimeoutError(entry.controller.signal.reason)).toBe(true);
    expect(entry.controller.signal.reason).toBeInstanceOf(Error);
    expect(entry.controller.signal.reason).toEqual(
      expect.objectContaining({ name: "TimeoutError" }),
    );

    stopMaintenanceTimers(timers);
  });

  it("keeps a renewed lease alive past its original deadline and aborts after the renewed deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const runId = "run-renew";
    const entry = createChatAbortControllerEntry({
      controller: new AbortController(),
      sessionId: "sess-renew",
      sessionKey: "main",
      startedAtMs: 0,
      timeoutMs: 5_000,
      activitySource: "chat.send",
    });
    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      chatAbortControllers: new Map([[runId, entry]]),
    });

    vi.setSystemTime(60_000);
    renewChatAbortControllerEntry({
      entry,
      now: 60_000,
      activitySource: "tool:start",
    });

    await vi.advanceTimersByTimeAsync(60_001);
    expect(entry.controller.signal.aborted).toBe(false);

    // Maintenance runs on a coarse interval. The lease should abort on the first sweep
    // after the renewed expiry, not merely when the original deadline has passed.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(entry.controller.signal.aborted).toBe(true);
    expect(isTimeoutError(entry.controller.signal.reason)).toBe(true);

    stopMaintenanceTimers(timers);
  });

  it("does not schedule recursive media cleanup unless ttl is configured", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
    });

    expect(cleanOldMediaMock).not.toHaveBeenCalled();
    expect(timers.mediaCleanup).toBeNull();

    stopMaintenanceTimers(timers);
  });

  it("runs startup media cleanup and repeats it hourly", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });

    expect(cleanOldMediaMock).toHaveBeenCalledWith(MEDIA_CLEANUP_TTL_MS, {
      recursive: true,
      pruneEmptyDirs: true,
    });

    cleanOldMediaMock.mockClear();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledWith(MEDIA_CLEANUP_TTL_MS, {
      recursive: true,
      pruneEmptyDirs: true,
    });

    stopMaintenanceTimers(timers);
  });

  it("skips overlapping media cleanup runs", async () => {
    vi.useFakeTimers();
    let resolveCleanup = () => {};
    let cleanupReady = false;
    cleanOldMediaMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
          cleanupReady = true;
        }),
    );
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });

    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);

    if (cleanupReady) {
      resolveCleanup();
    }
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(2);

    stopMaintenanceTimers(timers);
  });

  it("keeps an active chat run past the original timeout window after activity renewal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-renewed";
    const sessionKey = "main";
    const entry: ChatAbortControllerEntry = {
      controller: new AbortController(),
      sessionId: "session-renewed",
      sessionKey,
      startedAtMs: 0,
      expiresAtMs: 30_000,
    };
    deps.chatAbortControllers.set(runId, entry);
    deps.chatRunBuffers.set(runId, "partial reply");
    deps.chatDeltaSentAt.set(runId, 1);

    const timers = startGatewayMaintenanceTimers(deps);

    try {
      vi.setSystemTime(20_000);
      renewChatRunExpiry({ entry, now: Date.now(), timeoutMs: 30_000 });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(deps.chatAbortControllers.has(runId)).toBe(true);
      expect(entry.controller.signal.aborted).toBe(false);
      expect(deps.chatRunState.abortedRuns.has(runId)).toBe(false);
      expect(deps.broadcast).not.toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({
          runId,
          state: "aborted",
          stopReason: "timeout",
        }),
      );

      vi.setSystemTime(entry.expiresAtMs + 1);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(deps.chatAbortControllers.has(runId)).toBe(false);
      expect(entry.controller.signal.aborted).toBe(true);
      expect(deps.chatRunState.abortedRuns.has(runId)).toBe(true);
      expect(deps.broadcast).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({
          runId,
          state: "aborted",
          stopReason: "timeout",
        }),
      );
      expect(deps.nodeSendToSession).toHaveBeenCalledWith(
        sessionKey,
        "chat",
        expect.objectContaining({
          runId,
          state: "aborted",
          stopReason: "timeout",
        }),
      );
    } finally {
      stopMaintenanceTimers(timers);
    }
  });
});
