import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./pi-embedded-subscribe.handlers.tools.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

// Minimal mock context factory. Only the fields needed for the media emission path.
function createMockContext(overrides?: {
  shouldEmitToolOutput?: boolean;
  onToolResult?: ReturnType<typeof vi.fn>;
}): EmbeddedPiSubscribeContext {
  const onToolResult = overrides?.onToolResult ?? vi.fn();
  return {
    params: {
      runId: "test-run",
      onToolResult,
      onAgentEvent: vi.fn(),
    },
    state: {
      toolMetaById: new Map(),
      toolMetas: [],
      toolSummaryById: new Set(),
      pendingMessagingTexts: new Map(),
      pendingMessagingTargets: new Map(),
      pendingMessagingMediaUrls: new Map(),
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      deterministicApprovalPromptSent: false,
    },
    log: { debug: vi.fn(), warn: vi.fn() },
    shouldEmitToolResult: vi.fn(() => false),
    shouldEmitToolOutput: vi.fn(() => overrides?.shouldEmitToolOutput ?? false),
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
    hookRunner: undefined,
    // Fill in remaining required fields with no-ops.
    blockChunker: null,
    noteLastAssistant: vi.fn(),
    stripBlockTags: vi.fn((t: string) => t),
    emitBlockChunk: vi.fn(),
    flushBlockReplyBuffer: vi.fn(),
    emitReasoningStream: vi.fn(),
    consumeReplyDirectives: vi.fn(() => null),
    consumePartialReplyDirectives: vi.fn(() => null),
    resetAssistantMessageState: vi.fn(),
    resetForCompactionRetry: vi.fn(),
    finalizeAssistantTexts: vi.fn(),
    ensureCompactionPromise: vi.fn(),
    noteCompactionRetry: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
    recordAssistantUsage: vi.fn(),
    incrementCompactionCount: vi.fn(),
    getUsageTotals: vi.fn(() => undefined),
    getCompactionCount: vi.fn(() => 0),
  } as unknown as EmbeddedPiSubscribeContext;
}

async function emitPngMediaToolResult(
  ctx: EmbeddedPiSubscribeContext,
  opts?: { isError?: boolean },
) {
  await handleToolExecutionEnd(ctx, {
    type: "tool_execution_end",
    toolName: "browser",
    toolCallId: "tc-1",
    isError: opts?.isError ?? false,
    result: {
      content: [
        { type: "text", text: "MEDIA:/tmp/screenshot.png" },
        { type: "image", data: "base64", mimeType: "image/png" },
      ],
      details: { path: "/tmp/screenshot.png" },
    },
  });
}

async function emitUntrustedToolMediaResult(
  ctx: EmbeddedPiSubscribeContext,
  mediaPathOrUrl: string,
) {
  await handleToolExecutionEnd(ctx, {
    type: "tool_execution_end",
    toolName: "plugin_tool",
    toolCallId: "tc-1",
    isError: false,
    result: {
      content: [{ type: "text", text: `MEDIA:${mediaPathOrUrl}` }],
    },
  });
}

async function emitWhatsAppQrToolResult(ctx: EmbeddedPiSubscribeContext) {
  const qrPath = path.join(
    resolvePreferredOpenClawTmpDir(),
    "whatsapp-login",
    "openclaw-whatsapp-qr-default.png",
  );
  await handleToolExecutionEnd(ctx, {
    type: "tool_execution_end",
    toolName: "whatsapp_login",
    toolCallId: "tc-wa-1",
    isError: false,
    result: {
      content: [
        { type: "text", text: "Scan this QR in WhatsApp → Linked Devices." },
        { type: "image", data: "base64", mimeType: "image/png" },
      ],
      details: { path: qrPath },
    },
  });
}

