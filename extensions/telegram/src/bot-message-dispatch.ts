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
import { getAgentScopedMediaLocalRoots } from "../../../src/media/local-roots.js";
import type { RuntimeEnv } from "../../../src/runtime.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramBotOptions } from "./bot.js";
import { deliverReplies } from "./bot/delivery.js";
import { resolveTelegramReplyId } from "./bot/helpers.js";
import type { TelegramStreamMode } from "./bot/types.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { createTelegramDraftStream } from "./draft-stream.js";
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
import {
  createTelegramReasoningStepState,
  splitTelegramReasoningText,
} from "./reasoning-lane-coordinator.js";
import { editMessageTelegram } from "./send.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

/** Minimum chars before sending first streaming message (improves push notification UX). */
const DRAFT_MIN_INITIAL_CHARS = 12;
const DRAFT_MIN_INITIAL_CHARS_DM_MESSAGE_PREVIEW = 1;
const TOOL_PROGRESS_MAX_LINES = 6;

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

function hasInternalToolTraceText(text?: string) {
  const normalized = normalizeToolProgressLine(text);
  return normalized?.startsWith("🔧") === true;
}

function hasToolPayloadContent(payload: ReplyPayload) {
  return (
    Boolean(payload.text?.trim()) || Boolean(payload.mediaUrl) || Boolean(payload.mediaUrls?.length)
  );
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
};

