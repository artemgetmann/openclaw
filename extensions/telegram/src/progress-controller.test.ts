import type { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { createTelegramProgressController } from "./progress-controller.js";

function createProgressControllerHarness() {
  let resolveFirstSend: ((value: { message_id: number }) => void) | undefined;
  const firstSend = new Promise<{ message_id: number }>((resolve) => {
    resolveFirstSend = resolve;
  });
  const api = {
    sendMessage: vi.fn().mockReturnValueOnce(firstSend),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
  };
  const controller = createTelegramProgressController({
    api: api as unknown as Bot["api"],
    chatId: 123,
    maxChars: 4096,
    minInitialChars: 1,
    renderText: (text) => ({ text }),
  });
  return { api, controller, resolveFirstSend };
}

describe("createTelegramProgressController", () => {
  it("serializes pending first send, cancels pending cleanup edit, then deletes the same message", async () => {
    const { api, controller, resolveFirstSend } = createProgressControllerHarness();

    controller.update("Opening example.com");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    controller.update("Reading IANA example domains");
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    const clearPromise = controller.clear();
    expect(api.deleteMessage).not.toHaveBeenCalled();

    resolveFirstSend?.({ message_id: 77 });
    await clearPromise;

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.deleteMessage).toHaveBeenCalledWith(123, 77);
  });

  it("edits cumulative progress while work is still active", async () => {
    const { api, controller, resolveFirstSend } = createProgressControllerHarness();

    controller.update("Opening example.com");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    resolveFirstSend?.({ message_id: 77 });
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));

    controller.update("Reading IANA example domains");
    await vi.waitFor(() =>
      expect(api.editMessageText).toHaveBeenCalledWith(
        123,
        77,
        "Opening example.com\n\nReading IANA example domains",
      ),
    );
  });

  it("dedupes repeated progress entries while preserving first-seen order", async () => {
    const { api, controller, resolveFirstSend } = createProgressControllerHarness();

    controller.update("Opening example.com");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    resolveFirstSend?.({ message_id: 77 });
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));

    controller.update("Opening example.com");
    controller.update("Reading IANA example domains\nOpening example.com");
    await vi.waitFor(() =>
      expect(api.editMessageText).toHaveBeenLastCalledWith(
        123,
        77,
        "Opening example.com\n\nReading IANA example domains",
      ),
    );

    expect(api.editMessageText).toHaveBeenLastCalledWith(
      123,
      77,
      "Opening example.com\n\nReading IANA example domains",
    );
    await controller.clear();
    expect(api.deleteMessage).toHaveBeenCalledWith(123, 77);
  });

  it("caps cumulative progress by dropping oldest entries without leaking an omitted marker", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 77 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const controller = createTelegramProgressController({
      api: api as unknown as Bot["api"],
      chatId: 123,
      maxChars: 80,
      minInitialChars: 1,
      renderText: (text) => ({ text }),
    });

    controller.update("First progress entry that should eventually be omitted.");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    controller.update("Second progress entry that should remain visible.");
    controller.update("Third progress entry that should remain visible.");
    await vi.waitFor(() => expect(api.editMessageText).toHaveBeenCalled());

    const latestEditText = String(api.editMessageText.mock.lastCall?.[2] ?? "");
    expect(latestEditText.length).toBeLessThanOrEqual(80);
    expect(latestEditText).toContain("Third progress entry");
    expect(latestEditText).not.toContain("First progress entry");
    expect(latestEditText).not.toContain("earlier progress omitted");
  });

  it("keeps the newest progress entry visible when that entry alone needs truncation", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 77 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const controller = createTelegramProgressController({
      api: api as unknown as Bot["api"],
      chatId: 123,
      maxChars: 56,
      minInitialChars: 1,
      renderText: (text) => ({ text }),
    });

    controller.update("Short old status.");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    controller.update("Newest status must remain visible even when it is too long to fit fully.");
    await vi.waitFor(() => expect(api.editMessageText).toHaveBeenCalled());

    const latestEditText = String(api.editMessageText.mock.lastCall?.[2] ?? "");
    expect(latestEditText.length).toBeLessThanOrEqual(56);
    expect(latestEditText).toContain("Newest status");
    expect(latestEditText).not.toContain("Short old status");
  });

  it("does not throw when progress deletion fails", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 77 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockRejectedValue(new Error("delete failed")),
    };
    const warn = vi.fn();
    const controller = createTelegramProgressController({
      api: api as unknown as Bot["api"],
      chatId: 123,
      maxChars: 4096,
      minInitialChars: 1,
      renderText: (text) => ({ text }),
      warn,
    });

    controller.update("Opening example.com");
    await expect(controller.clear()).resolves.toBeUndefined();

    expect(api.deleteMessage).toHaveBeenCalledWith(123, 77);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("delete failed"));
  });
});
