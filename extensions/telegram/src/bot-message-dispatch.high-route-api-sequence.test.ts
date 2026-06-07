import type { Bot } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GetReplyOptions, ReplyPayload } from "../../../src/auto-reply/types.js";
import type { OpenClawConfig } from "../../../src/config/types.js";
import type { RuntimeEnv } from "../../../src/runtime.js";

const loadSessionStore = vi.hoisted(() => vi.fn());
const logVerbose = vi.hoisted(() => vi.fn());
const recordChannelActivity = vi.hoisted(() => vi.fn());
const resolveStorePath = vi.hoisted(() => vi.fn(() => "/tmp/sessions.json"));
const getReplyFromConfig = vi.hoisted(() => vi.fn());

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

vi.mock("../../../src/auto-reply/reply.js", () => ({
  getReplyFromConfig,
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
    ctxPayload: {
      Provider: "telegram",
      Surface: "telegram",
      Body: "do the thing",
      BodyForAgent: "do the thing",
    },
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

function createTelegramBotHarness(startMessageId = 7200) {
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
    sendAudio,
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

describe("dispatchTelegramMessage high-route progress API sequence", () => {
  beforeEach(() => {
    getReplyFromConfig.mockReset();
    loadSessionStore.mockReset();
    logVerbose.mockReset();
    recordChannelActivity.mockReset();
    resolveStorePath.mockReset();
    loadSessionStore.mockReturnValue({});
    resolveStorePath.mockReturnValue("/tmp/sessions.json");
  });

  it("keeps generic block-streaming commentary transient before the final answer", async () => {
    const harness = createTelegramBotHarness();
    const firstCommentary = "Checking the temp file state before I touch anything.";
    const secondCommentary = "Running the delete verification now.";
    const finalAnswer = "The three notes were written and the temp file was deleted.";

    getReplyFromConfig.mockImplementation(async (_ctx, opts?: GetReplyOptions) => {
      // Live provider callbacks can be fire-and-forget. The dispatcher still
      // has to preserve product order: progress first, cleanup, then one final.
      void opts?.onBlockReply?.({ text: firstCommentary });
      void opts?.onBlockReply?.({ text: secondCommentary });
      return { text: finalAnswer };
    });

    await dispatchWithHarness({
      bot: harness.bot,
      context: createContext({ ctxPayload: { SessionKey: "high-route-generic-progress" } }),
      telegramCfg: { blockStreaming: true },
    });

    const sends = sendMessageCalls(harness.calls);
    const progressSend = sends[0];
    const finalSends = sends.filter((call) => call.text.includes(finalAnswer));

    expect(progressSend).toBeDefined();
    expect(finalSends).toHaveLength(1);
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

  it("keeps flushed tool-boundary commentary transient when the terminal answer is a later block", async () => {
    const harness = createTelegramBotHarness(7300);
    const firstCommentary = "Step 1: writing the first note.";
    const secondCommentary = "Step 2: adding the second note.";
    const thirdCommentary = "Step 3: adding the third note.";
    const finalAnswer =
      "Notes covered example.com, IANA reserved domains, and MDN HTML basics; the file was removed.";

    getReplyFromConfig.mockImplementation(async (_ctx, opts?: GetReplyOptions) => {
      // This mirrors the observed live shape: each tool-boundary assistant text
      // was delivered as a block before the final-answer text block arrived.
      const commentaryChannelData = { openclaw: { assistantPhase: "commentary" } };
      await opts?.onBlockReply?.({ text: firstCommentary, channelData: commentaryChannelData });
      await opts?.onBlockReply?.({ text: secondCommentary, channelData: commentaryChannelData });
      await opts?.onBlockReply?.({ text: thirdCommentary, channelData: commentaryChannelData });
      await opts?.onBlockReply?.({
        text: finalAnswer,
        channelData: { openclaw: { assistantPhase: "final_answer" } },
      });
      return undefined;
    });

    await dispatchWithHarness({
      bot: harness.bot,
      context: createContext({ ctxPayload: { SessionKey: "terminal-phase-unknown-high-route" } }),
      telegramCfg: { blockStreaming: true },
    });

    const sends = sendMessageCalls(harness.calls);
    const progressSend = sends[0];
    const finalSends = sends.filter((call) => call.text.includes("Notes covered"));

    expect(progressSend).toBeDefined();
    expect(finalSends).toHaveLength(1);
    expect(harness.calls).toEqual([
      expect.objectContaining({
        op: "sendMessage",
        messageId: progressSend!.messageId,
        text: firstCommentary,
      }),
      expect.objectContaining({
        op: "editMessageText",
        messageId: progressSend!.messageId,
        text: `${firstCommentary}\n\n${secondCommentary}\n\n${thirdCommentary}`,
      }),
      expect.objectContaining({
        op: "deleteMessage",
        messageId: progressSend!.messageId,
      }),
      expect.objectContaining({
        op: "sendMessage",
        text: expect.stringContaining("Notes covered"),
      }),
    ]);
    expect(harness.sendVoice).not.toHaveBeenCalled();
    expect(harness.sendAudio).not.toHaveBeenCalled();
  });

  it("reuses one progress message across continuation dispatches until the final answer", async () => {
    const harness = createTelegramBotHarness(7400);
    const firstCommentary = "Step 1: starting the first note.";
    const secondCommentary = "Step 2: adding the second note.";
    const finalAnswer = "The notes were written and the temp file was removed.";
    const commentaryChannelData = { openclaw: { assistantPhase: "commentary" } };

    getReplyFromConfig.mockImplementationOnce(async (_ctx, opts?: GetReplyOptions) => {
      await opts?.onBlockReply?.({ text: firstCommentary, channelData: commentaryChannelData });
      return undefined;
    });
    await dispatchWithHarness({
      bot: harness.bot,
      context: createContext({ ctxPayload: { SessionKey: "telegram-progress-session" } }),
      telegramCfg: { blockStreaming: true },
    });

    getReplyFromConfig.mockImplementationOnce(async (_ctx, opts?: GetReplyOptions) => {
      await opts?.onBlockReply?.({ text: secondCommentary, channelData: commentaryChannelData });
      return undefined;
    });
    await dispatchWithHarness({
      bot: harness.bot,
      context: createContext({ ctxPayload: { SessionKey: "telegram-progress-session" } }),
      telegramCfg: { blockStreaming: true },
    });

    getReplyFromConfig.mockImplementationOnce(async (_ctx, opts?: GetReplyOptions) => {
      await opts?.onBlockReply?.({
        text: finalAnswer,
        channelData: { openclaw: { assistantPhase: "final_answer" } },
      });
      return undefined;
    });
    await dispatchWithHarness({
      bot: harness.bot,
      context: createContext({ ctxPayload: { SessionKey: "telegram-progress-session" } }),
      telegramCfg: { blockStreaming: true },
    });

    const sends = sendMessageCalls(harness.calls);
    const progressSend = sends[0];
    const finalSends = sends.filter((call) => call.text.includes(finalAnswer));

    expect(progressSend).toBeDefined();
    expect(finalSends).toHaveLength(1);
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

  it("treats a terminal phase-unknown block as final after prior progress", async () => {
    const harness = createTelegramBotHarness(7500);
    const progressText = "Step 3/3: appending the final delayed note.";
    const finalAnswer = "Done. The notes were written and the temp file was deleted.";

    getReplyFromConfig.mockImplementation(async (_ctx, opts?: GetReplyOptions) => {
      await opts?.onBlockReply?.({
        text: progressText,
        channelData: { openclaw: { assistantPhase: "commentary" } },
      });
      await opts?.onBlockReply?.({ text: finalAnswer });
      return undefined;
    });

    await dispatchWithHarness({
      bot: harness.bot,
      telegramCfg: { blockStreaming: true },
    });

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
});
