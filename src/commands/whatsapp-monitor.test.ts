import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappMonitorPollCommand } from "./whatsapp-monitor.js";

const commandMocks = vi.hoisted(() => ({
  pollWhatsAppMonitorEvents: vi.fn(async () => ({
    checked: 0,
    cursorStorePath: "/tmp/cursors.json",
    dispatched: 0,
    events: [] as Array<Record<string, unknown>>,
    skipped: [] as Array<Record<string, unknown>>,
    updatedCursors: 0,
  })),
}));

const listenerHealthMocks = vi.hoisted(() => ({
  classifyFatalListenerHealthError: vi.fn(() => "poll_failed:error"),
  resolveListenerHealthStorePath: vi.fn(() => "/tmp/whatsapp-listener-health.json"),
  updateListenerHealth: vi.fn(async () => ({
    record: { lastError: null as string | null },
    state: "healthy",
    transition: null as "degraded" | "recovered" | null,
  })),
}));

vi.mock("../whatsapp/monitor-listener.js", () => ({
  pollWhatsAppMonitorEvents: commandMocks.pollWhatsAppMonitorEvents,
}));
vi.mock("../monitor/listener-health.js", () => listenerHealthMocks);

describe("whatsappMonitorPollCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets commit-without-dispatch override a provided hook URL", async () => {
    await whatsappMonitorPollCommand(
      {
        commitWithoutDispatch: true,
        dbPath: "/tmp/wacli.db",
        hookUrl: "https://127.0.0.1:18789/hooks/monitor-event",
        json: true,
      },
      { log: vi.fn() } as never,
    );

    expect(commandMocks.pollWhatsAppMonitorEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        commitWithoutDispatch: true,
        dbPath: "/tmp/wacli.db",
        dispatchEvent: undefined,
      }),
    );
    expect(listenerHealthMocks.updateListenerHealth).not.toHaveBeenCalled();
  });

  it("records successful health for each watch poll", async () => {
    await whatsappMonitorPollCommand(
      {
        commitWithoutDispatch: true,
        dbPath: "/tmp/wacli.db",
        json: true,
        maxRuns: "2",
        pollIntervalMs: "1",
        watch: true,
      },
      { log: vi.fn() } as never,
    );

    expect(listenerHealthMocks.updateListenerHealth).toHaveBeenCalledTimes(2);
    expect(listenerHealthMocks.updateListenerHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({
        check: "success",
        routedEvent: false,
        service: "whatsapp",
      }),
    );
  });

  it("records an operational failure when a watch poll skips a backend error", async () => {
    commandMocks.pollWhatsAppMonitorEvents.mockResolvedValueOnce({
      checked: 1,
      cursorStorePath: "/tmp/cursors.json",
      dispatched: 0,
      events: [],
      skipped: [
        {
          error: "lookup failed: private message body should not be echoed",
          monitorId: "monitor-1",
          reason: "lookup_error",
        },
      ],
      updatedCursors: 0,
    });

    await whatsappMonitorPollCommand(
      {
        commitWithoutDispatch: true,
        dbPath: "/tmp/wacli.db",
        maxRuns: "1",
        pollIntervalMs: "1",
        watch: true,
      },
      { log: vi.fn() } as never,
    );

    expect(listenerHealthMocks.updateListenerHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        check: "failure",
        error: expect.stringContaining("lookup_error"),
        service: "whatsapp",
      }),
    );
  });

  it("marks a watch poll as routed when it emits an event", async () => {
    commandMocks.pollWhatsAppMonitorEvents.mockResolvedValueOnce({
      checked: 1,
      cursorStorePath: "/tmp/cursors.json",
      dispatched: 1,
      events: [
        {
          event: { idempotencyKey: "event-1" },
          monitor: { monitorId: "monitor-1" },
          target: "chat",
        },
      ],
      skipped: [],
      updatedCursors: 1,
    });

    await whatsappMonitorPollCommand(
      {
        commitWithoutDispatch: true,
        dbPath: "/tmp/wacli.db",
        maxRuns: "1",
        pollIntervalMs: "1",
        watch: true,
      },
      { log: vi.fn() } as never,
    );

    expect(listenerHealthMocks.updateListenerHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        check: "success",
        routedEvent: true,
        service: "whatsapp",
      }),
    );
  });

  it("surfaces each health transition once through the runtime channels", async () => {
    listenerHealthMocks.updateListenerHealth
      .mockResolvedValueOnce({
        record: { lastError: "safe backend error" },
        state: "degraded",
        transition: "degraded",
      })
      .mockResolvedValueOnce({
        record: { lastError: null },
        state: "healthy",
        transition: "recovered",
      });
    const runtime = { error: vi.fn(), log: vi.fn() };

    await whatsappMonitorPollCommand(
      {
        commitWithoutDispatch: true,
        dbPath: "/tmp/wacli.db",
        maxRuns: "2",
        pollIntervalMs: "1",
        watch: true,
      },
      runtime as never,
    );

    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("listener health degraded"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("listener health recovered"));
    expect(
      runtime.log.mock.calls.filter(([message]) =>
        String(message).includes("listener health recovered"),
      ),
    ).toHaveLength(1);
  });

  it("persists a bounded failure before a fatal watch poll exits", async () => {
    commandMocks.pollWhatsAppMonitorEvents.mockRejectedValueOnce(
      new Error("private selector /Users/alice/wacli.db token=secret"),
    );

    await expect(
      whatsappMonitorPollCommand(
        { commitWithoutDispatch: true, dbPath: "/tmp/wacli.db", watch: true },
        { error: vi.fn(), log: vi.fn() } as never,
      ),
    ).rejects.toThrow("private selector");

    expect(listenerHealthMocks.updateListenerHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        check: "failure",
        error: "poll_failed:error",
        service: "whatsapp",
      }),
    );
  });

  it("keeps polling when health persistence is temporarily unavailable", async () => {
    listenerHealthMocks.updateListenerHealth.mockRejectedValueOnce(new Error("permission denied"));
    const runtime = { error: vi.fn(), log: vi.fn() };

    await whatsappMonitorPollCommand(
      {
        commitWithoutDispatch: true,
        dbPath: "/tmp/wacli.db",
        maxRuns: 2,
        pollIntervalMs: 1,
        watch: true,
      },
      runtime as never,
    );

    expect(commandMocks.pollWhatsAppMonitorEvents).toHaveBeenCalledTimes(2);
    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("health persistence unavailable"),
    );
  });
});
