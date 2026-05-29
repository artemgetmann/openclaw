import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../commands/health.js";
import { renewChatRunExpiry, type ChatAbortControllerEntry } from "./chat-abort.js";

const { cleanOldMediaMock } = vi.hoisted(() => ({
  cleanOldMediaMock: vi.fn(async () => {}),
}));

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