async function emitImageGenerateToolResult(ctx: EmbeddedPiSubscribeContext, mediaPath: string) {
  await handleToolExecutionEnd(ctx, {
    type: "tool_execution_end",
    toolName: "image_generate",
    toolCallId: "tc-image-generate-1",
    isError: false,
    result: {
      content: [
        {
          type: "text",
          text: `Generated 1 image with openai/gpt-image-2.\nMEDIA:${mediaPath}`,
        },
      ],
      details: {
        provider: "openai",
        model: "gpt-image-2",
        count: 1,
        media: { mediaUrls: [mediaPath] },
        paths: [mediaPath],
      },
    },
  });
}

describe("handleToolExecutionEnd media emission", () => {
  it("does not warn for read tool when path is provided via file_path alias", async () => {
    const ctx = createMockContext();

    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tc-1",
      args: { file_path: "README.md" },
    });

    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("emits media when verbose is off and tool result has MEDIA: path", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await emitPngMediaToolResult(ctx);

    expect(onToolResult).toHaveBeenCalledWith({
      mediaUrls: ["/tmp/screenshot.png"],
    });
  });

  it("trusts whatsapp_login temp QR files for direct media delivery", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });
    const qrPath = path.join(
      resolvePreferredOpenClawTmpDir(),
      "whatsapp-login",
      "openclaw-whatsapp-qr-default.png",
    );

    await emitWhatsAppQrToolResult(ctx);

    expect(onToolResult).toHaveBeenCalledWith({ mediaUrls: [qrPath] });
  });

  it("trusts image_generate local tool-image-generation media when verbose output is off", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });
    const generatedPath = path.join(
      resolvePreferredOpenClawTmpDir(),
      "tool-image-generation",
      "generated-image.png",
    );

    await emitImageGenerateToolResult(ctx, generatedPath);

    expect(onToolResult).toHaveBeenCalledWith({ mediaUrls: [generatedPath] });
  });

  it("does NOT emit local media for untrusted tools", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await emitUntrustedToolMediaResult(ctx, "/tmp/secret.png");

    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("emits remote media for untrusted tools", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await emitUntrustedToolMediaResult(ctx, "https://example.com/file.png");

    expect(onToolResult).toHaveBeenCalledWith({
      mediaUrls: ["https://example.com/file.png"],
    });
  });

  it("does NOT emit media when verbose is full (emitToolOutput handles it)", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: true, onToolResult });

    await emitPngMediaToolResult(ctx);

    // onToolResult should NOT be called by the new media path (emitToolOutput handles it).
    // It may be called by emitToolOutput, but the new block should not fire.
    // Verify emitToolOutput was called instead.
    expect(ctx.emitToolOutput).toHaveBeenCalled();
    // The direct media emission should not have been called with just mediaUrls.
    const directMediaCalls = onToolResult.mock.calls.filter(
      (call: unknown[]) =>
        call[0] &&
        typeof call[0] === "object" &&
        "mediaUrls" in (call[0] as Record<string, unknown>) &&
        !("text" in (call[0] as Record<string, unknown>)),
    );
    expect(directMediaCalls).toHaveLength(0);
  });

  it("does NOT emit media for error results", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await emitPngMediaToolResult(ctx, { isError: true });

    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("does NOT emit when tool result has no media", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [{ type: "text", text: "Command executed successfully" }],
      },
    });

    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("does NOT emit media for <media:audio> placeholder text", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "tts",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "<media:audio> placeholder with successful preflight voice transcript",
          },
        ],
      },
    });

    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("does NOT emit media for malformed MEDIA:-prefixed prose", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "browser",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "MEDIA:-prefixed paths (lenient whitespace) when loading outbound media",
          },
        ],
      },
    });

    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("emits media from details.path fallback when no MEDIA: text", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "canvas",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [
          { type: "text", text: "Rendered canvas" },
          { type: "image", data: "base64", mimeType: "image/png" },
        ],
        details: { path: "/tmp/canvas-output.png" },
      },
    });

    expect(onToolResult).toHaveBeenCalledWith({
      mediaUrls: ["/tmp/canvas-output.png"],
    });
  });
});
