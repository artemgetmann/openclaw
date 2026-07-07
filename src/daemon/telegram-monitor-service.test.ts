import { describe, expect, it, vi } from "vitest";

const baseService = vi.hoisted(() => ({
  install: vi.fn(),
  isLoaded: vi.fn(),
  label: "LaunchAgent",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
  stop: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock("./service.js", () => ({
  resolveGatewayService: () => baseService,
}));

const { resolveTelegramMonitorService } = await import("./telegram-monitor-service.js");

describe("resolveTelegramMonitorService", () => {
  it("uses profile-scoped service identity before install", async () => {
    baseService.isLoaded.mockResolvedValueOnce(false);

    const service = resolveTelegramMonitorService();
    await service.isLoaded({
      env: {
        HOME: "/Users/test",
        OPENCLAW_PROFILE: "consumer-lane",
      },
    });

    expect(baseService.isLoaded).toHaveBeenCalledWith({
      env: expect.objectContaining({
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.consumer-lane.telegram-monitor",
        OPENCLAW_PROFILE: "consumer-lane",
        OPENCLAW_SERVICE_KIND: "telegram-monitor",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-telegram-monitor-consumer-lane",
      }),
    });
  });
});
