import type { Bot } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.js";
import type { RuntimeEnv } from "../../../src/runtime.js";

const dispatchReplyWithBufferedBlockDispatcher = vi.hoisted(() => vi.fn());
const loadSessionStore = vi.hoisted(() => vi.fn());
const logVerbose = vi.hoisted(() => vi.fn());
const recordChannelActivity = vi.hoisted(() => vi.fn());
const resolveStorePath = vi.hoisted(() => vi.fn(() => "/tmp/sessions.json"));

vi.mock("../../../src/auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher,
}));

vi.mock("../../../src/config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore,
    resolveStorePath,
  };
});

vi.mock("../../../src/globals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/globals.js")>();
  return {
    ...actual,
    logVerbose,
  };
});

vi.mock("../../../src/infra/channel-activity.js", () => ({
  recordChannelActivity,
}));

vi.mock("./sticker-cache.js", () => ({
  cacheSticker: vi.fn(),
  describeStickerImage: vi.fn(),
}));

import { dispatchTelegramMessage } from "./bot-message-dispatch.js";

type TelegramMessageContext = Parameters<typeof dispatchTelegramMessage>[0]["context"];

type TelegramApiCall =
  | {
      op: "sendMessage";
      chatId: string | number;
      text: string;
      messageId: number;
      params: unknown;
    }
  | {
      op: "editMessageText";
      chatId: string | number;
      messageId: number;
      text: string;
      params: unknown;
    }
  | {
      op: "deleteMessage";
      chatId: string | number;
      messageId: number;
    };

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: () => {
      throw new Error("exit");
    },
  };
}

function createContext(overrides?: Partial<TelegramMessageContext>): TelegramMessageContext {
  const base = {
    ctxPayload: { CommandAuthorized: true },
    primaryCtx: { message: { chat: { id: 123, type: "private" } } },
    msg: {
      chat: { id: 123, type: "private" },
      message_id: 456,
      message_thread_id: 777,
    },
    chatId: 123,
    isGroup: false,
    resolvedThreadId: undefined,
    replyThreadId: 777,
    threadSpec: { id: 777, scope: "dm" },
    historyKey: undefined,
    historyLimit: 0,
    groupHistories: new Map(),
    route: { agentId: "default", accountId: "default" },
    skillFilter: undefined,
    sendTyping: vi.fn(),
    sendRecordVoice: vi.fn(),
    ackReactionPromise: null,
    reactionApi: null,
    removeAckAfterReply: false,
  } as unknown as TelegramMessageContext;

  return {
    ...base,
    ...overrides,
    ctxPayload: {
      ...(base.ctxPayload as object),
      ...(overrides?.ctxPayload ? (overrides.ctxPayload as object) : null),
    } as TelegramMessageContext["ctxPayload"],
    primaryCtx: {
      ...(base.primaryCtx as object),
      ...(overrides?.primaryCtx ? (overrides.primaryCtx as object) : null),
    } as TelegramMessageContext["primaryCtx"],
    msg: {
      ...(base.msg as object),
      ...(overrides?.msg ? (overrides.msg as object) : null),
    } as TelegramMessageContext["msg"],
    route: {
      ...(base.route as object),
      ...(overrides?.route ? (overrides.route as object) : null),
    } as TelegramMessageContext["route"],
  };
}

function createTelegramBotHarness(startMessageId = 7000) {
  const calls: TelegramApiCall[] = [];
  let nextMessageId = startMessageId;
  const sendMessage = vi.fn(
    async (
      chatId: string | number,
      text: string,
      params?: Record<string, unknown>,
    ): Promise<{ message_id: number }> => {
      const messageId = nextMessageId++;
      calls.push({
        op: "sendMessage",
        chatId,
        text,
        messageId,
        params,
      });
      return { message_id: messageId };
    },
  );
  const editMessageText = vi.fn(
    async (
      chatId: string | number,
      messageId: number,
      text: string,
      params?: Record<string, unknown>,
    ) => {
      calls.push({
        op: "editMessageText",
        chatId,
        messageId,
        text,
        params,
      });
      return true;
    },
  );
  const deleteMessage = vi.fn(async (chatId: string | number, messageId: number) => {
    calls.push({
      op: "deleteMessage",
      chatId,
      messageId,
    });
    return true;
  });
  const sendVoice = vi.fn();
  const sendAudio = vi.fn();

  const bot = {
    api: {
      sendMessage,
      editMessageText,
      deleteMessage,
      sendVoice,
      sendAudio,
    },
  } as unknown as Bot;

  return {
    bot,
    calls,
    deleteMessage,
    editMessageText,
    sendAudio,
    sendMessage,
    sendVoice,
  };
}

async function dispatchWithHarness(params: {
  bot: Bot;
  context?: TelegramMessageContext;
  cfg?: OpenClawConfig;
  telegramCfg?: Parameters<typeof dispatchTelegramMessage>[0]["telegramCfg"];
}) {
  await dispatchTelegramMessage({
    context: params.context ?? createContext(),
    bot: params.bot,
    cfg: params.cfg ?? {},
    runtime: createRuntime(),
    replyToMode: "first",
    streamMode: "partial",
    textLimit: 4096,
    telegramCfg: params.telegramCfg ?? {},
    opts: { token: "token" },
  });
}

