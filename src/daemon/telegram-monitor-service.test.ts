import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

  it("removes and verifies a residual profile service command after uninstall", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-telegram-monitor-uninstall-"),
    );
    const sourcePath = path.join(tempDir, "ai.openclaw.consumer-lane.telegram-monitor.plist");
    await fs.writeFile(sourcePath, "<plist/>");
    baseService.uninstall.mockResolvedValueOnce(undefined);
    baseService.readCommand.mockImplementation(async () => {
      try {
        await fs.access(sourcePath);
        return {
          programArguments: ["openclaw", "telegram-user", "monitor-poll"],
          sourcePath,
        };
      } catch {
        return null;
      }
    });

    const service = resolveTelegramMonitorService();
    await service.uninstall({
      env: { HOME: "/Users/test", OPENCLAW_PROFILE: "consumer-lane" },
      stdout: process.stdout,
    });

    await expect(fs.access(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
