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

const { resolveWhatsAppMonitorService } = await import("./whatsapp-monitor-service.js");

describe("resolveWhatsAppMonitorService", () => {
  it("uses profile-scoped service identity before install", async () => {
    baseService.isLoaded.mockResolvedValueOnce(false);

    const service = resolveWhatsAppMonitorService();
    await service.isLoaded({
      env: {
        HOME: "/Users/test",
        OPENCLAW_PROFILE: "consumer-lane",
      },
    });

    expect(baseService.isLoaded).toHaveBeenCalledWith({
      env: expect.objectContaining({
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.consumer-lane.whatsapp-monitor",
        OPENCLAW_PROFILE: "consumer-lane",
        OPENCLAW_SERVICE_KIND: "whatsapp-monitor",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-whatsapp-monitor-consumer-lane",
      }),
    });
  });

  it("removes and verifies a residual profile service command after uninstall", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-whatsapp-monitor-uninstall-"),
    );
    const sourcePath = path.join(tempDir, "ai.openclaw.consumer-lane.whatsapp-monitor.plist");
    await fs.writeFile(sourcePath, "<plist/>");
    baseService.uninstall.mockResolvedValueOnce(undefined);
    baseService.readCommand.mockImplementation(async () => {
      try {
        await fs.access(sourcePath);
        return {
          programArguments: ["openclaw", "whatsapp-monitor", "poll"],
          sourcePath,
        };
      } catch {
        return null;
      }
    });

    const service = resolveWhatsAppMonitorService();
    await service.uninstall({
      env: { HOME: "/Users/test", OPENCLAW_PROFILE: "consumer-lane" },
      stdout: process.stdout,
    });

    await expect(fs.access(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
