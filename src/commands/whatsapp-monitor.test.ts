import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappMonitorPollCommand } from "./whatsapp-monitor.js";

const commandMocks = vi.hoisted(() => ({
  pollWhatsAppMonitorEvents: vi.fn(async () => ({
    checked: 0,
    cursorStorePath: "/tmp/cursors.json",
    dispatched: 0,
    events: [],
    skipped: [],
    updatedCursors: 0,
  })),
}));

vi.mock("../whatsapp/monitor-listener.js", () => ({
  pollWhatsAppMonitorEvents: commandMocks.pollWhatsAppMonitorEvents,
}));

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
  });
});
