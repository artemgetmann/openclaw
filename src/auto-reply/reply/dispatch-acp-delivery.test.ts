import { describe, expect, it, vi } from "vitest";
import { createAcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: unknown };
    return params.payload;
  }),
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
}) {
  const dispatcher = createDispatcher();
  const coordinator = createAcpDispatchDeliveryCoordinator({
    cfg: createAcpTestConfig(),
    ctx: buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:codex-acp:session-1",
    }),
    dispatcher,
    inboundAudio: false,
    shouldRouteToOriginating: false,
    ...(params?.shouldSendToolSummaries !== undefined
      ? { shouldSendToolSummaries: params.shouldSendToolSummaries }
      : {}),
    ...(params?.onReplyStart ? { onReplyStart: params.onReplyStart } : {}),
  });
  return { coordinator, dispatcher };
}

describe("createAcpDispatchDeliveryCoordinator", () => {
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
});
