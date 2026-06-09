import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

const routeMocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
}));

const ttsMocks = vi.hoisted(() => {
  const state = {
    synthesizeFinalAudio: false,
  };
  return {
    state,
    maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as { kind?: string; payload: Record<string, unknown> };
      if (state.synthesizeFinalAudio && params.kind === "final") {
        return {
          ...params.payload,
          mediaUrl: "https://example.com/final-tts.opus",
          audioAsVoice: true,
        };
      }
      return params.payload;
    }),
  };
});

vi.mock("./route-reply.js", () => ({
  routeReply: (params: unknown) => routeMocks.routeReply(params),
}));

vi.mock("../../tts/tts.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

function createCoordinator(params?: {
  onReplyStart?: (...args: unknown[]) => Promise<void>;
  shouldSendToolSummaries?: boolean;
  provider?: string;
  surface?: string;
  messageThreadId?: string | number;
  shouldRouteToOriginating?: boolean;
  originatingChannel?: string;
  originatingTo?: string;
}) {
  const dispatcher = createDispatcher();
  const coordinator = createAcpDispatchDeliveryCoordinator({
    cfg: createAcpTestConfig(),
    ctx: buildTestCtx({
      Provider: params?.provider ?? "discord",
      Surface: params?.surface ?? params?.provider ?? "discord",
      SessionKey: "agent:codex-acp:session-1",
      ...(params?.messageThreadId != null ? { MessageThreadId: params.messageThreadId } : {}),
    }),
    dispatcher,
    inboundAudio: false,
    shouldRouteToOriginating: params?.shouldRouteToOriginating ?? false,
    ...(params?.originatingChannel ? { originatingChannel: params.originatingChannel } : {}),
    ...(params?.originatingTo ? { originatingTo: params.originatingTo } : {}),
    ...(params?.shouldSendToolSummaries !== undefined
      ? { shouldSendToolSummaries: params.shouldSendToolSummaries }
      : {}),
    ...(params?.onReplyStart ? { onReplyStart: params.onReplyStart } : {}),
  });
  return { coordinator, dispatcher };
}

describe("createAcpDispatchDeliveryCoordinator", () => {
  beforeEach(() => {
    routeMocks.routeReply.mockClear();
    ttsMocks.state.synthesizeFinalAudio = false;
    ttsMocks.maybeApplyTtsToPayload.mockClear();
  });

  it("routes same-source Telegram ACP blocks through the dispatcher preview lane", async () => {
    const { coordinator, dispatcher } = createCoordinator({
      provider: "telegram",
      surface: "telegram",
      shouldRouteToOriginating: true,
      originatingChannel: "telegram",
      originatingTo: "telegram:123",
    });

    await coordinator.deliver("tool", { text: "Tool started." });
    await coordinator.deliver("block", { text: "Checking example.com." });
    await coordinator.deliver("final", { text: "Final answer." });

    expect(dispatcher.sendToolResult).toHaveBeenCalledWith({ text: "Tool started." });
    expect(dispatcher.sendBlockReply).toHaveBeenCalledWith({ text: "Checking example.com." });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "Final answer." });
    expect(routeMocks.routeReply).not.toHaveBeenCalled();
  });

  it("keeps non-Telegram originating ACP blocks on direct routeReply delivery", async () => {
    const { coordinator, dispatcher } = createCoordinator({
      provider: "discord",
      surface: "discord",
      shouldRouteToOriginating: true,
      originatingChannel: "telegram",
      originatingTo: "telegram:thread-1",
    });

    await coordinator.deliver("block", { text: "Checking example.com." });

    expect(routeMocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:thread-1",
      }),
    );
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("starts reply lifecycle only once when called directly and through deliver", async () => {
    const onReplyStart = vi.fn(async () => {});
    const { coordinator } = createCoordinator({ onReplyStart });

    await coordinator.startReplyLifecycle();
    await coordinator.deliver("final", { text: "hello" });
    await coordinator.startReplyLifecycle();
    await coordinator.deliver("block", { text: "world" });

    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("starts reply lifecycle once when deliver triggers first", async () => {
    const onReplyStart = vi.fn(async () => {});
    const { coordinator } = createCoordinator({ onReplyStart });

    await coordinator.deliver("final", { text: "hello" });
    await coordinator.startReplyLifecycle();

    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("does not start reply lifecycle for empty payload delivery", async () => {
    const onReplyStart = vi.fn(async () => {});
    const { coordinator } = createCoordinator({ onReplyStart });

    await coordinator.deliver("final", {});

    expect(onReplyStart).not.toHaveBeenCalled();
  });

  it("strips leaked ACP tool summary labels at delivery when summaries are disabled", async () => {
    const { coordinator, dispatcher } = createCoordinator({ shouldSendToolSummaries: false });

    await coordinator.deliver("block", {
      text: "🔧 exec\n\n🔧 web_search\n\n🔧 exec update\n\ntelegram_voice_sanitize_ok\n\n🔧 web_fetch\n\n🔧 cron\n\nfinal",
    });

    expect(dispatcher.sendBlockReply).toHaveBeenCalledWith({
      text: "telegram_voice_sanitize_ok\nfinal",
    });
  });

  it("preserves ACP tool summary labels at delivery when summaries are enabled", async () => {
    const { coordinator, dispatcher } = createCoordinator({ shouldSendToolSummaries: true });
    const text = "🔧 exec\n\n🔧 exec update\n\ntelegram_voice_verbose_ok";

    await coordinator.deliver("block", { text });

    expect(dispatcher.sendBlockReply).toHaveBeenCalledWith({ text });
  });

  it("skips TTS for source-preview progress but keeps final TTS eligible", async () => {
    const { coordinator, dispatcher } = createCoordinator();
    const sourcePreview = {
      openclaw: {
        sourcePreview: true,
      },
    };

    await coordinator.deliver("tool", {
      text: "Checking example.com.",
      channelData: sourcePreview,
    });
    await coordinator.deliver("block", {
      text: "Reading IANA.",
      channelData: sourcePreview,
    });
    await coordinator.deliver("final", { text: "Final answer." });

    expect(ttsMocks.maybeApplyTtsToPayload).toHaveBeenCalledTimes(1);
    expect(ttsMocks.maybeApplyTtsToPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "final",
        payload: { text: "Final answer." },
      }),
    );
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith({
      text: "Checking example.com.",
      channelData: sourcePreview,
    });
    expect(dispatcher.sendBlockReply).toHaveBeenCalledWith({
      text: "Reading IANA.",
      channelData: sourcePreview,
    });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "Final answer." });
  });

  it("delivers synthesized final TTS as a media-only supplement", async () => {
    ttsMocks.state.synthesizeFinalAudio = true;
    const { coordinator, dispatcher } = createCoordinator();

    await coordinator.deliverFinalTtsSupplement("Final answer already visible.");

    expect(ttsMocks.maybeApplyTtsToPayload).toHaveBeenCalledTimes(1);
    expect(ttsMocks.maybeApplyTtsToPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "final",
        payload: { text: "Final answer already visible." },
      }),
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: undefined,
      mediaUrl: "https://example.com/final-tts.opus",
      audioAsVoice: true,
    });
  });

  it("delivers visible final text before media-only TTS in the same Telegram thread", async () => {
    ttsMocks.state.synthesizeFinalAudio = true;
    const { coordinator } = createCoordinator({
      provider: "discord",
      surface: "discord",
      shouldRouteToOriginating: true,
      originatingChannel: "telegram",
      originatingTo: "telegram:thread-1",
      messageThreadId: 777,
    });

    const visibleDelivered = await coordinator.deliverFinalTextBeforeTts("Final answer.");
    const voiceDelivered = await coordinator.deliverFinalTtsSupplement("Final answer.");

    expect(visibleDelivered).toBe(true);
    expect(voiceDelivered).toBe(true);
    expect(routeMocks.routeReply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:thread-1",
        threadId: 777,
        payload: expect.objectContaining({
          text: "Final answer.",
          channelData: {
            openclaw: {
              assistantPhase: "final_answer",
            },
          },
        }),
      }),
    );
    expect(routeMocks.routeReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:thread-1",
        threadId: 777,
        payload: expect.objectContaining({
          text: undefined,
          mediaUrl: "https://example.com/final-tts.opus",
          audioAsVoice: true,
        }),
      }),
    );
  });

  it("does not send the media-only TTS supplement when visible final text fails", async () => {
    ttsMocks.state.synthesizeFinalAudio = true;
    routeMocks.routeReply.mockResolvedValueOnce({ ok: false, error: "thread missing" });
    const { coordinator } = createCoordinator({
      provider: "discord",
      surface: "discord",
      shouldRouteToOriginating: true,
      originatingChannel: "telegram",
      originatingTo: "telegram:thread-1",
      messageThreadId: 777,
    });

    const visibleDelivered = await coordinator.deliverFinalTextBeforeTts("Final answer.");

    expect(visibleDelivered).toBe(false);
    expect(routeMocks.routeReply).toHaveBeenCalledTimes(1);
  });
});
