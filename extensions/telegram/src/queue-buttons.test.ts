import { describe, expect, it, vi } from "vitest";
import {
  buildTelegramDeferredButtons,
  buildTelegramQueuedButtons,
  buildTelegramSteeredButtons,
  cancelTelegramAutoSteer,
  parseTelegramQueueCallback,
  scheduleTelegramAutoSteer,
} from "./queue-buttons.js";

const DURABLE_ID = "12345678-1234-4234-8234-123456789abc";

describe("Telegram queue buttons", () => {
  it("renders Use now as the selected default and exposes the deferred action", () => {
    expect(buildTelegramQueuedButtons(DURABLE_ID)).toEqual([
      [
        {
          text: "After this",
          callback_data: `oqk:${DURABLE_ID}`,
        },
        {
          text: "✓ Use now",
          callback_data: `oqs:${DURABLE_ID}`,
          style: "success",
        },
      ],
    ]);
  });

  it("renders the irreversible settled steering state honestly", () => {
    expect(buildTelegramSteeredButtons(DURABLE_ID)).toEqual([
      [
        {
          text: "✓ Using now",
          callback_data: `oqd:${DURABLE_ID}`,
          style: "success",
        },
      ],
    ]);
  });

  it("renders the selected deferred state in consumer language", () => {
    expect(buildTelegramDeferredButtons(DURABLE_ID)).toEqual([
      [
        {
          text: "✓ After this",
          callback_data: `oqd:${DURABLE_ID}`,
          style: "success",
        },
      ],
    ]);
  });

  it("allows the default auto-steer to be cancelled during its grace period", async () => {
    const run = vi.fn();
    scheduleTelegramAutoSteer(DURABLE_ID, run, 10);
    expect(cancelTelegramAutoSteer(DURABLE_ID)).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the default auto-steer once after its grace period", async () => {
    const run = vi.fn();
    scheduleTelegramAutoSteer(DURABLE_ID, run, 10);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(cancelTelegramAutoSteer(DURABLE_ID)).toBe("missing"));
  });

  it("reports an in-flight promotion instead of claiming a late deferral", async () => {
    let finish!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    scheduleTelegramAutoSteer(DURABLE_ID, run, 10);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(cancelTelegramAutoSteer(DURABLE_ID)).toBe("in-flight");
    finish();
    await vi.waitFor(() => expect(cancelTelegramAutoSteer(DURABLE_ID)).toBe("missing"));
  });

  it("parses only bounded ASCII durable ids", () => {
    expect(parseTelegramQueueCallback(`oqs:${DURABLE_ID}`)).toEqual({
      action: "steer",
      durableId: DURABLE_ID,
    });
    expect(parseTelegramQueueCallback("oqs:short")).toBeUndefined();
    expect(parseTelegramQueueCallback(`oqs:${"é".repeat(20)}`)).toBeUndefined();
    expect(parseTelegramQueueCallback(`oqs:${"a".repeat(49)}`)).toBeUndefined();
  });
});
