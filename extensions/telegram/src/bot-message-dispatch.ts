import type { Bot } from "grammy";
import { resolveAgentDir } from "../../../src/agents/agent-scope.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../../../src/agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../../../src/agents/model-selection.js";
import { resolveChunkMode } from "../../../src/auto-reply/chunk.js";
import { isControlCommandReplyPayload } from "../../../src/auto-reply/reply/control-command-reply.js";
import { isCopySafeDraftReplyPayload } from "../../../src/auto-reply/reply/copy-safe-reply.js";
import { isCaptionlessFinalMediaSupplement } from "../../../src/auto-reply/reply/final-media-supplement.js";
import { clearHistoryEntriesIfEnabled } from "../../../src/auto-reply/reply/history.js";
import {
  cancelProactiveCompactionForIncomingTurn,
  scheduleProactiveCompactionAfterDelivery,
} from "../../../src/auto-reply/reply/proactive-compaction.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../../src/auto-reply/reply/provider-dispatcher.js";
import { promoteQueuedFollowupToSteer } from "../../../src/auto-reply/reply/queue.js";
import {
  clearDurableFollowupTelegramPendingUseNow,
  completeDurableFollowup,
  markDurableFollowupTelegramPendingUseNow,
} from "../../../src/auto-reply/reply/queue/durable-store.js";
import { buildFinalTtsCaptionPreview } from "../../../src/auto-reply/reply/tts-caption-preview.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../../../src/auto-reply/thinking.js";
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
import { markdownToIRWithMeta } from "../../../src/markdown/ir.js";
import { getAgentScopedMediaLocalRoots } from "../../../src/media/local-roots.js";
import {
  formatMonitorReceipt,
  readMonitorReceiptDisclosure,
} from "../../../src/monitor/receipt.js";
import type { RuntimeEnv } from "../../../src/runtime.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramBotOptions } from "./bot.js";
import {
  deliverReplies,
  prepareTelegramReplyForDelivery,
  type TelegramReplyDeliveredEvent,
} from "./bot/delivery.js";
import { resolveTelegramReplyId } from "./bot/helpers.js";
import { buildTelegramThreadParams } from "./bot/helpers.js";
import type { TelegramStreamMode } from "./bot/types.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { guardedTelegramDeleteMessage } from "./delete-guard.js";
import { createTelegramDraftStream, type TelegramDraftStream } from "./draft-stream.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import { markdownToTelegramRichHtml, renderTelegramHtmlText } from "./format.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import {
  type ArchivedPreview,
  createLaneDeliveryStateTracker,
  createLaneTextDeliverer,
  type DraftLaneState,
  type LaneName,
  type LanePreviewLifecycle,
  mergePreviewProgressWithFinal,
  normalizeAdjacentProgressBoundaries,
} from "./lane-delivery.js";
import type { TelegramReplyLatencyTrace } from "./latency-trace.js";
import {
  createTelegramProgressController,
  type TelegramProgressController,
} from "./progress-controller.js";
import {
  buildTelegramDeferredButtons,
  buildTelegramQueuedButtons,
  buildTelegramSteeredButtons,
  scheduleTelegramAutoSteer,
} from "./queue-buttons.js";
import {
  createTelegramReasoningStepState,
  splitTelegramReasoningText,
} from "./reasoning-lane-coordinator.js";
import { getTelegramRichRawApi } from "./rich-message.js";
import { buildInlineKeyboard, editMessageTelegram } from "./send.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { getTelegramSequentialKey, markTelegramSequentialKeyBusy } from "./sequential-key.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

/** Minimum chars before sending first streaming message (improves push notification UX). */
const DRAFT_MIN_INITIAL_CHARS = 12;
/** DMs optimize for time-to-first-visible text; push-notification debounce matters less there. */
const DRAFT_MIN_INITIAL_CHARS_DM_MESSAGE_PREVIEW = 1;
/** Keep fast DM previews responsive after the first send without token-by-token API spam. */
const DRAFT_DM_MESSAGE_PREVIEW_THROTTLE_MS = 250;
const PROGRESS_FINAL_CLEANUP_TIMEOUT_MS = 2_000;
const SILENT_TOOL_PROGRESS_DELAY_MS = 3_000;
const MAX_FULL_TOOL_COMPLETION_EVENTS = 4;
const MAX_FULL_TOOL_COMPLETION_LINES = 8;
const MAX_FULL_TOOL_COMPLETION_CHARS = 600;

function resolveSafeToolStartProgressText(toolName?: string): string {
  const normalized = toolName?.trim().toLowerCase();
  // Tool names are provider-controlled and can accidentally contain arguments,
  // paths, or plugin internals. Reject anything outside the identifier grammar,
  // then expose only reviewed categories rather than echoing the identifier.
  if (!normalized || !/^[a-z0-9_.:/-]{1,80}$/.test(normalized)) {
    return "Still working on it.";
  }
  if (normalized === "codex" || normalized === "codex_threads") {
    return "Waiting for Codex…";
  }
  if (normalized === "exec" || normalized === "bash" || normalized.includes("shell")) {
    return "Using Terminal…";
  }
  if (normalized.startsWith("browser") || normalized.includes("chrome")) {
    return "Using Browser…";
  }
  if (normalized.includes("web_search")) {
    return "Searching the web…";
  }
  if (normalized.includes("web_fetch")) {
    return "Reading a web page…";
  }
  if (normalized.includes("gmail") || normalized.includes("email")) {
    return "Checking email…";
  }
  if (normalized.includes("calendar")) {
    return "Checking the calendar…";
  }
  if (normalized.includes("memory")) {
    return "Checking memory…";
  }
  if (normalized.includes("message") || normalized.includes("telegram")) {
    return "Handling messages…";
  }
  if (
    normalized === "read" ||
    normalized === "write" ||
    normalized === "edit" ||
    normalized === "apply_patch"
  ) {
    return "Working with files…";
  }
  if (normalized === "update_plan") {
    return "Updating the plan…";
  }
  return "Still working on it.";
}

function resolveBoundedFullToolCompletionText(text?: string): string | undefined {
  const trimmed = text?.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!trimmed || trimmed.startsWith("🔧")) {
    // Providers can reuse the result callback for a pre-execution summary.
    // A start summary is not completion output and often includes raw args.
    return undefined;
  }
  const boundedLines = trimmed.split(/\r?\n/).slice(0, MAX_FULL_TOOL_COMPLETION_LINES).join("\n");
  if (boundedLines.length <= MAX_FULL_TOOL_COMPLETION_CHARS) {
    return boundedLines;
  }
  return `${boundedLines.slice(0, MAX_FULL_TOOL_COMPLETION_CHARS - 3).trimEnd()}...`;
}

// Continuation-style agent runs can re-enter Telegram delivery between tool
// turns. A function-local progress controller gets cleared at the end of each
// dispatch and turns every progress update into a durable message. Keep one
// controller per Telegram conversation/session until a final or fallback reply
// explicitly clears it.
const activeTelegramProgressControllers = new Map<string, TelegramProgressController>();

