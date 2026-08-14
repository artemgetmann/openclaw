import type { Bot } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramProgressController } from "./progress-controller.js";
import {
  __testing as runStopTesting,
  claimTelegramRunStop,
  registerTelegramRunStop,
} from "./run-stop-control.js";
import {
  __testing as workLogTesting,
  getTelegramWorkLog,
  renderTelegramWorkLog,
} from "./work-log.js";

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
  beforeEach(() => {
    workLogTesting.resetTelegramWorkLogsForTests();
    runStopTesting.resetTelegramRunStopsForTests();
  });

  it("serializes pending first send, flushes pending progress edit, then deletes the same message", async () => {
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
    expect(api.editMessageText).toHaveBeenCalledWith(
      123,
      77,
      "Opening example.com\n\nReading IANA example domains",
    );
    expect(api.deleteMessage).toHaveBeenCalledWith(123, 77);
    expect(api.editMessageText.mock.invocationCallOrder[0]).toBeLessThan(
      api.deleteMessage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
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

  it("hosts an active Stop control on a temporary Working bubble and removes it safely", async () => {
    const onDispose = vi.fn();
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 77 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const controller = createTelegramProgressController({
      api: api as unknown as Bot["api"],
      chatId: 123,
      maxChars: 4096,
      minInitialChars: 1,
      activeReplyMarkup: {
        inline_keyboard: [[{ text: "⏹ Stop", callback_data: "ors:1", style: "danger" }]],
      },
      onDispose,
      renderText: (text) => ({ text }),
    });

    controller.start("Working…");
    await vi.waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Working…", {
        reply_markup: {
          inline_keyboard: [[{ text: "⏹ Stop", callback_data: "ors:1", style: "danger" }]],
        },
      }),
    );
    await expect(controller.retainAsWorkLog()).resolves.toEqual({ retained: false });
    await controller.clear();

    expect(api.editMessageReplyMarkup).toHaveBeenCalledWith(123, 77, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(api.deleteMessage).toHaveBeenCalledWith(123, 77);
    expect(onDispose).toHaveBeenCalledTimes(1);
  });

  it("releases the active Stop claim when progress cleanup flush fails", async () => {
    const onDispose = vi.fn();
    const adoptedStream = {
      update: vi.fn(),
      flush: vi.fn().mockRejectedValue(new Error("flush failed")),
      messageId: vi.fn().mockReturnValue(88),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      materialize: vi.fn().mockResolvedValue(88),
      forceNewMessage: vi.fn(),
    };
    const controller = createTelegramProgressController({
      api: { editMessageReplyMarkup: vi.fn() } as unknown as Bot["api"],
      chatId: 123,
      maxChars: 4096,
      stream: adoptedStream,
      activeReplyMarkup: {
        inline_keyboard: [[{ text: "⏹ Stop", callback_data: "ors:1", style: "danger" }]],
      },
      onDispose,
      renderText: (text) => ({ text }),
    });

    await expect(controller.clear()).rejects.toThrow("flush failed");

    expect(adoptedStream.clear).not.toHaveBeenCalled();
    expect(onDispose).toHaveBeenCalledTimes(1);
  });

  it("retires run A before stalled cleanup can overlap same-route run B", () => {
    const route = {
      accountId: "default",
      chatId: 123,
      requesterId: 9,
      threadId: 77,
    };
    const runA = registerTelegramRunStop(route);
    const runAToken = runA.buttons[0]?.[0]?.callback_data ?? "";
    const neverFlushes = new Promise<void>(() => {});
    const controller = createTelegramProgressController({
      api: {} as Bot["api"],
      chatId: 123,
      maxChars: 4096,
      stream: {
        update: vi.fn(),
        flush: vi.fn().mockReturnValue(neverFlushes),
        messageId: vi.fn().mockReturnValue(88),
        clear: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        materialize: vi.fn().mockResolvedValue(88),
        forceNewMessage: vi.fn(),
      },
      activeReplyMarkup: {
        inline_keyboard: runA.buttons.map((row) => row.map((button) => ({ ...button }))),
      },
      onDispose: runA.release,
      renderText: (text) => ({ text }),
    });

    // Do not await: this models dispatch cleanup timing out while Telegram's
    // flush remains stuck. The terminal transition itself must revoke run A.
    void controller.clear();
    const runB = registerTelegramRunStop(route);
    const runBToken = runB.buttons[0]?.[0]?.callback_data ?? "";

    expect(
      claimTelegramRunStop({
        data: runAToken,
        ...route,
      }),
    ).toEqual({ status: "stale" });
    expect(
      claimTelegramRunStop({
        data: runBToken,
        ...route,
      })?.status,
    ).toBe("claimed");
  });

  it("releases the active Stop claim when Work log conversion flush fails", async () => {
    const onDispose = vi.fn();
    const adoptedStream = {
      update: vi.fn(),
      flush: vi.fn().mockRejectedValue(new Error("flush failed")),
      messageId: vi.fn().mockReturnValue(88),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      materialize: vi.fn().mockResolvedValue(88),
      forceNewMessage: vi.fn(),
    };
    const controller = createTelegramProgressController({
      api: { editMessageText: vi.fn() } as unknown as Bot["api"],
      chatId: 123,
      maxChars: 4096,
      stream: adoptedStream,
      activeReplyMarkup: {
        inline_keyboard: [[{ text: "⏹ Stop", callback_data: "ors:1", style: "danger" }]],
      },
      onDispose,
      renderText: (text) => ({ text }),
    });
    controller.update("Checking workspace state.");

    await expect(controller.retainAsWorkLog()).rejects.toThrow("flush failed");

    expect(adoptedStream.materialize).not.toHaveBeenCalled();
    expect(onDispose).toHaveBeenCalledTimes(1);
  });

  it("can adopt an existing visible stream as the progress bubble", async () => {
    const adoptedStream = {
      update: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      messageId: vi.fn().mockReturnValue(88),
      previewMode: vi.fn().mockReturnValue("message"),
      previewRevision: vi.fn().mockReturnValue(1),
      lastDeliveredText: vi.fn().mockReturnValue("Speculative answer preview."),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      materialize: vi.fn().mockResolvedValue(88),
      forceNewMessage: vi.fn(),
      sendMayHaveLanded: vi.fn().mockReturnValue(false),
    };
    const api = {
      sendMessage: vi.fn(),
      editMessageText: vi.fn(),
      deleteMessage: vi.fn(),
    };
    const controller = createTelegramProgressController({
      api: api as unknown as Bot["api"],
      chatId: 123,
      maxChars: 4096,
      minInitialChars: 1,
      stream: adoptedStream,
      renderText: (text) => ({ text }),
    });

    controller.update("Checking workspace state.");
    await controller.clear();

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(adoptedStream.update).toHaveBeenCalledWith("Checking workspace state.");
    expect(adoptedStream.clear).toHaveBeenCalledTimes(1);
    expect(controller.messageId()).toBe(88);
  });

  it("reopens the progress stream when acknowledgment materialization has no message id", async () => {
    const adoptedStream = {
      update: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      messageId: vi.fn().mockReturnValue(undefined),
      previewMode: vi.fn().mockReturnValue("draft"),
      previewRevision: vi.fn().mockReturnValue(1),
      lastDeliveredText: vi.fn().mockReturnValue("I’ll inspect the files, then run tests."),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      materialize: vi.fn().mockResolvedValue(undefined),
      forceNewMessage: vi.fn(),
      sendMayHaveLanded: vi.fn().mockReturnValue(false),
    };
    const controller = createTelegramProgressController({
      api: {} as Bot["api"],
      chatId: 123,
      maxChars: 4096,
      minInitialChars: 1,
      stream: adoptedStream,
      renderText: (text) => ({ text }),
    });

    controller.update("I’ll inspect the files, then run tests.");
    await expect(controller.materialize()).resolves.toBeUndefined();
    controller.updatePlan("Plan updated\n- [~] Inspect files\n- [ ] Run tests");

    // materialize() stops a Telegram draft even when it cannot return an ID.
    // The replacement plan must therefore reopen a new preview generation.
    expect(adoptedStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(adoptedStream.forceNewMessage.mock.invocationCallOrder[0]).toBeLessThan(
      adoptedStream.update.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY,
    );
    expect(adoptedStream.update).toHaveBeenLastCalledWith(
      "I’ll inspect the files, then run tests.\n\nPlan updated\n- [~] Inspect files\n- [ ] Run tests",
    );
  });

  it("can discard pending progress edits before deleting the visible final-bound bubble", async () => {
    const adoptedStream = {
      update: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      messageId: vi.fn().mockReturnValue(88),
      previewMode: vi.fn().mockReturnValue("message"),
      previewRevision: vi.fn().mockReturnValue(1),
      lastDeliveredText: vi.fn().mockReturnValue("Already visible progress."),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      materialize: vi.fn().mockResolvedValue(88),
      forceNewMessage: vi.fn(),
      sendMayHaveLanded: vi.fn().mockReturnValue(false),
    };
    const api = {
      sendMessage: vi.fn(),
      editMessageText: vi.fn(),
      deleteMessage: vi.fn(),
    };
    const controller = createTelegramProgressController({
      api: api as unknown as Bot["api"],
      chatId: 123,
      maxChars: 4096,
      minInitialChars: 1,
      stream: adoptedStream,
      renderText: (text) => ({ text }),
    });

    controller.update("Stale progress edit still queued.");
    await controller.clear({ flushBeforeDelete: false, waitForInFlight: false });

    expect(adoptedStream.update).toHaveBeenCalledWith("Stale progress edit still queued.");
    expect(adoptedStream.flush).not.toHaveBeenCalled();
    expect(adoptedStream.clear).toHaveBeenCalledWith({ waitForInFlight: false });
  });

  it("can retain visible progress as a collapsed work log instead of deleting it", async () => {
    const { api, controller, resolveFirstSend } = createProgressControllerHarness();

    controller.update("Opening example.com");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    resolveFirstSend?.({ message_id: 77 });
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));

    controller.update("Reading IANA example domains");
    const retained = await controller.retainAsWorkLog({ toolNames: ["browser.open"] });

    expect(retained).toEqual({ retained: true, messageId: 77, workLogId: "1" });
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).toHaveBeenLastCalledWith(123, 77, "Work log", {
      reply_markup: {
        inline_keyboard: [[{ text: "Show", callback_data: "wl:1:show" }]],
      },
    });
  });

  it("expands retained work log progress through the registered callback state", async () => {
    const { api, controller, resolveFirstSend } = createProgressControllerHarness();

    controller.update("Opening example.com");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    resolveFirstSend?.({ message_id: 77 });
    controller.update("Reading IANA example domains");
    await controller.retainAsWorkLog({ toolNames: ["browser.open"] });

    const workLog = getTelegramWorkLog("1");
    expect(workLog).toBeDefined();
    expect(renderTelegramWorkLog(workLog!, true)).toEqual({
      text: "Work log\n\nOpening example.com\n\nReading IANA example domains",
      buttons: [[{ text: "Hide", callback_data: "wl:1:hide" }]],
    });
  });

  it("retains acknowledgment, latest plan, and commentary in first-seen Work log order", async () => {
    const { api, controller, resolveFirstSend } = createProgressControllerHarness();

    controller.update("I’ll inspect the package first, then run the checks.");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    resolveFirstSend?.({ message_id: 77 });
    controller.updatePlan("Plan updated\n- [~] Inspect package\n- [ ] Run checks");
    controller.update("The package is confirmed; I’m running the checks now.");
    controller.updatePlan("Plan updated\n- [x] Inspect package\n- [~] Run checks");
    await controller.retainAsWorkLog({ toolNames: ["exec"] });

    const workLog = getTelegramWorkLog("1");
    expect(workLog).toBeDefined();
    expect(renderTelegramWorkLog(workLog!, true)).toEqual({
      text: [
        "Work log",
        "I’ll inspect the package first, then run the checks.",
        "Plan updated\n- [x] Inspect package\n- [~] Run checks",
        "The package is confirmed; I’m running the checks now.",
      ].join("\n\n"),
      buttons: [[{ text: "Hide", callback_data: "wl:1:hide" }]],
    });
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

  it("updates one plan slot without discarding acknowledgment or later progress", async () => {
    const { api, controller, resolveFirstSend } = createProgressControllerHarness();

    controller.update("Opening example.com");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    resolveFirstSend?.({ message_id: 77 });
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));

    controller.updatePlan("Plan updated\n- [~] Run tests");
    await vi.waitFor(() =>
      expect(api.editMessageText).toHaveBeenLastCalledWith(
        123,
        77,
        "Opening example.com\n\nPlan updated\n- [~] Run tests",
      ),
    );

    controller.update("Collecting logs");
    await vi.waitFor(() =>
      expect(api.editMessageText).toHaveBeenLastCalledWith(
        123,
        77,
        "Opening example.com\n\nPlan updated\n- [~] Run tests\n\nCollecting logs",
      ),
    );
    controller.updatePlan("Plan updated\n- [x] Run tests");
    await vi.waitFor(
      () =>
        expect(api.editMessageText).toHaveBeenLastCalledWith(
          123,
          77,
          "Opening example.com\n\nPlan updated\n- [x] Run tests\n\nCollecting logs",
        ),
      { timeout: 3_000 },
    );
    expect(String(api.editMessageText.mock.lastCall?.[2] ?? "")).not.toContain("[~] Run tests");
  });

  it("caps plan snapshots while preserving earlier Work log history when space allows", async () => {
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

    controller.update("Initial progress that should be replaced.");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    controller.updatePlan(
      [
        "Plan updated",
        "- [x] First very long checklist row that should not survive replacement truncation.",
        "- [~] Latest replacement row must remain visible even after capping.",
      ].join("\n"),
    );
    await vi.waitFor(() => expect(api.editMessageText).toHaveBeenCalled());

    const replacementText = String(api.editMessageText.mock.lastCall?.[2] ?? "");
    expect(replacementText.length).toBeLessThanOrEqual(80);
    expect(replacementText).toContain("Latest replacement row");

    controller.update("After replacement");
    await vi.waitFor(() =>
      expect(api.editMessageText).toHaveBeenLastCalledWith(
        123,
        77,
        expect.stringContaining("After replacement"),
      ),
    );
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
