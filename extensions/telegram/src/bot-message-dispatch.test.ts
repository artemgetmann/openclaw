import path from "node:path";
import type { Bot } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isDurableFollowupMessageProcessed,
  loadDurableFollowups,
  persistDurableFollowup,
} from "../../../src/auto-reply/reply/queue/durable-store.js";
import { STATE_DIR } from "../../../src/config/paths.js";
import { withStateDirEnv } from "../../../src/test-helpers/state-dir-env.js";
import {
  createSequencedTestDraftStream,
  createTestDraftStream,
} from "./draft-stream.test-helpers.js";
import { __testing as workLogTesting } from "./work-log.js";

const createTelegramDraftStream = vi.hoisted(() => vi.fn());
const dispatchReplyWithBufferedBlockDispatcher = vi.hoisted(() => vi.fn());
const deliverReplies = vi.hoisted(() => vi.fn());
const prepareTelegramReplyForDelivery = vi.hoisted(() => vi.fn());
const editMessageTelegram = vi.hoisted(() => vi.fn());
const guardedTelegramDeleteMessage = vi.hoisted(() => vi.fn());
const loadSessionStore = vi.hoisted(() => vi.fn());
const resolveStorePath = vi.hoisted(() => vi.fn(() => "/tmp/sessions.json"));

vi.mock("./draft-stream.js", () => ({
  createTelegramDraftStream,
}));

vi.mock("../../../src/auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher,
}));

vi.mock("./bot/delivery.js", () => ({
  deliverReplies,
  prepareTelegramReplyForDelivery,
}));

vi.mock("./send.js", () => ({
  editMessageTelegram,
}));

vi.mock("./delete-guard.js", () => ({
  guardedTelegramDeleteMessage,
}));

vi.mock("../../../src/config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore,
    resolveStorePath,
  };
});

vi.mock("./sticker-cache.js", () => ({
  cacheSticker: vi.fn(),
  describeStickerImage: vi.fn(),
}));

import { dispatchTelegramMessage } from "./bot-message-dispatch.js";

