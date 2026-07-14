import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const browserReplyObserveCommand = vi.fn(
  async (_opts: Record<string, unknown>, _runtime: unknown) => undefined,
);

vi.mock("../browser/reply-monitor-command.js", () => ({ browserReplyObserveCommand }));

const { registerBrowserMonitorCli } = await import("./browser-monitor-cli.js");

describe("browser-monitor cli", () => {
  beforeEach(() => browserReplyObserveCommand.mockClear());

  it("parses the browser profile without colliding with the root profile option", async () => {
    const program = new Command().name("openclaw");
    program.option("--profile <name>", "Global config profile");
    program.exitOverride();
    registerBrowserMonitorCli(program);

    const browserMonitor = program.commands.find((command) => command.name() === "browser-monitor");
    const observe = browserMonitor?.commands.find((command) => command.name() === "observe");
    expect(observe?.options.map((option) => option.long)).not.toContain("--hook-token");
    expect(observe?.options.map((option) => option.long)).not.toContain("--profile");
    expect(observe?.options.map((option) => option.long)).toContain("--browser-profile");
    expect(observe?.helpInformation()).toContain("OPENCLAW_HOOKS_TOKEN");

    await program.parseAsync(
      [
        "node",
        "openclaw",
        "browser-monitor",
        "observe",
        "--browser-profile",
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
      { from: "node" },
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
    expect(browserReplyObserveCommand.mock.calls[0]?.[0]).not.toHaveProperty("browserProfile");
  });
});
