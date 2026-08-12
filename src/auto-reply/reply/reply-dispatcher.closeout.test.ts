import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

describe("reply dispatcher delivery listeners", () => {
  it("notifies listeners only after successful channel delivery", async () => {
    const onError = vi.fn();
    const listener = vi.fn();
    const deliver = vi.fn(async (payload: ReplyPayload) => {
      if (payload.text === "failed") {
        throw new Error("channel rejected delivery");
      }
    });
    const dispatcher = createReplyDispatcher({ deliver, onError });
    dispatcher.addDeliveryListener?.(listener);

    dispatcher.sendFinalReply({ text: "failed" });
    dispatcher.sendFinalReply({ text: "delivered" });
    await dispatcher.waitForIdle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ text: "delivered" }, { kind: "final" });
  });

  it("does not turn observer failures into delivery failures", async () => {
    const onError = vi.fn();
    const successfulListener = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver: vi.fn(async () => {}), onError });
    dispatcher.addDeliveryListener?.(() => {
      throw new Error("receipt store unavailable");
    });
    dispatcher.addDeliveryListener?.(successfulListener);

    dispatcher.sendFinalReply({ text: "Delivered" });
    await dispatcher.waitForIdle();
    dispatcher.sendBlockReply({ text: "Delivered block" });
    await expect(dispatcher.finalizeBlockReply?.()).resolves.toBeUndefined();

    expect(onError).not.toHaveBeenCalled();
    expect(successfulListener).toHaveBeenCalledTimes(3);
  });

  it("promotes only successfully delivered block text at finalization", async () => {
    const listener = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver: vi.fn(async () => {}),
      onBlockReplyFinalized: vi.fn(async () => "Clean final receipt"),
    });
    dispatcher.addDeliveryListener?.(listener);

    dispatcher.sendBlockReply({ text: "Raw streamed receipt" });
    await dispatcher.finalizeBlockReply?.();

    expect(listener).toHaveBeenLastCalledWith(
      { text: "Clean final receipt" },
      { kind: "finalized-block" },
    );
  });

  it("preserves a receipt split across multiple delivered blocks", async () => {
    const listener = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver: vi.fn(async () => {}) });
    dispatcher.addDeliveryListener?.(listener);

    dispatcher.sendBlockReply({ text: "Outcome: PR merged\nRemaining: None" });
    dispatcher.sendBlockReply({ text: "Owner: This chat\nNext action: None" });
    await dispatcher.finalizeBlockReply?.();

    expect(listener).toHaveBeenLastCalledWith(
      {
        text: "Outcome: PR merged\nRemaining: None\n\nOwner: This chat\nNext action: None",
      },
      { kind: "finalized-block" },
    );
  });
});
