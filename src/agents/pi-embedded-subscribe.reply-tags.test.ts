import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession reply tags", () => {
  function createBlockReplyHarness(options?: { deferPhaseUnknownBlockReplies?: boolean }) {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onBlockReply,
      deferPhaseUnknownBlockReplies: options?.deferPhaseUnknownBlockReplies,
      blockReplyBreak: "text_end",
      blockReplyChunking: {
        minChars: 1,
        maxChars: 50,
        breakPreference: "newline",
      },
    });

    return { emit, onBlockReply };
  }

  it("carries reply_to_current across tag-only block chunks", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "[[reply_to_current]]\nHello" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "[[reply_to_current]]\nHello" }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = onBlockReply.mock.calls[0]?.[0];
    expect(payload?.text).toBe("Hello");
    expect(payload?.replyToCurrent).toBe(true);
    expect(payload?.replyToTag).toBe(true);
  });

  it("carries assistant textSignature phase metadata into block replies", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness();
    const textSignature = JSON.stringify({
      v: 1,
      id: "msg_final",
      phase: "final_answer",
    });

    emit({
      type: "message_start",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final answer", textSignature }],
      },
    });
    emitAssistantTextDelta({ emit, delta: "Final answer" });
    emitAssistantTextEnd({ emit });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final answer", textSignature }],
      } as AssistantMessage,
    });
    await Promise.resolve();

    const payload = onBlockReply.mock.calls[0]?.[0];
    expect(payload?.channelData).toMatchObject({
      openclaw: { assistantPhase: "final_answer" },
    });
  });

  it("keeps phase metadata when text streams before the signed message end", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness({
      deferPhaseUnknownBlockReplies: true,
    });
    const textSignature = JSON.stringify({
      v: 1,
      id: "msg_commentary",
      phase: "commentary",
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Step 1: writing the first note." });
    emitAssistantTextEnd({ emit });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Step 1: writing the first note.", textSignature }],
      } as AssistantMessage,
    });
    await Promise.resolve();

    const payload = onBlockReply.mock.calls[0]?.[0];
    expect(payload?.channelData).toMatchObject({
      openclaw: { assistantPhase: "commentary" },
    });
  });

  it("marks pre-tool text as commentary when phase is deferred", () => {
    const { emit, onBlockReply } = createBlockReplyHarness({
      deferPhaseUnknownBlockReplies: true,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Step 1: writing the first note." });
    emit({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-1",
      args: { command: "printf hi" },
    });

    const payload = onBlockReply.mock.calls[0]?.[0];
    expect(payload?.channelData).toMatchObject({
      openclaw: { assistantPhase: "commentary" },
    });
  });

  it("flushes trailing directive tails on stream end", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Hello [[" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello [[" }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Hello");
    expect(onBlockReply.mock.calls[1]?.[0]?.text).toBe("[[");
  });

  it("streams partial replies past reply_to tags split across chunks", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "[[reply_to:1897" });
    emitAssistantTextDelta({ emit, delta: "]] Hello" });
    emitAssistantTextDelta({ emit, delta: " world" });
    emitAssistantTextEnd({ emit });

    const lastPayload = onPartialReply.mock.calls.at(-1)?.[0];
    expect(lastPayload?.text).toBe("Hello world");
    for (const call of onPartialReply.mock.calls) {
      expect(call[0]?.text?.includes("[[reply_to")).toBe(false);
    }
  });
});
