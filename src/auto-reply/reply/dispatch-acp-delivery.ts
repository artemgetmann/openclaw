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
  accumulatedBlockText: string;
  blockCount: number;
  routedCounts: Record<ReplyDispatchKind, number>;
  toolMessageByCallId: Map<string, ToolMessageHandle>;
};

const ACP_INTERNAL_TOOL_SUMMARY_LINE_RE =
  /^🔧\s+[\w./:-]+(?:\s+(?:start|update|completed|failed|cancelled|done|error))?$/iu;

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
  getBlockCount: () => number;
  getAccumulatedBlockText: () => string;
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
    accumulatedBlockText: "",
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
      if (state.accumulatedBlockText.length > 0) {
        state.accumulatedBlockText += "\n";
      }
      state.accumulatedBlockText += payload.text;
      state.blockCount += 1;
    }

    if ((payload.text?.trim() ?? "").length > 0 || payload.mediaUrl || payload.mediaUrls?.length) {
      await startReplyLifecycleOnce();
    }

    const ttsPayload = await maybeApplyTtsToPayload({
      payload,
      cfg: params.cfg,
      channel: params.ttsChannel,
      kind,
      inboundAudio: params.inboundAudio,
      ttsAuto: params.sessionTtsAuto,
    });

    if (shouldUseSourceDispatcherForTelegram()) {
      return deliverViaDispatcher(kind, ttsPayload);
    }

    if (params.shouldRouteToOriginating && params.originatingChannel && params.originatingTo) {
      const toolCallId = meta?.toolCallId?.trim();
      if (kind === "tool" && meta?.allowEdit === true && toolCallId) {
        const edited = await tryEditToolMessage(ttsPayload, toolCallId);
        if (edited) {
          return true;
        }
      }

      const result = await routeReply({
        payload: ttsPayload,
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

    return deliverViaDispatcher(kind, ttsPayload);
  };

  return {
    startReplyLifecycle: startReplyLifecycleOnce,
    deliver,
    getBlockCount: () => state.blockCount,
    getAccumulatedBlockText: () => state.accumulatedBlockText,
    getRoutedCounts: () => ({ ...state.routedCounts }),
    applyRoutedCounts: (counts) => {
      counts.tool += state.routedCounts.tool;
      counts.block += state.routedCounts.block;
      counts.final += state.routedCounts.final;
    },
  };
}
