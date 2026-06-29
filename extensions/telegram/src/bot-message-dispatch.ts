import type { Bot } from "grammy";
import { resolveAgentDir } from "../../../src/agents/agent-scope.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../../../src/agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../../../src/agents/model-selection.js";
import { resolveChunkMode } from "../../../src/auto-reply/chunk.js";
import { clearHistoryEntriesIfEnabled } from "../../../src/auto-reply/reply/history.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../../src/auto-reply/reply/provider-dispatcher.js";
import { buildFinalTtsCaptionPreview } from "../../../src/auto-reply/reply/tts-caption-preview.js";
import type { ReplyPayload } from "../../../src/auto-reply/types.js";
import { removeAckReactionAfterReply } from "../../../src/channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../../../src/channels/logging.js";
import { createReplyPrefixOptions } from "../../../src/channels/reply-prefix.js";
import { createTypingCallbacks } from "../../../src/channels/typing.js";
import { resolveMarkdownTableMode } from "../../../src/config/markdown-tables.js";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "../../../src/config/sessions.js";
import type {
  OpenClawConfig,
  ReplyToMode,
  TelegramAccountConfig,
} from "../../../src/config/types.js";
import { danger, logVerbose } from "../../../src/globals.js";
import { recordChannelActivity } from "../../../src/infra/channel-activity.js";
import { getAgentScopedMediaLocalRoots } from "../../../src/media/local-roots.js";
import type { RuntimeEnv } from "../../../src/runtime.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramBotOptions } from "./bot.js";
import { deliverReplies, type TelegramReplyDeliveredEvent } from "./bot/delivery.js";
import { resolveTelegramReplyId } from "./bot/helpers.js";
import type { TelegramStreamMode } from "./bot/types.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { guardedTelegramDeleteMessage } from "./delete-guard.js";
import { createTelegramDraftStream, type TelegramDraftStream } from "./draft-stream.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import { renderTelegramHtmlText } from "./format.js";
import {
  type ArchivedPreview,
  createLaneDeliveryStateTracker,
  createLaneTextDeliverer,
  type DraftLaneState,
  type LaneName,
  type LanePreviewLifecycle,
  normalizeAdjacentProgressBoundaries,
} from "./lane-delivery.js";
import type { TelegramReplyLatencyTrace } from "./latency-trace.js";
import {
  createTelegramProgressController,
  type TelegramProgressController,
} from "./progress-controller.js";
import {
  createTelegramReasoningStepState,
  splitTelegramReasoningText,
} from "./reasoning-lane-coordinator.js";
import { editMessageTelegram } from "./send.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

/** Minimum chars before sending first streaming message (improves push notification UX). */
const DRAFT_MIN_INITIAL_CHARS = 12;
/** DMs optimize for time-to-first-visible text; push-notification debounce matters less there. */
const DRAFT_MIN_INITIAL_CHARS_DM_MESSAGE_PREVIEW = 1;
/** Keep fast DM previews responsive after the first send without token-by-token API spam. */
const DRAFT_DM_MESSAGE_PREVIEW_THROTTLE_MS = 250;
const PROGRESS_FINAL_CLEANUP_TIMEOUT_MS = 2_000;

// Continuation-style agent runs can re-enter Telegram delivery between tool
// turns. A function-local progress controller gets cleared at the end of each
// dispatch and turns every progress update into a durable message. Keep one
// controller per Telegram conversation/session until a final or fallback reply
// explicitly clears it.
const activeTelegramProgressControllers = new Map<string, TelegramProgressController>();

type ProgressCleanupResult = "none" | "completed" | "timed-out" | "failed";

function normalizeToolProgressLine(text?: string) {
  return text?.replace(/\s+/g, " ").trim();
}

function normalizeAnswerPreviewText(text: string): string {
  return normalizeAdjacentProgressBoundaries(text)
    .replace(/\.{3,}/g, "")
    .trimEnd();
}

function isSuppressibleAnswerPreviewPrefix(text: string): boolean {
  const trimmed = normalizeAnswerPreviewText(text).trim();
  if (!trimmed) {
    return false;
  }
  const isSingleLine = !/\n/.test(trimmed);
  const isShortHeading = trimmed.length <= 120 && /^[^!?\n]{1,80}[:：]\s*[^.!?\n]*$/.test(trimmed);
  return isSingleLine && isShortHeading;
}

function isLikelyFinalAnswerPreviewAfterProgress(text: string): boolean {
  const trimmed = normalizeAnswerPreviewText(text).trim();
  if (!trimmed) {
    return false;
  }
  const firstParagraph = trimmed.split(/\n{2,}/)[0]?.trim() ?? "";
  if (/^(?:Done|Verified|Final|Result(?:s)?|Short version)[:.!]?(?:\s|$)/i.test(firstParagraph)) {
    return true;
  }
  if (/^Ran it[.!]?(?:\s|$)/i.test(firstParagraph) && /\n{2,}/.test(trimmed)) {
    return true;
  }
  return false;
}

