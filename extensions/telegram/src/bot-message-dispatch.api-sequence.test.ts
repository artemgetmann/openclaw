import type { Bot } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.js";
import type { RuntimeEnv } from "../../../src/runtime.js";
import {
  __testing as workLogTesting,
  getTelegramWorkLog,
  renderTelegramWorkLog,
} from "./work-log.js";

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
  const sendVoice = vi.fn(async () => ({ message_id: nextMessageId++ }));
  const sendAudio = vi.fn(async () => ({ message_id: nextMessageId++ }));

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
    workLogTesting.resetTelegramWorkLogsForTests();
    loadSessionStore.mockReturnValue({});
    resolveStorePath.mockReturnValue("/tmp/sessions.json");
  });

  it("folds acknowledgment and plan into one Work log while final keeps its own identity", async () => {
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
            editMessageTextCalls(harness.calls).some((call) => call.text.includes("Plan updated")),
          ).toBe(true),
        );
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: partialAnswer });
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
    const planEdit = editMessageTextCalls(harness.calls).find((call) =>
      call.text.includes("Plan updated"),
    );
    const previewSend = sendMessageCalls(harness.calls).find((call) =>
      call.text.includes(partialAnswer),
    );

    expect(acknowledgmentSend).toBeDefined();
    expect(planEdit).toBeDefined();
    expect(previewSend).toBeDefined();
    // Assert the product contract at Telegram API level: the first natural
    // acknowledgment becomes the Work log in place, while final text owns a
    // separate preview identity that is finalized by edit.
    expect(planEdit).toEqual(
      expect.objectContaining({
        messageId: acknowledgmentSend!.messageId,
        text: expect.stringMatching(
          new RegExp(`${acknowledgment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*Plan updated`, "s"),
        ),
      }),
    );
    expect(harness.calls).toEqual([
      expect.objectContaining({
        op: "sendMessage",
        messageId: acknowledgmentSend!.messageId,
        text: acknowledgment,
      }),
      expect.objectContaining({
        op: "editMessageText",
        messageId: acknowledgmentSend!.messageId,
        text: expect.stringMatching(/I’ll inspect.*Plan updated/s),
      }),
      expect.objectContaining({
        op: "sendMessage",
        messageId: previewSend!.messageId,
        text: partialAnswer,
      }),
      expect.objectContaining({
        op: "editMessageText",
        messageId: acknowledgmentSend!.messageId,
        text: "Work log",
      }),
      expect.objectContaining({
        op: "editMessageText",
        messageId: acknowledgmentSend!.messageId,
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

  it("retains the complete acknowledgment instead of a one-character transport snapshot", async () => {
    const harness = createTelegramBotHarness(6970);
    const acknowledgment = "I’ll inspect the files first, then run the focused checks.";
    const planText = "Plan updated\n- [~] Inspect files\n- [ ] Run checks";

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        // Reproduce the live ordering: fast-first transport sends one delta,
        // then the lane receives the complete accumulated acknowledgment.
        await replyOptions?.onPartialReply?.({ text: "I" });
        await vi.waitFor(() =>
          expect(sendMessageCalls(harness.calls).some((call) => call.text === "I")).toBe(true),
        );
        await replyOptions?.onPartialReply?.({ text: acknowledgment });
        await replyOptions?.onToolStart?.({ name: "update_plan", phase: "completed" });
        await replyOptions?.onToolResult?.({
          text: planText,
          channelData: { openclaw: { sourcePreview: true, progressKind: "plan" } },
        });
        await dispatcherOptions.deliver({ text: "Focused checks passed." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithHarness({ bot: harness.bot });

    const workLog = getTelegramWorkLog("1");
    expect(workLog).toBeDefined();
    expect(renderTelegramWorkLog(workLog!, true).text).toBe(
      `Work log\n\n${acknowledgment}\n\n${planText}`,
    );
    expect(renderTelegramWorkLog(workLog!, true).text).not.toMatch(/^Work log\n\nI\n\n/m);

    const oneCharacterSendIndex = harness.calls.findIndex(
      (call) => call.op === "sendMessage" && call.text === "I",
    );
    const collapsedWorkLogEditIndex = harness.calls.findIndex(
      (call) => call.op === "editMessageText" && call.text === "Work log",
    );
    const finalSendIndex = harness.calls.findIndex(
      (call) => call.op === "sendMessage" && call.text.includes("Focused checks passed."),
    );
    expect(oneCharacterSendIndex).toBeLessThan(collapsedWorkLogEditIndex);
    expect(collapsedWorkLogEditIndex).toBeLessThan(finalSendIndex);
  });

  it("keeps repeated plans and natural commentary inside one Work log", async () => {
    const harness = createTelegramBotHarness(6970);
    const acknowledgment =
      "I’ll inspect the package metadata first, then verify the temp-file round trip.";
    const firstPlan = "Plan updated\n- [~] Inspect files\n- [ ] Run checks";
    const commentary = "The package name is confirmed; I’m checking the temp file next.";
    const secondPlan = "Plan updated\n- [x] Inspect files\n- [~] Run checks";
    const partialAnswerPrefix = "The package metadata is verified.";
    const partialAnswer = `${partialAnswerPrefix} The temp-file cleanup is verified.`;
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
          text: firstPlan,
          channelData: { openclaw: { sourcePreview: true, progressKind: "plan" } },
        });
        await vi.waitFor(() =>
          expect(
            editMessageTextCalls(harness.calls).some((call) =>
              call.text.includes("[~] Inspect files"),
            ),
          ).toBe(true),
        );

        await dispatcherOptions.deliver(
          {
            text: commentary,
            channelData: { openclaw: { assistantPhase: "commentary" } },
          },
          { kind: "block" },
        );
        await vi.waitFor(() =>
          expect(
            editMessageTextCalls(harness.calls).some((call) => call.text.includes(commentary)),
          ).toBe(true),
        );

        await replyOptions?.onToolStart?.({ name: "update_plan", phase: "completed" });
        await replyOptions?.onToolResult?.({
          text: secondPlan,
          channelData: { openclaw: { sourcePreview: true, progressKind: "plan" } },
        });
        await vi.waitFor(() =>
          expect(
            editMessageTextCalls(harness.calls).some((call) =>
              call.text.includes("[x] Inspect files"),
            ),
          ).toBe(true),
        );
        // Providers can stream cumulative final snapshots before a delayed
        // assistant-message boundary, or omit that callback entirely. Both
        // snapshots stay buffered until the final boundary proves they belong
        // to the answer, then keep one answer identity after commentary detaches.
        await replyOptions?.onPartialReply?.({ text: partialAnswerPrefix });
        await replyOptions?.onPartialReply?.({ text: partialAnswer });
        await replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.deliver({ text: finalAnswer }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithHarness({
      bot: harness.bot,
      cfg: { channels: { telegram: { accounts: { default: { botToken: "123:test" } } } } },
      context: createContext({
        ctxPayload: { CommandAuthorized: true, SessionKey: "repeated-plan-api-sequence" },
      }),
    });

    const acknowledgmentSend = sendMessageCalls(harness.calls).find((call) =>
      call.text.includes(acknowledgment),
    );
    const firstPlanEdit = editMessageTextCalls(harness.calls).find((call) =>
      call.text.includes("[~] Inspect files"),
    );
    const commentaryEdit = editMessageTextCalls(harness.calls).find((call) =>
      call.text.includes(commentary),
    );
    const finalPreviewSend = sendMessageCalls(harness.calls).find((call) =>
      call.text.includes(partialAnswerPrefix),
    );
    const partialPreviewEdits = editMessageTextCalls(harness.calls).filter((call) =>
      call.text.includes(partialAnswer),
    );
    const secondPlanEdits = editMessageTextCalls(harness.calls).filter((call) =>
      call.text.includes("[x] Inspect files"),
    );
    const workLogEdits = workLogEditCalls(harness.calls);
    const finalEdits = editMessageTextCalls(harness.calls).filter((call) =>
      call.text.includes(finalAnswer),
    );

    expect(acknowledgmentSend).toBeDefined();
    expect(firstPlanEdit).toBeDefined();
    expect(commentaryEdit).toBeDefined();
    expect(finalPreviewSend).toBeDefined();
    expect(firstPlanEdit!.messageId).toBe(acknowledgmentSend!.messageId);
    expect(commentaryEdit!.messageId).toBe(acknowledgmentSend!.messageId);
    expect(commentaryEdit!.text).toMatch(/I’ll inspect.*Plan updated.*package name is confirmed/s);
    expect(secondPlanEdits).toEqual([
      expect.objectContaining({
        messageId: acknowledgmentSend!.messageId,
        text: expect.stringContaining("[x] Inspect files"),
      }),
    ]);
    expect(workLogEdits.length).toBeGreaterThan(0);
    expect(new Set(workLogEdits.map((call) => call.messageId))).toEqual(
      new Set([acknowledgmentSend!.messageId]),
    );
    expect(finalEdits).toEqual([
      expect.objectContaining({ messageId: finalPreviewSend!.messageId, text: finalAnswer }),
    ]);
    expect(partialPreviewEdits).toEqual([
      expect.objectContaining({ messageId: finalPreviewSend!.messageId, text: finalAnswer }),
    ]);
    expect(deleteMessageCalls(harness.calls)).toHaveLength(0);
    expect(
      sendMessageCalls(harness.calls).filter((call) => call.text.includes("[x] Inspect files")),
    ).toHaveLength(0);
    expect(
      sendMessageCalls(harness.calls).filter((call) => call.text.includes(commentary)),
    ).toHaveLength(0);
    expect(
      sendMessageCalls(harness.calls).filter((call) => call.text.includes(finalAnswer)),
    ).toHaveLength(0);
  });

  it("streams explicitly phased final partials beside an active Work log on one stable ID", async () => {
    const harness = createTelegramBotHarness(7050);
    const planText = "Plan updated\n- [x] Inspect lifecycle\n- [~] Verify ordered delivery";
    const commentary =
      "The lifecycle boundary is confirmed; I’m checking final delivery ordering now.";
    const finalPrefix =
      "The final answer now starts streaming as soon as the runtime marks the assistant message as final.";
    const finalMiddle = `${finalPrefix} ${"Each cumulative snapshot keeps the same Telegram message identity. ".repeat(10).trim()}`;
    const finalAnswer = `${finalMiddle} Work log collapse and voice delivery remain independent.`;
    const finalPhase = { openclaw: { assistantPhase: "final_answer" } };

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolResult?.({
          text: planText,
          channelData: { openclaw: { sourcePreview: true, progressKind: "plan" } },
        });
        await dispatcherOptions.deliver(
          {
            text: commentary,
            channelData: { openclaw: { assistantPhase: "commentary" } },
          },
          { kind: "block" },
        );

        await replyOptions?.onPartialReply?.({ text: finalPrefix, channelData: finalPhase });
        await replyOptions?.onPartialReply?.({ text: finalMiddle, channelData: finalPhase });
        await dispatcherOptions.deliver(
          { text: finalAnswer, channelData: finalPhase },
          { kind: "block" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithHarness({
      bot: harness.bot,
      cfg: { channels: { telegram: { accounts: { default: { botToken: "123:test" } } } } },
      context: createContext({
        ctxPayload: { CommandAuthorized: true, SessionKey: "explicit-final-partial-stream" },
      }),
    });

    const sends = sendMessageCalls(harness.calls);
    const workLogSend = sends.find((call) => call.text.includes("Inspect lifecycle"));
    const finalSend = sends.find((call) => call.text === finalPrefix);
    const finalEdits = editMessageTextCalls(harness.calls).filter(
      (call) => call.text === finalMiddle || call.text === finalAnswer,
    );

    expect(workLogSend).toBeDefined();
    expect(finalSend).toBeDefined();
    expect(finalSend!.messageId).not.toBe(workLogSend!.messageId);
    expect(finalEdits).toEqual([
      expect.objectContaining({ messageId: finalSend!.messageId, text: finalMiddle }),
      expect.objectContaining({ messageId: finalSend!.messageId, text: finalAnswer }),
    ]);
    expect(workLogEditCalls(harness.calls)).not.toHaveLength(0);
    expect(
      workLogEditCalls(harness.calls).every((call) => call.messageId === workLogSend!.messageId),
    ).toBe(true);
    expect(sendMessageCalls(harness.calls).filter((call) => call.text === commentary)).toHaveLength(
      0,
    );
    expect(deleteMessageCalls(harness.calls)).toHaveLength(0);
  });

  it("buffers raw plan-adjacent commentary partials without transient send-delete churn", async () => {
    const harness = createTelegramBotHarness(6990);
    const planText = "Plan updated\n- [~] Inspect the lifecycle\n- [ ] Report the result";
    const commentaryPrefix = "I found the dispatch boundary";
    const commentary =
      "I found the dispatch boundary; I’m checking the ordered callbacks before wrapping up.";
    const finalPrefix = "The callback order is verified.";
    const finalAnswer = `${finalPrefix} Commentary stayed in Work log and the final kept one message ID.`;

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolResult?.({
          text: planText,
          channelData: { openclaw: { sourcePreview: true, progressKind: "plan" } },
        });

        // Raw provider snapshots arrive before their authoritative phased
        // commentary block. None may allocate an answer preview while the plan
        // Work log is active.
        await replyOptions?.onPartialReply?.({ text: commentaryPrefix });
        await replyOptions?.onPartialReply?.({ text: commentary });
        await dispatcherOptions.deliver(
          {
            text: commentary,
            channelData: { openclaw: { assistantPhase: "commentary" } },
          },
          { kind: "block" },
        );

        // A later raw snapshot is proven to be the final prefix by the final
        // boundary. It should materialize once and then be edited in place.
        await replyOptions?.onPartialReply?.({ text: finalPrefix });
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
      cfg: { channels: { telegram: { accounts: { default: { botToken: "123:test" } } } } },
      context: createContext({
        ctxPayload: { CommandAuthorized: true, SessionKey: "plan-partial-commentary-buffer" },
      }),
    });

    const sends = sendMessageCalls(harness.calls);
    const progressSend = sends.find((call) => call.text.includes("Inspect the lifecycle"));
    const finalPreviewSend = sends.find((call) => call.text === finalPrefix);
    const standaloneCommentarySends = sends.filter(
      (call) => call.text === commentaryPrefix || call.text === commentary,
    );
    const finalEdits = editMessageTextCalls(harness.calls).filter((call) =>
      call.text.includes(finalAnswer),
    );

    expect(progressSend).toBeDefined();
    expect(standaloneCommentarySends).toHaveLength(0);
    expect(sends).toHaveLength(2);
    expect(finalPreviewSend).toBeDefined();
    expect(finalPreviewSend!.messageId).not.toBe(progressSend!.messageId);
    expect(finalEdits).toEqual([
      expect.objectContaining({ messageId: finalPreviewSend!.messageId, text: finalAnswer }),
    ]);
    expect(deleteMessageCalls(harness.calls)).toHaveLength(0);
    expect(workLogEditCalls(harness.calls).length).toBeGreaterThan(0);
    expect(
      workLogEditCalls(harness.calls).every((call) => call.messageId === progressSend!.messageId),
    ).toBe(true);
  });

  it("keeps plan-adjacent commentary inside the existing Work log", async () => {
    const commentary = "The package name is confirmed; I’m checking the temp file next.";
    const harness = createTelegramBotHarness(6980);
    const firstPlan = "Plan updated\n- [~] Inspect files\n- [ ] Run checks";
    const secondPlan = "Plan updated\n- [x] Inspect files\n- [~] Run checks";

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolResult?.({
          text: firstPlan,
          channelData: { openclaw: { sourcePreview: true, progressKind: "plan" } },
        });
        await vi.waitFor(() =>
          expect(
            sendMessageCalls(harness.calls).some((call) => call.text.includes("[~] Inspect files")),
          ).toBe(true),
        );
        await dispatcherOptions.deliver(
          {
            text: commentary,
            channelData: { openclaw: { assistantPhase: "commentary" } },
          },
          { kind: "block" },
        );
        await replyOptions?.onToolResult?.({
          text: secondPlan,
          channelData: { openclaw: { sourcePreview: true, progressKind: "plan" } },
        });
        await vi.waitFor(() =>
          expect(
            editMessageTextCalls(harness.calls).some((call) =>
              call.text.includes("[x] Inspect files"),
            ),
          ).toBe(true),
        );
        await dispatcherOptions.deliver({ text: "Done." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithHarness({ bot: harness.bot });

    const planSend = sendMessageCalls(harness.calls).find((call) =>
      call.text.includes("[~] Inspect files"),
    );
    const commentaryAttempts = sendMessageCalls(harness.calls).filter((call) =>
      call.text.includes(commentary),
    );
    const commentaryEdits = editMessageTextCalls(harness.calls).filter((call) =>
      call.text.includes(commentary),
    );
    const secondPlanEdits = editMessageTextCalls(harness.calls).filter((call) =>
      call.text.includes("[x] Inspect files"),
    );
    expect(planSend).toBeDefined();
    expect(commentaryAttempts).toHaveLength(0);
    expect(commentaryEdits).toEqual([expect.objectContaining({ messageId: planSend!.messageId })]);
    expect(secondPlanEdits).toEqual([expect.objectContaining({ messageId: planSend!.messageId })]);
    expect(deleteMessageCalls(harness.calls)).toHaveLength(0);
  });

  it("keeps block-streaming acknowledgment, plans, and commentary on one Work log identity", async () => {
    const harness = createTelegramBotHarness(6990);
    const acknowledgment = "I’ll inspect the files first, then run the checks.";
    const firstPlan = "Plan updated\n- [~] Inspect files\n- [ ] Run checks";
    const commentary = "The package is confirmed; I’m running the checks now.";
    const secondPlan = "Plan updated\n- [x] Inspect files\n- [~] Run checks";

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
          text: firstPlan,
          channelData: { openclaw: { sourcePreview: true, progressKind: "plan" } },
        });
        await dispatcherOptions.deliver(
          {
            text: commentary,
            channelData: { openclaw: { assistantPhase: "commentary" } },
          },
          { kind: "block" },
        );
        await replyOptions?.onToolResult?.({
          text: secondPlan,
          channelData: { openclaw: { sourcePreview: true, progressKind: "plan" } },
        });
        await vi.waitFor(() =>
          expect(
            editMessageTextCalls(harness.calls).some((call) =>
              call.text.includes("[x] Inspect files"),
            ),
          ).toBe(true),
        );
        await dispatcherOptions.deliver({ text: "Done." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithHarness({
      bot: harness.bot,
      context: createContext({
        ctxPayload: { CommandAuthorized: true, SessionKey: "block-stream-plan-commentary" },
      }),
      telegramCfg: { blockStreaming: true },
    });

    const acknowledgmentSend = sendMessageCalls(harness.calls).find((call) =>
      call.text.includes(acknowledgment),
    );
    const commentaryEdit = editMessageTextCalls(harness.calls).find((call) =>
      call.text.includes(commentary),
    );
    const latestPlanEdit = editMessageTextCalls(harness.calls).find((call) =>
      call.text.includes("[x] Inspect files"),
    );
    expect(acknowledgmentSend).toBeDefined();
    expect(commentaryEdit).toBeDefined();
    expect(latestPlanEdit).toBeDefined();
    expect(commentaryEdit!.messageId).toBe(acknowledgmentSend!.messageId);
    expect(latestPlanEdit!.messageId).toBe(acknowledgmentSend!.messageId);
    expect(latestPlanEdit!.text).toMatch(/I’ll inspect.*Plan updated.*package is confirmed/s);
    expect(new Set(workLogEditCalls(harness.calls).map((call) => call.messageId))).toEqual(
      new Set([acknowledgmentSend!.messageId]),
    );
    expect(
      sendMessageCalls(harness.calls).filter((call) => call.text.includes(commentary)),
    ).toHaveLength(0);
    expect(deleteMessageCalls(harness.calls)).toHaveLength(0);
  });

  it("keeps generic source previews mutable instead of materializing them beside the plan", async () => {
    const harness = createTelegramBotHarness(7010);
    const plan = "Plan updated\n- [~] Inspect files\n- [ ] Run checks";
    const genericPreview = "Opening the package metadata now.";

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolResult?.({
          text: plan,
          channelData: { openclaw: { sourcePreview: true, progressKind: "plan" } },
        });
        await replyOptions?.onToolResult?.({
          text: genericPreview,
          channelData: { openclaw: { sourcePreview: true } },
        });
        await vi.waitFor(() =>
          expect(
            editMessageTextCalls(harness.calls).some((call) => call.text.includes(genericPreview)),
          ).toBe(true),
        );
        await dispatcherOptions.deliver({ text: "Done." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithHarness({ bot: harness.bot });

    const planSend = sendMessageCalls(harness.calls).find((call) =>
      call.text.includes("[~] Inspect files"),
    );
    expect(planSend).toBeDefined();
    expect(
      sendMessageCalls(harness.calls).filter((call) => call.text.includes(genericPreview)),
    ).toHaveLength(0);
    expect(
      editMessageTextCalls(harness.calls).filter((call) => call.text.includes(genericPreview)),
    ).toEqual([expect.objectContaining({ messageId: planSend!.messageId })]);
    expect(new Set(workLogEditCalls(harness.calls).map((call) => call.messageId))).toEqual(
      new Set([planSend!.messageId]),
    );
    expect(deleteMessageCalls(harness.calls)).toHaveLength(0);
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
