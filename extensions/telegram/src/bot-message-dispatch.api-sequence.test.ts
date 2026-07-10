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

function workLogEditCalls(calls: readonly TelegramApiCall[]) {
  return editMessageTextCalls(calls).filter((call) => call.text === "Work log");
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

  it("keeps acknowledgment, plan, and streamed final on separate stable messages", async () => {
    const harness = createTelegramBotHarness(6950);
    const acknowledgment =
      "I’ll inspect the package metadata first, then verify the temp-file round trip.";
    const planText = "Plan updated\n- [x] Inspect files\n- [~] Run tests";
    const partialAnswer = "Package metadata and the temp-file round trip are verified.";
    const finalAnswer = `${partialAnswer} All three checks passed.`;

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: acknowledgment });
        await vi.waitFor(() =>
          expect(
            sendMessageCalls(harness.calls).some((call) => call.text.includes(acknowledgment)),
          ).toBe(true),
        );
        await replyOptions?.onToolStart?.({ name: "update_plan", phase: "completed" });
        await replyOptions?.onToolResult?.({
          text: planText,
          channelData: { openclaw: { sourcePreview: true, progressKind: "plan" } },
        });
        await vi.waitFor(() =>
          expect(
            sendMessageCalls(harness.calls).some((call) => call.text.includes("Plan updated")),
          ).toBe(true),
        );
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: partialAnswer });
        await vi.waitFor(() =>
          expect(
            sendMessageCalls(harness.calls).some((call) => call.text.includes(partialAnswer)),
          ).toBe(true),
        );
        await dispatcherOptions.deliver({ text: finalAnswer }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithHarness({
      bot: harness.bot,
      cfg: { channels: { telegram: { accounts: { default: { botToken: "123:test" } } } } },
      context: createContext({
        ctxPayload: { CommandAuthorized: true, SessionKey: "ack-plan-final-api-sequence" },
      }),
    });

    const acknowledgmentSend = sendMessageCalls(harness.calls).find((call) =>
      call.text.includes(acknowledgment),
    );
    const planSend = sendMessageCalls(harness.calls).find((call) =>
      call.text.includes("Plan updated"),
    );
    const previewSend = sendMessageCalls(harness.calls).find((call) =>
      call.text.includes(partialAnswer),
    );

    expect(acknowledgmentSend).toBeDefined();
    expect(planSend).toBeDefined();
    expect(previewSend).toBeDefined();
    // Assert Telegram API order and identity, not merely callback order: the
    // acknowledgment remains visible, plan owns Work log, and final owns one ID.
    expect(harness.calls).toEqual([
      expect.objectContaining({
        op: "sendMessage",
        messageId: acknowledgmentSend!.messageId,
        text: acknowledgment,
      }),
      expect.objectContaining({
        op: "sendMessage",
        messageId: planSend!.messageId,
        text: expect.stringContaining("Plan updated"),
      }),
      expect.objectContaining({
        op: "sendMessage",
        messageId: previewSend!.messageId,
        text: partialAnswer,
      }),
      expect.objectContaining({
        op: "editMessageText",
        messageId: planSend!.messageId,
        text: "Work log",
      }),
      expect.objectContaining({
        op: "editMessageText",
        messageId: planSend!.messageId,
        text: "Work log",
      }),
      expect.objectContaining({
        op: "editMessageText",
        messageId: previewSend!.messageId,
        text: finalAnswer,
      }),
    ]);
    expect(deleteMessageCalls(harness.calls)).toHaveLength(0);
    expect(
      sendMessageCalls(harness.calls).filter((call) => call.text.includes(finalAnswer)),
    ).toHaveLength(0);
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
    expect(workLogEditCalls(harness.calls)).not.toHaveLength(0);
    expect(deleteMessageCalls(harness.calls)).toHaveLength(0);
    expect(finalSends[0]?.messageId).not.toBe(progressSend?.messageId);
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
    expect(workLogEditCalls(harness.calls)).not.toHaveLength(0);
    expect(deleteMessageCalls(harness.calls)).toHaveLength(0);
    expect(finalSends[0]?.messageId).not.toBe(progressSend?.messageId);
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
    expect(workLogEditCalls(harness.calls)).not.toHaveLength(0);
    expect(deleteMessageCalls(harness.calls)).toHaveLength(0);
    expect(finalSends[0]?.messageId).not.toBe(progressSend?.messageId);
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
    expect(workLogEditCalls(harness.calls)).not.toHaveLength(0);
    expect(deleteMessageCalls(harness.calls)).toHaveLength(0);
    expect(finalSends[0]?.messageId).not.toBe(progressSend?.messageId);
    expect(harness.sendVoice).not.toHaveBeenCalled();
    expect(harness.sendAudio).not.toHaveBeenCalled();
  });

  it("still sends final text once after work log retention", async () => {
    const harness = createTelegramBotHarness();

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Opening example.com" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "Final answer after progress." }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithHarness({ bot: harness.bot });

    const finalSends = sendMessageCalls(harness.calls).filter((call) =>
      call.text.includes("Final answer after progress."),
    );
    expect(workLogEditCalls(harness.calls)).not.toHaveLength(0);
    expect(harness.deleteMessage).not.toHaveBeenCalled();
    expect(finalSends).toHaveLength(1);
    expect(harness.sendVoice).not.toHaveBeenCalled();
    expect(harness.sendAudio).not.toHaveBeenCalled();
  });

  it("sends final text after retaining progress as work log", async () => {
    const harness = createTelegramBotHarness();

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Opening example.com" }, { kind: "block" });
      await dispatcherOptions.deliver(
        { text: "Final answer after retained work log." },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithHarness({ bot: harness.bot });

    const sends = sendMessageCalls(harness.calls);
    const progressSend = sends[0];
    const finalSend = sends.find((call) =>
      call.text.includes("Final answer after retained work log."),
    );
    expect(workLogEditCalls(harness.calls)).not.toHaveLength(0);
    expect(finalSend?.messageId).not.toBe(progressSend?.messageId);
  });
});