function shouldEmitCoalescedDraftPreview(params: {
  previousText: string;
  nextText: string;
  laneName: LaneName;
  fastFirstPreview?: boolean;
}): boolean {
  if (params.laneName === "reasoning") {
    return true;
  }
  const previous = params.previousText.trimEnd();
  const next = params.nextText.trimEnd();
  if (!next || next === previous) {
    return false;
  }
  if (!previous) {
    if (params.fastFirstPreview) {
      return true;
    }
    // Avoid creating Telegram drafts for tiny token prefixes; the final lane
    // still receives the complete answer even when early previews are skipped.
    return next.length >= 48 || /(?:[.!?…]["')\]]?|[\n\r]{2,})$/.test(next);
  }
  if (next.length < previous.length) {
    return true;
  }
  const addedChars = next.length - previous.length;
  return addedChars >= 180 || /(?:[.!?…]["')\]]?|[\n\r]{2,})$/.test(next);
}

function hasInternalToolTraceText(text?: string) {
  const normalized = normalizeToolProgressLine(text);
  return normalized?.startsWith("🔧") === true;
}

function hasExecApprovalPayload(payload: ReplyPayload) {
  const execApproval =
    payload.channelData &&
    typeof payload.channelData === "object" &&
    !Array.isArray(payload.channelData)
      ? payload.channelData.execApproval
      : undefined;
  return Boolean(execApproval && typeof execApproval === "object" && !Array.isArray(execApproval));
}

function hasUserFacingToolEnvelope(payload: ReplyPayload) {
  return Boolean(
    payload.mediaUrl ||
    payload.mediaUrls?.length ||
    payload.interactive ||
    payload.btw ||
    payload.isError ||
    hasExecApprovalPayload(payload),
  );
}

function hasOpenClawSourcePreviewMarker(payload: ReplyPayload): boolean {
  const openclaw =
    payload.channelData &&
    typeof payload.channelData === "object" &&
    !Array.isArray(payload.channelData)
      ? payload.channelData.openclaw
      : undefined;

  return (
    openclaw != null &&
    typeof openclaw === "object" &&
    !Array.isArray(openclaw) &&
    (openclaw as { sourcePreview?: unknown }).sourcePreview === true
  );
}

function isFinalTtsSupplementPayload(payload: ReplyPayload): boolean {
  const openclaw =
    payload.channelData &&
    typeof payload.channelData === "object" &&
    !Array.isArray(payload.channelData)
      ? payload.channelData.openclaw
      : undefined;

  return (
    openclaw != null &&
    typeof openclaw === "object" &&
    !Array.isArray(openclaw) &&
    (openclaw as { finalTtsSupplement?: unknown }).finalTtsSupplement === true
  );
}

function isTextOnlyOpenClawSourcePreview(payload: ReplyPayload): boolean {
  return (
    hasOpenClawSourcePreviewMarker(payload) &&
    typeof payload.text === "string" &&
    payload.text.trim().length > 0 &&
    !hasUserFacingToolEnvelope(payload)
  );
}

function resolveOpenClawAssistantPhase(
  payload: ReplyPayload,
): "commentary" | "final_answer" | undefined {
  const openclaw =
    payload.channelData &&
    typeof payload.channelData === "object" &&
    !Array.isArray(payload.channelData) &&
    payload.channelData.openclaw &&
    typeof payload.channelData.openclaw === "object" &&
    !Array.isArray(payload.channelData.openclaw)
      ? (payload.channelData.openclaw as Record<string, unknown>)
      : undefined;
  const phase = openclaw?.assistantPhase;
  return phase === "commentary" || phase === "final_answer" ? phase : undefined;
}

async function resolveStickerVisionSupport(cfg: OpenClawConfig, agentId: string) {
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) {
      return false;
    }
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
}

export function pruneStickerMediaFromContext(
  ctxPayload: {
    MediaPath?: string;
    MediaUrl?: string;
    MediaType?: string;
    MediaPaths?: string[];
    MediaUrls?: string[];
    MediaTypes?: string[];
  },
  opts?: { stickerMediaIncluded?: boolean },
) {
  if (opts?.stickerMediaIncluded === false) {
    return;
  }
  const nextMediaPaths = Array.isArray(ctxPayload.MediaPaths)
    ? ctxPayload.MediaPaths.slice(1)
    : undefined;
  const nextMediaUrls = Array.isArray(ctxPayload.MediaUrls)
    ? ctxPayload.MediaUrls.slice(1)
    : undefined;
  const nextMediaTypes = Array.isArray(ctxPayload.MediaTypes)
    ? ctxPayload.MediaTypes.slice(1)
    : undefined;
  ctxPayload.MediaPaths = nextMediaPaths && nextMediaPaths.length > 0 ? nextMediaPaths : undefined;
  ctxPayload.MediaUrls = nextMediaUrls && nextMediaUrls.length > 0 ? nextMediaUrls : undefined;
  ctxPayload.MediaTypes = nextMediaTypes && nextMediaTypes.length > 0 ? nextMediaTypes : undefined;
  ctxPayload.MediaPath = ctxPayload.MediaPaths?.[0];
  ctxPayload.MediaUrl = ctxPayload.MediaUrls?.[0] ?? ctxPayload.MediaPath;
  ctxPayload.MediaType = ctxPayload.MediaTypes?.[0];
}

type DispatchTelegramMessageParams = {
  context: TelegramMessageContext;
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramCfg: TelegramAccountConfig;
  opts: Pick<TelegramBotOptions, "token">;
  latencyTrace?: TelegramReplyLatencyTrace;
};

type TelegramReasoningLevel = "off" | "on" | "stream";
type TelegramDurableSendReason =
  | "progress"
  | "final"
  | "tool"
  | "error"
  | "media"
  | "fallback"
  | "unknown";

type TelegramDurableSendClassification = {
  reason: TelegramDurableSendReason;
  callsite: string;
  sourceKind?: string;
};

type TelegramPreviewLedgerLane = "answer" | "progress" | "reasoning" | "tts" | "tool" | "unknown";
type TelegramPreviewLedgerPhase =
  | "partial_received"
  | "preview_send_attempt"
  | "preview_send_completed"
  | "preview_edit_attempt"
  | "preview_edit_completed"
  | "preview_delete_attempt"
  | "preview_delete_completed"
  | "preview_adopted"
  | "draft_update_attempt"
  | "draft_update_completed"
  | "progress_update"
  | "progress_clear_started"
  | "progress_clear_completed"
  | "final_send_attempt"
  | "final_send_completed"
  | "final_preview_edit_attempt"
  | "final_preview_edit_completed"
  | "tts_send_attempt"
  | "tts_send_completed";

type TelegramPreviewLedgerSource =
  | "partial"
  | "block"
  | "tool"
  | "final"
  | "tts"
  | "cleanup"
  | "unknown";

function logTelegramPreviewLedger(params: {
  traceId?: string;
  chatId: number;
  threadId?: number | string;
  sessionId?: string;
  accountId?: string;
  lane: TelegramPreviewLedgerLane;
  phase: TelegramPreviewLedgerPhase;
  source: TelegramPreviewLedgerSource;
  messageId?: number | "unknown";
  operation?: string;
  previewTransport?: string;
  textLength?: number;
  mediaKind?: string;
  result?: string;
  callsite?: string;
}): string {
  // This is intentionally body-free. It exists so live Telegram screenshots can
  // be reconciled to structural delivery events without logging private text.
  const fields = [
    `trace=${params.traceId ?? "none"}`,
    `chat=${params.chatId}`,
    params.threadId != null ? `thread=${params.threadId}` : undefined,
    params.sessionId ? `session=${params.sessionId}` : undefined,
    params.accountId ? `account=${params.accountId}` : undefined,
    `lane=${params.lane}`,
    `phase=${params.phase}`,
    `source=${params.source}`,
    `message=${params.messageId ?? "unknown"}`,
    params.operation ? `operation=${params.operation}` : undefined,
    params.previewTransport ? `previewTransport=${params.previewTransport}` : undefined,
    params.textLength != null ? `textLength=${params.textLength}` : undefined,
    params.mediaKind ? `mediaKind=${params.mediaKind}` : undefined,
    params.result ? `result=${params.result}` : undefined,
    params.callsite ? `callsite=${params.callsite}` : undefined,
  ].filter((field): field is string => Boolean(field));
  const line = `telegram.preview.ledger ${fields.join(" ")}`;
  logVerbose(line);
  return line;
}

function resolveTelegramReasoningLevel(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId: string;
}): TelegramReasoningLevel {
  const { cfg, sessionKey, agentId } = params;
  if (!sessionKey) {
    return "off";
  }
  try {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = resolveSessionStoreEntry({ store, sessionKey }).existing;
    const level = entry?.reasoningLevel;
    if (level === "on" || level === "stream") {
      return level;
    }
  } catch {
    // Fall through to default.
  }
  return "off";
}

function logTelegramDurableSendClassification(params: {
  reason: TelegramDurableSendReason;
  callsite: string;
  laneName?: LaneName;
  messageId?: number | "unknown";
  draftCallsite?: string;
  previewTransport?: string;
  threadFallback?: boolean;
  delivered?: boolean;
  hasMedia?: boolean;
  isError?: boolean;
  infoKind?: string;
  sourceKind?: string;
  retained?: boolean;
  deleteOnCleanup?: boolean;
}) {
  // Keep these diagnostics as stable key/value fields so live Telegram proof can
  // grep a message id and immediately know which structural path created it.
  const fields = [
    `reason=${params.reason}`,
    `callsite=${params.callsite}`,
    params.laneName ? `lane=${params.laneName}` : undefined,
    `message=${params.messageId ?? "unknown"}`,
    params.infoKind ? `infoKind=${params.infoKind}` : undefined,
    params.sourceKind ? `sourceKind=${params.sourceKind}` : undefined,
    params.draftCallsite ? `draftCallsite=${params.draftCallsite}` : undefined,
    params.previewTransport ? `previewTransport=${params.previewTransport}` : undefined,
    params.threadFallback != null ? `threadFallback=${String(params.threadFallback)}` : undefined,
    params.delivered != null ? `delivered=${String(params.delivered)}` : undefined,
    params.hasMedia != null ? `hasMedia=${String(params.hasMedia)}` : undefined,
    params.isError != null ? `isError=${String(params.isError)}` : undefined,
    params.retained != null ? `retained=${String(params.retained)}` : undefined,
    params.deleteOnCleanup != null
      ? `deleteOnCleanup=${String(params.deleteOnCleanup)}`
      : undefined,
  ].filter((field): field is string => Boolean(field));
  logVerbose(`telegram: durable send classified ${fields.join(" ")}`);
}

export const dispatchTelegramMessage = async ({
  context,
  bot,
  cfg,
  runtime,
  replyToMode,
  streamMode,
  textLimit,
  telegramCfg,
  opts,
  latencyTrace,
}: DispatchTelegramMessageParams) => {
  const {
    ctxPayload,
    msg,
    chatId,
    isGroup,
    threadSpec,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
    statusReactionController,
  } = context;
  const sessionId = typeof ctxPayload?.SessionKey === "string" ? ctxPayload.SessionKey : undefined;
  const logPreviewLedger = (
    event: Omit<
      Parameters<typeof logTelegramPreviewLedger>[0],
      "traceId" | "chatId" | "threadId" | "sessionId" | "accountId"
    >,
  ) => {
    const line = logTelegramPreviewLedger({
      traceId: latencyTrace?.id,
      chatId,
      threadId: threadSpec?.id,
      sessionId,
      accountId: route.accountId,
      ...event,
    });
    runtime.log?.(line);
  };

  const draftMaxChars = Math.min(textLimit, 4096);
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId,
  });
  const renderDraftPreview = (text: string) => ({
    text: renderTelegramHtmlText(text, { tableMode }),
    parseMode: "HTML" as const,
  });
  latencyTrace?.mark("route_account_session_selected", {
    accountId: route.accountId,
    agentId: route.agentId,
    sessionKey: typeof ctxPayload.SessionKey === "string" ? ctxPayload.SessionKey : undefined,
    chatId,
    threadId: threadSpec?.id,
    threadScope: threadSpec?.scope,
  });
  const accountBlockStreamingEnabled =
    typeof telegramCfg.blockStreaming === "boolean"
      ? telegramCfg.blockStreaming
      : cfg.agents?.defaults?.blockStreamingDefault === "on";
  const resolvedReasoningLevel = resolveTelegramReasoningLevel({
    cfg,
    sessionKey: ctxPayload.SessionKey,
    agentId: route.agentId,
  });
  const forceBlockStreamingForReasoning = resolvedReasoningLevel === "on";
  const streamReasoningDraft = resolvedReasoningLevel === "stream";
  const previewStreamingEnabled = streamMode !== "off";
  const rawReplyQuoteText =
    ctxPayload.ReplyToIsQuote && typeof ctxPayload.ReplyToQuoteText === "string"
      ? ctxPayload.ReplyToQuoteText
      : undefined;
  const replyQuoteText = ctxPayload.ReplyToIsQuote
    ? rawReplyQuoteText?.trim()
      ? rawReplyQuoteText
      : ctxPayload.ReplyToBody?.trim() || undefined
    : undefined;
  const replyQuoteMessageId =
    replyQuoteText && !ctxPayload.ReplyToIsExternal
      ? resolveTelegramReplyId(ctxPayload.ReplyToId)
      : undefined;
  const hasNativeQuoteReply =
    replyToMode !== "off" && replyQuoteText != null && replyQuoteMessageId != null;
  const canStreamProgressDraft = previewStreamingEnabled && !hasNativeQuoteReply;
  const canStreamAnswerDraft =
    previewStreamingEnabled &&
    !hasNativeQuoteReply &&
    !accountBlockStreamingEnabled &&
    !forceBlockStreamingForReasoning &&
    !streamReasoningDraft;
  const canStreamReasoningDraft = streamReasoningDraft;
  const draftReplyToMessageId =
    replyToMode !== "off" && typeof msg.message_id === "number"
      ? (replyQuoteMessageId ?? msg.message_id)
      : undefined;
  const progressThreadKey = threadSpec ? `${threadSpec.scope}:${threadSpec.id ?? ""}` : "none";
  const progressControllerKey = [
    route.accountId,
    String(chatId),
    progressThreadKey,
    ctxPayload.SessionKey ?? "no-session",
  ].join("|");
  // Native Telegram drafts animate nicely, but real message/edit previews are
  // the lower-latency DM path. Use them for user-visible answer/progress text;
  // keep native draft transport available for reasoning and non-DM surfaces.
  const useMessagePreviewTransportForDm =
    threadSpec?.scope === "dm" && (canStreamAnswerDraft || canStreamProgressDraft);
  const answerPreviewTransport = useMessagePreviewTransportForDm ? "message" : "auto";
  const progressPreviewTransport = useMessagePreviewTransportForDm ? "message" : "auto";
  const draftMinInitialChars = useMessagePreviewTransportForDm
    ? DRAFT_MIN_INITIAL_CHARS_DM_MESSAGE_PREVIEW
    : DRAFT_MIN_INITIAL_CHARS;
  const dmMessagePreviewThrottleMs = useMessagePreviewTransportForDm
    ? DRAFT_DM_MESSAGE_PREVIEW_THROTTLE_MS
    : undefined;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const archivedAnswerPreviews: ArchivedPreview[] = [];
  const archivedReasoningPreviewIds: number[] = [];
  let partialCallbackCount = 0;
  let firstPartialTextLength: number | undefined;
  let firstTelegramPreviewAttemptLogged = false;
  let firstTelegramPreviewCompleteLogged = false;
  // Draft streams only know that they created a real Telegram message. The
  // dispatcher owns the semantic reason, so it tags the next real send before
  // each update/materialize path that can allocate a message id.
  const draftDurableSendClassificationByLane: Record<LaneName, TelegramDurableSendClassification> =
    {
      answer: {
        reason: "unknown",
        callsite: "answer-preview",
        sourceKind: "unknown",
      },
      reasoning: {
        reason: "progress",
        callsite: "reasoning-preview",
        sourceKind: "reasoning",
      },
    };
  const setDraftDurableSendClassification = (
    laneName: LaneName,
    classification: TelegramDurableSendClassification,
  ) => {
    draftDurableSendClassificationByLane[laneName] = classification;
  };
  const previewAttemptPhase = (
    operation: "send" | "edit" | "draft" | "delete",
  ): TelegramPreviewLedgerPhase => {
    if (operation === "send") {
      return "preview_send_attempt";
    }
    if (operation === "edit") {
      return "preview_edit_attempt";
    }
    if (operation === "delete") {
      return "preview_delete_attempt";
    }
    return "draft_update_attempt";
  };
  const previewCompletePhase = (
    operation: "send" | "edit" | "draft" | "delete",
  ): TelegramPreviewLedgerPhase => {
    if (operation === "send") {
      return "preview_send_completed";
    }
    if (operation === "edit") {
      return "preview_edit_completed";
    }
    if (operation === "delete") {
      return "preview_delete_completed";
    }
    return "draft_update_completed";
  };
  const createDraftLaneStream = (laneName: LaneName) => {
    const laneMinInitialChars =
      laneName === "answer" ? draftMinInitialChars : DRAFT_MIN_INITIAL_CHARS;
    return createTelegramDraftStream({
      api: bot.api,
      chatId,
      maxChars: draftMaxChars,
      thread: threadSpec,
      previewTransport: laneName === "answer" ? answerPreviewTransport : "auto",
      replyToMessageId: draftReplyToMessageId,
      ...(laneName === "answer" && dmMessagePreviewThrottleMs != null
        ? { throttleMs: dmMessagePreviewThrottleMs }
        : {}),
      minInitialChars: laneMinInitialChars,
      deleteAudit: {
        callsite: `telegram-${laneName}-preview-clear`,
        reason: "lane_preview_cleanup",
        accountId: route.accountId,
        lane: laneName,
        classification: draftDurableSendClassificationByLane[laneName].reason,
        sessionId:
          typeof context.ctxPayload?.SessionKey === "string"
            ? context.ctxPayload.SessionKey
            : undefined,
        topicId: threadSpec?.id,
      },
      renderText: renderDraftPreview,
      onMessageDelivered: (messageId, event) => {
        const classification = draftDurableSendClassificationByLane[laneName];
        logPreviewLedger({
          lane: laneName,
          phase:
            event.callsite === "materialize-send"
              ? "final_send_completed"
              : "preview_send_completed",
          source: classification.sourceKind === "partial" ? "partial" : "block",
          messageId,
          previewTransport: event.previewTransport,
          result: event.callsite,
          callsite: classification.callsite,
        });
        logTelegramDurableSendClassification({
          ...classification,
          laneName,
          messageId,
          draftCallsite: event.callsite,
          previewTransport: event.previewTransport,
          threadFallback: event.threadFallback,
        });
        recordChannelActivity({
          channel: "telegram",
          accountId: route.accountId,
          direction: "outbound",
        });
      },
      onPreviewAttempt: (event) => {
        logPreviewLedger({
          lane: laneName,
          phase: previewAttemptPhase(event.operation),
          source: laneName === "answer" ? "partial" : "unknown",
          messageId: event.messageId,
          operation: event.operation,
          previewTransport: event.previewTransport,
          textLength: event.textLength,
          callsite: `${laneName}-draft-stream`,
        });
        if (firstTelegramPreviewAttemptLogged) {
          return;
        }
        firstTelegramPreviewAttemptLogged = true;
        latencyTrace?.mark("first_telegram_preview_send_edit_attempted", {
          lane: laneName,
          previewTransport: event.previewTransport,
          operation: event.operation,
          textLength: event.textLength,
          partialCallbackCount,
          firstPartialTextLength,
        });
      },
      onPreviewComplete: (event) => {
        logPreviewLedger({
          lane: laneName,
          phase: previewCompletePhase(event.operation),
          source: laneName === "answer" ? "partial" : "unknown",
          messageId: event.messageId,
          operation: event.operation,
          previewTransport: event.previewTransport,
          textLength: event.textLength,
          callsite: `${laneName}-draft-stream`,
        });
        if (firstTelegramPreviewCompleteLogged) {
          return;
        }
        firstTelegramPreviewCompleteLogged = true;
        latencyTrace?.mark("first_telegram_preview_send_edit_completed", {
          lane: laneName,
          previewTransport: event.previewTransport,
          operation: event.operation,
          textLength: event.textLength,
          messageId: event.messageId,
          partialCallbackCount,
          firstPartialTextLength,
        });
      },
      onSupersededPreview:
        laneName === "answer" || laneName === "reasoning"
          ? (preview) => {
              if (laneName === "reasoning") {
                if (!archivedReasoningPreviewIds.includes(preview.messageId)) {
                  archivedReasoningPreviewIds.push(preview.messageId);
                }
                return;
              }
              archivedAnswerPreviews.push({
                messageId: preview.messageId,
                textSnapshot: preview.textSnapshot,
                deleteIfUnused: true,
              });
            }
          : undefined,
      log: logVerbose,
      warn: logVerbose,
    });
  };
  const createDraftLane = (): DraftLaneState => {
    return {
      stream: undefined,
      lastPartialText: "",
      hasStreamedMessage: false,
    };
  };
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: createDraftLane(),
    reasoning: createDraftLane(),
  };
  const draftLaneStreamingEnabled: Record<LaneName, boolean> = {
    answer: canStreamAnswerDraft,
    reasoning: canStreamReasoningDraft,
  };
  // Active preview lifecycle answers "can this current preview still be
  // finalized?" Cleanup retention is separate so archived-preview decisions do
  // not poison the active lane.
  const activePreviewLifecycleByLane: Record<LaneName, LanePreviewLifecycle> = {
    answer: "transient",
    reasoning: "transient",
  };
  const retainPreviewOnCleanupByLane: Record<LaneName, boolean> = {
    answer: false,
    reasoning: false,
  };
  const answerLane = lanes.answer;
  const reasoningLane = lanes.reasoning;
  const ensureDraftLaneStream = (laneName: LaneName) => {
    const lane = lanes[laneName];
    if (!lane.stream && draftLaneStreamingEnabled[laneName]) {
      lane.stream = createDraftLaneStream(laneName);
    }
    return lane.stream;
  };
  let splitReasoningOnNextStream = false;
  let skipNextAnswerMessageStartRotation = false;
  let retainedAnswerProgressPreviewText = "";
  let retainedAnswerProgressFromExplicitBoundary = false;
  let forceNextAnswerFinalSend = false;
  const transientProgressPreviewTexts: string[] = [];
  const transientProgressPreviewKeys = new Set<string>();
  let draftLaneEventQueue = Promise.resolve();
  let processingDraftLaneEvent = false;
  let progressController: TelegramProgressController | undefined;
  let sawAssistantPartial = false;
  // Once a tool boundary proves the assistant is narrating work, later
  // phase-less assistant partials should keep editing that same progress
  // bubble. Without this, every natural "Browser is up..." style update starts
  // a fresh answer preview that can survive as a stale Telegram message.
  let routeToolStatusPartialsToProgress = false;
  const reasoningStepState = createTelegramReasoningStepState();
  const enqueueDraftLaneEvent = (task: () => Promise<void>): Promise<void> => {
    const next = draftLaneEventQueue.then(async () => {
      processingDraftLaneEvent = true;
      try {
        await task();
      } finally {
        processingDraftLaneEvent = false;
      }
    });
    draftLaneEventQueue = next.catch((err) => {
      logVerbose(`telegram: draft lane callback failed: ${String(err)}`);
    });
    return draftLaneEventQueue;
  };
  const waitForDraftLaneIdle = async () => {
    if (!processingDraftLaneEvent) {
      await draftLaneEventQueue;
    }
  };
  type SplitLaneSegment = { lane: LaneName; text: string };
  type SplitLaneSegmentsResult = {
    segments: SplitLaneSegment[];
    suppressedReasoningOnly: boolean;
  };
  const splitTextIntoLaneSegments = (text?: string): SplitLaneSegmentsResult => {
    const split = splitTelegramReasoningText(text);
    const segments: SplitLaneSegment[] = [];
    const suppressReasoning = resolvedReasoningLevel === "off";
    if (split.reasoningText && !suppressReasoning) {
      segments.push({ lane: "reasoning", text: split.reasoningText });
    }
    if (split.answerText) {
      segments.push({ lane: "answer", text: split.answerText });
    }
    return {
      segments,
      suppressedReasoningOnly:
        Boolean(split.reasoningText) && suppressReasoning && !split.answerText,
    };
  };
  const resetDraftLaneState = (lane: DraftLaneState) => {
    lane.lastPartialText = "";
    lane.hasStreamedMessage = false;
    if (lane === answerLane) {
      retainedAnswerProgressPreviewText = "";
      retainedAnswerProgressFromExplicitBoundary = false;
    }
  };
  const recordTransientProgressPreviewText = (text: string | undefined) => {
    const normalized = normalizeAdjacentProgressBoundaries(text ?? "").trim();
    if (!normalized) {
      return;
    }
    for (const rawEntry of normalized.split(/\n+/)) {
      const entry = rawEntry.trim();
      if (!entry) {
        continue;
      }
      const key = entry.replace(/\s+/g, " ");
      if (transientProgressPreviewKeys.has(key)) {
        continue;
      }
      transientProgressPreviewKeys.add(key);
      transientProgressPreviewTexts.push(entry);
    }
  };
  const stripTransientProgressPrefixFromFinal = (text: string) => {
    let remaining = normalizeAdjacentProgressBoundaries(text).trimStart();
    let stripped = false;
    let changed = true;
    while (changed) {
      changed = false;
      for (const progressText of transientProgressPreviewTexts) {
        if (!remaining.startsWith(progressText)) {
          continue;
        }
        remaining = remaining.slice(progressText.length).trimStart();
        stripped = true;
        changed = true;
        break;
      }
    }
    return { text: remaining.trim(), stripped };
  };
  const getProgressController = (adoptedStream?: TelegramDraftStream) => {
    if (!canStreamProgressDraft) {
      return undefined;
    }
    const existingController = activeTelegramProgressControllers.get(progressControllerKey);
    if (existingController && !adoptedStream) {
      progressController = existingController;
      return existingController;
    }
    if (adoptedStream || !progressController) {
      progressController = createTelegramProgressController({
        api: bot.api,
        chatId,
        maxChars: draftMaxChars,
        stream: adoptedStream,
        thread: threadSpec,
        previewTransport: progressPreviewTransport,
        replyToMessageId: draftReplyToMessageId,
        ...(dmMessagePreviewThrottleMs != null ? { throttleMs: dmMessagePreviewThrottleMs } : {}),
        minInitialChars: draftMinInitialChars,
        deleteAudit: {
          callsite: "telegram-progress-controller-clear",
          reason: "progress_cleanup",
          accountId: route.accountId,
          lane: "answer",
          classification: "progress",
          sessionId:
            typeof context.ctxPayload?.SessionKey === "string"
              ? context.ctxPayload.SessionKey
              : undefined,
          topicId: threadSpec?.id,
        },
        renderText: renderDraftPreview,
        onMessageDelivered: (messageId, event) => {
          logPreviewLedger({
            lane: "progress",
            phase:
              event.callsite === "materialize-send"
                ? "final_send_completed"
                : "preview_send_completed",
            source: "block",
            messageId,
            previewTransport: event.previewTransport,
            result: event.callsite,
            callsite: "telegram-progress-controller-preview",
          });
          logTelegramDurableSendClassification({
            reason: "progress",
            callsite: "telegram-progress-controller-preview",
            laneName: "answer",
            messageId,
            draftCallsite: event.callsite,
            previewTransport: event.previewTransport,
            threadFallback: event.threadFallback,
            sourceKind: "block",
          });
          recordChannelActivity({
            channel: "telegram",
            accountId: route.accountId,
            direction: "outbound",
          });
        },
        onPreviewAttempt: (event) => {
          logPreviewLedger({
            lane: "progress",
            phase: previewAttemptPhase(event.operation),
            source: "block",
            messageId: event.messageId,
            operation: event.operation,
            previewTransport: event.previewTransport,
            textLength: event.textLength,
            callsite: "telegram-progress-controller",
          });
          if (firstTelegramPreviewAttemptLogged) {
            return;
          }
          firstTelegramPreviewAttemptLogged = true;
          latencyTrace?.mark("first_telegram_preview_send_edit_attempted", {
            lane: "answer",
            previewTransport: event.previewTransport,
            operation: event.operation,
            textLength: event.textLength,
            partialCallbackCount,
            firstPartialTextLength,
          });
        },
        onPreviewComplete: (event) => {
          logPreviewLedger({
            lane: "progress",
            phase: previewCompletePhase(event.operation),
            source: "block",
            messageId: event.messageId,
            operation: event.operation,
            previewTransport: event.previewTransport,
            textLength: event.textLength,
            callsite: "telegram-progress-controller",
          });
          if (firstTelegramPreviewCompleteLogged) {
            return;
          }
          firstTelegramPreviewCompleteLogged = true;
          latencyTrace?.mark("first_telegram_preview_send_edit_completed", {
            lane: "answer",
            previewTransport: event.previewTransport,
            operation: event.operation,
            textLength: event.textLength,
            messageId: event.messageId,
            partialCallbackCount,
            firstPartialTextLength,
          });
        },
        log: logVerbose,
        warn: logVerbose,
      });
      activeTelegramProgressControllers.set(progressControllerKey, progressController);
    }
    return progressController;
  };
  const getActiveProgressController = () =>
    activeTelegramProgressControllers.get(progressControllerKey) ?? progressController;
  const clearProgressController = async (callsite: string, options?: { timeoutMs?: number }) => {
    const controller =
      activeTelegramProgressControllers.get(progressControllerKey) ?? progressController;
    if (!controller) {
      return "none";
    }
    logPreviewLedger({
      lane: "progress",
      phase: "progress_clear_started",
      source: "cleanup",
      messageId: controller.messageId(),
      callsite,
    });
    const cleanupPromise = controller.clear();
    let cleanupResult: ProgressCleanupResult = "completed";
    try {
      const timeoutMs = options?.timeoutMs;
      if (typeof timeoutMs !== "number" || timeoutMs <= 0) {
        await cleanupPromise;
      } else {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const raceResult = await Promise.race([
          cleanupPromise.then(() => "completed" as const),
          new Promise<"timed-out">((resolve) => {
            timeoutHandle = setTimeout(() => resolve("timed-out"), timeoutMs);
          }),
        ]);
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (raceResult === "timed-out") {
          cleanupResult = "timed-out";
          // Final delivery is the durable product contract. Progress cleanup is
          // best effort after the bounded window so a stuck Telegram delete/edit
          // cannot strand the user's answer.
          void cleanupPromise.catch((err) => {
            logVerbose(
              `telegram: progress cleanup failed after timeout callsite=${callsite}: ${String(err)}`,
            );
          });
          logVerbose(
            `telegram: progress cleanup timed out callsite=${callsite} timeoutMs=${timeoutMs}; continuing delivery`,
          );
        }
      }
    } catch (err) {
      cleanupResult = "failed";
      logVerbose(`telegram: progress cleanup failed callsite=${callsite}: ${String(err)}`);
    } finally {
      if (activeTelegramProgressControllers.get(progressControllerKey) === controller) {
        activeTelegramProgressControllers.delete(progressControllerKey);
      }
      if (progressController === controller) {
        progressController = undefined;
      }
    }
    logPreviewLedger({
      lane: "progress",
      phase: "progress_clear_completed",
      source: "cleanup",
      messageId: controller.messageId(),
      result: cleanupResult,
      callsite,
    });
    return cleanupResult;
  };
  const rotateAnswerLaneForNewAssistantMessage = async () => {
    let didForceNewMessage = false;
    if (answerLane.hasStreamedMessage) {
      const boundaryClassification: TelegramDurableSendClassification = {
        reason: retainedAnswerProgressFromExplicitBoundary ? "progress" : "unknown",
        callsite: "answer-boundary-rotation-materialize",
        sourceKind: retainedAnswerProgressFromExplicitBoundary ? "block" : "partial",
      };
      setDraftDurableSendClassification("answer", boundaryClassification);
      // Materialize the current streamed draft into a permanent message
      // so it remains visible across tool boundaries.
      const materializedId = await answerLane.stream?.materialize?.();
      const previewMessageId = materializedId ?? answerLane.stream?.messageId();
      if (
        typeof previewMessageId === "number" &&
        activePreviewLifecycleByLane.answer === "transient"
      ) {
        archivedAnswerPreviews.push({
          messageId: previewMessageId,
          textSnapshot: answerLane.lastPartialText,
          deleteIfUnused: false,
        });
        logTelegramDurableSendClassification({
          ...boundaryClassification,
          callsite: "answer-boundary-rotation-retain",
          laneName: "answer",
          messageId: previewMessageId,
          retained: true,
          deleteOnCleanup: false,
        });
      }
      answerLane.stream?.forceNewMessage();
      didForceNewMessage = true;
    }
    resetDraftLaneState(answerLane);
    if (didForceNewMessage) {
      // New assistant message boundary: this lane now tracks a fresh preview lifecycle.
      activePreviewLifecycleByLane.answer = "transient";
      retainPreviewOnCleanupByLane.answer = false;
    }
    return didForceNewMessage;
  };
  const stripRetainedProgressFromFinal = (text: string) => {
    const transientStripped = stripTransientProgressPrefixFromFinal(text);
    return {
      text: normalizeAdjacentProgressBoundaries(transientStripped.text).trim(),
      stripped: transientStripped.stripped,
    };
  };
  const materializeAnswerProgressBeforeFinal = async () => {
    if (
      !answerLane.stream ||
      !answerLane.hasStreamedMessage ||
      !retainedAnswerProgressFromExplicitBoundary ||
      !retainedAnswerProgressPreviewText.trim()
    ) {
      return false;
    }
    const progressToMaterialize = retainedAnswerProgressPreviewText.trim();
    // Only explicit non-final message boundaries become retained progress.
    // Plain answer partials stay preview-only so final text cannot be split by
    // English-looking status phrases.
    if (progressToMaterialize && progressToMaterialize !== answerLane.lastPartialText.trim()) {
      answerLane.stream.update(progressToMaterialize);
      answerLane.lastPartialText = progressToMaterialize;
    }
    setDraftDurableSendClassification("answer", {
      reason: "progress",
      callsite: "answer-progress-before-final-materialize",
      sourceKind: "block",
    });
    // Materialization snapshots the last delivered preview. Force any restored
    // progress-only edit out first so a late partial containing the final
    // answer cannot be frozen into the retained progress bubble.
    await answerLane.stream.flush();
    const materializedProgressMessageId = await answerLane.stream.materialize?.();
    if (typeof materializedProgressMessageId === "number") {
      logTelegramDurableSendClassification({
        reason: "progress",
        callsite: "answer-progress-before-final-retain",
        laneName: "answer",
        messageId: materializedProgressMessageId,
        retained: true,
        deleteOnCleanup: false,
        sourceKind: "block",
      });
    }
    answerLane.stream.forceNewMessage();
    answerLane.stream = undefined;
    resetDraftLaneState(answerLane);
    // The retained progress bubble is now permanent. The paired final answer
    // must be delivered as a fresh outbound message, not routed back through
    // the generic preview-final edit path.
    forceNextAnswerFinalSend = true;
    activePreviewLifecycleByLane.answer = "transient";
    retainPreviewOnCleanupByLane.answer = false;
    return true;
  };
  const prepareFinalAnswerText = async (
    text: string,
    opts?: { hasMedia?: boolean; isError?: boolean },
  ) => {
    const prepared = stripRetainedProgressFromFinal(text);
    const retainedProgress = retainedAnswerProgressPreviewText.trim();
    const hasSeparateFinalText =
      prepared.text.trim() !== (retainedProgress || answerLane.lastPartialText.trim());
    const hasRetainedProgressTranscript =
      retainedAnswerProgressFromExplicitBoundary && retainedProgress;
    if (
      !opts?.hasMedia &&
      !opts?.isError &&
      answerLane.hasStreamedMessage &&
      answerLane.lastPartialText.trim() &&
      hasSeparateFinalText &&
      (prepared.stripped || hasRetainedProgressTranscript)
    ) {
      await materializeAnswerProgressBeforeFinal();
    }
    return prepared.text;
  };
  const updateActiveProgressPreviewFromPartial = (text: string, callsite: string) => {
    const controller = getActiveProgressController();
    if (!controller) {
      return false;
    }
    const progressText = normalizeAdjacentProgressBoundaries(text).trim();
    if (!progressText) {
      return false;
    }
    controller.preview(progressText);
    logPreviewLedger({
      lane: "progress",
      phase: "progress_update",
      source: "partial",
      messageId: controller.messageId(),
      textLength: progressText.length,
      previewTransport: progressPreviewTransport,
      callsite,
    });
    return true;
  };
  const updateDraftFromPartial = async (laneName: LaneName, text: string | undefined) => {
    const lane = lanes[laneName];
    if (!text) {
      return;
    }
    partialCallbackCount += 1;
    firstPartialTextLength ??= text.length;
    let previewText = lane === answerLane ? normalizeAnswerPreviewText(text) : text;
    latencyTrace?.mark("telegram_partial_callback", {
      partialCallbackCount,
      firstPartialTextLength,
      textLength: text.length,
      lane: laneName,
      previewTransport:
        laneName === "answer"
          ? getActiveProgressController()
            ? progressPreviewTransport
            : answerPreviewTransport
          : (lane.stream?.previewMode?.() ?? "unknown"),
    });
    if (previewText === lane.lastPartialText) {
      return;
    }
    // Some providers briefly emit a shorter prefix snapshot (for example
    // "Sure." -> "Sure" -> "Sure."). Keep the longer preview to avoid
    // visible punctuation flicker.
    if (
      lane.lastPartialText &&
      lane.lastPartialText.startsWith(previewText) &&
      previewText.length < lane.lastPartialText.length
    ) {
      return;
    }
    if (lane === answerLane) {
      if (isSuppressibleAnswerPreviewPrefix(previewText)) {
        return;
      }
      if (
        retainedAnswerProgressFromExplicitBoundary &&
        previewText !== retainedAnswerProgressPreviewText &&
        previewText.startsWith(retainedAnswerProgressPreviewText)
      ) {
        previewText = retainedAnswerProgressPreviewText;
      }
    }
    if (previewText === lane.lastPartialText) {
      return;
    }
    if (
      lane === answerLane &&
      routeToolStatusPartialsToProgress &&
      getActiveProgressController() &&
      isLikelyFinalAnswerPreviewAfterProgress(previewText)
    ) {
      // Tool/status narration owns the transient progress bubble. Once a
      // final-looking answer starts streaming, delete progress before opening
      // the durable answer lane so Telegram never shows final text inside the
      // soon-to-be-deleted progress message.
      routeToolStatusPartialsToProgress = false;
      await clearProgressController("before-answer-partial", {
        timeoutMs: PROGRESS_FINAL_CLEANUP_TIMEOUT_MS,
      });
    }
    if (
      lane === answerLane &&
      routeToolStatusPartialsToProgress &&
      updateActiveProgressPreviewFromPartial(previewText, "answer-partial-progress-preview")
    ) {
      // This is a live preview of the current assistant text, not committed
      // progress history. The final payload still owns the durable answer, so
      // do not record this text as a transient prefix to strip from final.
      lane.lastPartialText = previewText;
      return;
    }
    const laneStream = lane.stream ?? ensureDraftLaneStream(laneName);
    if (!laneStream) {
      return;
    }
    setDraftDurableSendClassification(laneName, {
      reason: laneName === "reasoning" ? "progress" : "unknown",
      callsite: `${laneName}-partial-preview`,
      sourceKind: "partial",
    });
    const previousDeliveredPreviewText = laneStream.lastDeliveredText?.() ?? "";
    if (
      !shouldEmitCoalescedDraftPreview({
        previousText: previousDeliveredPreviewText,
        nextText: previewText,
        laneName,
        fastFirstPreview: lane === answerLane && useMessagePreviewTransportForDm,
      })
    ) {
      lane.lastPartialText = previewText;
      return;
    }
    lane.lastPartialText = previewText;
    // `lastPartialText` is the complete accumulated snapshot. This flag means
    // a preview update was actually queued, which controls later materialize
    // and cleanup behavior.
    lane.hasStreamedMessage = true;
    laneStream.update(previewText);
  };
  const ingestDraftLaneSegments = async (text: string | undefined) => {
    const split = splitTextIntoLaneSegments(text);
    const hasAnswerSegment = split.segments.some((segment) => segment.lane === "answer");
    if (hasAnswerSegment && activePreviewLifecycleByLane.answer !== "transient") {
      // Some providers can emit the first partial of a new assistant message before
      // onAssistantMessageStart() arrives. Rotate preemptively so we do not edit
      // the previously finalized preview message with the next message's text.
      skipNextAnswerMessageStartRotation = await rotateAnswerLaneForNewAssistantMessage();
    }
    for (const segment of split.segments) {
      if (segment.lane === "reasoning") {
        reasoningStepState.noteReasoningHint();
        reasoningStepState.noteReasoningDelivered();
      }
      await updateDraftFromPartial(segment.lane, segment.text);
    }
  };
  const flushDraftLane = async (lane: DraftLaneState) => {
    if (!lane.stream) {
      return;
    }
    await lane.stream.flush();
  };
  const adoptSpeculativeAnswerPreviewAsProgress = async (callsite: string) => {
    if (!answerLane.stream || !answerLane.hasStreamedMessage) {
      return undefined;
    }
    const stream = answerLane.stream;
    const previewMessageId = stream.messageId();
    recordTransientProgressPreviewText(answerLane.lastPartialText);
    const existingController = getActiveProgressController();
    if (existingController) {
      updateActiveProgressPreviewFromPartial(
        answerLane.lastPartialText,
        `${callsite}-existing-progress`,
      );
      answerLane.stream = undefined;
      resetDraftLaneState(answerLane);
      activePreviewLifecycleByLane.answer = "transient";
      retainPreviewOnCleanupByLane.answer = false;
      logPreviewLedger({
        lane: "progress",
        phase: "preview_adopted",
        source: "cleanup",
        messageId: previewMessageId,
        operation: "delete",
        previewTransport: stream.previewMode?.() ?? progressPreviewTransport,
        textLength: stream.lastDeliveredText?.().length,
        result: "answer_to_existing_progress",
        callsite,
      });
      try {
        await stream.clear();
      } catch (err) {
        logVerbose(
          `telegram: adopted stray answer preview cleanup failed message=${previewMessageId ?? "unknown"} callsite=${callsite}: ${String(err)}`,
        );
      }
      return existingController;
    }
    const controller = getProgressController(stream);
    if (!controller) {
      return undefined;
    }
    // The first assistant deltas are speculative. If later structure proves
    // they were progress/commentary, keep the same Telegram bubble and let the
    // progress controller edit/clear it. Deleting here creates the churn users
    // see as a disappearing answer preview followed by a new progress bubble.
    answerLane.stream = undefined;
    resetDraftLaneState(answerLane);
    activePreviewLifecycleByLane.answer = "transient";
    retainPreviewOnCleanupByLane.answer = false;
    logPreviewLedger({
      lane: "progress",
      phase: "preview_adopted",
      source: "cleanup",
      messageId: previewMessageId,
      operation: "edit",
      previewTransport: stream.previewMode?.() ?? progressPreviewTransport,
      textLength: stream.lastDeliveredText?.().length,
      result: "answer_to_progress",
      callsite,
    });
    logVerbose(
      `telegram: adopted speculative answer preview as progress message=${previewMessageId ?? "unknown"} callsite=${callsite} trace=${latencyTrace?.id ?? "none"}`,
    );
    return controller;
  };
  const updateAnswerProgressFromBlock = async (text: string | undefined) => {
    if (!text) {
      return false;
    }
    const progressText = normalizeAdjacentProgressBoundaries(text).trim();
    if (!progressText) {
      return false;
    }
    // Assistant partial callbacks are queued to preserve stream order. A later
    // structural progress boundary must wait for them before it decides whether
    // there is an existing visible answer bubble to adopt.
    await waitForDraftLaneIdle();
    const controller =
      (await adoptSpeculativeAnswerPreviewAsProgress("before-progress-update")) ??
      getProgressController();
    if (!controller) {
      return false;
    }
    // Progress owns the transient bubble. The final answer must be sent as its
    // own durable message if no later answer stream appears. When a later
    // answer stream does appear, final delivery may safely finalize that active
    // answer bubble instead of deleting/re-sending it.
    forceNextAnswerFinalSend = true;
    recordTransientProgressPreviewText(progressText);
    logPreviewLedger({
      lane: "progress",
      phase: "progress_update",
      source: "block",
      messageId: controller.messageId(),
      textLength: progressText.length,
      previewTransport: progressPreviewTransport,
      callsite: "update-answer-progress-from-block",
    });
    controller.update(progressText);
    return true;
  };
  const renderTextWithToolProgress = (text: string) => {
    return normalizeAdjacentProgressBoundaries(text);
  };
  const resetToolProgressDraft = () => {
    // Telegram no longer renders tool-status text as product UI.
  };

  const disableBlockStreaming = !previewStreamingEnabled
    ? true
    : forceBlockStreamingForReasoning
      ? false
      : canStreamProgressDraft
        ? false
        : typeof telegramCfg.blockStreaming === "boolean"
          ? !telegramCfg.blockStreaming
          : canStreamAnswerDraft
            ? true
            : undefined;

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "telegram",
    accountId: route.accountId,
  });
  const tracedOnModelSelected: typeof onModelSelected = (modelCtx) => {
    latencyTrace?.mark("model_selected", {
      provider: modelCtx.provider,
      model: modelCtx.model,
      thinkLevel: modelCtx.thinkLevel,
    });
    onModelSelected?.(modelCtx);
  };
  const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);

  // Handle uncached stickers: get a dedicated vision description before dispatch
  // This ensures we cache a raw description rather than a conversational response
  const sticker = ctxPayload.Sticker;
  if (sticker?.fileId && sticker.fileUniqueId && ctxPayload.MediaPath) {
    const agentDir = resolveAgentDir(cfg, route.agentId);
    const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
    let description = sticker.cachedDescription ?? null;
    if (!description) {
      description = await describeStickerImage({
        imagePath: ctxPayload.MediaPath,
        cfg,
        agentDir,
        agentId: route.agentId,
      });
    }
    if (description) {
      // Format the description with sticker context
      const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
        .filter(Boolean)
        .join(" ");
      const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;

      sticker.cachedDescription = description;
      if (!stickerSupportsVision) {
        // Update context to use description instead of image
        ctxPayload.Body = formattedDesc;
        ctxPayload.BodyForAgent = formattedDesc;
        // Drop only the sticker attachment; keep replied media context if present.
        pruneStickerMediaFromContext(ctxPayload, {
          stickerMediaIncluded: ctxPayload.StickerMediaIncluded,
        });
      }

      // Cache the description for future encounters
      if (sticker.fileId) {
        cacheSticker({
          fileId: sticker.fileId,
          fileUniqueId: sticker.fileUniqueId,
          emoji: sticker.emoji,
          setName: sticker.setName,
          description,
          cachedAt: new Date().toISOString(),
          receivedFrom: ctxPayload.From,
        });
        logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
      } else {
        logVerbose(`telegram: skipped sticker cache (missing fileId)`);
      }
    }
  }

  const implicitQuoteReplyTargetId =
    replyQuoteMessageId != null ? String(replyQuoteMessageId) : undefined;
  const currentMessageIdForQuoteReply =
    implicitQuoteReplyTargetId && ctxPayload.MessageSid ? ctxPayload.MessageSid : undefined;
  const replyQuotePosition =
    typeof ctxPayload.ReplyToQuotePosition === "number"
      ? ctxPayload.ReplyToQuotePosition
      : undefined;
  const replyQuoteEntities = Array.isArray(ctxPayload.ReplyToQuoteEntities)
    ? ctxPayload.ReplyToQuoteEntities
    : undefined;
  const deliveryState = createLaneDeliveryStateTracker();
  const clearGroupHistory = () => {
    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
    }
  };
  const deliveryBaseOptions = {
    chatId: String(chatId),
    accountId: route.accountId,
    sessionKeyForInternalHooks: ctxPayload.SessionKey,
    mirrorIsGroup: isGroup,
    mirrorGroupId: isGroup ? String(chatId) : undefined,
    token: opts.token,
    runtime,
    bot,
    mediaLocalRoots,
    replyToMode,
    textLimit,
    thread: threadSpec,
    tableMode,
    chunkMode,
    linkPreview: telegramCfg.linkPreview,
    replyQuoteMessageId,
    replyQuoteText,
    replyQuotePosition,
    replyQuoteEntities,
  };
  const applyTextToPayload = (payload: ReplyPayload, text: string): ReplyPayload => {
    if (payload.text === text) {
      return payload;
    }
    return { ...payload, text };
  };
  const applyQuoteReplyTarget = (payload: ReplyPayload): ReplyPayload => {
    if (
      !implicitQuoteReplyTargetId ||
      !currentMessageIdForQuoteReply ||
      payload.replyToId !== currentMessageIdForQuoteReply ||
      payload.replyToTag ||
      payload.replyToCurrent
    ) {
      return payload;
    }
    return { ...payload, replyToId: implicitQuoteReplyTargetId };
  };
  const classifyPayloadDurableSendReason = (
    payload: ReplyPayload,
    infoKind?: string,
  ): TelegramDurableSendReason => {
    const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
    if (payload.isError) {
      return "error";
    }
    if (hasMedia) {
      return "media";
    }
    if (infoKind === "final") {
      return "final";
    }
    if (infoKind === "tool") {
      return "tool";
    }
    if (infoKind === "block") {
      return "progress";
    }
    if (infoKind === "fallback") {
      return "fallback";
    }
    return "unknown";
  };
  const stripInternalToolTraceText = (payload: ReplyPayload): ReplyPayload | undefined => {
    if (payload.isError || !hasInternalToolTraceText(payload.text)) {
      return payload;
    }
    const withoutTraceText = { ...payload, text: undefined };
    if (!hasUserFacingToolEnvelope(withoutTraceText)) {
      return undefined;
    }
    return withoutTraceText;
  };
  const sendPayload = async (
    payload: ReplyPayload,
    classification?: {
      reason?: TelegramDurableSendReason;
      callsite?: string;
      laneName?: LaneName;
      infoKind?: string;
    },
  ) => {
    let normalizedPayload =
      typeof payload.text === "string"
        ? applyTextToPayload(payload, normalizeAdjacentProgressBoundaries(payload.text))
        : payload;
    const hasMedia =
      Boolean(normalizedPayload.mediaUrl) || (normalizedPayload.mediaUrls?.length ?? 0) > 0;
    const isTtsSupplement = isFinalTtsSupplementPayload(normalizedPayload);
    if (
      isTtsSupplement &&
      hasMedia &&
      normalizedPayload.audioAsVoice === true &&
      typeof normalizedPayload.text === "string" &&
      normalizedPayload.text.trim().length > 0
    ) {
      // Marked TTS payloads are audio supplements to already-visible final
      // text. Keep a bounded caption preview for Telegram snippets, but never
      // duplicate the full final answer as a voice caption.
      const captionPreview = buildFinalTtsCaptionPreview(normalizedPayload.text);
      logVerbose(
        `telegram: final TTS supplement caption ${captionPreview ? "previewed" : "omitted"} captionLength=${captionPreview?.length ?? 0}`,
      );
      normalizedPayload = { ...normalizedPayload, text: captionPreview };
    }
    const durableReason =
      classification?.reason ??
      classifyPayloadDurableSendReason(normalizedPayload, classification?.infoKind);
    const ledgerLane: TelegramPreviewLedgerLane = isTtsSupplement
      ? "tts"
      : classification?.laneName === "answer"
        ? "answer"
        : durableReason === "tool"
          ? "tool"
          : durableReason === "progress"
            ? "progress"
            : durableReason === "final" || classification?.infoKind === "final"
              ? "answer"
              : "unknown";
    const ledgerSource: TelegramPreviewLedgerSource = isTtsSupplement
      ? "tts"
      : classification?.infoKind === "tool"
        ? "tool"
        : classification?.infoKind === "final"
          ? "final"
          : durableReason === "progress"
            ? "block"
            : "unknown";
    const attemptPhase: TelegramPreviewLedgerPhase = isTtsSupplement
      ? "tts_send_attempt"
      : classification?.infoKind === "final" || durableReason === "final"
        ? "final_send_attempt"
        : "preview_send_attempt";
    const completedPhase: TelegramPreviewLedgerPhase = isTtsSupplement
      ? "tts_send_completed"
      : classification?.infoKind === "final" || durableReason === "final"
        ? "final_send_completed"
        : "preview_send_completed";
    logPreviewLedger({
      lane: ledgerLane,
      phase: attemptPhase,
      source: ledgerSource,
      textLength: normalizedPayload.text?.length ?? 0,
      mediaKind: hasMedia ? (normalizedPayload.audioAsVoice ? "voice" : "media") : "text",
      callsite: classification?.callsite ?? "dispatch-send-payload",
    });
    logTelegramDurableSendClassification({
      reason: durableReason,
      callsite: classification?.callsite ?? "dispatch-send-payload",
      laneName: classification?.laneName,
      messageId: "unknown",
      infoKind: classification?.infoKind,
      hasMedia,
      isError: normalizedPayload.isError === true,
    });
    const result = await deliverReplies({
      ...deliveryBaseOptions,
      replies: [applyQuoteReplyTarget(normalizedPayload)],
      onVoiceRecording: sendRecordVoice,
      onReplyDelivered: (event: TelegramReplyDeliveredEvent) => {
        logPreviewLedger({
          lane: event.finalTtsSupplement ? "tts" : ledgerLane,
          phase: event.finalTtsSupplement ? "tts_send_completed" : completedPhase,
          source: event.finalTtsSupplement ? "tts" : ledgerSource,
          messageId: event.messageId,
          textLength: event.textLength,
          mediaKind: event.hasMedia ? (event.audioAsVoice ? "voice" : "media") : "text",
          result: event.delivered ? "delivered" : "not-delivered",
          callsite: classification?.callsite ?? "dispatch-send-payload",
        });
      },
    });
    if (result.delivered) {
      deliveryState.markDelivered();
    }
    return result.delivered;
  };
  const sendToolPayload = async (payload: ReplyPayload) => {
    if (isTextOnlyOpenClawSourcePreview(payload)) {
      // Same-chat message-tool progress is model-authored working state. Render
      // it through the mutable progress controller so it never becomes durable
      // Telegram text and never reaches TTS as a tool result.
      await updateAnswerProgressFromBlock(payload.text);
      return;
    }

    const sanitizedPayload = stripInternalToolTraceText(payload);
    if (!sanitizedPayload) {
      return;
    }
    // Tool payloads already arrive fully structured, including media URLs from
    // trusted tool results. Deliver them directly so Telegram does not have to
    // infer media from assistant prose after the model paraphrases the tool.
    if (!hasUserFacingToolEnvelope(sanitizedPayload)) {
      return;
    }
    await sendPayload(sanitizedPayload, {
      reason: classifyPayloadDurableSendReason(sanitizedPayload, "tool"),
      callsite: "dispatch-tool-payload",
      infoKind: "tool",
    });
  };
  const deliverLaneText = createLaneTextDeliverer({
    lanes,
    archivedAnswerPreviews,
    activePreviewLifecycleByLane,
    retainPreviewOnCleanupByLane,
    draftMaxChars,
    applyTextToPayload,
    sendPayload,
    flushDraftLane,
    stopDraftLane: async (lane) => {
      await lane.stream?.stop();
    },
    editPreview: async ({ laneName, messageId, text, context, previewButtons }) => {
      logPreviewLedger({
        lane: laneName,
        phase: context === "final" ? "final_preview_edit_attempt" : "preview_edit_attempt",
        source: context === "final" ? "final" : "unknown",
        messageId,
        textLength: text.length,
        operation: "edit",
        callsite: "lane-delivery-edit-preview",
      });
      await editMessageTelegram(chatId, messageId, text, {
        api: bot.api,
        cfg,
        accountId: route.accountId,
        linkPreview: telegramCfg.linkPreview,
        buttons: previewButtons,
      });
      logPreviewLedger({
        lane: laneName,
        phase: context === "final" ? "final_preview_edit_completed" : "preview_edit_completed",
        source: context === "final" ? "final" : "unknown",
        messageId,
        textLength: text.length,
        operation: "edit",
        result: "edited",
        callsite: "lane-delivery-edit-preview",
      });
    },
    deletePreviewMessage: async (messageId) => {
      logPreviewLedger({
        lane: "answer",
        phase: "preview_delete_attempt",
        source: "cleanup",
        messageId,
        operation: "delete",
        callsite: "lane-delivery-delete-preview",
      });
      await guardedTelegramDeleteMessage({
        api: bot.api,
        chatId,
        messageId,
        audit: {
          callsite: "telegram-lane-preview-delete",
          reason: "lane_delivery_preview_cleanup",
          safetyMode: "deterministic_cleanup",
          accountId: route.accountId,
          lane: "answer",
          classification: "preview",
          sessionId:
            typeof context.ctxPayload?.SessionKey === "string"
              ? context.ctxPayload.SessionKey
              : undefined,
          topicId: threadSpec?.id,
          thread: threadSpec,
        },
      });
      logPreviewLedger({
        lane: "answer",
        phase: "preview_delete_completed",
        source: "cleanup",
        messageId,
        operation: "delete",
        callsite: "lane-delivery-delete-preview",
      });
    },
    log: logVerbose,
    markDelivered: () => {
      deliveryState.markDelivered();
    },
  });
  const deliverFinalAnswerText = async ({
    text,
    payload,
    previewButtons,
    hasMedia,
  }: {
    text: string;
    payload: ReplyPayload;
    previewButtons?: TelegramInlineButtons;
    hasMedia?: boolean;
  }) => {
    const preparedText = await prepareFinalAnswerText(text, {
      hasMedia,
      isError: payload.isError,
    });
    setDraftDurableSendClassification("answer", {
      reason: classifyPayloadDurableSendReason(payload, "final"),
      callsite: "answer-final-preview",
      sourceKind: "final",
    });
    let result: "sent" | "skipped" | "preview-finalized" | "preview-retained" | "preview-updated";
    if (forceNextAnswerFinalSend && !answerLane.hasStreamedMessage) {
      forceNextAnswerFinalSend = false;
      const delivered = await sendPayload(applyTextToPayload(payload, preparedText), {
        reason: classifyPayloadDurableSendReason(payload, "final"),
        callsite: "answer-final-forced-send",
        laneName: "answer",
        infoKind: "final",
      });
      result = delivered ? "sent" : "skipped";
    } else {
      forceNextAnswerFinalSend = false;
      result = await deliverLaneText({
        laneName: "answer",
        text: preparedText,
        payload,
        infoKind: "final",
        previewButtons,
      });
    }
    if (result !== "skipped") {
      latencyTrace?.mark("final_telegram_send_edit_completed", {
        result,
        textLength: preparedText.length,
        hasMedia: Boolean(hasMedia),
        partialCallbackCount,
        firstPartialTextLength,
        previewReplacedOrCleaned: result !== "sent",
      });
      await clearProgressController("after-final", {
        timeoutMs: PROGRESS_FINAL_CLEANUP_TIMEOUT_MS,
      });
    }
    return result;
  };

  const sendFinalPayloadThenCleanupProgress = async (
    payload: ReplyPayload,
    classification: {
      reason?: TelegramDurableSendReason;
      callsite?: string;
      laneName?: LaneName;
      infoKind?: string;
    },
  ) => {
    const delivered = await sendPayload(payload, classification);
    if (delivered) {
      latencyTrace?.mark("final_telegram_send_edit_completed", {
        result: "sent",
        textLength: payload.text?.length ?? 0,
        hasMedia: Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0,
        partialCallbackCount,
        firstPartialTextLength,
        previewReplacedOrCleaned: false,
      });
      await clearProgressController(`${classification.callsite ?? "final"}-after-final`, {
        timeoutMs: PROGRESS_FINAL_CLEANUP_TIMEOUT_MS,
      });
    }
    return delivered;
  };

  type PendingAmbiguousAnswerBlock = {
    text: string;
    payload: ReplyPayload;
    previewButtons?: TelegramInlineButtons;
    hasMedia: boolean;
  };

  let queuedFinal = false;
  let pendingAmbiguousAnswerBlock: PendingAmbiguousAnswerBlock | undefined;

  const bufferAmbiguousAnswerBlock = (pending: PendingAmbiguousAnswerBlock) => {
    pendingAmbiguousAnswerBlock = pending;
    logVerbose("telegram: buffered phase-unknown answer block until lifecycle boundary");
  };

  const flushAmbiguousAnswerBlockAsProgress = async (callsite: string) => {
    const pending = pendingAmbiguousAnswerBlock;
    if (!pending) {
      return;
    }
    pendingAmbiguousAnswerBlock = undefined;
    logVerbose(`telegram: routing phase-unknown answer block as progress callsite=${callsite}`);
    await updateAnswerProgressFromBlock(renderTextWithToolProgress(pending.text));
  };

  const flushAmbiguousAnswerBlockAsFinal = async (callsite: string) => {
    const pending = pendingAmbiguousAnswerBlock;
    if (!pending) {
      return;
    }
    pendingAmbiguousAnswerBlock = undefined;
    logVerbose(
      `telegram: routing terminal phase-unknown answer block as final callsite=${callsite}`,
    );
    const result = await deliverFinalAnswerText({
      text: pending.text,
      payload: pending.payload,
      previewButtons: pending.previewButtons,
      hasMedia: pending.hasMedia,
    });
    queuedFinal = result !== "skipped" || queuedFinal;
  };

  if (statusReactionController) {
    void statusReactionController.setThinking();
  }

  const typingCallbacks = createTypingCallbacks({
    start: sendTyping,
    onStartError: (err) => {
      logTypingFailure({
        log: logVerbose,
        channel: "telegram",
        target: String(chatId),
        error: err,
      });
    },
  });

  let dispatchError: unknown;
  try {
    latencyTrace?.mark("reply_dispatch_started", {
      streamMode,
      answerPreviewTransport,
      progressPreviewTransport,
      canStreamAnswerDraft,
      canStreamProgressDraft,
      canStreamReasoningDraft,
    });
    ({ queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        ...prefixOptions,
        typingCallbacks,
        onBlockReplyFinalized: async () => {
          // Some providers stream the visible final answer as phase-less block
          // callbacks and return no separate final payload. Once the generic
          // reply layer confirms the block stream is complete, materialize that
          // buffered text as the durable final before slower supplements such as
          // TTS run; otherwise users can see a duplicate preview until voice
          // synthesis finishes.
          logVerbose(
            `telegram: block stream finalize hook buffered=${String(Boolean(pendingAmbiguousAnswerBlock))}`,
          );
          if (sawAssistantPartial) {
            pendingAmbiguousAnswerBlock = undefined;
            logVerbose("telegram: dropped phase-unknown block buffer after assistant partials");
            return;
          }
          await flushAmbiguousAnswerBlockAsFinal("after-block-stream-final");
        },
        deliver: async (payload, info) => {
          try {
            const assistantPhase = resolveOpenClawAssistantPhase(payload);
            const deliveryKind =
              info.kind === "block" && assistantPhase === "final_answer" ? "final" : info.kind;
            const hasPayloadMedia =
              Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
            const hasPayloadText =
              typeof payload.text === "string" && payload.text.trim().length > 0;
            const isTtsMediaFinalBoundary =
              deliveryKind === "final" &&
              hasPayloadMedia &&
              (!hasPayloadText || isFinalTtsSupplementPayload(payload));
            if (deliveryKind === "final") {
              // Assistant callbacks are fire-and-forget; ensure queued boundary
              // rotations/partials are applied before final delivery mapping.
              await enqueueDraftLaneEvent(async () => {});
            }
            if (
              pendingAmbiguousAnswerBlock &&
              deliveryKind === "final" &&
              assistantPhase === "final_answer" &&
              !isTtsMediaFinalBoundary
            ) {
              // The generic/ACP layer is now sending the accepted final text
              // with an explicit phase marker. Treat that marker as the
              // authority and drop the older phase-less block buffer; otherwise
              // Telegram briefly shows the same text once as mutable progress
              // and again as durable final text.
              pendingAmbiguousAnswerBlock = undefined;
              logVerbose("telegram: dropped phase-unknown answer buffer before marked final");
            } else if (
              pendingAmbiguousAnswerBlock &&
              sawAssistantPartial &&
              !isTtsMediaFinalBoundary &&
              (deliveryKind === "final" || (deliveryKind === "block" && !assistantPhase))
            ) {
              // Codex can emit both raw assistant deltas and phase-less block
              // snapshots for the same final answer. Once answer deltas are
              // already driving the durable answer lane, those block snapshots
              // are duplicate answer text, not process progress.
              pendingAmbiguousAnswerBlock = undefined;
              logVerbose(
                `telegram: dropped phase-unknown answer buffer after assistant partial before ${deliveryKind}`,
              );
            } else if (
              pendingAmbiguousAnswerBlock &&
              (deliveryKind === "final" ||
                deliveryKind === "tool" ||
                assistantPhase === "commentary" ||
                (deliveryKind === "block" && !assistantPhase))
            ) {
              if (isTtsMediaFinalBoundary) {
                // A TTS/audio supplement is a final boundary, but it is not the
                // final text. Captioned TTS carries short preview text for
                // Telegram, so the explicit supplement marker keeps this from
                // being mistaken for the full final answer.
                await flushAmbiguousAnswerBlockAsFinal(`before-${deliveryKind}-media`);
              } else {
                // A later structural boundary proves the previous phase-less
                // block was in-flight commentary. Route it through the mutable
                // progress controller before handling the new event.
                await flushAmbiguousAnswerBlockAsProgress(`before-${deliveryKind}`);
              }
            }
            if (
              shouldSuppressLocalTelegramExecApprovalPrompt({
                cfg,
                accountId: route.accountId,
                payload,
              })
            ) {
              queuedFinal = true;
              return;
            }
            const previewButtons = (
              payload.channelData?.telegram as { buttons?: TelegramInlineButtons } | undefined
            )?.buttons;
            if (deliveryKind === "tool") {
              const sanitizedPayload = stripInternalToolTraceText(payload);
              if (!sanitizedPayload) {
                return;
              }
              payload = sanitizedPayload;
              if (
                !payload.mediaUrl &&
                !(payload.mediaUrls?.length ?? 0) &&
                !payload.isError &&
                typeof payload.text === "string"
              ) {
                await sendToolPayload(payload);
                return;
              }
            }
            const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;

            const flushBufferedFinalAnswer = async () => {
              const buffered = reasoningStepState.takeBufferedFinalAnswer();
              if (!buffered) {
                return;
              }
              const bufferedButtons = (
                buffered.payload.channelData?.telegram as
                  | { buttons?: TelegramInlineButtons }
                  | undefined
              )?.buttons;
              await deliverFinalAnswerText({
                text: buffered.text,
                payload: buffered.payload,
                previewButtons: bufferedButtons,
              });
              reasoningStepState.resetForNextStep();
            };

            if (isTtsMediaFinalBoundary) {
              await sendFinalPayloadThenCleanupProgress(payload, {
                reason: classifyPayloadDurableSendReason(payload, deliveryKind),
                callsite: "dispatch-final-tts-supplement",
                infoKind: deliveryKind,
              });
              await flushBufferedFinalAnswer();
              return;
            }

            const split = splitTextIntoLaneSegments(payload.text);
            const segments = split.segments;

            for (const segment of segments) {
              if (
                segment.lane === "answer" &&
                deliveryKind === "final" &&
                reasoningStepState.shouldBufferFinalAnswer()
              ) {
                reasoningStepState.bufferFinalAnswer({
                  payload,
                  text: segment.text,
                });
                continue;
              }
              if (segment.lane === "reasoning") {
                reasoningStepState.noteReasoningHint();
              }
              if (segment.lane === "answer" && deliveryKind !== "final") {
                if (hasMedia || payload.isError) {
                  await sendPayload(payload, {
                    reason: classifyPayloadDurableSendReason(payload, deliveryKind),
                    callsite: "dispatch-nonfinal-answer-envelope",
                    laneName: "answer",
                    infoKind: deliveryKind,
                  });
                } else if (deliveryKind === "block" && !assistantPhase) {
                  // Phase metadata is the only safe way to distinguish
                  // commentary from final-answer text. If it is missing, wait
                  // until the next lifecycle signal: a tool/final/known phase
                  // makes this progress; end-of-run makes it the final answer.
                  bufferAmbiguousAnswerBlock({
                    text: segment.text,
                    payload,
                    previewButtons,
                    hasMedia,
                  });
                } else {
                  await updateAnswerProgressFromBlock(renderTextWithToolProgress(segment.text));
                }
                continue;
              }
              const result =
                segment.lane === "answer" && deliveryKind === "final"
                  ? await deliverFinalAnswerText({
                      text: segment.text,
                      payload,
                      previewButtons,
                      hasMedia,
                    })
                  : await (async () => {
                      if (segment.lane === "reasoning" && deliveryKind === "final") {
                        ensureDraftLaneStream("reasoning");
                      }
                      return deliverLaneText({
                        laneName: segment.lane,
                        text:
                          segment.lane === "answer"
                            ? renderTextWithToolProgress(segment.text)
                            : segment.text,
                        payload,
                        infoKind: deliveryKind,
                        previewButtons,
                        allowPreviewUpdateForNonFinal: segment.lane === "reasoning",
                      });
                    })();
              if (segment.lane === "reasoning") {
                if (result !== "skipped") {
                  reasoningStepState.noteReasoningDelivered();
                  await flushBufferedFinalAnswer();
                }
                continue;
              }
              if (deliveryKind === "final") {
                if (reasoningLane.hasStreamedMessage) {
                  activePreviewLifecycleByLane.reasoning = "complete";
                  retainPreviewOnCleanupByLane.reasoning = true;
                }
                reasoningStepState.resetForNextStep();
              }
            }
            if (segments.length > 0) {
              return;
            }
            if (split.suppressedReasoningOnly) {
              if (hasMedia) {
                const payloadWithoutSuppressedReasoning =
                  typeof payload.text === "string" ? { ...payload, text: "" } : payload;
                const classification = {
                  reason: classifyPayloadDurableSendReason(
                    payloadWithoutSuppressedReasoning,
                    deliveryKind,
                  ),
                  callsite: "dispatch-suppressed-reasoning-media",
                  infoKind: deliveryKind,
                };
                if (deliveryKind === "final") {
                  await sendFinalPayloadThenCleanupProgress(
                    payloadWithoutSuppressedReasoning,
                    classification,
                  );
                } else {
                  await sendPayload(payloadWithoutSuppressedReasoning, classification);
                }
              }
              if (deliveryKind === "final") {
                await flushBufferedFinalAnswer();
              }
              return;
            }

            if (deliveryKind === "final") {
              await answerLane.stream?.stop();
              await reasoningLane.stream?.stop();
              reasoningStepState.resetForNextStep();
            }
            const canSendAsIs =
              hasMedia || (typeof payload.text === "string" && payload.text.length > 0);
            if (!canSendAsIs) {
              if (deliveryKind === "final") {
                await flushBufferedFinalAnswer();
                await clearProgressController("before-final-empty", {
                  timeoutMs: PROGRESS_FINAL_CLEANUP_TIMEOUT_MS,
                });
              }
              return;
            }
            if (
              deliveryKind !== "final" &&
              typeof payload.text === "string" &&
              !hasMedia &&
              !payload.isError
            ) {
              if (deliveryKind === "block" && !assistantPhase) {
                bufferAmbiguousAnswerBlock({
                  text: payload.text,
                  payload,
                  previewButtons,
                  hasMedia,
                });
              } else {
                await updateAnswerProgressFromBlock(renderTextWithToolProgress(payload.text));
              }
              return;
            }
            const payloadToSend = payload.text
              ? applyTextToPayload(
                  payload,
                  deliveryKind === "final"
                    ? await prepareFinalAnswerText(payload.text, {
                        hasMedia,
                        isError: payload.isError,
                      })
                    : renderTextWithToolProgress(payload.text),
                )
              : payload;
            const classification = {
              reason: classifyPayloadDurableSendReason(payload, deliveryKind),
              callsite: "dispatch-direct-payload",
              infoKind: deliveryKind,
            };
            if (deliveryKind === "final") {
              await sendFinalPayloadThenCleanupProgress(payloadToSend, classification);
            } else {
              await sendPayload(payloadToSend, classification);
            }
            if (deliveryKind === "final") {
              await flushBufferedFinalAnswer();
            }
          } finally {
            if (
              info.kind === "final" ||
              resolveOpenClawAssistantPhase(payload) === "final_answer"
            ) {
              resetToolProgressDraft();
            }
          }
        },
        onSkip: (_payload, info) => {
          if (info.reason !== "silent") {
            deliveryState.markNonSilentSkip();
          }
        },
        onError: (err, info) => {
          deliveryState.markNonSilentFailure();
          runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
          const failedPayload = info.payload;
          const failedTtsMedia =
            info.kind === "final" &&
            failedPayload &&
            (isFinalTtsSupplementPayload(failedPayload) ||
              ((Boolean(failedPayload.mediaUrl) || (failedPayload.mediaUrls?.length ?? 0) > 0) &&
                failedPayload.audioAsVoice === true));
          if (failedTtsMedia) {
            // TTS is additive. If the media send fails after the durable final
            // text is already visible, keep the text in place and add a small
            // status instead of deleting/replacing anything.
            void sendFinalPayloadThenCleanupProgress(
              {
                text: "Voice note failed. Final text is above.",
                channelData: {
                  openclaw: {
                    finalTtsSupplement: true,
                    ttsFailureStatus: true,
                  },
                },
              },
              {
                callsite: "dispatch-final-tts-send-failure",
                infoKind: "final",
              },
            ).catch((statusErr) => {
              logVerbose(`telegram: final TTS failure status send failed: ${String(statusErr)}`);
            });
          }
        },
      },
      replyOptions: {
        skillFilter,
        disableBlockStreaming,
        onToolResult: (payload) =>
          enqueueDraftLaneEvent(async () => {
            await flushAmbiguousAnswerBlockAsProgress("before-tool-result");
            if (getActiveProgressController()) {
              routeToolStatusPartialsToProgress = true;
            }
            await sendToolPayload(payload);
          }),
        onPartialReply:
          canStreamAnswerDraft || canStreamReasoningDraft
            ? (payload) =>
                enqueueDraftLaneEvent(async () => {
                  sawAssistantPartial = true;
                  await ingestDraftLaneSegments(payload.text);
                })
            : undefined,
        onReasoningStream: canStreamReasoningDraft
          ? (payload) =>
              enqueueDraftLaneEvent(async () => {
                // Split between reasoning blocks only when the next reasoning
                // stream starts. Splitting at reasoning-end can orphan the active
                // preview and cause duplicate reasoning sends on reasoning final.
                if (splitReasoningOnNextStream) {
                  reasoningLane.stream?.forceNewMessage();
                  resetDraftLaneState(reasoningLane);
                  splitReasoningOnNextStream = false;
                }
                await ingestDraftLaneSegments(payload.text);
              })
          : undefined,
        onAssistantMessageStart: canStreamAnswerDraft
          ? () =>
              enqueueDraftLaneEvent(async () => {
                reasoningStepState.resetForNextStep();
                if (skipNextAnswerMessageStartRotation) {
                  skipNextAnswerMessageStartRotation = false;
                  activePreviewLifecycleByLane.answer = "transient";
                  retainPreviewOnCleanupByLane.answer = false;
                  return;
                }
                await rotateAnswerLaneForNewAssistantMessage();
                // Message-start is an explicit assistant-message boundary.
                // Even when no forceNewMessage happened (e.g. prior answer had no
                // streamed partials), the next partial belongs to a fresh lifecycle
                // and must not trigger late pre-rotation mid-message.
                activePreviewLifecycleByLane.answer = "transient";
                retainPreviewOnCleanupByLane.answer = false;
              })
          : undefined,
        onReasoningEnd: canStreamReasoningDraft
          ? () =>
              enqueueDraftLaneEvent(async () => {
                // Split when/if a later reasoning block begins.
                splitReasoningOnNextStream = reasoningLane.hasStreamedMessage;
              })
          : undefined,
        onToolStart: async (payload) => {
          await flushAmbiguousAnswerBlockAsProgress("before-tool-start");
          if (getActiveProgressController()) {
            routeToolStatusPartialsToProgress = true;
          }
          if (!statusReactionController) {
            return;
          }
          await statusReactionController.setTool(payload.name);
        },
        onCompactionStart: statusReactionController
          ? () => statusReactionController.setCompacting()
          : undefined,
        onCompactionEnd: statusReactionController
          ? async () => {
              statusReactionController.cancelPending();
              await statusReactionController.setThinking();
            }
          : undefined,
        onModelSelected: tracedOnModelSelected,
      },
    }));
  } catch (err) {
    dispatchError = err;
    runtime.error?.(danger(`telegram dispatch failed: ${String(err)}`));
  } finally {
    // Upstream assistant callbacks are fire-and-forget; drain queued lane work
    // before stream cleanup so boundary rotations/materialization complete first.
    await draftLaneEventQueue;
    if (!dispatchError) {
      await flushAmbiguousAnswerBlockAsFinal("dispatch-settled");
    }
    // Must stop() first to flush debounced content before clear() wipes state.
    const streamCleanupStates = new Map<
      NonNullable<DraftLaneState["stream"]>,
      { shouldClear: boolean }
    >();
    const lanesToCleanup: Array<{ laneName: LaneName; lane: DraftLaneState }> = [
      { laneName: "answer", lane: answerLane },
      { laneName: "reasoning", lane: reasoningLane },
    ];
    for (const laneState of lanesToCleanup) {
      const stream = laneState.lane.stream;
      if (!stream) {
        continue;
      }
      // Don't clear (delete) the stream if: (a) it was finalized, or
      // (b) the active stream message is itself a boundary-finalized archive.
      const activePreviewMessageId = stream.messageId();
      const hasBoundaryFinalizedActivePreview =
        laneState.laneName === "answer" &&
        typeof activePreviewMessageId === "number" &&
        archivedAnswerPreviews.some(
          (p) => p.deleteIfUnused === false && p.messageId === activePreviewMessageId,
        );
      const shouldClear =
        !retainPreviewOnCleanupByLane[laneState.laneName] && !hasBoundaryFinalizedActivePreview;
      const existing = streamCleanupStates.get(stream);
      if (!existing) {
        streamCleanupStates.set(stream, { shouldClear });
        continue;
      }
      existing.shouldClear = existing.shouldClear && shouldClear;
    }
    for (const [stream, cleanupState] of streamCleanupStates) {
      await stream.stop();
      if (cleanupState.shouldClear) {
        await stream.clear();
      }
    }
    for (const archivedPreview of archivedAnswerPreviews) {
      if (archivedPreview.deleteIfUnused === false) {
        continue;
      }
      try {
        await guardedTelegramDeleteMessage({
          api: bot.api,
          chatId,
          messageId: archivedPreview.messageId,
          audit: {
            callsite: "telegram-archived-answer-preview-cleanup",
            reason: "archived_answer_preview_cleanup",
            safetyMode: "deterministic_cleanup",
            accountId: route.accountId,
            lane: "answer",
            classification: "preview",
            sessionId:
              typeof context.ctxPayload?.SessionKey === "string"
                ? context.ctxPayload.SessionKey
                : undefined,
            topicId: threadSpec?.id,
            thread: threadSpec,
          },
        });
      } catch (err) {
        logVerbose(
          `telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(err)}`,
        );
      }
    }
    for (const messageId of archivedReasoningPreviewIds) {
      try {
        await guardedTelegramDeleteMessage({
          api: bot.api,
          chatId,
          messageId,
          audit: {
            callsite: "telegram-archived-reasoning-preview-cleanup",
            reason: "archived_reasoning_preview_cleanup",
            safetyMode: "deterministic_cleanup",
            accountId: route.accountId,
            lane: "reasoning",
            classification: "progress",
            sessionId:
              typeof context.ctxPayload?.SessionKey === "string"
                ? context.ctxPayload.SessionKey
                : undefined,
            topicId: threadSpec?.id,
            thread: threadSpec,
          },
        });
      } catch (err) {
        logVerbose(
          `telegram: archived reasoning preview cleanup failed (${messageId}): ${String(err)}`,
        );
      }
    }
  }
  let sentFallback = false;
  const deliverySummary = deliveryState.snapshot();
  if (
    dispatchError ||
    (!deliverySummary.delivered &&
      (deliverySummary.skippedNonSilent > 0 || deliverySummary.failedNonSilent > 0))
  ) {
    const fallbackText = dispatchError
      ? "Something went wrong while processing your request. Please try again."
      : EMPTY_RESPONSE_FALLBACK;
    await clearProgressController("before-fallback", {
      timeoutMs: PROGRESS_FINAL_CLEANUP_TIMEOUT_MS,
    });
    logTelegramDurableSendClassification({
      reason: "fallback",
      callsite: "dispatch-empty-or-error-fallback",
      messageId: "unknown",
      infoKind: "fallback",
    });
    logPreviewLedger({
      lane: "answer",
      phase: "final_send_attempt",
      source: "final",
      textLength: fallbackText.length,
      mediaKind: "text",
      callsite: "dispatch-empty-or-error-fallback",
    });
    const result = await deliverReplies({
      replies: [{ text: fallbackText }],
      ...deliveryBaseOptions,
      onReplyDelivered: (event: TelegramReplyDeliveredEvent) => {
        logPreviewLedger({
          lane: "answer",
          phase: "final_send_completed",
          source: "final",
          messageId: event.messageId,
          textLength: event.textLength,
          mediaKind: event.hasMedia ? (event.audioAsVoice ? "voice" : "media") : "text",
          result: event.delivered ? "delivered" : "not-delivered",
          callsite: "dispatch-empty-or-error-fallback",
        });
      },
    });
    sentFallback = result.delivered;
  }

  const hasFinalResponse = queuedFinal || sentFallback;

  if (statusReactionController && !hasFinalResponse) {
    void statusReactionController.setError().catch((err) => {
      logVerbose(`telegram: status reaction error finalize failed: ${String(err)}`);
    });
  }

  if (!hasFinalResponse) {
    clearGroupHistory();
    return;
  }

  if (statusReactionController) {
    void statusReactionController.setDone().catch((err) => {
      logVerbose(`telegram: status reaction finalize failed: ${String(err)}`);
    });
  } else {
    removeAckReactionAfterReply({
      removeAfterReply: removeAckAfterReply,
      ackReactionPromise,
      ackReactionValue: ackReactionPromise ? "ack" : null,
      remove: () => reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve(),
      onError: (err) => {
        if (!msg.message_id) {
          return;
        }
        logAckFailure({
          log: logVerbose,
          channel: "telegram",
          target: `${chatId}/${msg.message_id}`,
          error: err,
        });
      },
    });
  }
  clearGroupHistory();
};