type ProgressCleanupResult = "none" | "completed" | "timed-out" | "failed";
type ProgressRetainResult = "none" | "retained" | "failed";

function normalizeToolProgressLine(text?: string) {
  return text?.replace(/\s+/g, " ").trim();
}

function normalizeAnswerPreviewText(text: string): string {
  // A streaming snapshot can end at the directive prefix before the local
  // path arrives. Remove the entire transport line without re-parsing the
  // answer: the final parser owns media extraction, while preview sanitization
  // must preserve the user's paragraph and list formatting byte-for-byte.
  const previewSafeText = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("MEDIA:"))
    .join("\n");
  return normalizeAdjacentProgressBoundaries(previewSafeText)
    .replace(/\.{3,}/g, "")
    .trimEnd();
}

function isSuppressibleAnswerPreviewPrefix(text: string): boolean {
  const trimmed = normalizeAnswerPreviewText(text).trim();
  if (!trimmed) {
    return false;
  }
  // Codex often emits tiny raw delta prefixes such as "Step" or "Step 2"
  // immediately before a structured commentary block. In DM/message-preview
  // mode those prefixes can allocate a real Telegram message before we know
  // they are progress. Hold them until a fuller sentence or known phase arrives.
  if (/^Step(?:\s+\d+)?$/i.test(trimmed)) {
    return true;
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

function hasCompleteFirstPreviewBoundary(text: string): boolean {
  // The first DM preview is durable user-facing text, so wait for evidence
  // that the provider finished a sentence or paragraph instead of guessing
  // completeness from an arbitrary character count.
  return /(?:[.!?…]["')\]]?|[\r\n]{2,})\s*$/.test(text);
}

function shouldEmitCoalescedDraftPreview(params: {
  previousText: string;
  nextText: string;
  laneName: LaneName;
  fastFirstPreview?: boolean;
  requireCompleteFirstPreview?: boolean;
  nextTextHasCompletionBoundary?: boolean;
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
    if (params.requireCompleteFirstPreview) {
      return params.nextTextHasCompletionBoundary === true;
    }
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

function resolveOpenClawProgressKind(payload: ReplyPayload): string | undefined {
  const openclaw =
    payload.channelData &&
    typeof payload.channelData === "object" &&
    !Array.isArray(payload.channelData)
      ? payload.channelData.openclaw
      : undefined;
  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
    return undefined;
  }
  const progressKind = (openclaw as { progressKind?: unknown }).progressKind;
  return typeof progressKind === "string" ? progressKind : undefined;
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

function resolveTelegramVisibilityLevel(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId: string;
  isGroup: boolean;
}): VerboseLevel {
  const { cfg, sessionKey, agentId, isGroup } = params;
  if (sessionKey) {
    try {
      const storePath = resolveStorePath(cfg.session?.store, { agentId });
      const store = loadSessionStore(storePath, { skipCache: true });
      const entry = resolveSessionStoreEntry({ store, sessionKey }).existing;
      const explicitLevel = normalizeVerboseLevel(entry?.verboseLevel);
      if (explicitLevel) {
        return explicitLevel;
      }
    } catch {
      // A missing or unreadable session must never increase visible detail.
    }
  }
  if (isGroup) {
    // Group participants can differ from the owner who selected global defaults.
    // Require an explicit group/topic session opt-in before exposing work detail.
    return "off";
  }
  return normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault) ?? "off";
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
  // User work always outranks idle maintenance. Abort before entering the agent
  // runner so a background compaction cannot hold the per-session lane first.
  const interruptedProactiveCompaction = sessionId
    ? cancelProactiveCompactionForIncomingTurn(sessionId)
    : "none";
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
    supportsBlockTables: true,
  });
  const isEligibleRichTableFinalText = (payload: ReplyPayload, text: string) => {
    const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
    const hasTelegramButtons = Boolean(
      (payload.channelData?.telegram as { buttons?: unknown } | undefined)?.buttons,
    );
    if (
      tableMode !== "block" ||
      telegramCfg.richMessages === false ||
      !getTelegramRichRawApi(bot.api) ||
      hasMedia ||
      hasTelegramButtons ||
      payload.interactive ||
      payload.isError ||
      isControlCommandReplyPayload(payload) ||
      isCopySafeDraftReplyPayload(payload)
    ) {
      return false;
    }
    const parsed = markdownToIRWithMeta(text, { tableMode });
    if (!parsed.hasTables) {
      return false;
    }
    // A mixed answer can contain both comparison tables and recipient-ready
    // quoted drafts. Check the post-rewrite rich HTML so a table outside the
    // quote stays native, while a table wholly inside a copy-safe draft does
    // not opt into rich transport after it has become a pre block.
    return markdownToTelegramRichHtml(text, {
      tableMode,
      copySafeBlockquotes: true,
    }).includes("<table");
  };
  const renderDraftPreview = (text: string) => ({
    text: renderTelegramHtmlText(text, { tableMode, copySafeBlockquotes: true }),
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
  const readVisibilityLevel = () =>
    resolveTelegramVisibilityLevel({
      cfg,
      sessionKey: ctxPayload.SessionKey,
      agentId: route.agentId,
      isGroup,
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
  const inlineButtonsScope = resolveTelegramInlineButtonsScope({
    cfg,
    accountId: route.accountId,
  });
  const canShowQueueButtons =
    inlineButtonsScope === "all" ||
    inlineButtonsScope === "allowlist" ||
    (inlineButtonsScope === "dm" && !isGroup) ||
    (inlineButtonsScope === "group" && isGroup);
  const archivedAnswerPreviews: ArchivedPreview[] = [];
  const archivedReasoningPreviewIds: number[] = [];
  let partialCallbackCount = 0;
  let firstPartialTextLength: number | undefined;
  let firstDmAnswerPreviewDelivered = false;
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
        if (laneName === "answer" && useMessagePreviewTransportForDm) {
          firstDmAnswerPreviewDelivered = true;
        }
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
  // The generic block/TTS pipeline needs the exact text Telegram accepted as
  // final after removing retained progress. Keep that channel-authoritative
  // value separate from the resolver's accumulated block transcript.
  let lastPreparedFinalAnswerText = "";
  const transientProgressPreviewTexts: string[] = [];
  const transientProgressPreviewKeys = new Set<string>();
  let draftLaneEventQueue = Promise.resolve();
  let processingDraftLaneEvent = false;
  let progressController: TelegramProgressController | undefined;
  const workLogToolNames: string[] = [];
  let fullToolCompletionEvents = 0;
  let silentToolProgressTimer: ReturnType<typeof setTimeout> | undefined;
  let silentToolProgressGeneration = 0;
  let silentToolFallbackRendered = false;
  let sawExplicitProgress = false;
  let finalPhaseStarted = false;
  const cancelSilentToolProgressFallback = () => {
    // Incrementing the generation also invalidates a callback that already left
    // the timer queue but has not yet entered the serialized draft-lane queue.
    silentToolProgressGeneration += 1;
    if (silentToolProgressTimer) {
      clearTimeout(silentToolProgressTimer);
      silentToolProgressTimer = undefined;
    }
  };
  const noteExplicitProgress = () => {
    sawExplicitProgress = true;
    cancelSilentToolProgressFallback();
  };
  const noteFinalPhaseStarted = () => {
    finalPhaseStarted = true;
    cancelSilentToolProgressFallback();
  };
  // Structured plan checklists own only explicit plan updates; later assistant
  // partials are answer candidates and must not be folded back into the plan.
  let activeProgressKind: "generic" | "plan" | undefined;
  let sawAssistantPartial = false;
  // Once a tool boundary proves the assistant is narrating work, later
  // phase-less assistant partials should keep editing that same progress
  // bubble. Without this, every natural "Browser is up..." style update starts
  // a fresh answer preview that can survive as a stale Telegram message.
  let routeToolStatusPartialsToProgress = false;
  // A structured plan makes the next phase-less answer delta ambiguous: it can
  // be either natural commentary that will shortly arrive as an explicitly
  // phased block, or the prefix of the final answer. Do not allocate a Telegram
  // answer message until a structural callback resolves that ambiguity.
  let pendingAnswerPartialDuringPlan: string | undefined;
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
  const noteWorkLogToolName = (name: string | undefined) => {
    const normalized = name?.trim();
    if (!normalized || workLogToolNames.includes(normalized)) {
      return false;
    }
    workLogToolNames.push(normalized);
    return true;
  };
  const clearProgressController = async (
    callsite: string,
    options?: { timeoutMs?: number; flushBeforeDelete?: boolean; waitForInFlight?: boolean },
  ) => {
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
    const cleanupPromise = controller.clear({
      flushBeforeDelete: options?.flushBeforeDelete,
      waitForInFlight: options?.waitForInFlight,
    });
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
      activeProgressKind = undefined;
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
  const retainProgressControllerAsWorkLog = async (
    callsite: string,
  ): Promise<ProgressRetainResult> => {
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
    let retainResult: ProgressRetainResult = "retained";
    try {
      const retained = await controller.retainAsWorkLog({ toolNames: workLogToolNames });
      if (!retained.retained) {
        retainResult = "none";
      }
    } catch (err) {
      retainResult = "failed";
      logVerbose(`telegram: progress work log retain failed callsite=${callsite}: ${String(err)}`);
    } finally {
      if (activeTelegramProgressControllers.get(progressControllerKey) === controller) {
        activeTelegramProgressControllers.delete(progressControllerKey);
      }
      if (progressController === controller) {
        progressController = undefined;
      }
      activeProgressKind = undefined;
    }
    logPreviewLedger({
      lane: "progress",
      phase: "progress_clear_completed",
      source: "cleanup",
      messageId: controller.messageId(),
      result: retainResult,
      callsite,
    });
    return retainResult;
  };
  const beginFinalAnswerPhase = async (callsite: string): Promise<ProgressRetainResult> => {
    // Final-answer text is user-visible output, not progress. Freeze any active
    // progress bubble first so the first final delta cannot briefly edit the
    // soon-to-be-retained Work Log message.
    noteFinalPhaseStarted();
    routeToolStatusPartialsToProgress = false;
    const retainResult = await retainProgressControllerAsWorkLog(callsite);
    if (retainResult === "retained") {
      // Once progress has become the Work Log, the paired final must be a
      // separate durable send. Reusing the generic preview-finalization path
      // can leave Telegram with a blank answer bubble while TTS speaks the
      // real text.
      forceNextAnswerFinalSend = true;
    }
    return retainResult;
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
    lastPreparedFinalAnswerText = prepared.text;
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
    if (lane === answerLane && activeProgressKind === "plan" && getActiveProgressController()) {
      pendingAnswerPartialDuringPlan = previewText;
      logVerbose(
        `telegram: buffered phase-unknown answer partial while plan progress is active length=${previewText.length}`,
      );
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
      // final-looking answer starts streaming, retain progress before opening
      // the durable answer lane so Telegram never shows final text inside the
      // soon-to-be-retained Work Log message.
      routeToolStatusPartialsToProgress = false;
      await retainProgressControllerAsWorkLog("before-answer-partial");
    }
    if (
      lane === answerLane &&
      routeToolStatusPartialsToProgress &&
      activeProgressKind !== "plan" &&
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
        // Only the first visible DM answer must wait for a complete boundary.
        // Once it lands, later edits and the separate final lane keep the
        // existing low-latency streaming behavior.
        requireCompleteFirstPreview:
          lane === answerLane && useMessagePreviewTransportForDm && !firstDmAnswerPreviewDelivered,
        fastFirstPreview:
          lane === answerLane && useMessagePreviewTransportForDm && firstDmAnswerPreviewDelivered,
        // Completion must be evaluated after transport directives are removed.
        // Otherwise a final sentence followed by `MEDIA:/path` looks incomplete
        // and never reaches the preview even though the visible text is ready.
        nextTextHasCompletionBoundary: hasCompleteFirstPreviewBoundary(previewText),
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
  const discardTransientAnswerPreviewBeforeForcedFinal = async (callsite: string) => {
    if (!answerLane.stream || !answerLane.hasStreamedMessage) {
      return;
    }
    try {
      // This preview is transient, either after retained progress or before a
      // table final. Remove it before the durable send so the user never sees
      // a stale legacy bubble beside the native table.
      await answerLane.stream.clear({ waitForInFlight: true });
    } catch (err) {
      logVerbose(
        `telegram: answer preview cleanup before forced final failed callsite=${callsite}: ${String(err)}`,
      );
    } finally {
      answerLane.stream = undefined;
      resetDraftLaneState(answerLane);
      activePreviewLifecycleByLane.answer = "transient";
      retainPreviewOnCleanupByLane.answer = false;
    }
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
    // The answer draft already rendered the natural acknowledgment before it
    // was adopted. Seed the controller's ordered history with that visible
    // text so the subsequent plan update edits this same message into a Work
    // log containing the acknowledgment instead of overwriting it.
    // The transport can deliver a speculative first delta (for example just
    // "I") before the lane receives the complete acknowledgment snapshot.
    // Work log history must use the newest logical snapshot, not that older
    // transport artifact, or both fragments become permanent ordered entries.
    const adoptedText = answerLane.lastPartialText.trim();
    if (adoptedText) {
      controller.update(adoptedText);
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
  const flushBufferedFirstDmAnswerPreviewAtProgressBoundary = async () => {
    if (
      !useMessagePreviewTransportForDm ||
      firstDmAnswerPreviewDelivered ||
      answerLane.hasStreamedMessage ||
      !answerLane.lastPartialText.trim()
    ) {
      return;
    }
    // A tool/progress boundary proves the preceding assistant snapshot is
    // complete even when the model omitted punctuation. Materialize that
    // buffered acknowledgment before adopting it into the Work log.
    const stream = answerLane.stream ?? ensureDraftLaneStream("answer");
    if (!stream) {
      return;
    }
    setDraftDurableSendClassification("answer", {
      reason: "progress",
      callsite: "answer-preview-progress-boundary-fallback",
      sourceKind: "partial",
    });
    answerLane.hasStreamedMessage = true;
    stream.update(answerLane.lastPartialText);
    await stream.flush();
  };
  const updateAnswerProgressFromBlock = async (
    text: string | undefined,
    options: {
      progressKind?: "generic" | "plan";
      naturalCommentary?: boolean;
      silentToolFallback?: boolean;
    } = {},
  ) => {
    if (!text) {
      return false;
    }
    const progressText = normalizeAdjacentProgressBoundaries(text).trim();
    if (!progressText) {
      return false;
    }
    if (options.silentToolFallback !== true) {
      // Any provider-authored commentary wins over the delayed generic receipt.
      // Cancel before awaiting lane work so both cannot flash in succession.
      noteExplicitProgress();
    }
    // Assistant partial callbacks are queued to preserve stream order. A later
    // structural progress boundary must wait for them before it decides whether
    // there is an existing visible answer bubble to adopt.
    await waitForDraftLaneIdle();
    // This explicit progress/commentary boundary classifies any raw partial
    // immediately before it as progress. If the first acknowledgment lacked
    // punctuation, materialize it now; then drop the candidate after the queue
    // is idle so fire-and-forget callbacks cannot repopulate it behind the
    // boundary.
    await flushBufferedFirstDmAnswerPreviewAtProgressBoundary();
    pendingAnswerPartialDuringPlan = undefined;
    const controller =
      (await adoptSpeculativeAnswerPreviewAsProgress("before-progress-update")) ??
      getProgressController();
    if (!controller) {
      return false;
    }
    if (options.progressKind === "plan") {
      activeProgressKind = "plan";
    } else if (!activeProgressKind) {
      activeProgressKind = "generic";
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
    if (options.progressKind === "plan") {
      controller.updatePlan(progressText);
    } else {
      controller.update(progressText);
    }
    if (options.progressKind === "plan" || options.naturalCommentary === true) {
      // Providers may report the next assistant-message boundary after the
      // first final delta. The answer lane is currently empty because all
      // pre-final commentary belongs to Work log, so consume that delayed
      // boundary instead of rotating the new final preview onto another ID.
      skipNextAnswerMessageStartRotation = true;
    }
    return true;
  };
  const scheduleSilentToolProgressFallback = (toolName?: string) => {
    if (
      readVisibilityLevel() === "off" ||
      sawExplicitProgress ||
      answerLane.hasStreamedMessage ||
      finalPhaseStarted ||
      silentToolFallbackRendered ||
      silentToolProgressTimer
    ) {
      return;
    }
    const generation = ++silentToolProgressGeneration;
    const progressText = resolveSafeToolStartProgressText(toolName);
    silentToolProgressTimer = setTimeout(() => {
      silentToolProgressTimer = undefined;
      // Timer callbacks join the same serialized lane as provider callbacks,
      // then re-check both lifecycle cancellation and the current session mode.
      void enqueueDraftLaneEvent(async () => {
        if (
          generation !== silentToolProgressGeneration ||
          readVisibilityLevel() === "off" ||
          sawExplicitProgress ||
          answerLane.hasStreamedMessage ||
          finalPhaseStarted ||
          silentToolFallbackRendered
        ) {
          return;
        }
        const rendered = await updateAnswerProgressFromBlock(progressText, {
          silentToolFallback: true,
        });
        silentToolFallbackRendered = rendered;
      });
    }, SILENT_TOOL_PROGRESS_DELAY_MS);
  };
  if (interruptedProactiveCompaction === "running") {
    await updateAnswerProgressFromBlock("Pausing conversation cleanup for your message…");
  }
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
  // General delivery state includes progress, tools, and media. Recovery state
  // may be cleared only after the terminal answer itself reaches Telegram.
  let terminalDeliveryConfirmed = false;
  let terminalDeliveryAttempted = false;
  let intentionalSilentTerminal = false;
  let sawSilentNonFinalSkip = false;
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
  const deliveredFinalTextKeys = new Set<string>();
  const sendPayload = async (
    payload: ReplyPayload,
    classification?: {
      reason?: TelegramDurableSendReason;
      callsite?: string;
      laneName?: LaneName;
      infoKind?: string;
      forceLegacyTextTransport?: boolean;
      messageSendingHookApplied?: boolean;
    },
  ) => {
    let normalizedPayload =
      typeof payload.text === "string"
        ? applyTextToPayload(payload, normalizeAdjacentProgressBoundaries(payload.text))
        : payload;
    const hasMedia =
      Boolean(normalizedPayload.mediaUrl) || (normalizedPayload.mediaUrls?.length ?? 0) > 0;
    const sourceDurableReason =
      classification?.reason ??
      classifyPayloadDurableSendReason(normalizedPayload, classification?.infoKind);
    const sourceFinalTextKey =
      sourceDurableReason === "final" && !hasMedia && typeof normalizedPayload.text === "string"
        ? normalizedPayload.text.trim()
        : undefined;
    if (sourceFinalTextKey && deliveredFinalTextKeys.has(sourceFinalTextKey)) {
      // Deduplicate the provider's logical final before invoking a modifying
      // hook. Stateful message_sending hooks must run once for one visible
      // final, even when a provider replays that final through two callbacks.
      logVerbose(
        `telegram: skipped duplicate source final text callsite=${classification?.callsite ?? "dispatch-send-payload"}`,
      );
      return true;
    }
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
    if (!classification?.messageSendingHookApplied) {
      const prepared = await prepareTelegramReplyForDelivery({
        reply: normalizedPayload,
        chatId: String(chatId),
        accountId: route.accountId,
        thread: threadSpec,
      });
      if (prepared.cancelled) {
        return false;
      }
      normalizedPayload = prepared.reply;
    }
    const durableReason =
      classification?.reason ??
      classifyPayloadDurableSendReason(normalizedPayload, classification?.infoKind);
    const finalTextKey =
      durableReason === "final" && !hasMedia && typeof normalizedPayload.text === "string"
        ? normalizedPayload.text.trim()
        : undefined;
    if (finalTextKey && deliveredFinalTextKeys.has(finalTextKey)) {
      // High-route providers can emit an explicitly phased final-answer block
      // and then return the same final payload through the generic dispatcher.
      // One visible final is the product contract; a second identical send is
      // just duplicate noise in Telegram and TTS ordering proof.
      logVerbose(
        `telegram: skipped duplicate final text send callsite=${classification?.callsite ?? "dispatch-send-payload"}`,
      );
      return true;
    }
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
    const isEligibleRichTableFinal =
      durableReason === "final" &&
      typeof normalizedPayload.text === "string" &&
      classification?.forceLegacyTextTransport !== true &&
      isEligibleRichTableFinalText(normalizedPayload, normalizedPayload.text);
    const shouldUseLegacyTextTransport =
      classification?.forceLegacyTextTransport === true ||
      // Keep ordinary finals on legacy HTML after rich delivery produced blank
      // Telegram bubbles. Valid unfenced tables alone opt into the guarded rich path.
      (durableReason === "final" && !hasMedia && !isEligibleRichTableFinal) ||
      isControlCommandReplyPayload(normalizedPayload) ||
      isCopySafeDraftReplyPayload(normalizedPayload);
    const shouldUseCopySafeBlockquotes =
      !hasMedia && (isCopySafeDraftReplyPayload(normalizedPayload) || durableReason === "final");
    const result = await deliverReplies({
      ...deliveryBaseOptions,
      // sendPayload prepared message_sending above so table eligibility and
      // actual delivery observe one rewritten reply, never two hook passes.
      skipMessageSendingHooks: true,
      ...(shouldUseLegacyTextTransport ? { richMessages: false } : {}),
      // Final-answer blockquotes are commonly used for draft messages the user
      // wants to copy into another chat. Render those quote bodies as Telegram
      // code/pre blocks so links stay literal and one-tap copy works.
      ...(shouldUseCopySafeBlockquotes ? { copySafeBlockquotes: true } : {}),
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
      if (sourceFinalTextKey) {
        // Keep both sides of a hook rewrite. The source key suppresses provider
        // replay before another hook pass; the delivered key suppresses a
        // different source payload that rewrites to the same visible final.
        deliveredFinalTextKeys.add(sourceFinalTextKey);
      }
      if (finalTextKey) {
        deliveredFinalTextKeys.add(finalTextKey);
      }
      deliveryState.markDelivered();
    }
    return result.delivered;
  };
  const sendToolMediaAfterProgress = async (
    payload: ReplyPayload,
    classification: {
      reason?: TelegramDurableSendReason;
      callsite?: string;
      laneName?: LaneName;
      infoKind?: string;
      forceLegacyTextTransport?: boolean;
    },
  ) => {
    // Browser screenshots are durable Telegram messages, so they land after
    // the mutable progress bubble. Freeze that progress segment first; later
    // commentary then opens a fresh bubble below the screenshot instead of
    // silently editing an older, off-screen message.
    await retainProgressControllerAsWorkLog(
      `${classification.callsite ?? "tool-media"}-before-envelope`,
    );
    return await sendPayload(payload, classification);
  };
  const sendToolPayload = async (payload: ReplyPayload) => {
    const monitorReceiptDisclosure = readMonitorReceiptDisclosure(payload.channelData);
    if (monitorReceiptDisclosure) {
      // monitor.create supplies a trusted normalized disclosure marker. Render
      // that contract here so the receipt cannot drift with model prose.
      await sendPayload(
        { text: formatMonitorReceipt(monitorReceiptDisclosure) },
        {
          reason: "tool",
          callsite: "dispatch-monitor-receipt",
          infoKind: "tool",
          forceLegacyTextTransport: true,
        },
      );
      return;
    }
    if (isTextOnlyOpenClawSourcePreview(payload)) {
      // Same-chat message-tool progress is model-authored working state. Render
      // it through the mutable progress controller so it never becomes durable
      // Telegram text and never reaches TTS as a tool result.
      const progressKind = resolveOpenClawProgressKind(payload) === "plan" ? "plan" : "generic";
      await updateAnswerProgressFromBlock(payload.text, {
        progressKind,
      });
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
      if (
        readVisibilityLevel() === "full" &&
        fullToolCompletionEvents < MAX_FULL_TOOL_COMPLETION_EVENTS
      ) {
        // Full mode is intentionally bounded per turn as well as per payload.
        // This keeps the evolving Work Log useful without turning raw tool
        // output into an unbounded second transcript.
        const completionText = resolveBoundedFullToolCompletionText(payload.text);
        if (completionText) {
          fullToolCompletionEvents += 1;
          await updateAnswerProgressFromBlock(completionText);
        }
      }
      return;
    }
    await sendPayload(sanitizedPayload, {
      reason: classifyPayloadDurableSendReason(sanitizedPayload, "tool"),
      callsite: "dispatch-tool-payload",
      infoKind: "tool",
    });
  };
  const deleteLanePreviewMessage = async (
    messageId: number,
    {
      laneName = "answer",
      callsite = "lane-delivery-delete-preview",
      reason = "lane_delivery_preview_cleanup",
    }: {
      laneName?: LaneName;
      callsite?: string;
      reason?: string;
    } = {},
  ) => {
    logPreviewLedger({
      lane: laneName,
      phase: "preview_delete_attempt",
      source: "cleanup",
      messageId,
      operation: "delete",
      callsite,
    });
    const result = await guardedTelegramDeleteMessage({
      api: bot.api,
      chatId,
      messageId,
      audit: {
        callsite: "telegram-lane-preview-delete",
        reason,
        safetyMode: "deterministic_cleanup",
        accountId: route.accountId,
        lane: laneName,
        classification: "preview",
        sessionId:
          typeof context.ctxPayload?.SessionKey === "string"
            ? context.ctxPayload.SessionKey
            : undefined,
        topicId: threadSpec?.id,
        thread: threadSpec,
      },
    });
    if (result.deleted) {
      logPreviewLedger({
        lane: laneName,
        phase: "preview_delete_completed",
        source: "cleanup",
        messageId,
        operation: "delete",
        callsite,
      });
    }
    return result;
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
        // Preview edits mutate an already-visible bubble. Telegram can accept
        // native rich-message edit payloads and still render a blank client
        // bubble, while the Bot API response looks successful. Keep this path
        // on legacy HTML; durable final sends are guarded separately.
        richMessages: false,
        tableMode,
        // The preview renderer already exposes recipient drafts as copyable
        // code blocks. Preserve that contract on the final in-place edit
        // instead of downgrading the same bubble back to a blockquote.
        copySafeBlockquotes: true,
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
      await deleteLanePreviewMessage(messageId);
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
    // Final partial callbacks are queued independently from durable payloads.
    // Drain them before any state-dependent preparation reads or mutates the
    // answer lane, otherwise finalization can allocate the wrong preview.
    await waitForDraftLaneIdle();
    const pendingPlanPartial = pendingAnswerPartialDuringPlan;
    pendingAnswerPartialDuringPlan = undefined;
    if (pendingPlanPartial) {
      const normalizedPendingPartial =
        normalizeAdjacentProgressBoundaries(pendingPlanPartial).trim();
      const normalizedFinalText = normalizeAdjacentProgressBoundaries(text).trim();
      if (normalizedPendingPartial && normalizedFinalText.startsWith(normalizedPendingPartial)) {
        // The final boundary proves the buffered raw snapshot was an answer
        // prefix. Materialize it only now, then finalize that same Telegram ID
        // below. This preserves streaming identity without ever exposing a
        // speculative commentary bubble that later needs deletion.
        const stream = ensureDraftLaneStream("answer");
        if (stream) {
          setDraftDurableSendClassification("answer", {
            reason: "final",
            callsite: "plan-buffered-answer-partial-materialize",
            sourceKind: "partial",
          });
          answerLane.lastPartialText = pendingPlanPartial;
          answerLane.hasStreamedMessage = true;
          stream.update(pendingPlanPartial);
          await stream.flush();
        }
      } else {
        logVerbose(
          "telegram: discarded buffered plan-adjacent partial that was not a final prefix",
        );
      }
    }
    let preparedText = await prepareFinalAnswerText(text, {
      hasMedia,
      isError: payload.isError,
    });
    let normalizedPreparedText = normalizeAdjacentProgressBoundaries(preparedText).trim();
    if (
      !normalizedPreparedText &&
      payload.isError === true &&
      resolveOpenClawAssistantPhase(payload) === "final_answer"
    ) {
      // Progress cleanup normally removes replayed commentary from a final. A
      // provider-error fallback can legitimately promote that exact text with
      // an explicit final marker, leaving nothing after the cleanup. Preserve
      // the trusted terminal payload instead of completing with no text.
      preparedText = normalizeAdjacentProgressBoundaries(text).trim();
      normalizedPreparedText = preparedText;
    }
    if (!normalizedPreparedText) {
      return "skipped";
    }
    if (deliveredFinalTextKeys.has(normalizedPreparedText)) {
      // The phased final path prepares its hook before sendPayload. Suppress a
      // provider replay here so one logical final cannot invoke that hook twice.
      logVerbose("telegram: skipped duplicate final before final-answer preparation");
      return "skipped";
    }
    const activeProgressController = getActiveProgressController();
    const activeProgressText = normalizeAdjacentProgressBoundaries(
      activeProgressController?.lastText() ?? "",
    ).trim();
    if (
      (resolveOpenClawAssistantPhase(payload) !== "final_answer" || payload.isError !== true) &&
      activeProgressController &&
      (transientProgressPreviewTexts.includes(normalizedPreparedText) ||
        normalizedPreparedText === activeProgressText) &&
      !isLikelyFinalAnswerPreviewAfterProgress(normalizedPreparedText)
    ) {
      // The high-route dispatcher can replay the latest progress/commentary
      // block as an unmarked synthetic final when an agent turn pauses for
      // continuation. Treat only that legacy shape as a progress echo. An
      // explicit final_answer marker is authoritative even when an error
      // fallback repeats the last visible block verbatim.
      logVerbose("telegram: skipped final echo that matched transient progress");
      return "skipped";
    }
    // Give the hook the exact merged text that preview editing or fallback
    // delivery will expose.
    const mergedPreparedText = mergePreviewProgressWithFinal(
      answerLane.lastPartialText,
      preparedText,
    );
    const preparedFinal = await prepareTelegramReplyForDelivery({
      reply: applyTextToPayload(payload, mergedPreparedText),
      chatId: String(chatId),
      accountId: route.accountId,
      thread: threadSpec,
    });
    if (preparedFinal.cancelled) {
      return "skipped";
    }
    const finalPayload = preparedFinal.reply;
    const finalText = finalPayload.text;
    if (!finalText?.trim()) {
      return "skipped";
    }
    // Enter the final phase only after the hook has accepted the exact visible
    // payload. No post-hook text merge is allowed beyond idempotent normalization.
    await beginFinalAnswerPhase("before-final-answer");
    setDraftDurableSendClassification("answer", {
      reason: classifyPayloadDurableSendReason(finalPayload, "final"),
      callsite: "answer-final-preview",
      sourceKind: "final",
    });
    let result: "sent" | "skipped" | "preview-finalized" | "preview-retained" | "preview-updated";
    if (isEligibleRichTableFinalText(finalPayload, finalText)) {
      // Native table blocks need a fresh durable rich send. A legacy edit
      // downgrades the table, while rich preview edits retain blank-bubble
      // history; prose and copy-safe drafts keep same-message legacy finish.
      forceNextAnswerFinalSend = false;
      const previewStream = answerLane.stream;
      const hasVisibleAnswerPreview =
        answerLane.hasStreamedMessage &&
        (typeof previewStream?.messageId() === "number" ||
          previewStream?.sendMayHaveLanded?.() === true);
      if (hasVisibleAnswerPreview) {
        // Keep the visible legacy preview as the failure fallback. Rich send
        // rejection is ambiguous, so only a confirmed durable send may remove it.
        retainPreviewOnCleanupByLane.answer = true;
      }
      let delivered: boolean;
      try {
        delivered = await sendPayload(finalPayload, {
          reason: "final",
          callsite: "answer-final-rich-table-send",
          laneName: "answer",
          infoKind: "final",
          messageSendingHookApplied: true,
        });
      } catch (error) {
        // Preserve the fallback even if queued lifecycle work reset the flag
        // while the rich request was in flight. Do not retry an ambiguous send.
        if (hasVisibleAnswerPreview) {
          retainPreviewOnCleanupByLane.answer = true;
        }
        throw error;
      }
      if (delivered && hasVisibleAnswerPreview) {
        await discardTransientAnswerPreviewBeforeForcedFinal("answer-final-rich-table-send");
      } else if (hasVisibleAnswerPreview) {
        // A false return is an unconfirmed final. Leave the preview visible.
        retainPreviewOnCleanupByLane.answer = true;
      }
      result = delivered ? "sent" : "skipped";
    } else {
      // Work Log retention requires a separate final bubble, but an already-streamed
      // answer preview is already that separate bubble. Force a new send only when
      // there is no visible answer identity available to finalize in place.
      const shouldForceFreshFinalSend = forceNextAnswerFinalSend && !answerLane.hasStreamedMessage;
      if (shouldForceFreshFinalSend) {
        forceNextAnswerFinalSend = false;
        await discardTransientAnswerPreviewBeforeForcedFinal("answer-final-forced-send");
        const delivered = await sendPayload(finalPayload, {
          reason: classifyPayloadDurableSendReason(finalPayload, "final"),
          callsite: "answer-final-forced-send",
          laneName: "answer",
          infoKind: "final",
          messageSendingHookApplied: true,
        });
        result = delivered ? "sent" : "skipped";
      } else {
        forceNextAnswerFinalSend = false;
        // Preserve the visible Telegram message across finalization. Clearing it
        // here would make the answer disappear before the replacement send lands.
        result = await deliverLaneText({
          laneName: "answer",
          text: finalText,
          payload: finalPayload,
          infoKind: "final",
          previewButtons,
          messageSendingHookApplied: true,
          finalTextAlreadyMerged: true,
        });
      }
    }
    if (result === "sent" || result === "preview-finalized") {
      terminalDeliveryConfirmed = true;
    }
    if (result !== "skipped") {
      // Record the provider's pre-hook text as well as sendPayload's delivered
      // text. A replay must be suppressed before another message_sending pass.
      deliveredFinalTextKeys.add(normalizedPreparedText);
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
    await beginFinalAnswerPhase(`${classification.callsite ?? "final"}-before-final`);
    const delivered = await sendPayload(payload, classification);
    if (delivered) {
      if (!isFinalTtsSupplementPayload(payload) && !isCaptionlessFinalMediaSupplement(payload)) {
        terminalDeliveryConfirmed = true;
      }
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
    const progressText = renderTextWithToolProgress(pending.text);
    await updateAnswerProgressFromBlock(progressText, {
      naturalCommentary: true,
    });
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
  let durableDirectTurnId: string | undefined;
  let releaseBusySequentialKey: (() => void) | undefined;
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
            return lastPreparedFinalAnswerText || undefined;
          }
          await flushAmbiguousAnswerBlockAsFinal("after-block-stream-final");
          return lastPreparedFinalAnswerText || undefined;
        },
        deliver: async (payload, info) => {
          try {
            const assistantPhase = resolveOpenClawAssistantPhase(payload);
            const deliveryKind =
              info.kind === "block" && assistantPhase === "final_answer" ? "final" : info.kind;
            const hasPayloadMedia =
              Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
            const isTtsMediaFinalBoundary =
              deliveryKind === "final" &&
              hasPayloadMedia &&
              payload.audioAsVoice === true &&
              isFinalTtsSupplementPayload(payload);
            if (deliveryKind === "final") {
              // Cancel before draining queued partial work so a due fallback
              // cannot flash immediately before the durable final answer.
              noteFinalPhaseStarted();
              terminalDeliveryAttempted = true;
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
              // The local prompt is intentionally replaced by the canonical
              // approval surface, so no Telegram final is expected here.
              intentionalSilentTerminal = true;
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

            if (
              deliveryKind === "final" &&
              hasMedia &&
              isCaptionlessFinalMediaSupplement(payload)
            ) {
              // The final answer already owns the streamed text message. Bypass
              // lane text merging entirely so its accumulated preview cannot be
              // resurrected as this document's caption.
              await sendFinalPayloadThenCleanupProgress(
                { ...payload, text: undefined },
                {
                  reason: "media",
                  callsite: "dispatch-final-captionless-media-supplement",
                  infoKind: deliveryKind,
                },
              );
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
                  const progressText = renderTextWithToolProgress(segment.text);
                  await updateAnswerProgressFromBlock(progressText, {
                    naturalCommentary: assistantPhase === "commentary",
                  });
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
                const progressText = renderTextWithToolProgress(payload.text);
                await updateAnswerProgressFromBlock(progressText, {
                  naturalCommentary: assistantPhase === "commentary",
                });
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
            } else if (deliveryKind === "tool" && hasMedia) {
              await sendToolMediaAfterProgress(payloadToSend, classification);
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
          if (info.reason === "silent") {
            if (info.kind === "final") {
              intentionalSilentTerminal = true;
            } else if (info.kind === "block") {
              // A block-level NO_REPLY may still precede a failing final.
              // Promote it only after the whole dispatcher settles cleanly.
              sawSilentNonFinalSkip = true;
            }
            return;
          }
          deliveryState.markNonSilentSkip();
        },
        onError: (err, info) => {
          cancelSilentToolProgressFallback();
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
        onAgentRunStart: () => {
          // grammY normally serializes a whole Telegram conversation until
          // this dispatch returns. Once real model work starts, temporarily
          // admit plain follow-ups and Queue/Steer callbacks on unique keys so
          // they can reach the durable queue instead of waiting invisibly.
          releaseBusySequentialKey ??= markTelegramSequentialKeyBusy(
            getTelegramSequentialKey({ message: msg }),
          );
        },
        onTypingCleanup: () => {
          releaseBusySequentialKey?.();
          releaseBusySequentialKey = undefined;
        },
        onToolResult: (payload) => {
          return enqueueDraftLaneEvent(async () => {
            await flushAmbiguousAnswerBlockAsProgress("before-tool-result");
            await sendToolPayload(payload);
            if (getActiveProgressController() && activeProgressKind !== "plan") {
              routeToolStatusPartialsToProgress = true;
            }
          });
        },
        onPartialReply:
          canStreamAnswerDraft || canStreamReasoningDraft
            ? (payload) =>
                enqueueDraftLaneEvent(async () => {
                  sawAssistantPartial = true;
                  if (resolveOpenClawAssistantPhase(payload) === "final_answer") {
                    // Freeze the Work Log before opening the answer lane, then
                    // stream this structurally final snapshot immediately. The
                    // later final/block payload edits the same answer identity;
                    // it no longer needs to materialize the whole buffered text.
                    await beginFinalAnswerPhase("before-final-answer-partial");
                  }
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
          const firstStartForTool = noteWorkLogToolName(payload.name);
          await flushAmbiguousAnswerBlockAsProgress("before-tool-start");
          // Join the shared draft-lane queue before writing progress so a tool
          // boundary cannot overtake the assistant acknowledgment immediately
          // before it. Duplicate start/update events stay one Work Log entry.
          await waitForDraftLaneIdle();
          if (firstStartForTool && silentToolFallbackRendered && readVisibilityLevel() !== "off") {
            // Once the first delayed receipt is visible, later distinct tools
            // can evolve that same Work Log without another debounce window.
            await updateAnswerProgressFromBlock(resolveSafeToolStartProgressText(payload.name));
          } else if (firstStartForTool) {
            scheduleSilentToolProgressFallback(payload.name);
          }
          if (getActiveProgressController() && activeProgressKind !== "plan") {
            routeToolStatusPartialsToProgress = true;
          }
          if (!statusReactionController) {
            return;
          }
          await statusReactionController.setTool(payload.name);
        },
        onCompactionStart: async () => {
          // Compaction can legitimately take minutes. A reaction alone looks
          // indistinguishable from a hung bot, so expose the actual operation.
          await updateAnswerProgressFromBlock(
            "I’m condensing our conversation so we can keep talking. This may take a few minutes.",
          );
          await statusReactionController?.setCompacting();
        },
        onCompactionEnd: statusReactionController
          ? async () => {
              statusReactionController.cancelPending();
              await statusReactionController.setThinking();
            }
          : undefined,
        onModelSelected: tracedOnModelSelected,
        onDurableReplyAccepted: (durableId) => {
          // The runner persists restart recovery before invoking this callback.
          // Keep only the opaque id in the transport lifecycle; no prompt,
          // route, credential, or generated text is duplicated here.
          durableDirectTurnId = durableId;
          // Durable acceptance is the first safe point at which another plain
          // Telegram message must classify as a queued follow-up. Open the
          // per-topic bypass here instead of waiting for the model's first
          // lifecycle event, which may be delayed by memory or provider work.
          // The later onAgentRunStart callback remains an idempotent fallback.
          releaseBusySequentialKey ??= markTelegramSequentialKeyBusy(
            getTelegramSequentialKey({ message: msg }),
          );
        },
        onFollowupQueued: async ({ durableId }) => {
          // Persistence happens before this callback, so the short grace period
          // can never trade responsiveness for message safety. Until promotion
          // succeeds, the ordinary durable FIFO still owns the exact input.
          const queueKeyboard = canShowQueueButtons
            ? buildInlineKeyboard(buildTelegramQueuedButtons(durableId))
            : undefined;
          // Never advertise an action the configured Telegram surface cannot
          // render. The shorter fallback still makes the queue state explicit
          // to both a person and an agent reading message history.
          const queueReceiptText = queueKeyboard
            ? "I’ll use this in my current task. Tap After this if it can wait."
            : "Adding this to what I’m doing now.";
          const sent = await bot.api.sendMessage(chatId, queueReceiptText, {
            ...buildTelegramThreadParams(threadSpec),
            reply_parameters: {
              message_id: msg.message_id,
              allow_sending_without_reply: true,
            },
            ...(queueKeyboard ? { reply_markup: queueKeyboard } : {}),
          });
          recordSentMessage(chatId, sent.message_id, {
            sessionKey:
              typeof ctxPayload.SessionKey === "string" ? ctxPayload.SessionKey : undefined,
            messageThreadId: threadSpec?.id,
            durableFollowupId: durableId,
          });
          // The active model turn cannot survive a gateway replacement. Keep
          // enough opaque receipt identity on disk for the next process to
          // replace the selected live-steer promise with a truthful state.
          recordChannelActivity({
            channel: "telegram",
            accountId: route.accountId,
            direction: "outbound",
          });
          runtime.log?.(
            `telegram.queue.receipt chat=${chatId} thread=${threadSpec?.id ?? "none"} message=${sent.message_id}`,
          );

          scheduleTelegramAutoSteer(durableId, async () => {
            let promoted = false;
            try {
              const promotion = await promoteQueuedFollowupToSteer({
                durableId,
                expectedTelegramRoute: {
                  chatId: String(chatId),
                  accountId: route.accountId,
                  threadId: threadSpec?.id,
                },
              });
              if (promotion.status !== "promoted") {
                runtime.log?.(
                  `telegram.auto-steer.skipped chat=${chatId} durable=${durableId} status=${promotion.status}`,
                );
                const remainsQueued =
                  promotion.status === "still-queued" && promotion.reason === "not-streaming";
                await editMessageTelegram(
                  chatId,
                  sent.message_id,
                  remainsQueued
                    ? "I’ll handle this after the current task."
                    : "This message has already moved on.",
                  {
                    api: bot.api,
                    cfg,
                    accountId: route.accountId,
                    buttons:
                      canShowQueueButtons && remainsQueued
                        ? buildTelegramDeferredButtons(durableId)
                        : [],
                    richMessages: false,
                  },
                );
                await clearDurableFollowupTelegramPendingUseNow(durableId);
                return;
              }
              promoted = true;
              // Promotion acknowledges and removes the durable record. This is
              // intentionally best-effort for the narrow race where unlinking
              // failed after Pi accepted the steer.
              await editMessageTelegram(chatId, sent.message_id, "Adding this now.", {
                api: bot.api,
                cfg,
                accountId: route.accountId,
                // Preserve the conversation's inline-button scope on edits too;
                // the send helper does not repeat that authorization check.
                buttons: canShowQueueButtons ? buildTelegramSteeredButtons(durableId) : [],
                richMessages: false,
              });
              await clearDurableFollowupTelegramPendingUseNow(durableId);
              runtime.log?.(`telegram.auto-steer.promoted chat=${chatId} durable=${durableId}`);
            } catch (err) {
              runtime.error?.(
                promoted
                  ? `telegram auto-steer promoted but receipt edit failed: ${String(err)}`
                  : `telegram auto-steer failed; follow-up remains queued: ${String(err)}`,
              );
              if (!promoted) {
                try {
                  await editMessageTelegram(
                    chatId,
                    sent.message_id,
                    "I’ll handle this after the current task.",
                    {
                      api: bot.api,
                      cfg,
                      accountId: route.accountId,
                      buttons: canShowQueueButtons ? buildTelegramDeferredButtons(durableId) : [],
                      richMessages: false,
                    },
                  );
                  await clearDurableFollowupTelegramPendingUseNow(durableId);
                } catch (receiptErr) {
                  runtime.error?.(
                    `telegram auto-steer fallback receipt failed: ${String(receiptErr)}`,
                  );
                }
              }
            }
          });
          // Register the cancellable timer before awaiting marker I/O. A fast
          // After this tap must never be overwritten by a later registration.
          try {
            await markDurableFollowupTelegramPendingUseNow({
              id: durableId,
              receipt: {
                accountId: route.accountId,
                buttonsAllowed: Boolean(queueKeyboard),
                chatId: String(chatId),
                threadId: threadSpec?.id,
                messageId: sent.message_id,
              },
            });
          } catch (err) {
            // Receipt repair is cosmetic. The advertised default must still
            // run even when its optional restart marker cannot be persisted.
            runtime.error?.(`telegram pending Use now marker failed: ${String(err)}`);
          }
        },
      },
    }));
  } catch (err) {
    cancelSilentToolProgressFallback();
    dispatchError = err;
    runtime.error?.(danger(`telegram dispatch failed: ${String(err)}`));
  } finally {
    // Dispatch-local timers never survive cancellation, restart recovery, or
    // a silent/no-final return. The retained Work Log controller may survive;
    // its old timer may not.
    cancelSilentToolProgressFallback();
    releaseBusySequentialKey?.();
    releaseBusySequentialKey = undefined;
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
  const settledSilentTerminal =
    intentionalSilentTerminal ||
    (sawSilentNonFinalSkip &&
      !dispatchError &&
      !terminalDeliveryAttempted &&
      deliverySummary.skippedNonSilent === 0 &&
      deliverySummary.failedNonSilent === 0);
  if (durableDirectTurnId && (terminalDeliveryConfirmed || settledSilentTerminal)) {
    // Publish the processed-message receipt before Telegram middleware may
    // advance its update offset. If the process dies earlier, startup delivers
    // the conservative blocker without replaying tools or ambiguous actions.
    // A generic error fallback is visible but cannot prove whether a prior tool
    // or external action completed, so it deliberately leaves recovery armed.
    await completeDurableFollowup(durableDirectTurnId);
  }

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
  if (sessionId && (terminalDeliveryConfirmed || sentFallback)) {
    // This call only arms an idle timer. The expensive work starts after the
    // delivered final is readable and is cancelled by any subsequent message.
    scheduleProactiveCompactionAfterDelivery({
      cfg,
      agentId: route.agentId,
      sessionKey: sessionId,
      messageChannel: "telegram",
      messageProvider: "telegram",
    });
  }
  clearGroupHistory();
};