describe("dispatchTelegramMessage Telegram delivery", () => {
  type TelegramMessageContext = Parameters<typeof dispatchTelegramMessage>[0]["context"];

  beforeEach(() => {
    createTelegramDraftStream.mockClear();
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
    deliverReplies.mockClear();
    prepareTelegramReplyForDelivery.mockReset();
    prepareTelegramReplyForDelivery.mockImplementation(async ({ reply }) => ({
      reply,
      cancelled: false,
    }));
    editMessageTelegram.mockClear();
    guardedTelegramDeleteMessage.mockReset();
    guardedTelegramDeleteMessage.mockResolvedValue({ ok: true, deleted: false, suppressed: true });
    workLogTesting.resetTelegramWorkLogsForTests();
    loadSessionStore.mockClear();
    resolveStorePath.mockClear();
    resolveStorePath.mockReturnValue("/tmp/sessions.json");
    loadSessionStore.mockReturnValue({});
  });

  const createDraftStream = (messageId?: number) => createTestDraftStream({ messageId });
  const createSequencedDraftStream = (startMessageId = 1001) =>
    createSequencedTestDraftStream(startMessageId);

  function createContext(overrides?: Partial<TelegramMessageContext>): TelegramMessageContext {
    const base = {
      ctxPayload: {},
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
      // Test cases usually override only the field under inspection. Keep the
      // rest of Telegram's nested context stable so failures point at dispatch.
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

  function createBot(options?: { richMessages?: boolean }): Bot {
    return {
      api: {
        sendMessage: vi.fn(),
        editMessageText: vi.fn(),
        deleteMessage: vi.fn().mockResolvedValue(true),
        ...(options?.richMessages ? { raw: { sendRichMessage: vi.fn() } } : {}),
      },
    } as unknown as Bot;
  }

  const createRichBot = () => createBot({ richMessages: true });

  function createRuntime(): Parameters<typeof dispatchTelegramMessage>[0]["runtime"] {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: () => {
        throw new Error("exit");
      },
    };
  }

  async function dispatchWithContext(params: {
    context: TelegramMessageContext;
    cfg?: Parameters<typeof dispatchTelegramMessage>[0]["cfg"];
    telegramCfg?: Parameters<typeof dispatchTelegramMessage>[0]["telegramCfg"];
    streamMode?: Parameters<typeof dispatchTelegramMessage>[0]["streamMode"];
    bot?: Bot;
    runtime?: Parameters<typeof dispatchTelegramMessage>[0]["runtime"];
  }) {
    const bot = params.bot ?? createBot();
    await dispatchTelegramMessage({
      context: params.context,
      bot,
      cfg: params.cfg ?? {},
      runtime: params.runtime ?? createRuntime(),
      replyToMode: "first",
      streamMode: params.streamMode ?? "partial",
      textLimit: 4096,
      telegramCfg: params.telegramCfg ?? {},
      opts: { token: "token" },
    });
  }

  function createReasoningStreamContext(): TelegramMessageContext {
    loadSessionStore.mockReturnValue({
      s1: { reasoningLevel: "stream" },
    });
    return createContext({
      ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
    });
  }

  function expectFinalPreviewEditedInPlace(messageId: number, text: string) {
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      messageId,
      text,
      expect.objectContaining({ richMessages: false }),
    );
    expect(deliverReplies).not.toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text })],
      }),
    );
    expect(guardedTelegramDeleteMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 123,
        messageId,
        audit: expect.objectContaining({
          reason: "lane_final_rich_replacement_preview_cleanup",
        }),
      }),
    );
  }

  function allowDeterministicPreviewDeletes() {
    guardedTelegramDeleteMessage.mockResolvedValue({ ok: true, deleted: true });
  }

  it("completes a direct-turn recovery record only after visible final delivery", async () => {
    await withStateDirEnv("openclaw-telegram-direct-turn-complete-", async () => {
      const queueKey = "agent:main:telegram:direct:123";
      const run = {
        prompt: "accepted input",
        messageId: "telegram:456",
        enqueuedAt: Date.now(),
        originatingChannel: "telegram" as const,
        originatingTo: "123",
        originatingAccountId: "default",
        originatingThreadId: 777,
        run: {
          agentId: "main",
          agentDir: "/tmp/agent",
          sessionId: "session-1",
          sessionKey: queueKey,
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp/workspace",
          config: {},
          provider: "test",
          model: "test",
          timeoutMs: 30_000,
          blockReplyBreak: "message_end" as const,
        },
      };
      const record = await persistDurableFollowup({
        queueKey,
        run,
        settings: { mode: "followup", debounceMs: 0, cap: 20 },
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions.onDurableReplyAccepted?.(record.id);
          await dispatcherOptions.deliver({ text: "Visible final." }, { kind: "final" });
          return { queuedFinal: true };
        },
      );
      deliverReplies.mockResolvedValue({ delivered: true });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "off",
      });

      expect(deliverReplies).toHaveBeenCalledWith(
        expect.objectContaining({
          replies: [expect.objectContaining({ text: "Visible final." })],
        }),
      );
      await expect(loadDurableFollowups()).resolves.toEqual([]);
      await expect(isDurableFollowupMessageProcessed({ queueKey, run })).resolves.toBe(true);
    });
  });

  it("retains direct-turn recovery when only a non-terminal payload was delivered", async () => {
    await withStateDirEnv("openclaw-telegram-direct-turn-nonterminal-", async () => {
      const queueKey = "agent:main:telegram:direct:123";
      const run = {
        prompt: "accepted input",
        messageId: "telegram:457",
        enqueuedAt: Date.now(),
        originatingChannel: "telegram" as const,
        originatingTo: "123",
        originatingAccountId: "default",
        originatingThreadId: 777,
        run: {
          agentId: "main",
          agentDir: "/tmp/agent",
          sessionId: "session-1",
          sessionKey: queueKey,
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp/workspace",
          config: {},
          provider: "test",
          model: "test",
          timeoutMs: 30_000,
          blockReplyBreak: "message_end" as const,
        },
      };
      const record = await persistDurableFollowup({
        queueKey,
        run,
        settings: { mode: "followup", debounceMs: 0, cap: 20 },
        deliveryPayloads: [{ text: "Visible recovery receipt.", isError: true }],
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions.onDurableReplyAccepted?.(record.id);
          // A tool/error envelope reaches Telegram, but the actual answer does
          // not. General delivery success must not erase terminal recovery.
          await dispatcherOptions.deliver(
            { text: "The intermediate tool reported a warning.", isError: true },
            { kind: "block" },
          );
          dispatcherOptions.onSkip?.({ text: "NO_REPLY" }, { reason: "silent", kind: "block" });
          await dispatcherOptions.deliver({ text: "Invisible final." }, { kind: "final" });
          return { queuedFinal: false };
        },
      );
      deliverReplies
        .mockResolvedValueOnce({ delivered: true })
        .mockResolvedValueOnce({ delivered: false });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "off",
      });

      expect(deliverReplies).toHaveBeenCalledTimes(2);
      await expect(loadDurableFollowups()).resolves.toEqual([
        expect.objectContaining({
          id: record.id,
          delivery: expect.objectContaining({
            payloads: [{ text: "Visible recovery receipt.", isError: true }],
          }),
        }),
      ]);
    });
  });

  it("streams progress previews in private threads through the fastest visible message path", async () => {
    const progressStream = createDraftStream(9001);
    createTelegramDraftStream.mockReturnValue(progressStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Checking the page." }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "Final answer." }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        route: {
          agentId: "work",
        } as unknown as TelegramMessageContext["route"],
      }),
    });

    expect(createTelegramDraftStream).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 123,
        thread: { id: 777, scope: "dm" },
        previewTransport: "message",
        throttleMs: 250,
        minInitialChars: 1,
      }),
    );
    expect(progressStream.update).toHaveBeenCalledWith("Checking the page.");
    expect(progressStream.update).toHaveBeenCalledWith("Work log");
    expect(progressStream.flush).toHaveBeenCalledTimes(1);
    expect(progressStream.clear).not.toHaveBeenCalled();
    expect(progressStream.materialize.mock.invocationCallOrder[0]).toBeLessThan(
      deliverReplies.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: { id: 777, scope: "dm" },
        mediaLocalRoots: expect.arrayContaining([path.join(STATE_DIR, "workspace-work")]),
        replies: [expect.objectContaining({ text: "Final answer." })],
      }),
    );
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          disableBlockStreaming: false,
        }),
      }),
    );
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("does not wait for a sentence before surfacing same-chat DM source previews", async () => {
    const progressStream = createDraftStream(9004);
    createTelegramDraftStream.mockReturnValue(progressStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolResult?.({
          text: "A",
          channelData: { openclaw: { sourcePreview: true } },
        });
        await dispatcherOptions.deliver({ text: "Answer." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(createTelegramDraftStream).toHaveBeenCalledWith(
      expect.objectContaining({
        previewTransport: "message",
        minInitialChars: 1,
      }),
    );
    expect(progressStream.update).toHaveBeenCalledWith("A");
  });

  it("accumulates block progress in one transient bubble before the final answer", async () => {
    const progressStream = createDraftStream(9002);
    createTelegramDraftStream.mockReturnValue(progressStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Checking example.com." }, { kind: "block" });
      await dispatcherOptions.deliver(
        { text: "Checking the IANA reserved domains page." },
        { kind: "block" },
      );
      await dispatcherOptions.deliver({ text: "Final answer." }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(progressStream.update).toHaveBeenNthCalledWith(1, "Checking example.com.");
    expect(progressStream.update).toHaveBeenNthCalledWith(
      2,
      "Checking example.com.\n\nChecking the IANA reserved domains page.",
    );
    expect(progressStream.update).toHaveBeenCalledWith("Work log");
    expect(progressStream.flush).toHaveBeenCalledTimes(1);
    expect(progressStream.materialize).toHaveBeenCalledTimes(1);
    expect(progressStream.clear).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Final answer." })],
      }),
    );
  });

  it("starts final-looking partials in a separate answer bubble after transient progress", async () => {
    const progressStream = createDraftStream(9010);
    const answerStream = createDraftStream(9011);
    createTelegramDraftStream.mockReturnValueOnce(progressStream).mockReturnValueOnce(answerStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "I'll inspect browser support, write a report, and clean up the temp file.",
        });
        await dispatcherOptions.deliver(
          {
            text: "I'll inspect browser support, write a report, and clean up the temp file.",
          },
          { kind: "block" },
        );
        await replyOptions?.onToolStart?.({ name: "browser.open" });

        await replyOptions?.onPartialReply?.({
          text: "Browser is up. I'm checking docs and code now.",
        });
        await dispatcherOptions.deliver(
          {
            text: "Browser is up. I'm checking docs and code now.",
          },
          { kind: "block" },
        );
        await replyOptions?.onToolStart?.({ name: "notes.write" });

        await replyOptions?.onPartialReply?.({
          text: "Ran it.\n\nWhat I tested:\n\nBrowser, Notes, and Desktop temp-file cleanup.",
          channelData: { openclaw: { assistantPhase: "final_answer" } },
        });
        await dispatcherOptions.deliver(
          {
            text: "Ran it.\n\nWhat I tested:\n\nBrowser, Notes, and Desktop temp-file cleanup.",
            channelData: { openclaw: { assistantPhase: "final_answer" } },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "9011" });
    allowDeterministicPreviewDeletes();

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(2);
    expect(progressStream.update).toHaveBeenCalledWith(
      "I'll inspect browser support, write a report, and clean up the temp file.",
    );
    expect(progressStream.update).toHaveBeenCalledWith(
      "I'll inspect browser support, write a report, and clean up the temp file.\n\n" +
        "Browser is up. I'm checking docs and code now.",
    );
    expect(progressStream.update).not.toHaveBeenCalledWith(
      expect.stringContaining("Ran it.\n\nWhat I tested:"),
    );
    expect(progressStream.update).toHaveBeenCalledWith("Work log");
    expect(progressStream.flush).toHaveBeenCalledTimes(1);
    expect(progressStream.clear).not.toHaveBeenCalled();
    expect(progressStream.materialize.mock.invocationCallOrder[0]).toBeLessThan(
      answerStream.update.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(answerStream.update).toHaveBeenCalledWith(
      "Ran it.\n\nWhat I tested:\n\nBrowser, Notes, and Desktop temp-file cleanup.",
    );
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      9011,
      "Ran it.\n\nWhat I tested:\n\nBrowser, Notes, and Desktop temp-file cleanup.",
      expect.objectContaining({ richMessages: false }),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("routes sourcePreview tool text through transient progress", async () => {
    const progressStream = createDraftStream(9003);
    createTelegramDraftStream.mockReturnValue(progressStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolResult?.({
          text: "Opening the browser tab.",
          channelData: { openclaw: { sourcePreview: true } },
        });
        await dispatcherOptions.deliver({ text: "Done." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(progressStream.update).toHaveBeenCalledWith("Opening the browser tab.");
    expect(progressStream.update).toHaveBeenCalledWith("Work log");
    expect(progressStream.clear).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Done." })],
      }),
    );
  });

  it("routes plan sourcePreview tool text through transient progress", async () => {
    const progressStream = createDraftStream(9004);
    createTelegramDraftStream.mockReturnValue(progressStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolResult?.({
          text: "Plan updated\n- [x] Inspect files\n- [~] Render checklist\n- [ ] Run tests",
          channelData: { openclaw: { sourcePreview: true, progressKind: "plan" } },
        });
        await replyOptions?.onToolResult?.({
          text: "Plan updated\n- [x] Inspect files\n- [x] Render checklist\n- [~] Run tests",
          channelData: { openclaw: { sourcePreview: true, progressKind: "plan" } },
        });
        await dispatcherOptions.deliver({ text: "Done." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(progressStream.update).toHaveBeenNthCalledWith(
      1,
      "Plan updated\n- [x] Inspect files\n- [~] Render checklist\n- [ ] Run tests",
    );
    expect(progressStream.update).toHaveBeenNthCalledWith(
      2,
      "Plan updated\n- [x] Inspect files\n- [x] Render checklist\n- [~] Run tests",
    );
    expect(progressStream.update).toHaveBeenCalledWith("Work log");
    expect(progressStream.update).toHaveBeenCalledTimes(3);
    expect(progressStream.clear).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Done." })],
      }),
    );
  });

  it("folds a progress acknowledgment into the plan without materializing a second message", async () => {
    const progressStream = createDraftStream();
    progressStream.materialize.mockResolvedValue(undefined);
    createTelegramDraftStream.mockReturnValue(progressStream);
    const acknowledgment = "I’ll inspect the files first, then run the focused tests.";
    const planText = "Plan updated\n- [~] Inspect files\n- [ ] Run tests";
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await dispatcherOptions.deliver(
          {
            text: acknowledgment,
            channelData: { openclaw: { assistantPhase: "commentary" } },
          },
          { kind: "block" },
        );
        await replyOptions?.onToolStart?.({ name: "update_plan" });
        await replyOptions?.onToolResult?.({
          text: planText,
          channelData: { openclaw: { sourcePreview: true, progressKind: "plan" } },
        });
        await dispatcherOptions.deliver({ text: "Done." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { CommandAuthorized: true, SessionKey: "plan-materialize-fallback" },
      }),
      streamMode: "partial",
      telegramCfg: { blockStreaming: true },
    });

    expect(progressStream.update).toHaveBeenCalledWith(acknowledgment);
    expect(progressStream.materialize).toHaveBeenCalledTimes(1);
    expect(progressStream.forceNewMessage).not.toHaveBeenCalled();
    expect(progressStream.update).toHaveBeenCalledWith(
      `${acknowledgment}\n\nPlan updated\n- [~] Inspect files\n- [ ] Run tests`,
    );
  });

  it("keeps final answer partials out of the plan progress bubble", async () => {
    const progressStream = createDraftStream(9005);
    const answerStream = createDraftStream(9105);
    const finalText =
      "- Checked local-file evidence for update_plan registration.\n" +
      "- Temp-file cleanup was verified.\n" +
      "- Remaining risk is low.";
    createTelegramDraftStream
      .mockImplementationOnce(() => progressStream)
      .mockImplementationOnce(() => answerStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolResult?.({
          text: "Plan updated\n- [~] Inspect files\n- [ ] Write temp report\n- [ ] Summarize",
          channelData: { openclaw: { sourcePreview: true, progressKind: "plan" } },
        });
        await replyOptions?.onPartialReply?.({
          text: "- Checked local-file evidence for update_plan registration.",
        });
        await replyOptions?.onPartialReply?.({ text: finalText });
        await dispatcherOptions.deliver({ text: finalText }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "9105" });
    deliverReplies.mockResolvedValue({ delivered: true });
    allowDeterministicPreviewDeletes();

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(progressStream.update).toHaveBeenCalledWith(
      "Plan updated\n- [~] Inspect files\n- [ ] Write temp report\n- [ ] Summarize",
    );
    expect(progressStream.update).not.toHaveBeenCalledWith(finalText);
    expect(answerStream.update).toHaveBeenCalledWith(finalText);
    expect(progressStream.update).toHaveBeenCalledWith("Work log");
    expect(progressStream.clear).not.toHaveBeenCalled();
    expect(answerStream.clear).not.toHaveBeenCalled();
    expectFinalPreviewEditedInPlace(9105, finalText);
    expect(deliverReplies).not.toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "" })],
      }),
    );
  });

  it("streams assistant partials through the durable answer lane instead of transient progress", async () => {
    const answerStream = createDraftStream(9101);
    createTelegramDraftStream.mockImplementation((params) => {
      expect(params).toEqual(
        expect.objectContaining({
          previewTransport: "message",
          deleteAudit: expect.objectContaining({
            callsite: "telegram-answer-preview-clear",
          }),
        }),
      );
      return answerStream;
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "Once upon a time, the answer began streaming.",
        });
        await dispatcherOptions.deliver(
          {
            text: "Once upon a time, the answer began streaming and stayed in the same bubble.",
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "9101" });
    allowDeterministicPreviewDeletes();

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
    expect(answerStream.update).toHaveBeenCalledWith(
      "Once upon a time, the answer began streaming.",
    );
    expect(answerStream.clear).not.toHaveBeenCalled();
    expectFinalPreviewEditedInPlace(
      9101,
      "Once upon a time, the answer began streaming and stayed in the same bubble.",
    );
  });

  it("does not promote phase-less answer blocks to progress after assistant partials started", async () => {
    const answerStream = createDraftStream(9201);
    createTelegramDraftStream.mockImplementation((params) => {
      expect(params).toEqual(
        expect.objectContaining({
          deleteAudit: expect.objectContaining({
            callsite: "telegram-answer-preview-clear",
          }),
        }),
      );
      return answerStream;
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "The durable story starts here.",
        });
        await dispatcherOptions.deliver(
          { text: "The durable story starts here." },
          { kind: "block" },
        );
        await dispatcherOptions.deliver(
          { text: "The durable story starts here. It continues as a block snapshot." },
          { kind: "block" },
        );
        await dispatcherOptions.deliver(
          {
            text: "The durable story starts here. It continues as a block snapshot.",
            channelData: { openclaw: { assistantPhase: "final_answer" } },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "9201" });
    allowDeterministicPreviewDeletes();

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
    expect(answerStream.update).toHaveBeenCalledWith("The durable story starts here.");
    expect(answerStream.clear).not.toHaveBeenCalled();
    expectFinalPreviewEditedInPlace(
      9201,
      "The durable story starts here. It continues as a block snapshot.",
    );
  });

  it("adopts a speculative answer preview when structure reclassifies it as progress", async () => {
    const answerStream = createTestDraftStream({
      messageId: 9301,
      clearMessageIdOnForceNew: true,
    });
    createTelegramDraftStream.mockReturnValueOnce(answerStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "Inspecting the workspace state.",
        });
        await dispatcherOptions.deliver(
          {
            text: "Checking the current branch and recent edits.",
            channelData: { openclaw: { assistantPhase: "commentary" } },
          },
          { kind: "block" },
        );
        await dispatcherOptions.deliver(
          {
            text: "The branch is clean enough to patch safely.",
            channelData: { openclaw: { assistantPhase: "final_answer" } },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
    expect(answerStream.update).toHaveBeenCalledWith("Inspecting the workspace state.");
    expect(answerStream.update).toHaveBeenCalledWith(
      "Inspecting the workspace state.\n\nChecking the current branch and recent edits.",
    );
    expect(answerStream.update).toHaveBeenCalledWith("Work log");
    expect(answerStream.clear).not.toHaveBeenCalled();
    expect(answerStream.update.mock.invocationCallOrder[1]).toBeLessThan(
      answerStream.materialize.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(answerStream.forceNewMessage).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: "The branch is clean enough to patch safely.",
          }),
        ],
      }),
    );
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("finalizes visible final preview after retained progress and strips transient prefixes", async () => {
    const speculativeAnswerStream = createTestDraftStream({
      messageId: 9401,
      clearMessageIdOnForceNew: true,
    });
    const finalAnswerStream = createDraftStream(9403);
    createTelegramDraftStream
      .mockReturnValueOnce(speculativeAnswerStream)
      .mockReturnValueOnce(finalAnswerStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "Inspecting the workspace state.",
        });
        await dispatcherOptions.deliver(
          {
            text: "Checking the current branch and recent edits.",
            channelData: { openclaw: { assistantPhase: "commentary" } },
          },
          { kind: "block" },
        );
        await replyOptions?.onPartialReply?.({
          text: "The branch is clean enough to patch safely.",
        });
        await dispatcherOptions.deliver(
          {
            text:
              "Inspecting the workspace state.Checking the current branch and recent edits.\n\n" +
              "The branch is clean enough to patch safely.",
            channelData: { openclaw: { assistantPhase: "final_answer" } },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "9403" });
    allowDeterministicPreviewDeletes();

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(2);
    expect(speculativeAnswerStream.update).toHaveBeenCalledWith(
      "Inspecting the workspace state.\n\nChecking the current branch and recent edits.",
    );
    expect(speculativeAnswerStream.forceNewMessage).not.toHaveBeenCalled();
    expect(finalAnswerStream.update).toHaveBeenCalledWith(
      "The branch is clean enough to patch safely.",
    );
    expect(finalAnswerStream.clear).not.toHaveBeenCalled();
    expectFinalPreviewEditedInPlace(9403, "The branch is clean enough to patch safely.");
    expect(speculativeAnswerStream.update).toHaveBeenCalledWith("Work log");
    expect(speculativeAnswerStream.clear).not.toHaveBeenCalled();
  });

  it("treats a terminal ambiguous block as the final answer", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Only answer." }, { kind: "block" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Only answer." })],
      }),
    );
  });

  it("keeps final answer text on legacy Telegram HTML transport", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Final answer for normal clients." },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    const call = deliverReplies.mock.calls[0]?.[0];
    expect(call).toEqual(
      expect.objectContaining({
        copySafeBlockquotes: true,
        richMessages: false,
        replies: [expect.objectContaining({ text: "Final answer for normal clients." })],
      }),
    );
  });

  it("lets valid unfenced table finals use guarded rich delivery", async () => {
    const tableText = [
      "| Plan | Owner |",
      "| --- | --- |",
      "| Ship | Jarvis |",
      "",
      "Review it.",
    ].join("\n");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: tableText }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
      bot: createRichBot(),
    });

    const call = deliverReplies.mock.calls[0]?.[0];
    expect(call).toEqual(
      expect.objectContaining({
        copySafeBlockquotes: true,
        replies: [expect.objectContaining({ text: tableText })],
      }),
    );
    expect(call).not.toHaveProperty("richMessages");
  });

  it("keeps table finals on legacy delivery when Telegram lacks rich raw API", async () => {
    const tableText = [
      "| Plan | Owner |",
      "| --- | --- |",
      "| Ship | Jarvis |",
      "",
      "Review it.",
    ].join("\n");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: tableText }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        richMessages: false,
        replies: [expect.objectContaining({ text: tableText })],
      }),
    );
  });

  it("keeps table-and-blockquote drafts on copy-safe legacy delivery", async () => {
    const draftText = [
      "| Plan | Owner |",
      "| --- | --- |",
      "| Ship | Jarvis |",
      "",
      "> Hi Sveta, here is the booking link: https://example.com.",
    ].join("\n");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: draftText }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
      bot: createRichBot(),
    });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        copySafeBlockquotes: true,
        richMessages: false,
        replies: [expect.objectContaining({ text: draftText })],
      }),
    );
  });

  it("finalizes a streamed table preview as legacy after message_sending removes the table", async () => {
    const tableText = ["| Plan | Owner |", "| --- | --- |", "| Ship | Jarvis |"].join("\n");
    const answerStream = createDraftStream(9301);
    createTelegramDraftStream.mockReturnValueOnce(answerStream);
    prepareTelegramReplyForDelivery.mockImplementationOnce(async ({ reply }) => ({
      reply: { ...reply, text: "Plain final after hook." },
      cancelled: false,
    }));
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: tableText });
        await dispatcherOptions.deliver({ text: tableText }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "9301" });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      bot: createRichBot(),
    });

    expect(prepareTelegramReplyForDelivery).toHaveBeenCalledTimes(1);
    expectFinalPreviewEditedInPlace(9301, "Plain final after hook.");
  });

  it("clears a streamed prose preview after message_sending adds a table", async () => {
    const tableText = ["| Plan | Owner |", "| --- | --- |", "| Ship | Jarvis |"].join("\n");
    const answerStream = createDraftStream(9302);
    createTelegramDraftStream.mockReturnValueOnce(answerStream);
    prepareTelegramReplyForDelivery.mockImplementationOnce(async ({ reply }) => ({
      reply: { ...reply, text: tableText },
      cancelled: false,
    }));
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Plain final before hook." });
        await dispatcherOptions.deliver({ text: "Plain final before hook." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      bot: createRichBot(),
    });

    expect(prepareTelegramReplyForDelivery).toHaveBeenCalledTimes(1);
    expect(answerStream.clear).toHaveBeenCalledWith({ waitForInFlight: true });
    expect(deliverReplies.mock.invocationCallOrder[0]).toBeLessThan(
      answerStream.clear.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deliverReplies.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: tableText })],
      }),
    );
    expect(deliverReplies.mock.calls[0]?.[0]).not.toHaveProperty("richMessages");
  });

  it("deduplicates replayed final text before rerunning message_sending", async () => {
    const sourceText = "One logical final.";
    prepareTelegramReplyForDelivery.mockImplementation(async ({ reply }) => ({
      reply: { ...reply, text: "One rewritten final." },
      cancelled: false,
    }));
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      // High-route providers can expose the same logical final through both a
      // phased callback and their generic completion callback.
      await dispatcherOptions.deliver({ text: sourceText }, { kind: "final" });
      await dispatcherOptions.deliver({ text: sourceText }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(prepareTelegramReplyForDelivery).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "One rewritten final." })],
      }),
    );
  });

  it("runs message_sending against the exact preview-merged final text", async () => {
    const previewText = "Context before final. Shared final sentence.";
    const finalText = "Shared final sentence. Conclusion.";
    const mergedText = "Context before final.\n\nShared final sentence. Conclusion.";
    const answerStream = createDraftStream(9303);
    createTelegramDraftStream.mockReturnValueOnce(answerStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: previewText });
        await dispatcherOptions.deliver({ text: finalText }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "9303" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(prepareTelegramReplyForDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        reply: expect.objectContaining({ text: mergedText }),
      }),
    );
    expectFinalPreviewEditedInPlace(9303, mergedText);
  });

  it("does not restore preview text removed by message_sending", async () => {
    const previewText = "Secret prefix. Shared final sentence.";
    const finalText = "Shared final sentence. Conclusion.";
    const rewrittenText = "Shared final sentence. Approved conclusion.";
    const answerStream = createDraftStream(9304);
    createTelegramDraftStream.mockReturnValueOnce(answerStream);
    prepareTelegramReplyForDelivery.mockImplementationOnce(async ({ reply }) => ({
      reply: { ...reply, text: rewrittenText },
      cancelled: false,
    }));
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: previewText });
        await dispatcherOptions.deliver({ text: finalText }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "9304" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expectFinalPreviewEditedInPlace(9304, rewrittenText);
    expect(editMessageTelegram).not.toHaveBeenCalledWith(
      123,
      9304,
      expect.stringContaining("Secret prefix."),
      expect.anything(),
    );
  });

  it.each(["off", "code", "bullets"] as const)(
    "keeps table finals on legacy delivery when Telegram tables are %s",
    async (tables) => {
      const tableText = ["| Plan | Owner |", "| --- | --- |", "| Ship | Jarvis |"].join("\n");
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: tableText }, { kind: "final" });
        return { queuedFinal: true };
      });
      deliverReplies.mockResolvedValue({ delivered: true });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "off",
        bot: createRichBot(),
        cfg: {
          channels: { telegram: { markdown: { tables } } },
        } as Parameters<typeof dispatchTelegramMessage>[0]["cfg"],
      });

      expect(deliverReplies).toHaveBeenCalledWith(
        expect.objectContaining({
          richMessages: false,
          replies: [expect.objectContaining({ text: tableText })],
        }),
      );
    },
  );

  it("keeps table finals on legacy delivery when rich messages are disabled", async () => {
    const tableText = ["| Plan | Owner |", "| --- | --- |", "| Ship | Jarvis |"].join("\n");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: tableText }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
      bot: createRichBot(),
      telegramCfg: { richMessages: false },
    });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        richMessages: false,
        replies: [expect.objectContaining({ text: tableText })],
      }),
    );
  });

  it("keeps fenced table text on legacy Telegram HTML transport", async () => {
    const fencedTableText = [
      "```markdown",
      "| Plan | Owner |",
      "| --- | --- |",
      "| Ship | Jarvis |",
      "```",
    ].join("\n");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: fencedTableText }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        richMessages: false,
        replies: [expect.objectContaining({ text: fencedTableText })],
      }),
    );
  });

  it("enables copy-safe blockquote rendering for final draft-style answers", async () => {
    const draftText = [
      "I would send:",
      "",
      "> Hi Sveta, here is the booking link: https://example.com.",
      "> Confirm if this works.",
    ].join("\n");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: draftText,
          channelData: { openclaw: { copySafeDraft: true } },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      bot: createRichBot(),
    });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        copySafeBlockquotes: true,
        richMessages: false,
        replies: [expect.objectContaining({ text: draftText })],
      }),
    );
  });

  it("sends control-command text without Telegram rich-message transport even with media", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "TTS enabled.",
          mediaUrl: "file:///tmp/tts-preview.mp3",
          audioAsVoice: true,
          channelData: { openclaw: { controlCommandReply: true } },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        richMessages: false,
        replies: [
          expect.objectContaining({
            text: "TTS enabled.",
            mediaUrl: "file:///tmp/tts-preview.mp3",
            audioAsVoice: true,
          }),
        ],
      }),
    );
  });

  it("disables answer preview streaming and preserves native quote replies", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "quoted answer", replyToId: "456" },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          MessageSid: "456",
          ReplyToId: "500",
          ReplyToBody: "fallback quote",
          ReplyToIsQuote: true,
          ReplyToQuoteText: "selected quote",
          ReplyToQuotePosition: 3,
          ReplyToQuoteEntities: [{ type: "bold", offset: 0, length: 8 }],
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "partial",
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replyQuoteMessageId: 500,
        replyQuoteText: "selected quote",
        replyQuotePosition: 3,
        replyQuoteEntities: [{ type: "bold", offset: 0, length: 8 }],
        replies: [expect.objectContaining({ replyToId: "500" })],
      }),
    );
  });

  it("drops raw tool trace fallback delivery when preview streaming is off", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onToolResult?.({ text: "🔧 exec: ls" });
      return { queuedFinal: false };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("clears a streamed preview before sending an eligible table final through rich delivery", async () => {
    const answerStream = createDraftStream(9101);
    createTelegramDraftStream.mockReturnValueOnce(answerStream);
    const finalText = [
      "Use the boring option tonight.",
      "",
      "| Place | Why |",
      "| --- | --- |",
      "| Warung Local | light food, short ride |",
      "| Fancy Spot | more effort, less upside |",
      "",
      "Bring:",
      "- Water",
      "- A light jacket",
      "",
      "Then:",
      "1. Eat first.",
      "2. Decide on dessert after.",
    ].join("\n");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: finalText });
        await dispatcherOptions.deliver(
          {
            text: finalText,
            channelData: { openclaw: { assistantPhase: "final_answer" } },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      bot: createRichBot(),
    });

    const renderText = createTelegramDraftStream.mock.calls[0]?.[0]?.renderText;
    expect(renderText).toBeTypeOf("function");
    expect(renderText(finalText)).toEqual(
      expect.objectContaining({
        parseMode: "HTML",
        text: expect.stringContaining("<pre><code>"),
      }),
    );
    expect(renderText(finalText)).not.toHaveProperty("richMessage");
    expect(answerStream.update).toHaveBeenCalledWith(finalText);
    expect(answerStream.clear).toHaveBeenCalledWith({ waitForInFlight: true });
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        copySafeBlockquotes: true,
        replies: [expect.objectContaining({ text: finalText })],
      }),
    );
    expect(deliverReplies.mock.calls[0]?.[0]).not.toHaveProperty("richMessages");
    expect(guardedTelegramDeleteMessage).not.toHaveBeenCalled();
  });

  it("retains a streamed table preview when durable rich delivery reports false", async () => {
    const answerStream = createDraftStream(9104);
    createTelegramDraftStream.mockReturnValueOnce(answerStream);
    const tableText = [
      "| Plan | Owner |",
      "| --- | --- |",
      "| Ship | Jarvis |",
      "",
      "Review it.",
    ].join("\n");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: tableText });
        await dispatcherOptions.deliver({ text: tableText }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: false });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      bot: createRichBot(),
    });

    expect(deliverReplies).toHaveBeenCalled();
    expect(answerStream.clear).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("retains a streamed table preview when durable rich delivery rejects", async () => {
    const answerStream = createDraftStream(9105);
    createTelegramDraftStream.mockReturnValueOnce(answerStream);
    const tableText = [
      "| Plan | Owner |",
      "| --- | --- |",
      "| Ship | Jarvis |",
      "",
      "Review it.",
    ].join("\n");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: tableText });
        await dispatcherOptions.deliver({ text: tableText }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    // The dispatcher owns the existing error fallback; this is not a second
    // rich-final attempt and must not erase the already-visible preview.
    deliverReplies.mockRejectedValueOnce(new Error("rich delivery rejected")).mockResolvedValue({
      delivered: true,
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      bot: createRichBot(),
    });

    expect(answerStream.clear).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("renders streamed draft-preview blockquotes as copy-safe legacy code blocks", async () => {
    const answerStream = createDraftStream(9102);
    createTelegramDraftStream.mockReturnValueOnce(answerStream);
    const draftText = [
      "Suggested reply:",
      "",
      "> Hi Sveta, here is the page: [booking](https://example.com/booking).",
      "> Please confirm the passenger names.",
    ].join("\n");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: draftText });
      return { queuedFinal: false };
    });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    const renderText = createTelegramDraftStream.mock.calls[0]?.[0]?.renderText;
    expect(renderText).toBeTypeOf("function");
    const rendered = renderText(draftText);
    expect(rendered).toEqual(
      expect.objectContaining({
        parseMode: "HTML",
        text: expect.stringContaining("<pre><code>"),
      }),
    );
    expect(rendered).not.toHaveProperty("richMessage");
    expect(rendered.text).not.toContain("<blockquote>");
    expect(rendered.text).not.toContain("<a href");
  });

  it("finalizes streamed copy-safe drafts in the same legacy preview", async () => {
    const answerStream = createDraftStream(9103);
    createTelegramDraftStream.mockReturnValueOnce(answerStream);
    const draftText = [
      "Suggested reply:",
      "",
      "> Hi Sveta, here is the page: https://example.com/booking.",
      "> Please confirm the passenger names.",
    ].join("\n");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: draftText });
        await dispatcherOptions.deliver(
          {
            text: draftText,
            channelData: { openclaw: { copySafeDraft: true } },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "9103" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(answerStream.update).toHaveBeenCalledWith(draftText);
    expectFinalPreviewEditedInPlace(9103, draftText);
  });

  it("suppresses raw tool traces when preview streaming is on", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onToolResult?.({ text: "🔧 exec: ls" });
        await dispatcherOptions.deliver({ text: "telegram_voice_sanitize_ok" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "partial",
    });

    const deliveredTexts = deliverReplies.mock.calls.flatMap(([arg]) => {
      return (
        (arg as { replies?: Array<{ text?: string }> }).replies?.map((reply) => reply.text) ?? []
      );
    });
    expect(deliveredTexts).not.toContain("🔧 exec: ls");
    expect(deliveredTexts).toContain("telegram_voice_sanitize_ok");
  });

  it("suppresses trace captions but still delivers media-bearing tool payloads", async () => {
    loadSessionStore.mockReturnValue({
      s1: { verboseLevel: "off" },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onToolResult?.({
        text: "🔧 browser.screenshot",
        mediaUrls: ["file:///tmp/screenshot.png"],
      });
      await replyOptions?.onToolResult?.({
        text: "Screenshot captured",
        mediaUrls: ["file:///tmp/screenshot.png"],
      });
      return { queuedFinal: false };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "partial",
    });

    const mediaReplies = deliverReplies.mock.calls.flatMap(([arg]) => {
      const replies = (
        arg as {
          replies?: Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
        }
      ).replies;
      return replies ?? [];
    });
    expect(
      mediaReplies.some(
        (reply) =>
          (reply.mediaUrl === "file:///tmp/screenshot.png" ||
            reply.mediaUrls?.includes("file:///tmp/screenshot.png")) &&
          reply.text !== "🔧 browser.screenshot",
      ),
    ).toBe(true);
    expect(
      mediaReplies.some(
        (reply) =>
          (reply.mediaUrl === "file:///tmp/screenshot.png" ||
            reply.mediaUrls?.includes("file:///tmp/screenshot.png")) &&
          typeof reply.text === "string" &&
          reply.text.startsWith("🔧"),
      ),
    ).toBe(false);
  });

  it("starts fresh visible progress below an interleaved tool screenshot", async () => {
    const progressBeforeMedia = createSequencedDraftStream(9101);
    const progressAfterMedia = createSequencedDraftStream(9201);
    createTelegramDraftStream
      .mockReturnValueOnce(progressBeforeMedia)
      .mockReturnValueOnce(progressAfterMedia);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      const commentaryChannelData = { openclaw: { assistantPhase: "commentary" } };
      await dispatcherOptions.deliver(
        { text: "Opening the checkout.", channelData: commentaryChannelData },
        { kind: "block" },
      );
      await dispatcherOptions.deliver(
        { mediaUrls: ["file:///tmp/checkout-proof.png"] },
        { kind: "tool" },
      );
      await dispatcherOptions.deliver(
        { text: "Checking the passenger details.", channelData: commentaryChannelData },
        { kind: "block" },
      );
      await dispatcherOptions.deliver(
        {
          text: "Passenger details are ready.",
          channelData: { openclaw: { assistantPhase: "final_answer" } },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "progress-around-tool-media",
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(2);
    expect(progressBeforeMedia.materialize).toHaveBeenCalledTimes(1);
    expect(progressBeforeMedia.update).toHaveBeenCalledWith(
      expect.stringContaining("Opening the checkout."),
    );
    expect(progressAfterMedia.update).toHaveBeenCalledWith(
      expect.stringContaining("Checking the passenger details."),
    );
    expect(progressBeforeMedia.materialize.mock.invocationCallOrder[0]).toBeLessThan(
      deliverReplies.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(deliverReplies.mock.invocationCallOrder[0]).toBeLessThan(
      progressAfterMedia.update.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("does not inject approval buttons in local dispatch once the monitor owns approvals", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Mode: foreground\nRun: /approve 117ba06d allow-once (or allow-always / deny).",
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
      cfg: {
        channels: {
          telegram: {
            execApprovals: {
              enabled: true,
              approvers: ["123"],
              target: "dm",
            },
          },
        },
      },
    });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: "Mode: foreground\nRun: /approve 117ba06d allow-once (or allow-always / deny).",
          }),
        ],
      }),
    );
    const deliveredPayload = (deliverReplies.mock.calls[0]?.[0] as { replies?: Array<unknown> })
      ?.replies?.[0] as { channelData?: unknown } | undefined;
    expect(deliveredPayload?.channelData).toBeUndefined();
  });

  it("keeps block streaming enabled when account config enables it", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      telegramCfg: { blockStreaming: true },
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          disableBlockStreaming: false,
          onPartialReply: undefined,
        }),
      }),
    );
  });

  it("keeps block streaming enabled when session reasoning level is on", async () => {
    loadSessionStore.mockReturnValue({
      s1: { reasoningLevel: "on" },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Reasoning:\n_step_" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          disableBlockStreaming: false,
        }),
      }),
    );
    expect(loadSessionStore).toHaveBeenCalledWith("/tmp/sessions.json", { skipCache: true });
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Reasoning:\n_step_" })],
      }),
    );
  });

  it("streams reasoning draft updates even when answer stream mode is off", async () => {
    const reasoningDraftStream = createDraftStream(111);
    createTelegramDraftStream.mockReturnValue(reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_step_" });
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "off",
    });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
    expect(reasoningDraftStream.update).toHaveBeenCalledWith("Reasoning:\n_step_");
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Hello" })],
      }),
    );
    expect(loadSessionStore).toHaveBeenCalledWith("/tmp/sessions.json", { skipCache: true });
  });

  it.each([
    { label: "default account config", telegramCfg: {} },
    { label: "account blockStreaming override", telegramCfg: { blockStreaming: true } },
  ])("disables all preview streams when streamMode is off ($label)", async ({ telegramCfg }) => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
      telegramCfg,
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          disableBlockStreaming: true,
        }),
      }),
    );
  });

  it.each(["block", "partial"] as const)(
    "splits reasoning lane only when a later reasoning block starts (%s mode)",
    async (streamMode) => {
      const reasoningDraftStream = createDraftStream(111);
      createTelegramDraftStream.mockReturnValue(reasoningDraftStream);
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_first block_" });
          await replyOptions?.onReasoningEnd?.();
          expect(reasoningDraftStream.forceNewMessage).not.toHaveBeenCalled();
          await replyOptions?.onPartialReply?.({ text: "checking files..." });
          await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_second block_" });
          await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
          return { queuedFinal: true };
        },
      );
      deliverReplies.mockResolvedValue({ delivered: true });

      await dispatchWithContext({ context: createReasoningStreamContext(), streamMode });

      expect(reasoningDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
      expect(deliverReplies).toHaveBeenCalledWith(
        expect.objectContaining({
          replies: [expect.objectContaining({ text: "Done" })],
        }),
      );
    },
  );

  it("queues reasoning-end split decisions behind queued reasoning deltas", async () => {
    const reasoningDraftStream = createDraftStream(111);
    createTelegramDraftStream.mockReturnValue(reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        const firstReasoningPromise = replyOptions?.onReasoningStream?.({
          text: "Reasoning:\n_first block_",
        });
        await replyOptions?.onReasoningEnd?.();
        await firstReasoningPromise;
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_second block_" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(reasoningDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
  });

  it("cleans superseded reasoning previews after lane rotation", async () => {
    let reasoningDraftParams:
      | {
          onSupersededPreview?: (preview: { messageId: number; textSnapshot: string }) => void;
        }
      | undefined;
    const reasoningDraftStream = createDraftStream(111);
    createTelegramDraftStream.mockImplementationOnce((params) => {
      reasoningDraftParams = params as typeof reasoningDraftParams;
      return reasoningDraftStream;
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_first block_" });
        await replyOptions?.onReasoningEnd?.();
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_second block_" });
        reasoningDraftParams?.onSupersededPreview?.({
          messageId: 4444,
          textSnapshot: "Reasoning:\n_first block_",
        });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    const bot = createBot();
    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "partial",
      bot,
    });

    expect(reasoningDraftParams?.onSupersededPreview).toBeTypeOf("function");
    expect(guardedTelegramDeleteMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        api: bot.api,
        chatId: 123,
        messageId: 4444,
        audit: expect.objectContaining({
          callsite: "telegram-archived-reasoning-preview-cleanup",
          reason: "archived_reasoning_preview_cleanup",
          safetyMode: "deterministic_cleanup",
          accountId: "default",
          lane: "reasoning",
        }),
      }),
    );
    expect(bot.api.deleteMessage).not.toHaveBeenCalled();
  });

  it.each(["block", "partial"] as const)(
    "does not split reasoning lane on reasoning end without a later reasoning block (%s mode)",
    async (streamMode) => {
      const reasoningDraftStream = createDraftStream(111);
      createTelegramDraftStream.mockReturnValue(reasoningDraftStream);
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_first block_" });
          await replyOptions?.onReasoningEnd?.();
          await replyOptions?.onPartialReply?.({ text: "Here's the answer" });
          await dispatcherOptions.deliver({ text: "Here's the answer" }, { kind: "final" });
          return { queuedFinal: true };
        },
      );
      deliverReplies.mockResolvedValue({ delivered: true });

      await dispatchWithContext({ context: createReasoningStreamContext(), streamMode });

      expect(reasoningDraftStream.forceNewMessage).not.toHaveBeenCalled();
      expect(deliverReplies).toHaveBeenCalledWith(
        expect.objectContaining({
          replies: [expect.objectContaining({ text: "Here's the answer" })],
        }),
      );
    },
  );

  it("suppresses reasoning-only final payloads when reasoning level is off", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Reasoning:\n_step one_" }, { kind: "final" });
      await dispatcherOptions.deliver(
        { text: "Hi, I did what you asked and..." },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    const deliveredTexts = deliverReplies.mock.calls.flatMap(([arg]) => {
      return (
        (arg as { replies?: Array<{ text?: string }> }).replies?.map((reply) => reply.text) ?? []
      );
    });
    expect(deliveredTexts).not.toContain("Reasoning:\n_step one_");
    expect(deliveredTexts).toContain("Hi, I did what you asked and...");
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it.each([undefined, null] as const)(
    "skips outbound send when final payload text is %s and has no media",
    async (emptyText) => {
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          { text: emptyText as unknown as string },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });
      deliverReplies.mockResolvedValue({ delivered: true });

      await dispatchWithContext({ context: createContext(), streamMode: "partial" });

      expect(createTelegramDraftStream).not.toHaveBeenCalled();
      expect(deliverReplies).not.toHaveBeenCalled();
      expect(editMessageTelegram).not.toHaveBeenCalled();
    },
  );

  it("uses native draft preview transport for DM reasoning streams while streaming is active", async () => {
    const reasoningDraftStream = createDraftStream(111);
    createTelegramDraftStream.mockReturnValue(reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_Working on it..._" });
        await dispatcherOptions.deliver({ text: "Checking the directory..." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
    expect(createTelegramDraftStream.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        thread: { id: 777, scope: "dm" },
        previewTransport: "auto",
      }),
    );
    expect(reasoningDraftStream.update).toHaveBeenCalledWith("Reasoning:\n_Working on it..._");
  });

  it("does not edit reasoning preview bubble with final answer when no assistant partial arrived yet", async () => {
    const reasoningDraftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_Working on it..._" });
        await dispatcherOptions.deliver({ text: "Here's what I found." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Here's what I found." })],
      }),
    );
  });

  it.each(["partial", "block"] as const)(
    "does not duplicate reasoning final after reasoning end (%s mode)",
    async (streamMode) => {
      const reasoningDraftStream = createDraftStream(111);
      createTelegramDraftStream.mockReturnValue(reasoningDraftStream);
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_step one_" });
          await replyOptions?.onReasoningEnd?.();
          await dispatcherOptions.deliver(
            { text: "Reasoning:\n_step one expanded_" },
            { kind: "final" },
          );
          return { queuedFinal: true };
        },
      );
      deliverReplies.mockResolvedValue({ delivered: true });
      editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "111" });

      await dispatchWithContext({ context: createReasoningStreamContext(), streamMode });

      expect(reasoningDraftStream.forceNewMessage).not.toHaveBeenCalled();
      expect(editMessageTelegram).toHaveBeenCalledWith(
        123,
        111,
        "Reasoning:\n_step one expanded_",
        expect.any(Object),
      );
      expect(deliverReplies).not.toHaveBeenCalledWith(
        expect.objectContaining({
          replies: [expect.objectContaining({ text: "Reasoning:\n_step one expanded_" })],
        }),
      );
    },
  );

  it("updates reasoning preview for reasoning block payloads instead of sending duplicates", async () => {
    const reasoningDraftStream = createDraftStream(111);
    createTelegramDraftStream.mockReturnValue(reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({
          text: "Reasoning:\nIf I count r in strawberry, I see positions 3, 8, and",
        });
        await replyOptions?.onReasoningEnd?.();
        await dispatcherOptions.deliver(
          {
            text: "Reasoning:\nIf I count r in strawberry, I see positions 3, 8, and 9. So the total is 3.",
          },
          { kind: "block" },
        );
        await dispatcherOptions.deliver({ text: "3" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "111" });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      111,
      "Reasoning:\nIf I count r in strawberry, I see positions 3, 8, and 9. So the total is 3.",
      expect.any(Object),
    );
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "3" })],
      }),
    );
  });

  it("routes think-tag partials to reasoning lane and keeps answer lane clean", async () => {
    const reasoningDraftStream = createDraftStream(111);
    createTelegramDraftStream.mockReturnValue(reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "<think>Counting letters in strawberry</think>3",
        });
        await dispatcherOptions.deliver({ text: "3" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith(
      "Reasoning:\n_Counting letters in strawberry_",
    );
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "3" })],
      }),
    );
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("routes unmatched think partials to reasoning lane without leaking answer lane", async () => {
    const reasoningDraftStream = createDraftStream(111);
    createTelegramDraftStream.mockReturnValue(reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "<think>Counting letters in strawberry",
        });
        await dispatcherOptions.deliver(
          { text: "There are 3 r's in strawberry." },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith(
      "Reasoning:\n_Counting letters in strawberry_",
    );
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "There are 3 r's in strawberry." })],
      }),
    );
  });

  it("splits think-tag final payload into reasoning and answer lanes", async () => {
    const reasoningDraftStream = createDraftStream(111);
    createTelegramDraftStream.mockReturnValue(reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "<think>Word: strawberry. r appears at 3, 8, 9.</think>There are 3 r's in strawberry.",
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "111" });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      111,
      "Reasoning:\n_Word: strawberry. r appears at 3, 8, 9._",
      expect.any(Object),
    );
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "There are 3 r's in strawberry." })],
      }),
    );
  });

  it("does not edit preview message when final payload is an error", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "⚠️ 🛠️ Exec: cat /nonexistent failed: No such file", isError: true },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "block" });

    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: expect.stringContaining("⚠️") })],
      }),
    );
  });

  it("delivers error-only finals as durable messages", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "tool failed", isError: true }, { kind: "final" });
      await dispatcherOptions.deliver({ text: "another error", isError: true }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledTimes(2);
  });

  it("delivers media finals without preview cleanup", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ mediaUrl: "file:///tmp/a.png" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ mediaUrl: "file:///tmp/a.png" })],
      }),
    );
  });

  it("finalizes an explicitly phased partial before a media-only voice supplement", async () => {
    const answerStream = createDraftStream(111);
    createTelegramDraftStream.mockReturnValue(answerStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "Final answer",
          channelData: { openclaw: { assistantPhase: "final_answer" } },
        });
        await dispatcherOptions.deliver(
          {
            text: "Final answer.",
            channelData: { openclaw: { assistantPhase: "final_answer" } },
          },
          { kind: "block" },
        );
        await dispatcherOptions.deliver(
          {
            mediaUrl: "file:///tmp/final-voice.ogg",
            audioAsVoice: true,
            channelData: { openclaw: { finalTtsSupplement: true } },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    expect(answerStream.update).toHaveBeenCalledWith("Final answer");
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      111,
      "Final answer.",
      expect.objectContaining({ richMessages: false }),
    );
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: { id: 777, scope: "dm" },
        replies: [
          expect.objectContaining({
            mediaUrl: "file:///tmp/final-voice.ogg",
            audioAsVoice: true,
          }),
        ],
      }),
    );
    expect(editMessageTelegram.mock.invocationCallOrder[0]).toBeLessThan(
      deliverReplies.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("hides MEDIA directives and local paths from streamed final previews", async () => {
    const answerStream = createDraftStream(111);
    createTelegramDraftStream.mockReturnValue(answerStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text:
            "Done. The PDF is attached.\n\nDetails stay in this paragraph.\n" +
            "MEDIA:/tmp/private/generated-report.pdf",
        });
        await dispatcherOptions.deliver(
          {
            text: "Done. The PDF is attached.\n\nDetails stay in this paragraph.",
            channelData: { openclaw: { assistantPhase: "final_answer" } },
          },
          { kind: "final" },
        );
        await dispatcherOptions.deliver(
          { mediaUrl: "file:///tmp/private/generated-report.pdf" },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    expect(answerStream.update).toHaveBeenCalledWith(
      "Done. The PDF is attached.\n\nDetails stay in this paragraph.",
    );
    expect(answerStream.update).not.toHaveBeenCalledWith(expect.stringContaining("MEDIA:"));
    expect(answerStream.update).not.toHaveBeenCalledWith(expect.stringContaining("/tmp/private"));
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      111,
      "Done. The PDF is attached.\n\nDetails stay in this paragraph.",
      expect.objectContaining({ richMessages: false }),
    );
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ mediaUrl: "file:///tmp/private/generated-report.pdf" }],
      }),
    );
  });

  it("does not classify unmarked media-only finals as TTS supplements", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          mediaUrl: "file:///tmp/unmarked-voice.ogg",
          audioAsVoice: true,
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });
    const runtime = createRuntime();

    await dispatchWithContext({ context: createContext(), runtime });

    const logLines = (runtime.log as ReturnType<typeof vi.fn>).mock.calls.map(([line]) =>
      String(line),
    );
    expect(logLines.some((line) => line.includes("lane=tts"))).toBe(false);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          {
            mediaUrl: "file:///tmp/unmarked-voice.ogg",
            audioAsVoice: true,
          },
        ],
      }),
    );
  });

  it("sends a marked captionless document after finalized text and before TTS voice", async () => {
    const answerStream = createDraftStream(111);
    createTelegramDraftStream.mockReturnValue(answerStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "Proof complete retry.",
          channelData: { openclaw: { assistantPhase: "final_answer" } },
        });
        await dispatcherOptions.deliver(
          {
            text: "Proof complete retry.",
            channelData: { openclaw: { assistantPhase: "final_answer" } },
          },
          { kind: "block" },
        );
        await dispatcherOptions.deliver(
          {
            // Deliberately include the accumulated final text to prove the
            // explicit marker wins before lane delivery reaches Telegram.
            text: "Proof complete retry.",
            mediaUrl: "file:///tmp/proof.pdf",
            channelData: { openclaw: { finalMediaSupplement: "captionless" } },
          },
          { kind: "final" },
        );
        await dispatcherOptions.deliver(
          {
            text: "Proof complete retry.",
            mediaUrl: "file:///tmp/proof-voice.ogg",
            audioAsVoice: true,
            channelData: { openclaw: { finalTtsSupplement: true } },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      111,
      "Proof complete retry.",
      expect.objectContaining({ richMessages: false }),
    );
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: undefined,
            mediaUrl: "file:///tmp/proof.pdf",
            channelData: { openclaw: { finalMediaSupplement: "captionless" } },
          }),
        ],
      }),
    );
    expect(deliverReplies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            mediaUrl: "file:///tmp/proof-voice.ogg",
            audioAsVoice: true,
          }),
        ],
      }),
    );
    expect(editMessageTelegram.mock.invocationCallOrder[0]).toBeLessThan(
      deliverReplies.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(deliverReplies.mock.invocationCallOrder[0]).toBeLessThan(
      deliverReplies.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("preserves an intentional caption on an unmarked final media payload", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Intentional document caption.",
          mediaUrl: "file:///tmp/captioned.pdf",
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: "Intentional document caption.",
            mediaUrl: "file:///tmp/captioned.pdf",
          }),
        ],
      }),
    );
  });

  it("finalizes a phase-less answer block before a preview-captioned TTS voice supplement and does not reuse progress on the next turn", async () => {
    const leakedProgressDraftStream = createSequencedDraftStream(9001);
    createTelegramDraftStream.mockReturnValue(leakedProgressDraftStream);
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          { text: "hi Sir. Still suspiciously operational." },
          {
            kind: "block",
          },
        );
        await dispatcherOptions.deliver(
          {
            mediaUrl: "file:///tmp/hi-voice.ogg",
            audioAsVoice: true,
            text: "hi Sir. Still suspiciously operational. This caption should stay attached to the voice supplement.",
            channelData: { openclaw: { finalTtsSupplement: true } },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "Princess Fiona repeat." }, { kind: "block" });
        await dispatcherOptions.deliver(
          {
            mediaUrl: "file:///tmp/fiona-voice.ogg",
            audioAsVoice: true,
            text: "Princess Fiona repeat. This caption should also stay attached to the voice supplement.",
            channelData: { openclaw: { finalTtsSupplement: true } },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });
    deliverReplies.mockResolvedValue({ delivered: true });
    const context = createContext({
      ctxPayload: {
        SessionKey: "topic-15431",
      } as unknown as TelegramMessageContext["ctxPayload"],
    });

    await dispatchWithContext({ context });
    await dispatchWithContext({ context });

    // The phase-less text block is the visible final answer when the next
    // boundary is the TTS media supplement. That supplement keeps only a short
    // caption preview for context and must never feed the mutable progress
    // controller as another text answer.
    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(leakedProgressDraftStream.update).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: "hi Sir. Still suspiciously operational.",
          }),
        ],
      }),
    );
    expect(deliverReplies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            mediaUrl: "file:///tmp/hi-voice.ogg",
            audioAsVoice: true,
            text: "hi Sir. Still suspiciously operational. This caption should stay attached to the voice supplement.",
          }),
        ],
      }),
    );
    expect(deliverReplies).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: "Princess Fiona repeat.",
          }),
        ],
      }),
    );
    expect(deliverReplies).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            mediaUrl: "file:///tmp/fiona-voice.ogg",
            audioAsVoice: true,
            text: "Princess Fiona repeat. This caption should also stay attached to the voice supplement.",
          }),
        ],
      }),
    );
  });

  it("logs bounded-caption preview ledger events for final TTS supplements", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Final answer.",
          channelData: { openclaw: { assistantPhase: "final_answer" } },
        },
        { kind: "final" },
      );
      await dispatcherOptions.deliver(
        {
          mediaUrl: "file:///tmp/final-voice.ogg",
          audioAsVoice: true,
          text: "Final answer.",
          channelData: { openclaw: { finalTtsSupplement: true } },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockImplementation(async (options) => {
      const reply = (options as { replies?: Array<{ text?: string; mediaUrl?: string }> })
        .replies?.[0];
      const deliveredHook = (
        options as {
          onReplyDelivered?: (event: {
            messageId?: number;
            textLength: number;
            hasMedia: boolean;
            audioAsVoice: boolean;
            finalTtsSupplement: boolean;
            delivered: boolean;
          }) => void;
        }
      ).onReplyDelivered;
      deliveredHook?.({
        messageId: reply?.mediaUrl ? 42 : 41,
        textLength: reply?.text?.length ?? 0,
        hasMedia: Boolean(reply?.mediaUrl),
        audioAsVoice: Boolean(reply?.mediaUrl),
        finalTtsSupplement: Boolean(reply?.mediaUrl),
        delivered: true,
      });
      return { delivered: true };
    });
    const runtime = createRuntime();

    await dispatchWithContext({ context: createContext(), runtime });

    expect(deliverReplies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            mediaUrl: "file:///tmp/final-voice.ogg",
            audioAsVoice: true,
            text: "Final answer.",
          }),
        ],
      }),
    );
    const logLines = (runtime.log as ReturnType<typeof vi.fn>).mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("telegram.preview.ledger"));
    expect(logLines.some((line) => line.includes("lane=tts phase=tts_send_attempt"))).toBe(true);
    expect(
      logLines.some(
        (line) =>
          line.includes("lane=tts") &&
          line.includes("phase=tts_send_completed") &&
          line.includes("message=42") &&
          line.includes("textLength=13"),
      ),
    ).toBe(true);
  });

  it("delivers tool-result media without falling back to empty response", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onToolResult?.({
        text: "Scan this QR in WhatsApp → Linked Devices.",
        mediaUrls: ["/tmp/openclaw-whatsapp-qr-default.png"],
      });
      return { queuedFinal: false };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: "Scan this QR in WhatsApp → Linked Devices.",
            mediaUrls: ["/tmp/openclaw-whatsapp-qr-default.png"],
          }),
        ],
      }),
    );
  });

  it("does not send fallback when response is NO_REPLY without a non-silent failure", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
    });

    await dispatchWithContext({ context: createContext() });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("falls back when all finals are skipped", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onSkip?.({ text: "" }, { reason: "no_reply", kind: "final" });
      return { queuedFinal: false };
    });
    deliverReplies.mockResolvedValueOnce({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: expect.stringContaining("No response"),
          }),
        ],
      }),
    );
  });

  it("sends fallback when deliver throws and dispatcher swallows the error", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      try {
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      } catch (err) {
        dispatcherOptions.onError(err, { kind: "final" });
      }
      return { queuedFinal: false };
    });
    deliverReplies
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ delivered: true });

    await expect(dispatchWithContext({ context: createContext() })).resolves.toBeUndefined();
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: expect.stringContaining("No response"),
          }),
        ],
      }),
    );
  });

  it("sends fallback in off mode when deliver throws", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      try {
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      } catch (err) {
        dispatcherOptions.onError(err, { kind: "final" });
      }
      return { queuedFinal: false };
    });
    deliverReplies
      .mockRejectedValueOnce(new Error("403 bot blocked"))
      .mockResolvedValueOnce({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: expect.stringContaining("No response"),
          }),
        ],
      }),
    );
  });

  it("sends error fallback when dispatcher throws", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error("dispatcher exploded"));
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          { text: "Something went wrong while processing your request. Please try again." },
        ],
      }),
    );
  });

  it("supports concurrent text-final dispatches without sharing progress previews", async () => {
    const draftA = createDraftStream(11);
    const draftB = createDraftStream(22);
    createTelegramDraftStream.mockReturnValueOnce(draftA).mockReturnValueOnce(draftB);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolResult?.({
          text: "working",
          channelData: { openclaw: { sourcePreview: true } },
        });
        await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await Promise.all([
      dispatchWithContext({
        context: createContext({
          chatId: 1,
          msg: { chat: { id: 1, type: "private" }, message_id: 1 } as never,
          threadSpec: { id: 1, scope: "dm" } as never,
        }),
      }),
      dispatchWithContext({
        context: createContext({
          chatId: 2,
          msg: { chat: { id: 2, type: "private" }, message_id: 2 } as never,
          threadSpec: { id: 2, scope: "dm" } as never,
        }),
      }),
    ]);

    expect(draftA.update).toHaveBeenCalledWith("working");
    expect(draftB.update).toHaveBeenCalledWith("working");
    expect(draftA.update).toHaveBeenCalledWith("Work log");
    expect(draftB.update).toHaveBeenCalledWith("Work log");
    expect(draftA.clear).not.toHaveBeenCalled();
    expect(draftB.clear).not.toHaveBeenCalled();
  });

  it("shows compacting reaction during auto-compaction and resumes thinking", async () => {
    const statusReactionController = {
      setThinking: vi.fn(async () => {}),
      setCompacting: vi.fn(async () => {}),
      setTool: vi.fn(async () => {}),
      setDone: vi.fn(async () => {}),
      setError: vi.fn(async () => {}),
      setQueued: vi.fn(async () => {}),
      cancelPending: vi.fn(() => {}),
      clear: vi.fn(async () => {}),
      restoreInitial: vi.fn(async () => {}),
    };
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onCompactionStart?.();
      await replyOptions?.onCompactionEnd?.();
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        statusReactionController: statusReactionController as never,
      }),
      streamMode: "off",
    });

    expect(statusReactionController.setCompacting).toHaveBeenCalledTimes(1);
    expect(statusReactionController.cancelPending).toHaveBeenCalledTimes(1);
    expect(statusReactionController.setThinking).toHaveBeenCalledTimes(2);
    expect(statusReactionController.setCompacting.mock.invocationCallOrder[0]).toBeLessThan(
      statusReactionController.cancelPending.mock.invocationCallOrder[0],
    );
    expect(statusReactionController.cancelPending.mock.invocationCallOrder[0]).toBeLessThan(
      statusReactionController.setThinking.mock.invocationCallOrder[1],
    );
  });
});
