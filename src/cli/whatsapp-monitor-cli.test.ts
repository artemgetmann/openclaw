import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const whatsappMonitorPollCommand = vi.fn().mockResolvedValue(undefined);
const runWhatsAppMonitorServiceInstall = vi.fn().mockResolvedValue(undefined);
const runWhatsAppMonitorServiceRestart = vi.fn().mockResolvedValue(undefined);
const runWhatsAppMonitorServiceStatus = vi.fn().mockResolvedValue(undefined);
const runWhatsAppMonitorServiceStop = vi.fn().mockResolvedValue(undefined);
const runWhatsAppMonitorServiceUninstall = vi.fn().mockResolvedValue(undefined);

vi.mock("../commands/whatsapp-monitor.js", () => ({
  whatsappMonitorPollCommand,
}));

vi.mock("./whatsapp-monitor-service.js", () => ({
  runWhatsAppMonitorServiceInstall,
  runWhatsAppMonitorServiceRestart,
  runWhatsAppMonitorServiceStatus,
  runWhatsAppMonitorServiceStop,
  runWhatsAppMonitorServiceUninstall,
}));

describe("whatsapp-monitor cli", () => {
  let registerWhatsAppMonitorCli: (typeof import("./whatsapp-monitor-cli.js"))["registerWhatsAppMonitorCli"];

  beforeAll(async () => {
    ({ registerWhatsAppMonitorCli } = await import("./whatsapp-monitor-cli.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("teaches the installed openclaw whatsapp-monitor path in command help", async () => {
    const program = new Command();
    let help = "";

    program.exitOverride();
    program.configureOutput({
      writeOut: (text) => {
        help += text;
      },
      writeErr: (text) => {
        help += text;
      },
    });
    registerWhatsAppMonitorCli(program);

    await expect(
      program.parseAsync(["whatsapp-monitor", "--help"], { from: "user" }),
    ).rejects.toThrow("outputHelp");

    expect(help).toContain("openclaw whatsapp-monitor poll --db-path /tmp/wacli.db");
    expect(help).toContain("--hook-url http://127.0.0.1:18789/hooks/monitor-event");
    expect(help).toContain("openclaw whatsapp-monitor poll --watch --max-runs 3");
    expect(help).toContain("openclaw whatsapp-monitor monitor-service install --db-path");
    expect(help).not.toContain("pnpm openclaw:local whatsapp-monitor");
  });

  it("registers poll and forwards store, dispatch, and watch options", async () => {
    const program = new Command();
    registerWhatsAppMonitorCli(program);

    const whatsappMonitor = program.commands.find(
      (command) => command.name() === "whatsapp-monitor",
    );
    expect(whatsappMonitor?.commands.map((command) => command.name())).toContain("poll");

    await program.parseAsync(
      [
        "whatsapp-monitor",
        "poll",
        "--db-path",
        "/tmp/wacli.db",
        "--cron-store",
        "/tmp/cron.json",
        "--monitor-store",
        "/tmp/monitors.json",
        "--cursor-store",
        "/tmp/cursors.json",
        "--hook-url",
        "http://127.0.0.1:18789/hooks/monitor-event",
        "--hook-token",
        "secret",
        "--watch",
        "--poll-interval-ms",
        "2500",
        "--max-runs",
        "3",
        "--commit-without-dispatch",
        "--json",
      ],
      { from: "user" },
    );

    expect(whatsappMonitorPollCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commitWithoutDispatch: true,
        cronStore: "/tmp/cron.json",
        cursorStore: "/tmp/cursors.json",
        dbPath: "/tmp/wacli.db",
        hookToken: "secret",
        hookUrl: "http://127.0.0.1:18789/hooks/monitor-event",
        json: true,
        maxRuns: "3",
        monitorStore: "/tmp/monitors.json",
        pollIntervalMs: "2500",
        watch: true,
      }),
      expect.any(Object),
    );
  });

  it("registers monitor-service install and forwards service options", async () => {
    const program = new Command();
    registerWhatsAppMonitorCli(program);

    const whatsappMonitor = program.commands.find(
      (command) => command.name() === "whatsapp-monitor",
    );
    const monitorService = whatsappMonitor?.commands.find(
      (command) => command.name() === "monitor-service",
    );
    expect(monitorService?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["install", "status", "restart", "stop", "uninstall"]),
    );
    expect(monitorService?.commands.map((command) => command.name())).not.toContain("start");

    await program.parseAsync(
      [
        "whatsapp-monitor",
        "monitor-service",
        "install",
        "--db-path",
        "/tmp/wacli.db",
        "--cron-store",
        "/tmp/cron.json",
        "--monitor-store",
        "/tmp/monitors.json",
        "--cursor-store",
        "/tmp/cursors.json",
        "--hook-url",
        "http://127.0.0.1:18789/hooks/monitor-event",
        "--poll-interval-ms",
        "2500",
        "--max-runs",
        "3",
        "--runtime",
        "node",
        "--force",
        "--json",
      ],
      { from: "user" },
    );

    expect(runWhatsAppMonitorServiceInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        cronStore: "/tmp/cron.json",
        cursorStore: "/tmp/cursors.json",
        dbPath: "/tmp/wacli.db",
        force: true,
        hookUrl: "http://127.0.0.1:18789/hooks/monitor-event",
        json: true,
        maxRuns: "3",
        monitorStore: "/tmp/monitors.json",
        pollIntervalMs: "2500",
        runtime: "node",
      }),
    );
  });
});
