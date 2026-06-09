import type { OpenClawConfig } from "../../config/config.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { logVerbose } from "../../globals.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { maybeApplyTtsToPayload } from "../../tts/tts.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { ReplyDispatcher, ReplyDispatchKind } from "./reply-dispatcher.js";
import { routeReply } from "./route-reply.js";

export type AcpDispatchDeliveryMeta = {
  toolCallId?: string;
  allowEdit?: boolean;
};

type ToolMessageHandle = {
  channel: string;
  accountId?: string;
  to: string;
  threadId?: string | number;
  messageId: string;
};

type AcpDispatchDeliveryState = {
  startedReplyLifecycle: boolean;
  blockCount: number;
  routedCounts: Record<ReplyDispatchKind, number>;
  toolMessageByCallId: Map<string, ToolMessageHandle>;
};

const ACP_INTERNAL_TOOL_SUMMARY_LINE_RE =
  /^🔧\s+[\w./:-]+(?:\s+(?:start|update|completed|failed|cancelled|done|error))?$/iu;

function isSourcePreviewToolPayload(payload: ReplyPayload): boolean {
  const channelData = payload.channelData;
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) {
    return false;
  }

  // Source previews are transient progress/status payloads emitted through the
  // tool lane. They should remain eligible for delivery filtering, but must not
  // be upgraded into voice/audio replies by the TTS layer.
  const openclaw = channelData.openclaw;
  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
    return false;
  }
  return (openclaw as { sourcePreview?: unknown }).sourcePreview === true;
}

function stripAcpInternalToolSummaryLines(text: string): string {
  const lines = text.split("\n");
  const strippedLines = lines.map((line) => ACP_INTERNAL_TOOL_SUMMARY_LINE_RE.test(line.trim()));
  if (!strippedLines.some(Boolean)) {
    return text;
  }

  return lines
    .filter((line, index) => {
      if (strippedLines[index]) {
        return false;
      }
      // Last-mile guard for ACP backends that already merged tool lifecycle
      // labels into visible text before delivery. Keep real output and only
      // remove blank paragraph separators attached to stripped labels.
      if (line.trim() !== "") {
        return true;
      }
      const previousStripped = index > 0 && strippedLines[index - 1];
      const nextStripped = index + 1 < strippedLines.length && strippedLines[index + 1];
      return !previousStripped && !nextStripped;
    })
    .join("\n");
}

export type AcpDispatchDeliveryCoordinator = {
  startReplyLifecycle: () => Promise<void>;
  deliver: (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    meta?: AcpDispatchDeliveryMeta,
  ) => Promise<boolean>;
  deliverFinalTextBeforeTts: (text: string) => Promise<boolean>;
  deliverFinalTtsSupplement: (text: string) => Promise<boolean>;
  getBlockCount: () => number;
  getRoutedCounts: () => Record<ReplyDispatchKind, number>;
  applyRoutedCounts: (counts: Record<ReplyDispatchKind, number>) => void;
};