type TelegramReasoningLevel = "off" | "on" | "stream";

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
  const canStreamAnswerDraft =
    previewStreamingEnabled &&
    !hasNativeQuoteReply &&
    !accountBlockStreamingEnabled &&
    !forceBlockStreamingForReasoning;
  const canStreamReasoningDraft = canStreamAnswerDraft || streamReasoningDraft;
  const draftReplyToMessageId =
    replyToMode !== "off" && typeof msg.message_id === "number"
      ? (replyQuoteMessageId ?? msg.message_id)
      : undefined;
  // Keep DM preview lanes on real message transport. Native draft previews still
  // require a draft->message materialize hop, and that overlap keeps reintroducing
  // a visible duplicate flash at finalize time.
  const useMessagePreviewTransportForDm = threadSpec?.scope === "dm" && canStreamAnswerDraft;
  const draftMinInitialChars = useMessagePreviewTransportForDm
    ? DRAFT_MIN_INITIAL_CHARS_DM_MESSAGE_PREVIEW
    : DRAFT_MIN_INITIAL_CHARS;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const archivedAnswerPreviews: ArchivedPreview[] = [];
  const archivedReasoningPreviewIds: number[] = [];
  const createDraftLane = (laneName: LaneName, enabled: boolean): DraftLaneState => {
    const stream = enabled
      ? createTelegramDraftStream({
          api: bot.api,
          chatId,
          maxChars: draftMaxChars,
          thread: threadSpec,
          previewTransport: useMessagePreviewTransportForDm ? "message" : "auto",
          replyToMessageId: draftReplyToMessageId,
          minInitialChars: draftMinInitialChars,
          renderText: renderDraftPreview,
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
        })
      : undefined;
    return {
      stream,
      lastPartialText: "",
      hasStreamedMessage: false,
    };
  };
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: createDraftLane("answer", canStreamAnswerDraft),
    reasoning: createDraftLane("reasoning", canStreamReasoningDraft),
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
  let splitReasoningOnNextStream = false;
  let skipNextAnswerMessageStartRotation = false;
  let retainedAnswerProgressPreviewText = "";
  let retainedAnswerProgressFromExplicitBoundary = false;
  let forceNextAnswerFinalSend = false;
  let toolProgressLines: string[] = [];
  let draftLaneEventQueue = Promise.resolve();
  const reasoningStepState = createTelegramReasoningStepState();
  const enqueueDraftLaneEvent = (task: () => Promise<void>): Promise<void> => {
    const next = draftLaneEventQueue.then(task);
    draftLaneEventQueue = next.catch((err) => {
      logVerbose(`telegram: draft lane callback failed: ${String(err)}`);
    });
    return draftLaneEventQueue;
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
  const appendAnswerProgressText = (text: string) => {
    const normalized = text.trim();
    if (!normalized) {
      return "";
    }
    const current = retainedAnswerProgressPreviewText.trim();
    if (!current) {
      retainedAnswerProgressPreviewText = normalized;
    } else if (normalized.startsWith(current)) {
      retainedAnswerProgressPreviewText = normalized;
    } else if (normalized !== current && !current.includes(normalized)) {
      retainedAnswerProgressPreviewText = `${current}\n\n${normalized}`;
    }
    retainedAnswerProgressFromExplicitBoundary = true;
    return retainedAnswerProgressPreviewText;
  };
  const rotateAnswerLaneForNewAssistantMessage = async () => {
    let didForceNewMessage = false;
    if (answerLane.hasStreamedMessage) {
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
    return { text: normalizeAdjacentProgressBoundaries(text).trim(), stripped: false };
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
    // Materialization snapshots the last delivered preview. Force any restored
    // progress-only edit out first so a late partial containing the final
    // answer cannot be frozen into the retained progress bubble.
    await answerLane.stream.flush();
    await answerLane.stream.materialize?.();
    answerLane.stream.forceNewMessage();
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
  const updateDraftFromPartial = (lane: DraftLaneState, text: string | undefined) => {
    const laneStream = lane.stream;
    if (!laneStream || !text) {
      return;
    }
    let previewText = lane === answerLane ? normalizeAnswerPreviewText(text) : text;
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
    // Mark only previews we actually render. A suppressed heading like
    // "example.com:" is just an early final-answer prefix, not progress.
    lane.hasStreamedMessage = true;
    lane.lastPartialText = previewText;
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
      updateDraftFromPartial(lanes[segment.lane], segment.text);
    }
  };
  const flushDraftLane = async (lane: DraftLaneState) => {
    if (!lane.stream) {
      return;
    }
    await lane.stream.flush();
  };
  const updateAnswerProgressFromBlock = (text: string | undefined) => {
    if (!answerLane.stream || !text) {
      return false;
    }
    const progressText = appendAnswerProgressText(text);
    if (!progressText) {
      return false;
    }
    answerLane.hasStreamedMessage = true;
    answerLane.lastPartialText = progressText;
    answerLane.stream.update(progressText);
    return true;
  };
  const canStreamToolProgressDraft = Boolean(answerLane.stream);
  const renderToolProgressDraftText = () => toolProgressLines.join("\n\n");
  const renderTextWithToolProgress = (text: string) => {
    const progressText = renderToolProgressDraftText();
    return normalizeAdjacentProgressBoundaries(progressText ? `${progressText}\n\n${text}` : text);
  };
  const resetToolProgressDraft = () => {
    toolProgressLines = [];
  };
  const pushToolProgressDraft = (line?: string) => {
    if (!canStreamToolProgressDraft) {
      return false;
    }
    const normalized = normalizeToolProgressLine(line);
    if (!normalized) {
      return false;
    }
    if (toolProgressLines.at(-1) === normalized) {
      return true;
    }
    toolProgressLines = [...toolProgressLines, normalized].slice(-TOOL_PROGRESS_MAX_LINES);
    updateAnswerProgressFromBlock(renderToolProgressDraftText());
    return true;
  };
  const pushToolStartProgressDraft = (payload: { name?: string; phase?: string }) => {
    // Raw tool lifecycle labels are product-visible trace noise and should not
    // be streamed into Telegram chats. Keep the status reaction, but suppress
    // the text transport entirely.
    void payload;
    return false;
  };

  const disableBlockStreaming = !previewStreamingEnabled
    ? true
    : forceBlockStreamingForReasoning
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
  const stripInternalToolTraceText = (payload: ReplyPayload): ReplyPayload | undefined => {
    if (!hasInternalToolTraceText(payload.text)) {
      return payload;
    }
    if (!payload.mediaUrl && !(payload.mediaUrls?.length ?? 0)) {
      return undefined;
    }
    return { ...payload, text: undefined };
  };
  const sendPayload = async (payload: ReplyPayload) => {
    const normalizedPayload =
      typeof payload.text === "string"
        ? applyTextToPayload(payload, normalizeAdjacentProgressBoundaries(payload.text))
        : payload;
    const result = await deliverReplies({
      ...deliveryBaseOptions,
      replies: [applyQuoteReplyTarget(normalizedPayload)],
      onVoiceRecording: sendRecordVoice,
    });
    if (result.delivered) {
      deliveryState.markDelivered();
    }
    return result.delivered;
  };
  const sendToolPayload = async (payload: ReplyPayload) => {
    const text = normalizeToolProgressLine(payload.text);
    const sanitizedPayload = stripInternalToolTraceText(payload);
    if (!sanitizedPayload) {
      return;
    }
    if (
      canStreamToolProgressDraft &&
      !sanitizedPayload.mediaUrl &&
      !sanitizedPayload.mediaUrls?.length &&
      pushToolProgressDraft(text)
    ) {
      return;
    }
    // Tool payloads already arrive fully structured, including media URLs from
    // trusted tool results. Deliver them directly so Telegram does not have to
    // infer media from assistant prose after the model paraphrases the tool.
    if (!hasToolPayloadContent(sanitizedPayload)) {
      return;
    }
    await sendPayload(sanitizedPayload);
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
    editPreview: async ({ messageId, text, previewButtons }) => {
      await editMessageTelegram(chatId, messageId, text, {
        api: bot.api,
        cfg,
        accountId: route.accountId,
        linkPreview: telegramCfg.linkPreview,
        buttons: previewButtons,
      });
    },
    deletePreviewMessage: async (messageId) => {
      await bot.api.deleteMessage(chatId, messageId);
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
    if (forceNextAnswerFinalSend) {
      forceNextAnswerFinalSend = false;
      const delivered = await sendPayload(applyTextToPayload(payload, preparedText));
      return delivered ? "sent" : "skipped";
    }
    return deliverLaneText({
      laneName: "answer",
      text: preparedText,
      payload,
      infoKind: "final",
      previewButtons,
    });
  };

  let queuedFinal = false;

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
    ({ queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        ...prefixOptions,
        typingCallbacks,
        deliver: async (payload, info) => {
          try {
            if (info.kind === "final") {
              // Assistant callbacks are fire-and-forget; ensure queued boundary
              // rotations/partials are applied before final delivery mapping.
              await enqueueDraftLaneEvent(async () => {});
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
            if (info.kind === "tool") {
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
            const split = splitTextIntoLaneSegments(payload.text);
            const segments = split.segments;
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

            for (const segment of segments) {
              if (
                segment.lane === "answer" &&
                info.kind === "final" &&
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
              if (segment.lane === "answer" && info.kind !== "final") {
                if (hasMedia || payload.isError) {
                  await sendPayload(payload);
                } else {
                  updateAnswerProgressFromBlock(renderTextWithToolProgress(segment.text));
                }
                continue;
              }
              const result =
                segment.lane === "answer" && info.kind === "final"
                  ? await deliverFinalAnswerText({
                      text: segment.text,
                      payload,
                      previewButtons,
                      hasMedia,
                    })
                  : await deliverLaneText({
                      laneName: segment.lane,
                      text:
                        segment.lane === "answer"
                          ? renderTextWithToolProgress(segment.text)
                          : segment.text,
                      payload,
                      infoKind: info.kind,
                      previewButtons,
                      allowPreviewUpdateForNonFinal: segment.lane === "reasoning",
                    });
              if (segment.lane === "reasoning") {
                if (result !== "skipped") {
                  reasoningStepState.noteReasoningDelivered();
                  await flushBufferedFinalAnswer();
                }
                continue;
              }
              if (info.kind === "final") {
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
                await sendPayload(payloadWithoutSuppressedReasoning);
              }
              if (info.kind === "final") {
                await flushBufferedFinalAnswer();
              }
              return;
            }

            if (info.kind === "final") {
              await answerLane.stream?.stop();
              await reasoningLane.stream?.stop();
              reasoningStepState.resetForNextStep();
            }
            const canSendAsIs =
              hasMedia || (typeof payload.text === "string" && payload.text.length > 0);
            if (!canSendAsIs) {
              if (info.kind === "final") {
                await flushBufferedFinalAnswer();
              }
              return;
            }
            if (
              info.kind !== "final" &&
              typeof payload.text === "string" &&
              !hasMedia &&
              !payload.isError
            ) {
              updateAnswerProgressFromBlock(renderTextWithToolProgress(payload.text));
              return;
            }
            await sendPayload(
              payload.text
                ? applyTextToPayload(
                    payload,
                    info.kind === "final"
                      ? await prepareFinalAnswerText(payload.text, {
                          hasMedia,
                          isError: payload.isError,
                        })
                      : renderTextWithToolProgress(payload.text),
                  )
                : payload,
            );
            if (info.kind === "final") {
              await flushBufferedFinalAnswer();
            }
          } finally {
            if (info.kind === "final") {
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
        },
      },
      replyOptions: {
        skillFilter,
        disableBlockStreaming,
        onToolResult: (payload) =>
          enqueueDraftLaneEvent(async () => {
            await sendToolPayload(payload);
          }),
        onPartialReply:
          answerLane.stream || reasoningLane.stream
            ? (payload) =>
                enqueueDraftLaneEvent(async () => {
                  await ingestDraftLaneSegments(payload.text);
                })
            : undefined,
        onReasoningStream: reasoningLane.stream
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
        onAssistantMessageStart: answerLane.stream
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
        onReasoningEnd: reasoningLane.stream
          ? () =>
              enqueueDraftLaneEvent(async () => {
                // Split when/if a later reasoning block begins.
                splitReasoningOnNextStream = reasoningLane.hasStreamedMessage;
              })
          : undefined,
        onToolStart: statusReactionController
          ? async (payload) => {
              const progressPromise = enqueueDraftLaneEvent(async () => {
                pushToolStartProgressDraft(payload);
              });
              await statusReactionController.setTool(payload.name);
              await progressPromise;
            }
          : canStreamToolProgressDraft
            ? (payload) =>
                enqueueDraftLaneEvent(async () => {
                  pushToolStartProgressDraft(payload);
                })
            : undefined,
        onCompactionStart: statusReactionController
          ? () => statusReactionController.setCompacting()
          : undefined,
        onCompactionEnd: statusReactionController
          ? async () => {
              statusReactionController.cancelPending();
              await statusReactionController.setThinking();
            }
          : undefined,
        onModelSelected,
      },
    }));
  } catch (err) {
    dispatchError = err;
    runtime.error?.(danger(`telegram dispatch failed: ${String(err)}`));
  } finally {
    // Upstream assistant callbacks are fire-and-forget; drain queued lane work
    // before stream cleanup so boundary rotations/materialization complete first.
    await draftLaneEventQueue;
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
        await bot.api.deleteMessage(chatId, archivedPreview.messageId);
      } catch (err) {
        logVerbose(
          `telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(err)}`,
        );
      }
    }
    for (const messageId of archivedReasoningPreviewIds) {
      try {
        await bot.api.deleteMessage(chatId, messageId);
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
    const result = await deliverReplies({
      replies: [{ text: fallbackText }],
      ...deliveryBaseOptions,
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
