import { describe, expect, it, vi } from "vitest";
import { emitCompactionLifecycleEvent } from "./compaction-events.js";

describe("emitCompactionLifecycleEvent", () => {
  it("emits the visible start and completed retry lifecycle", async () => {
    const onAgentEvent = vi.fn();
    const warn = vi.fn();

    await emitCompactionLifecycleEvent({ onAgentEvent, phase: "start", warn });
    await emitCompactionLifecycleEvent({
      onAgentEvent,
      phase: "end",
      completed: true,
      willRetry: true,
      warn,
    });

    expect(onAgentEvent).toHaveBeenNthCalledWith(1, {
      stream: "compaction",
      data: { phase: "start" },
    });
    expect(onAgentEvent).toHaveBeenNthCalledWith(2, {
      stream: "compaction",
      data: { phase: "end", completed: true, willRetry: true },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not let status-delivery failure block overflow recovery", async () => {
    const onAgentEvent = vi.fn(async () => {
      throw new Error("transport unavailable");
    });
    const warn = vi.fn();

    await expect(
      emitCompactionLifecycleEvent({ onAgentEvent, phase: "start", warn }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "compaction start notification failed during overflow recovery: Error: transport unavailable",
    );
  });
});
