import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const browserReplyObserveCommand = vi.fn(async () => undefined);

vi.mock("../browser/reply-monitor-command.js", () => ({ browserReplyObserveCommand }));

const { registerBrowserMonitorCli } = await import("./browser-monitor-cli.js");

describe("browser-monitor cli", () => {
  beforeEach(() => browserReplyObserveCommand.mockClear());

  it("registers explicit browser scope and forwards observe options", async () => {
    const program = new Command();
    program.exitOverride();
    registerBrowserMonitorCli(program);

    const browserMonitor = program.commands.find((command) => command.name() === "browser-monitor");
    const observe = browserMonitor?.commands.find((command) => command.name() === "observe");
    expect(observe?.options.map((option) => option.long)).not.toContain("--hook-token");
    expect(observe?.helpInformation()).toContain("OPENCLAW_HOOKS_TOKEN");

    await program.parseAsync(
      [
        "browser-monitor",
        "observe",
        "--profile",
        "isolated",
        "--target-id",
        "tab-1",
        "--url-pattern",
        "https://example.test/thread/*",
        "--selector",
        "[data-reply]",
        "--match-mode",
        "contains",
        "--match-value",
        "Replied",
        "--monitor-id",
        "monitor-1",
        "--hook-url",
        "http://127.0.0.1:18789/hooks/monitor-event",
        "--watch",
        "--max-runs",
        "2",
      ],
      { from: "user" },
    );

    expect(browserReplyObserveCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "isolated",
        targetId: "tab-1",
        urlPattern: "https://example.test/thread/*",
        selector: "[data-reply]",
        matchMode: "contains",
        matchValue: "Replied",
        monitorId: "monitor-1",
        watch: true,
        maxRuns: "2",
      }),
      expect.anything(),
    );
  });
});