export function createAcpDispatchDeliveryCoordinator(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  dispatcher: ReplyDispatcher;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  shouldRouteToOriginating: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  shouldSendToolSummaries?: boolean;
  onReplyStart?: () => Promise<void> | void;
}): AcpDispatchDeliveryCoordinator {
  const state: AcpDispatchDeliveryState = {
    startedReplyLifecycle: false,
    blockCount: 0,
    routedCounts: {
      tool: 0,
      block: 0,
      final: 0,
    },
    toolMessageByCallId: new Map(),
  };

  const startReplyLifecycleOnce = async () => {
    if (state.startedReplyLifecycle) {
      return;
    }
    state.startedReplyLifecycle = true;
    await params.onReplyStart?.();
  };

  const shouldUseSourceDispatcherForTelegram = () => {
    if (!params.shouldRouteToOriginating || !params.originatingChannel) {
      return false;
    }
    const sourceChannel = normalizeMessageChannel(params.ctx.Surface ?? params.ctx.Provider);
    const originatingChannel = normalizeMessageChannel(params.originatingChannel);
    return sourceChannel === "telegram" && originatingChannel === "telegram";
  };

  const deliverViaDispatcher = (kind: ReplyDispatchKind, payload: ReplyPayload): boolean => {
    if (kind === "tool") {
      return params.dispatcher.sendToolResult(payload);
    }
    if (kind === "block") {
      return params.dispatcher.sendBlockReply(payload);
    }
    return params.dispatcher.sendFinalReply(payload);
  };

  const deliverPreparedPayload = async (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    meta?: AcpDispatchDeliveryMeta,
  ): Promise<boolean> => {
    if (shouldUseSourceDispatcherForTelegram()) {
      return deliverViaDispatcher(kind, payload);
    }

    if (params.shouldRouteToOriginating && params.originatingChannel && params.originatingTo) {
      const toolCallId = meta?.toolCallId?.trim();
      if (kind === "tool" && meta?.allowEdit === true && toolCallId) {
        const edited = await tryEditToolMessage(payload, toolCallId);
        if (edited) {
          return true;
        }
      }

      const result = await routeReply({
        payload,
        channel: params.originatingChannel,
        to: params.originatingTo,
        sessionKey: params.ctx.SessionKey,
        accountId: params.ctx.AccountId,
        threadId: params.ctx.MessageThreadId,
        cfg: params.cfg,
      });
      if (!result.ok) {
        logVerbose(
          `dispatch-acp: route-reply (acp/${kind}) failed: ${result.error ?? "unknown error"}`,
        );
        return false;
      }
      if (kind === "tool" && meta?.toolCallId && result.messageId) {
        state.toolMessageByCallId.set(meta.toolCallId, {
          channel: params.originatingChannel,
          accountId: params.ctx.AccountId,
          to: params.originatingTo,
          ...(params.ctx.MessageThreadId != null ? { threadId: params.ctx.MessageThreadId } : {}),
          messageId: result.messageId,
        });
      }
      state.routedCounts[kind] += 1;
      return true;
    }

    return deliverViaDispatcher(kind, payload);
  };

  const tryEditToolMessage = async (
    payload: ReplyPayload,
    toolCallId: string,
  ): Promise<boolean> => {
    if (!params.shouldRouteToOriginating || !params.originatingChannel || !params.originatingTo) {
      return false;
    }
    const handle = state.toolMessageByCallId.get(toolCallId);
    if (!handle?.messageId) {
      return false;
    }
    const message = payload.text?.trim();
    if (!message) {
      return false;
    }

    try {
      await runMessageAction({
        cfg: params.cfg,
        action: "edit",
        params: {
          channel: handle.channel,
          accountId: handle.accountId,
          to: handle.to,
          threadId: handle.threadId,
          messageId: handle.messageId,
          message,
        },
        sessionKey: params.ctx.SessionKey,
      });
      state.routedCounts.tool += 1;
      return true;
    } catch (error) {
      logVerbose(
        `dispatch-acp: tool message edit failed for ${toolCallId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };

  const deliver = async (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    meta?: AcpDispatchDeliveryMeta,
  ): Promise<boolean> => {
    if (params.shouldSendToolSummaries === false && typeof payload.text === "string") {
      payload = {
        ...payload,
        text: stripAcpInternalToolSummaryLines(payload.text),
      };
    }
    if (kind === "block" && payload.text?.trim()) {
      state.blockCount += 1;
    }

    if ((payload.text?.trim() ?? "").length > 0 || payload.mediaUrl || payload.mediaUrls?.length) {
      await startReplyLifecycleOnce();
    }

    const ttsPayload = isSourcePreviewToolPayload(payload)
      ? payload
      : await maybeApplyTtsToPayload({
          payload,
          cfg: params.cfg,
          channel: params.ttsChannel,
          kind,
          inboundAudio: params.inboundAudio,
          ttsAuto: params.sessionTtsAuto,
        });

    return deliverPreparedPayload(kind, ttsPayload, meta);
  };

  const deliverFinalTextBeforeTts = async (text: string): Promise<boolean> => {
    const finalText = text.trim();
    if (!finalText) {
      return false;
    }

    await startReplyLifecycleOnce();
    return deliverPreparedPayload("final", {
      text: finalText,
      // ACP stream previews are intentionally transient in Telegram. This
      // structural final marker forces the accepted assistant output through
      // the durable final lane before any media-only TTS supplement can follow.
      channelData: {
        openclaw: {
          assistantPhase: "final_answer",
        },
      },
    });
  };

  const deliverFinalTtsSupplement = async (text: string): Promise<boolean> => {
    const finalText = text.trim();
    if (!finalText) {
      return false;
    }
    const ttsPayload = await maybeApplyTtsToPayload({
      payload: { text: finalText },
      cfg: params.cfg,
      channel: params.ttsChannel,
      kind: "final",
      inboundAudio: params.inboundAudio,
      ttsAuto: params.sessionTtsAuto,
    });
    if (!ttsPayload.mediaUrl && !(ttsPayload.mediaUrls?.length ?? 0)) {
      return false;
    }

    // The ACP block path has already made the final text visible. Send only
    // the generated media here so TTS remains additive instead of duplicating
    // the visible answer as a second final text/caption.
    return deliverPreparedPayload("final", {
      ...ttsPayload,
      text: undefined,
    });
  };

  return {
    startReplyLifecycle: startReplyLifecycleOnce,
    deliver,
    deliverFinalTextBeforeTts,
    deliverFinalTtsSupplement,
    getBlockCount: () => state.blockCount,
    getRoutedCounts: () => ({ ...state.routedCounts }),
    applyRoutedCounts: (counts) => {
      counts.tool += state.routedCounts.tool;
      counts.block += state.routedCounts.block;
      counts.final += state.routedCounts.final;
    },
  };
}
