import { describe, expect, it, vi } from "vitest";
import { resolveReplyRunWatchdogConfig, startReplyRunWatchdog } from "./reply-run-watchdog.js";

describe("reply run watchdog", () => {
  it("is silent by default because it has no evidence snapshot", () => {
    expect(resolveReplyRunWatchdogConfig({}).enabled).toBe(false);
  });

  it("only sends a progress ping when explicitly enabled with text", async () => {
    vi.useFakeTimers();
    const onBlockReply = vi.fn();
    const stop = startReplyRunWatchdog({
      cfg: {
        agents: {
          defaults: {
            replyRunWatchdog: {
              enabled: true,
              intervalMs: 10,
              text: "Read the checkpoint skill file.",
            },
          },
        },
      },
      enabled: true,
      onBlockReply,
    });

    await vi.advanceTimersByTimeAsync(10);
    stop();

    expect(onBlockReply).toHaveBeenCalledWith({ text: "Read the checkpoint skill file." });
    vi.useRealTimers();
  });
});