function sendMessageCalls(calls: readonly TelegramApiCall[]) {
  return calls.filter((call): call is Extract<TelegramApiCall, { op: "sendMessage" }> => {
    return call.op === "sendMessage";
  });
}

function editMessageTextCalls(calls: readonly TelegramApiCall[]) {
  return calls.filter((call): call is Extract<TelegramApiCall, { op: "editMessageText" }> => {
    return call.op === "editMessageText";
  });
}

function deleteMessageCalls(calls: readonly TelegramApiCall[]) {
  return calls.filter((call): call is Extract<TelegramApiCall, { op: "deleteMessage" }> => {
    return call.op === "deleteMessage";
  });
}

describe("dispatchTelegramMessage progress API sequence", () => {
  beforeEach(() => {
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    loadSessionStore.mockReset();
    logVerbose.mockReset();
    recordChannelActivity.mockReset();
    resolveStorePath.mockReset();
    loadSessionStore.mockReturnValue({});
    resolveStorePath.mockReturnValue("/tmp/sessions.json");
  });

  it("uses one mutable progress message, clears it, and sends final text once", async () => {
    const harness = createTelegramBotHarness();
    const finalAnswer =
      "Example.com is reserved for examples. IANA documents example domains. MDN documents HTML.";

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await dispatcherOptions.deliver({ text: "Opening example.com" }, { kind: "block" });
        await replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.deliver(
          { text: "Reading IANA example domains" },
          { kind: "block" },
        );
        await dispatcherOptions.deliver({ text: finalAnswer }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithHarness({
      bot: harness.bot,
      context: createContext({
        ctxPayload: { CommandAuthorized: true, SessionKey: "api-progress-sequence" },
      }),
    });

    const sends = sendMessageCalls(harness.calls);
    const progressSend = sends[0];
    const finalSends = sends.filter((call) => call.text.includes("reserved for examples"));

    expect(progressSend).toBeDefined();
    expect(finalSends).toHaveLength(1);
    expect(harness.calls).toEqual([
      expect.objectContaining({
        op: "sendMessage",
        messageId: progressSend!.messageId,
        text: expect.stringContaining("Opening"),
      }),
      expect.objectContaining({
        op: "editMessageText",
        messageId: progressSend!.messageId,
        text: expect.stringMatching(/Opening[\s\S]*Reading IANA example domains/),
      }),
      expect.objectContaining({
        op: "deleteMessage",
        messageId: progressSend!.messageId,
      }),
      expect.objectContaining({
        op: "sendMessage",
        text: expect.stringContaining("reserved for examples"),
      }),
    ]);
    expect(harness.sendVoice).not.toHaveBeenCalled();
    expect(harness.sendAudio).not.toHaveBeenCalled();
  });

  it("keeps live block-streaming commentary transient before final text", async () => {
    const harness = createTelegramBotHarness();
    const commentary = "Doing it step by step so there's actual proof, not vibes.";
    const finalAnswer =
      "Wrote and verified the three notes, and the temp file was deleted successfully.";

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: commentary }, { kind: "block" });
      await dispatcherOptions.deliver({ text: finalAnswer }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithHarness({
      bot: harness.bot,
      telegramCfg: { blockStreaming: true },
    });

    const sends = sendMessageCalls(harness.calls);
    const progressSend = sends[0];
    const finalSends = sends.filter((call) => call.text.includes("Wrote and verified"));

    expect(progressSend).toBeDefined();
    expect(finalSends).toHaveLength(1);
    expect(harness.calls).toEqual([
      expect.objectContaining({
        op: "sendMessage",
        messageId: progressSend!.messageId,
        text: commentary,
      }),
      expect.objectContaining({
        op: "deleteMessage",
        messageId: progressSend!.messageId,
      }),
      expect.objectContaining({
        op: "sendMessage",
        text: finalAnswer,
      }),
    ]);
    expect(harness.sendVoice).not.toHaveBeenCalled();
    expect(harness.sendAudio).not.toHaveBeenCalled();
  });

  it("does not turn commentary partial previews into durable progress messages", async () => {
    const harness = createTelegramBotHarness(7600);
    const firstCommentary = "Step 1: adding the first note after a 4-second wait.";
    const secondCommentary = "Step 2: adding the second note after another 4-second wait.";
    const finalAnswer = "The notes were written and the temp file was deleted.";
    const commentaryChannelData = { openclaw: { assistantPhase: "commentary" } };

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Step" });
        await dispatcherOptions.deliver(
          { text: firstCommentary, channelData: commentaryChannelData },
          { kind: "block" },
        );
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Step 2" });
        await dispatcherOptions.deliver(
          { text: secondCommentary, channelData: commentaryChannelData },
          { kind: "block" },
        );
        await dispatcherOptions.deliver(
          {
            text: finalAnswer,
            channelData: { openclaw: { assistantPhase: "final_answer" } },
          },
          { kind: "block" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithHarness({
      bot: harness.bot,
      context: createContext({
        ctxPayload: { CommandAuthorized: true, SessionKey: "terminal-phase-unknown-api" },
      }),
    });

    const sends = sendMessageCalls(harness.calls);
    const progressSend = sends[0];
    const finalSends = sends.filter((call) => call.text.includes(finalAnswer));

    expect(progressSend).toBeDefined();
    expect(finalSends).toHaveLength(1);
    expect(sendMessageCalls(harness.calls).map((call) => call.text)).not.toContain("Step");
    expect(harness.calls).toEqual([
      expect.objectContaining({
        op: "sendMessage",
        messageId: progressSend!.messageId,
        text: firstCommentary,
      }),
      expect.objectContaining({
        op: "editMessageText",
        messageId: progressSend!.messageId,
        text: `${firstCommentary}\n\n${secondCommentary}`,
      }),
      expect.objectContaining({
        op: "deleteMessage",
        messageId: progressSend!.messageId,
      }),
      expect.objectContaining({
        op: "sendMessage",
        text: finalAnswer,
      }),
    ]);
    expect(harness.sendVoice).not.toHaveBeenCalled();
    expect(harness.sendAudio).not.toHaveBeenCalled();
  });

  it("sends a terminal phase-unknown block as final instead of editing the progress bubble", async () => {
    const harness = createTelegramBotHarness(7700);
    const progressText = "Step 3/3: appending the final delayed note.";
    const finalAnswer = "Done. The notes were written and the temp file was deleted.";

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: progressText,
          channelData: { openclaw: { assistantPhase: "commentary" } },
        },
        { kind: "block" },
      );
      await dispatcherOptions.deliver({ text: finalAnswer }, { kind: "block" });
      return { queuedFinal: false };
    });

    await dispatchWithHarness({ bot: harness.bot });

    const sends = sendMessageCalls(harness.calls);
    const progressSend = sends[0];
    const finalSends = sends.filter((call) => call.text.includes(finalAnswer));

    expect(progressSend).toBeDefined();
    expect(finalSends).toHaveLength(1);
    expect(finalSends[0]?.messageId).not.toBe(progressSend?.messageId);
    expect(harness.calls).toEqual([
      expect.objectContaining({
        op: "sendMessage",
        messageId: progressSend!.messageId,
        text: progressText,
      }),
      expect.objectContaining({
        op: "deleteMessage",
        messageId: progressSend!.messageId,
      }),
      expect.objectContaining({
        op: "sendMessage",
        text: finalAnswer,
      }),
    ]);
    expect(harness.sendVoice).not.toHaveBeenCalled();
    expect(harness.sendAudio).not.toHaveBeenCalled();
  });

  it("still sends final text once when progress deletion fails", async () => {
    const harness = createTelegramBotHarness();
    harness.deleteMessage.mockRejectedValueOnce(new Error("delete failed"));

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Opening example.com" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "Final answer after progress." }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithHarness({ bot: harness.bot });

    const finalSends = sendMessageCalls(harness.calls).filter((call) =>
      call.text.includes("Final answer after progress."),
    );
    expect(harness.deleteMessage).toHaveBeenCalledTimes(1);
    expect(finalSends).toHaveLength(1);
    expect(harness.sendVoice).not.toHaveBeenCalled();
    expect(harness.sendAudio).not.toHaveBeenCalled();
  });

  it("does not hold the final answer hostage when progress cleanup hangs", async () => {
    vi.useFakeTimers();
    try {
      const harness = createTelegramBotHarness();
      let resolveDelete: ((value: boolean) => void) | undefined;
      const stalledDelete = new Promise<boolean>((resolve) => {
        resolveDelete = resolve;
      });
      harness.deleteMessage.mockImplementationOnce(async (chatId, messageId) => {
        harness.calls.push({ op: "deleteMessage", chatId, messageId });
        return stalledDelete;
      });

      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "Opening example.com" }, { kind: "block" });
        await dispatcherOptions.deliver(
          { text: "Final answer after stalled progress cleanup." },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });

      const dispatchPromise = dispatchWithHarness({ bot: harness.bot });
      await vi.waitFor(() => expect(harness.deleteMessage).toHaveBeenCalledTimes(1));

      // Telegram cleanup is cosmetic. If delete/flush gets wedged, the durable
      // final answer still has to move after the bounded cleanup window.
      await vi.advanceTimersByTimeAsync(3_500);
      await vi.waitFor(() =>
        expect(
          sendMessageCalls(harness.calls).filter((call) =>
            call.text.includes("Final answer after stalled progress cleanup."),
          ),
        ).toHaveLength(1),
      );
      const sends = sendMessageCalls(harness.calls);
      const progressSend = sends[0];
      const finalSend = sends.find((call) =>
        call.text.includes("Final answer after stalled progress cleanup."),
      );
      expect(finalSend?.messageId).not.toBe(progressSend?.messageId);
      await expect(dispatchPromise).resolves.toBeUndefined();

      resolveDelete?.(true);
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });
});
