import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveEffectiveToolPolicy } from "../../agents/pi-tools.policy.js";
import { isToolAllowedByPolicies } from "../../agents/tool-policy-match.js";
import { resolveToolProfilePolicy } from "../../agents/tool-policy-shared.js";
import { shouldSuppressLocalExecApprovalPrompt } from "../../channels/plugins/exec-approval-local.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionStore,
  parseSessionThreadInfo,
  resolveSessionStoreEntry,
  resolveStorePath,
  type SessionEntry,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  deriveInboundMessageHookContext,
  toPluginInboundClaimContext,
  toPluginInboundClaimEvent,
  toInternalMessageReceivedContext,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
} from "../../hooks/message-hook-mappers.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { logInfo } from "../../logger.js";
import {
  logMessageProcessed,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
import {
  buildPluginBindingDeclinedText,
  buildPluginBindingErrorText,
  buildPluginBindingUnavailableText,
  hasShownPluginBindingFallbackNotice,
  isPluginOwnedSessionBindingRecord,
  markPluginBindingFallbackNoticeShown,
  toPluginConversationBinding,
} from "../../plugins/conversation-binding.js";
import { getGlobalHookRunner, getGlobalPluginRegistry } from "../../plugins/hook-runner-global.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { truncateLine } from "../../shared/subagents-format.js";
import { parseTtsDirectives } from "../../tts/tts-core.js";
import {
  getLastTtsAttempt,
  maybeApplyTtsToPayload,
  normalizeTtsAutoMode,
  shouldSkipTtsForMediaDirectiveText,
  type ResolvedTtsModelOverrides,
  resolveTtsAutoMode,
  resolveTtsConfig,
  resolveTtsPrefsPath,
} from "../../tts/tts.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { maybeResolveTextAlias, normalizeCommandBody } from "../commands-registry.js";
import { getReplyFromConfig } from "../reply.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import {
  isControlCommandReplyPayload,
  markControlCommandReplyPayload,
} from "./control-command-reply.js";
import { shouldBypassAcpDispatchForCommand, tryDispatchAcpReply } from "./dispatch-acp.js";
import { shouldSkipDuplicateInbound } from "./inbound-dedupe.js";
import type { ReplyDispatcher, ReplyDispatchKind } from "./reply-dispatcher.js";
import { shouldSuppressReasoningPayload } from "./reply-payloads.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { resolveSourceReplyVisibilityPolicy } from "./source-reply-delivery-mode.js";
import { buildFinalTtsCaptionPreview } from "./tts-caption-preview.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";

const AUDIO_PLACEHOLDER_RE = /^<media:audio>(\s*\([^)]*\))?$/i;
const AUDIO_HEADER_RE = /^\[Audio\b/i;
const normalizeMediaType = (value: string): string => value.split(";")[0]?.trim().toLowerCase();
const NATIVE_TELEGRAM_VERBOSE_PREVIEW_MAX_LINES = 6;
const NATIVE_TELEGRAM_VERBOSE_PREVIEW_MAX_LINE_CHARS = 180;
const NATIVE_TELEGRAM_VERBOSE_SHORT_TEXT_MAX_LINES = 3;
const NATIVE_TELEGRAM_VERBOSE_SHORT_TEXT_MAX_CHARS = 240;

function hasTtsDirective(text: string): boolean {
  return /\[\[tts(?::|\]|\s)/i.test(text);
}

function shouldExpectFinalTtsAttempt(params: {
  cfg: OpenClawConfig;
  inboundAudio: boolean;
  sessionTtsAuto?: string;
  text: string;
}): boolean {
  const text = params.text.trim();
  if (text.length < 10) {
    return false;
  }
  if (shouldSkipTtsForMediaDirectiveText(text)) {
    return false;
  }
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const autoMode = resolveTtsAutoMode({
    config,
    prefsPath,
    ...(params.sessionTtsAuto ? { sessionAuto: params.sessionTtsAuto } : {}),
  });
  if (autoMode === "always") {
    return true;
  }
  if (autoMode === "inbound") {
    return params.inboundAudio;
  }
  if (autoMode === "tagged") {
    return hasTtsDirective(text);
  }
  return false;
}

const isInboundAudioContext = (ctx: FinalizedMsgContext): boolean => {
  const rawTypes = [
    typeof ctx.MediaType === "string" ? ctx.MediaType : undefined,
    ...(Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : []),
  ].filter(Boolean) as string[];
  const types = rawTypes.map((type) => normalizeMediaType(type));
  if (types.some((type) => type === "audio" || type.startsWith("audio/"))) {
    return true;
  }

  const body =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.CommandBody === "string"
        ? ctx.CommandBody
        : typeof ctx.RawBody === "string"
          ? ctx.RawBody
          : typeof ctx.Body === "string"
            ? ctx.Body
            : "";
  const trimmed = body.trim();
  if (!trimmed) {
    return false;
  }
  if (AUDIO_PLACEHOLDER_RE.test(trimmed)) {
    return true;
  }
  return AUDIO_HEADER_RE.test(trimmed);
};

function resolveCommandCandidateText(ctx: FinalizedMsgContext): string {
  const candidate =
    typeof ctx.CommandBody === "string"
      ? ctx.CommandBody
      : typeof ctx.BodyForCommands === "string"
        ? ctx.BodyForCommands
        : typeof ctx.RawBody === "string"
          ? ctx.RawBody
          : typeof ctx.Body === "string"
            ? ctx.Body
            : "";
  return candidate.trim();
}

function resolveTelegramTtsCommandAction(
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
  visibilityChannel: string | undefined,
): string | undefined {
  if (visibilityChannel !== "telegram") {
    return undefined;
  }
  const candidate = resolveCommandCandidateText(ctx);
  if (!candidate) {
    return undefined;
  }
  if (maybeResolveTextAlias(candidate, cfg) !== "/tts") {
    return undefined;
  }

  // `/tts on` is a product demo moment: the acknowledgement should be spoken
  // even when the command just enabled TTS and the pre-command session snapshot
  // still looks silent. Other `/tts` subcommands follow the effective setting.
  const normalized = normalizeCommandBody(candidate).trim().toLowerCase();
  if (normalized === "/tts") {
    return "status";
  }
  const rest = normalized.startsWith("/tts ") ? normalized.slice(5).trim() : "";
  return rest.split(/\s+/)[0] || "status";
}

function isTelegramControlCommandReply(
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
  visibilityChannel: string | undefined,
): boolean {
  if (visibilityChannel !== "telegram") {
    return false;
  }
  if (ctx.CommandSource === "native") {
    return true;
  }

  const candidate = resolveCommandCandidateText(ctx);
  if (!candidate) {
    return false;
  }
  if (maybeResolveTextAlias(candidate, cfg) != null) {
    return true;
  }
  // Slash/native command replies are control-plane feedback. Hidden/plugin
  // commands can be slash-shaped without appearing in the core alias registry.
  // They may change persistent TTS preferences, but the command acknowledgement
  // itself must not be upgraded into an automatic voice note.
  if (candidate.startsWith("/")) {
    return true;
  }
  return Boolean(ctx.CommandAuthorized) && candidate.startsWith("!");
}

function compactNativeTelegramToolText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").trimEnd();
  if (!normalized) {
    return normalized;
  }

  const lines = normalized.split("\n");
  if (
    lines.length <= NATIVE_TELEGRAM_VERBOSE_SHORT_TEXT_MAX_LINES &&
    normalized.length <= NATIVE_TELEGRAM_VERBOSE_SHORT_TEXT_MAX_CHARS
  ) {
    return normalized;
  }

  const previewLines: string[] = [];
  for (const line of lines) {
    if (previewLines.length >= NATIVE_TELEGRAM_VERBOSE_PREVIEW_MAX_LINES) {
      break;
    }
    previewLines.push(truncateLine(line, NATIVE_TELEGRAM_VERBOSE_PREVIEW_MAX_LINE_CHARS));
  }

  const preview = previewLines.join("\n").trimEnd();
  const suffix = `… truncated (${lines.length} lines, ${normalized.length} chars)`;
  return preview ? `${preview}\n\n${suffix}` : suffix;
}

function isSourcePreviewToolPayload(payload: ReplyPayload): boolean {
  const channelData = payload.channelData;
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) {
    return false;
  }

  // Source previews are transient progress/status payloads emitted through the
  // tool lane. They should remain eligible for normal delivery filtering, but
  // must not be upgraded into voice/audio replies by the TTS layer.
  const openclaw = channelData.openclaw;
  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
    return false;
  }
  return (openclaw as { sourcePreview?: unknown }).sourcePreview === true;
}

const TELEGRAM_INTERNAL_TOOL_SUMMARY_LINE_RE =
  /^🔧\s+[\w./:-]+(?:\s+(?:start|update|completed|failed|cancelled|done|error))?$/iu;

function stripTelegramInternalToolSummaryLines(text: string): string {
  const lines = text.split("\n");
  const strippedLines = lines.map((line) =>
    TELEGRAM_INTERNAL_TOOL_SUMMARY_LINE_RE.test(line.trim()),
  );
  if (!strippedLines.some(Boolean)) {
    return text;
  }

  return lines
    .filter((line, index) => {
      if (strippedLines[index]) {
        return false;
      }
      // Codex/Gateway can surface tool lifecycle labels as normal streaming
      // text. In non-verbose Telegram chats, drop only those standalone labels
      // and their paragraph separators; keep real command output/final text.
      if (line.trim() !== "") {
        return true;
      }
      const previousStripped = index > 0 && strippedLines[index - 1];
      const nextStripped = index + 1 < strippedLines.length && strippedLines[index + 1];
      return !previousStripped && !nextStripped;
    })
    .join("\n");
}

function deriveVisibleBlockFinalText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  const separated = trimmed
    .replace(/([.!?])(\s*)(FINAL\b)/g, "$1\n\n$3")
    .replace(/([.!?])(\s*)(Final\b)/g, "$1\n\n$3")
    .replace(/([.!?])(\s*)(Done\b)/g, "$1\n\n$3")
    .replace(/([.!?])(\s*)(Verified\b)/g, "$1\n\n$3")
    .replace(/([.!?])(\s*)(Proof marker\b)/g, "$1\n\n$3");
  const paragraphs = separated
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const boundaryIndex = paragraphs.findIndex((paragraph, index) => {
    if (index === 0) {
      return false;
    }
    // Proof runs often require a stable marker instead of a human "Done"
    // prefix. Treat that marker as the same final-answer boundary so the
    // additive TTS voice note cannot caption or speak the preceding progress.
    return /^(?:FINAL\b|Final\b|Done\b|Verified\b|Proof marker\b|Result(?:s)?:|Short version:)/.test(
      paragraph,
    );
  });
  if (boundaryIndex < 0) {
    return trimmed;
  }
  return paragraphs.slice(boundaryIndex).join("\n\n").trim();
}

function markFinalTtsSupplement(payload: ReplyPayload): ReplyPayload {
  const channelData =
    payload.channelData &&
    typeof payload.channelData === "object" &&
    !Array.isArray(payload.channelData)
      ? payload.channelData
      : {};
  const openclaw =
    channelData.openclaw &&
    typeof channelData.openclaw === "object" &&
    !Array.isArray(channelData.openclaw)
      ? channelData.openclaw
      : {};
  return {
    ...payload,
    channelData: {
      ...channelData,
      openclaw: {
        ...openclaw,
        finalTtsSupplement: true,
      },
    },
  };
}

const resolveSessionStoreLookup = (
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): {
  sessionKey?: string;
  entry?: SessionEntry;
} => {
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const sessionKey = (targetSessionKey ?? ctx.SessionKey)?.trim();
  if (!sessionKey) {
    return {};
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath);
    return {
      sessionKey,
      entry: resolveSessionStoreEntry({ store, sessionKey }).existing,
    };
  } catch {
    return {
      sessionKey,
    };
  }
};

export type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};

export async function dispatchReplyFromConfig(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: typeof getReplyFromConfig;
}): Promise<DispatchFromConfigResult> {
  const { ctx, cfg, dispatcher } = params;
  const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
  const channel = String(ctx.Surface ?? ctx.Provider ?? "unknown").toLowerCase();
  const chatId = ctx.To ?? ctx.From;
  const messageId = ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const sessionKey = ctx.SessionKey;
  const startTime = diagnosticsEnabled ? Date.now() : 0;
  const canTrackSession = diagnosticsEnabled && Boolean(sessionKey);

  const recordProcessed = (
    outcome: "completed" | "skipped" | "error",
    opts?: {
      reason?: string;
      error?: string;
    },
  ) => {
    if (!diagnosticsEnabled) {
      return;
    }
    logMessageProcessed({
      channel,
      chatId,
      messageId,
      sessionKey,
      durationMs: Date.now() - startTime,
      outcome,
      reason: opts?.reason,
      error: opts?.error,
    });
  };

  const markProcessing = () => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logMessageQueued({ sessionKey, channel, source: "dispatch" });
    logSessionStateChange({
      sessionKey,
      state: "processing",
      reason: "message_start",
    });
  };

  const markIdle = (reason: string) => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logSessionStateChange({
      sessionKey,
      state: "idle",
      reason,
    });
  };

  if (shouldSkipDuplicateInbound(ctx)) {
    recordProcessed("skipped", { reason: "duplicate" });
    return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
  }

  const sessionStoreEntry = resolveSessionStoreLookup(ctx, cfg);
  const acpDispatchSessionKey = sessionStoreEntry.sessionKey ?? sessionKey;
  const visibilityChannel = normalizeMessageChannel(
    ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider,
  );
  const isTelegramProvider = visibilityChannel === "telegram";
  // Restore route thread context only from the active turn or the thread-scoped session key.
  // Do not read thread ids from the normalised session store here: `origin.threadId` can be
  // folded back into lastThreadId/deliveryContext during store normalisation and resurrect a
  // stale route after thread delivery was intentionally cleared.
  const routeThreadId =
    ctx.MessageThreadId ?? parseSessionThreadInfo(acpDispatchSessionKey).threadId;
  const inboundAudio = isInboundAudioContext(ctx);
  const sessionTtsAuto = normalizeTtsAutoMode(sessionStoreEntry.entry?.ttsAuto);
  const telegramTtsCommandAction = resolveTelegramTtsCommandAction(ctx, cfg, visibilityChannel);
  const isTelegramTtsControlCommand = telegramTtsCommandAction !== undefined;
  const isControlCommandReply = isTelegramControlCommandReply(ctx, cfg, visibilityChannel);
  const commandTtsAuto =
    telegramTtsCommandAction === "on"
      ? "always"
      : telegramTtsCommandAction === "off"
        ? "off"
        : undefined;
  // Voice-in should get voice-out for this turn only. Keep explicit `/tts on`
  // as-is, but let inbound audio override typed-message modes like `off` or
  // `tagged` without writing a new preference.
  const turnTtsAuto = commandTtsAuto
    ? commandTtsAuto
    : isControlCommandReply && !isTelegramTtsControlCommand
      ? "off"
      : inboundAudio && sessionTtsAuto !== "always"
        ? "inbound"
        : sessionTtsAuto;
  const hookRunner = getGlobalHookRunner();

  // Extract message context for hooks (plugin and internal)
  const timestamp =
    typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : undefined;
  const messageIdForHook =
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const hookContext = deriveInboundMessageHookContext(ctx, { messageId: messageIdForHook });
  const { isGroup, groupId } = hookContext;
  const inboundClaimContext = toPluginInboundClaimContext(hookContext);
  const inboundClaimEvent = toPluginInboundClaimEvent(hookContext, {
    commandAuthorized:
      typeof ctx.CommandAuthorized === "boolean" ? ctx.CommandAuthorized : undefined,
    wasMentioned: typeof ctx.WasMentioned === "boolean" ? ctx.WasMentioned : undefined,
  });

  // Check if we should route replies to originating channel instead of dispatcher.
  // Only route when the originating channel is DIFFERENT from the current surface.
  // This handles cross-provider routing (e.g., message from Telegram being processed
  // by a shared session that's currently on Slack) while preserving normal dispatcher
  // flow when the provider handles its own messages.
  //
  // Debug: `pnpm test src/auto-reply/reply/dispatch-from-config.test.ts`
  const originatingChannel = normalizeMessageChannel(ctx.OriginatingChannel);
  const originatingTo = ctx.OriginatingTo;
  const providerChannel = normalizeMessageChannel(ctx.Provider);
  const surfaceChannel = normalizeMessageChannel(ctx.Surface);
  // Prefer provider channel because surface may carry origin metadata in relayed flows.
  const currentSurface = providerChannel ?? surfaceChannel;
  const isInternalWebchatTurn =
    currentSurface === INTERNAL_MESSAGE_CHANNEL &&
    (surfaceChannel === INTERNAL_MESSAGE_CHANNEL || !surfaceChannel) &&
    ctx.ExplicitDeliverRoute !== true;
  const shouldRouteToOriginating = Boolean(
    !isInternalWebchatTurn &&
    isRoutableChannel(originatingChannel) &&
    originatingTo &&
    originatingChannel !== currentSurface,
  );
  const shouldSuppressTyping =
    shouldRouteToOriginating || originatingChannel === INTERNAL_MESSAGE_CHANNEL;
  const ttsChannel = shouldRouteToOriginating ? originatingChannel : currentSurface;
  const shouldCaptionFinalTtsSupplement = ttsChannel === "telegram";
  const shouldMarkFinalTtsSupplement = shouldCaptionFinalTtsSupplement && !shouldRouteToOriginating;

  /**
   * Helper to send a payload via route-reply (async).
   * Only used when actually routing to a different provider.
   * Note: Only called when shouldRouteToOriginating is true, so
   * originatingChannel and originatingTo are guaranteed to be defined.
   */
  const sendPayloadAsync = async (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
    mirror?: boolean,
  ): Promise<void> => {
    // TypeScript doesn't narrow these from the shouldRouteToOriginating check,
    // but they're guaranteed non-null when this function is called.
    if (!originatingChannel || !originatingTo) {
      return;
    }
    if (abortSignal?.aborted) {
      return;
    }
    const result = await routeReply({
      payload,
      channel: originatingChannel,
      to: originatingTo,
      sessionKey: ctx.SessionKey,
      accountId: ctx.AccountId,
      threadId: routeThreadId,
      cfg,
      abortSignal,
      mirror,
      isGroup,
      groupId,
    });
    if (!result.ok) {
      logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
    }
  };

  const sendBindingNotice = async (
    payload: ReplyPayload,
    mode: "additive" | "terminal",
  ): Promise<boolean> => {
    if (shouldRouteToOriginating && originatingChannel && originatingTo) {
      const result = await routeReply({
        payload,
        channel: originatingChannel,
        to: originatingTo,
        sessionKey: ctx.SessionKey,
        accountId: ctx.AccountId,
        threadId: routeThreadId,
        cfg,
        isGroup,
        groupId,
      });
      if (!result.ok) {
        logVerbose(
          `dispatch-from-config: route-reply (plugin binding notice) failed: ${result.error ?? "unknown error"}`,
        );
      }
      return result.ok;
    }
    return mode === "additive"
      ? dispatcher.sendToolResult(payload)
      : dispatcher.sendFinalReply(payload);
  };

  const pluginOwnedBindingRecord =
    inboundClaimContext.conversationId && inboundClaimContext.channelId
      ? getSessionBindingService().resolveByConversation({
          channel: inboundClaimContext.channelId,
          accountId: inboundClaimContext.accountId ?? "default",
          conversationId: inboundClaimContext.conversationId,
          parentConversationId: inboundClaimContext.parentConversationId,
        })
      : null;
  const pluginOwnedBinding = isPluginOwnedSessionBindingRecord(pluginOwnedBindingRecord)
    ? toPluginConversationBinding(pluginOwnedBindingRecord)
    : null;

  let pluginFallbackReason:
    | "plugin-bound-fallback-missing-plugin"
    | "plugin-bound-fallback-no-handler"
    | undefined;

  if (pluginOwnedBinding) {
    getSessionBindingService().touch(pluginOwnedBinding.bindingId);
    logVerbose(
      `plugin-bound inbound routed to ${pluginOwnedBinding.pluginId} conversation=${pluginOwnedBinding.conversationId}`,
    );
    const targetedClaimOutcome = hookRunner?.runInboundClaimForPluginOutcome
      ? await hookRunner.runInboundClaimForPluginOutcome(
          pluginOwnedBinding.pluginId,
          inboundClaimEvent,
          inboundClaimContext,
        )
      : (() => {
          const pluginLoaded =
            getGlobalPluginRegistry()?.plugins.some(
              (plugin) => plugin.id === pluginOwnedBinding.pluginId && plugin.status === "loaded",
            ) ?? false;
          return pluginLoaded
            ? ({ status: "no_handler" } as const)
            : ({ status: "missing_plugin" } as const);
        })();

    switch (targetedClaimOutcome.status) {
      case "handled": {
        markIdle("plugin_binding_dispatch");
        recordProcessed("completed", { reason: "plugin-bound-handled" });
        return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
      }
      case "missing_plugin":
      case "no_handler": {
        pluginFallbackReason =
          targetedClaimOutcome.status === "missing_plugin"
            ? "plugin-bound-fallback-missing-plugin"
            : "plugin-bound-fallback-no-handler";
        if (!hasShownPluginBindingFallbackNotice(pluginOwnedBinding.bindingId)) {
          const didSendNotice = await sendBindingNotice(
            { text: buildPluginBindingUnavailableText(pluginOwnedBinding) },
            "additive",
          );
          if (didSendNotice) {
            markPluginBindingFallbackNoticeShown(pluginOwnedBinding.bindingId);
          }
        }
        break;
      }
      case "declined": {
        await sendBindingNotice(
          { text: buildPluginBindingDeclinedText(pluginOwnedBinding) },
          "terminal",
        );
        markIdle("plugin_binding_declined");
        recordProcessed("completed", { reason: "plugin-bound-declined" });
        return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
      }
      case "error": {
        logVerbose(
          `plugin-bound inbound claim failed for ${pluginOwnedBinding.pluginId}: ${targetedClaimOutcome.error}`,
        );
        await sendBindingNotice(
          { text: buildPluginBindingErrorText(pluginOwnedBinding) },
          "terminal",
        );
        markIdle("plugin_binding_error");
        recordProcessed("completed", { reason: "plugin-bound-error" });
        return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
      }
    }
  }

  // Trigger plugin hooks (fire-and-forget)
  if (hookRunner?.hasHooks("message_received")) {
    fireAndForgetHook(
      hookRunner.runMessageReceived(
        toPluginMessageReceivedEvent(hookContext),
        toPluginMessageContext(hookContext),
      ),
      "dispatch-from-config: message_received plugin hook failed",
    );
  }

  // Bridge to internal hooks (HOOK.md discovery system) - refs #8807
  if (sessionKey) {
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent("message", "received", sessionKey, {
          ...toInternalMessageReceivedContext(hookContext),
          timestamp,
        }),
      ),
      "dispatch-from-config: message_received internal hook failed",
    );
  }

  markProcessing();

  try {
    const fastAbort = await tryFastAbortFromMessage({ ctx, cfg });
    if (fastAbort.handled) {
      const payload = {
        text: formatAbortReplyText(fastAbort.stoppedSubagents),
      } satisfies ReplyPayload;
      let queuedFinal = false;
      let routedFinalCount = 0;
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: routeThreadId,
          cfg,
          isGroup,
          groupId,
        });
        queuedFinal = result.ok;
        if (result.ok) {
          routedFinalCount += 1;
        }
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (abort) failed: ${result.error ?? "unknown error"}`,
          );
        }
      } else {
        queuedFinal = dispatcher.sendFinalReply(payload);
      }
      const counts = dispatcher.getQueuedCounts();
      counts.final += routedFinalCount;
      recordProcessed("completed", { reason: "fast_abort" });
      markIdle("message_completed");
      return { queuedFinal, counts };
    }

    const bypassAcpForCommand = shouldBypassAcpDispatchForCommand(ctx, cfg);

    const sendPolicy = resolveSendPolicy({
      cfg,
      entry: sessionStoreEntry.entry,
      sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
      channel:
        sessionStoreEntry.entry?.channel ??
        ctx.OriginatingChannel ??
        ctx.Surface ??
        ctx.Provider ??
        undefined,
      chatType: sessionStoreEntry.entry?.chatType,
    });
    const { globalPolicy, agentPolicy, profile, providerProfile } = resolveEffectiveToolPolicy({
      config: cfg,
      sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
    });
    const messageToolAvailable = isToolAllowedByPolicies("message", [
      resolveToolProfilePolicy(profile),
      resolveToolProfilePolicy(providerProfile),
      globalPolicy,
      agentPolicy,
    ]);
    const sourceReplyPolicy = resolveSourceReplyVisibilityPolicy({
      cfg,
      ctx,
      requested: params.replyOptions?.sourceReplyDeliveryMode,
      sendPolicy,
      explicitSuppressTyping: params.replyOptions?.suppressTyping === true,
      shouldSuppressTyping,
      messageToolAvailable,
    });
    if (sendPolicy === "deny" && !bypassAcpForCommand) {
      logVerbose(
        `Send blocked by policy for session ${sessionStoreEntry.sessionKey ?? sessionKey ?? "unknown"}`,
      );
      const counts = dispatcher.getQueuedCounts();
      recordProcessed("completed", { reason: "send_policy_deny" });
      markIdle("message_completed");
      return { queuedFinal: false, counts };
    }

    const shouldSendToolSummaries =
      !sourceReplyPolicy.suppressAutomaticSourceDelivery &&
      ctx.ChatType !== "group" &&
      !isTelegramProvider;
    const sanitizeTelegramVisiblePayload = (payload: ReplyPayload): ReplyPayload => {
      if (!isTelegramProvider || typeof payload.text !== "string") {
        return payload;
      }
      const text = stripTelegramInternalToolSummaryLines(payload.text);
      return text === payload.text ? payload : { ...payload, text };
    };
    const maybeApplyAutomaticTts = async (
      payload: ReplyPayload,
      kind: ReplyDispatchKind,
    ): Promise<ReplyPayload> => {
      const shouldPreserveControlCommandMarker = isControlCommandReplyPayload(payload);
      // Command handlers mark their own control replies. That keeps `/status`
      // and `/model` text visible without voicing product UI, while command
      // surfaces that continue into a real assistant answer still get normal
      // final-answer TTS.
      if (shouldPreserveControlCommandMarker && !isTelegramTtsControlCommand) {
        return payload;
      }
      const ttsPayload = await maybeApplyTtsToPayload({
        payload,
        cfg,
        channel: ttsChannel,
        kind,
        inboundAudio,
        ttsAuto: turnTtsAuto,
      });
      // `/tts on` is a control reply and intentionally passes through TTS so
      // the acknowledgement can be spoken. Some TTS implementations rebuild the
      // payload while adding media, so reapply the structural marker after TTS
      // instead of relying on object-spread behavior in every TTS provider.
      return shouldPreserveControlCommandMarker
        ? markControlCommandReplyPayload(ttsPayload)
        : ttsPayload;
    };
    const acpDispatch = await tryDispatchAcpReply({
      ctx,
      cfg,
      dispatcher,
      sessionKey: acpDispatchSessionKey,
      inboundAudio,
      sessionTtsAuto: turnTtsAuto,
      ttsChannel,
      shouldRouteToOriginating,
      originatingChannel,
      originatingTo,
      shouldSendToolSummaries,
      bypassForCommand: bypassAcpForCommand,
      onReplyStart: params.replyOptions?.onReplyStart,
      recordProcessed,
      markIdle,
    });
    if (acpDispatch) {
      return acpDispatch;
    }

    const resolveToolDeliveryPayload = (payload: ReplyPayload): ReplyPayload | null => {
      if (
        shouldSuppressLocalExecApprovalPrompt({
          channel: normalizeMessageChannel(ctx.Surface ?? ctx.Provider),
          cfg,
          accountId: ctx.AccountId,
          payload,
        })
      ) {
        return null;
      }
      if (sourceReplyPolicy.suppressAutomaticSourceDelivery) {
        return null;
      }
      if (isSourcePreviewToolPayload(payload)) {
        // Same-source message-tool previews are already classified as transient
        // progress by the agent runner. Preserve that structural marker so
        // Telegram can route them through the mutable progress controller
        // instead of dropping them with internal tool/status chatter.
        return payload;
      }
      if (shouldSendToolSummaries) {
        const text =
          typeof payload.text === "string"
            ? compactNativeTelegramToolText(payload.text)
            : undefined;
        return text === payload.text ? payload : { ...payload, text };
      }
      const execApproval =
        payload.channelData &&
        typeof payload.channelData === "object" &&
        !Array.isArray(payload.channelData)
          ? payload.channelData.execApproval
          : undefined;
      if (execApproval && typeof execApproval === "object" && !Array.isArray(execApproval)) {
        return payload;
      }
      if (payload.isError) {
        return payload;
      }
      // Telegram product chats never render internal tool/status text. Media and
      // approval payloads still need delivery because they carry user-visible effects.
      const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
      if (!hasMedia) {
        return null;
      }
      return { ...payload, text: undefined };
    };
    const typing = resolveRunTypingPolicy({
      requestedPolicy: params.replyOptions?.typingPolicy,
      suppressTyping: sourceReplyPolicy.suppressTyping,
      originatingChannel,
      systemEvent: shouldRouteToOriginating,
    });

    // Some reply resolvers stream the durable answer only through block callbacks
    // and return no final payload. Track those visible blocks so final-mode TTS
    // still gets one additive supplement; sourcePreview blocks stay progress-only.
    let durableBlockFinalText = "";
    const replyResult = await (params.replyResolver ?? getReplyFromConfig)(
      ctx,
      {
        ...params.replyOptions,
        sourceReplyDeliveryMode: sourceReplyPolicy.sourceReplyDeliveryMode,
        typingPolicy: typing.typingPolicy,
        suppressTyping: typing.suppressTyping,
        onToolResult: (payload: ReplyPayload) => {
          const run = async () => {
            const ttsPayload = isSourcePreviewToolPayload(payload)
              ? payload
              : await maybeApplyAutomaticTts(payload, "tool");
            const deliveryPayload = resolveToolDeliveryPayload(ttsPayload);
            if (!deliveryPayload) {
              return;
            }
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(deliveryPayload, undefined, false);
            } else {
              dispatcher.sendToolResult(deliveryPayload);
            }
          };
          return run();
        },
        onBlockReply: (payload: ReplyPayload, context) => {
          const run = async () => {
            // Suppress reasoning payloads — channels using this generic dispatch
            // path (WhatsApp, web, etc.) do not have a dedicated reasoning lane.
            // Telegram has its own dispatch path that handles reasoning splitting.
            if (shouldSuppressReasoningPayload(payload)) {
              return;
            }
            const shouldTrackBlockAsDurableFinal =
              !isSourcePreviewToolPayload(payload) &&
              !sourceReplyPolicy.suppressAutomaticSourceDelivery;
            if (shouldTrackBlockAsDurableFinal && payload.text?.trim()) {
              durableBlockFinalText += payload.text;
            }
            // Block callbacks are preview/progress material until the resolver
            // either returns a final payload or the accumulated block text is
            // promoted to one durable final. Running TTS here can leak an
            // early progress snippet as a late voice caption after the final.
            const ttsPayload = payload;
            if (sourceReplyPolicy.suppressAutomaticSourceDelivery) {
              return;
            }
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(
                sanitizeTelegramVisiblePayload(ttsPayload),
                context?.abortSignal,
                false,
              );
            } else {
              dispatcher.sendBlockReply(sanitizeTelegramVisiblePayload(ttsPayload));
            }
          };
          return run();
        },
      },
      cfg,
    );

    if (ctx.AcpDispatchTailAfterReset === true) {
      // Command handling prepared a trailing prompt after ACP in-place reset.
      // Route that tail through ACP now (same turn) instead of embedded dispatch.
      ctx.AcpDispatchTailAfterReset = false;
      const acpTailDispatch = await tryDispatchAcpReply({
        ctx,
        cfg,
        dispatcher,
        sessionKey: acpDispatchSessionKey,
        inboundAudio,
        sessionTtsAuto: turnTtsAuto,
        ttsChannel,
        shouldRouteToOriginating,
        originatingChannel,
        originatingTo,
        shouldSendToolSummaries,
        bypassForCommand: false,
        onReplyStart: params.replyOptions?.onReplyStart,
        recordProcessed,
        markIdle,
      });
      if (acpTailDispatch) {
        return acpTailDispatch;
      }
    }

    const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];

    let queuedFinal = false;
    let routedFinalCount = 0;
    if (replies.length === 0 && durableBlockFinalText.trim()) {
      const durableBlockFinalTextTrimmed = durableBlockFinalText.trim();
      const blockFinalTextForDelivery = deriveVisibleBlockFinalText(durableBlockFinalTextTrimmed);
      let visibleDurableBlockFinalText = blockFinalTextForDelivery;
      if (shouldCaptionFinalTtsSupplement && !sourceReplyPolicy.suppressAutomaticSourceDelivery) {
        const resolvedTtsConfig = resolveTtsConfig(cfg);
        const fallbackDirectivePolicy: ResolvedTtsModelOverrides = {
          enabled: true,
          allowText: true,
          allowProvider: false,
          allowVoice: true,
          allowModelId: true,
          allowVoiceSettings: true,
          allowNormalization: true,
          allowSeed: true,
        };
        const visibleDurableText = parseTtsDirectives(
          blockFinalTextForDelivery,
          resolvedTtsConfig.modelOverrides ?? fallbackDirectivePolicy,
          resolvedTtsConfig.openai?.baseUrl,
        ).cleanedText.trim();
        const durableFinalPayload = sanitizeTelegramVisiblePayload({
          text: visibleDurableText || blockFinalTextForDelivery,
          channelData: {
            openclaw: {
              assistantPhase: "final_answer",
            },
          },
        });
        if (typeof durableFinalPayload.text === "string" && durableFinalPayload.text.trim()) {
          visibleDurableBlockFinalText = durableFinalPayload.text;
        }
        // Telegram block streams use mutable previews while the model is still
        // speaking. Once the resolver returns with no separate final payload,
        // promote the accumulated block text to a durable final immediately so
        // preview cleanup is not delayed by slower TTS synthesis.
        if (shouldRouteToOriginating && originatingChannel && originatingTo) {
          const result = await routeReply({
            payload: durableFinalPayload,
            channel: originatingChannel,
            to: originatingTo,
            sessionKey: ctx.SessionKey,
            accountId: ctx.AccountId,
            threadId: routeThreadId,
            cfg,
            isGroup,
            groupId,
          });
          if (!result.ok) {
            logVerbose(
              `dispatch-from-config: route-reply (block-final-text) failed: ${result.error ?? "unknown error"}`,
            );
          }
          queuedFinal = result.ok || queuedFinal;
          if (result.ok) {
            routedFinalCount += 1;
          }
        } else {
          queuedFinal = dispatcher.sendFinalReply(durableFinalPayload) || queuedFinal;
        }
      }
      logInfo(
        `telegram: block-stream final text ready; finalizing block preview before tts textLength=${blockFinalTextForDelivery.length}`,
      );
      await dispatcher.finalizeBlockReply?.();
      logInfo(
        `telegram: block-stream final preview finalized before tts textLength=${blockFinalTextForDelivery.length}`,
      );
      const ttsAttemptStartedAt = Date.now();
      logInfo(
        `tts: final supplement synthesis start path=block-stream textLength=${blockFinalTextForDelivery.length} channel=${ttsChannel ?? "unknown"}`,
      );
      const ttsReply = await maybeApplyAutomaticTts({ text: blockFinalTextForDelivery }, "final");
      const hasFinalTtsMedia = Boolean(ttsReply.mediaUrl) || (ttsReply.mediaUrls?.length ?? 0) > 0;
      if (hasFinalTtsMedia && !sourceReplyPolicy.suppressAutomaticSourceDelivery) {
        const ttsPayload = {
          ...ttsReply,
          // The TTS payload may carry cleaned or synthesized text that differs
          // from the final bubble. Telegram snippets must describe the visible
          // final answer, not an earlier progress draft or speech-only variant.
          text: shouldCaptionFinalTtsSupplement
            ? buildFinalTtsCaptionPreview(visibleDurableBlockFinalText)
            : undefined,
        };
        const ttsSupplement = sanitizeTelegramVisiblePayload(
          shouldMarkFinalTtsSupplement ? markFinalTtsSupplement(ttsPayload) : ttsPayload,
        );
        if (shouldRouteToOriginating && originatingChannel && originatingTo) {
          const result = await routeReply({
            payload: ttsSupplement,
            channel: originatingChannel,
            to: originatingTo,
            sessionKey: ctx.SessionKey,
            accountId: ctx.AccountId,
            threadId: routeThreadId,
            cfg,
            isGroup,
            groupId,
          });
          if (!result.ok) {
            logVerbose(
              `dispatch-from-config: route-reply (block-final-tts) failed: ${result.error ?? "unknown error"}`,
            );
          }
          queuedFinal = result.ok || queuedFinal;
          if (result.ok) {
            routedFinalCount += 1;
          }
        } else {
          queuedFinal = dispatcher.sendFinalReply(ttsSupplement) || queuedFinal;
        }
        logInfo(
          `tts: final supplement media send queued path=block-stream textLength=${durableBlockFinalText.trim().length}`,
        );
      } else if (
        shouldCaptionFinalTtsSupplement &&
        !sourceReplyPolicy.suppressAutomaticSourceDelivery
      ) {
        const lastAttempt = getLastTtsAttempt();
        const failedThisAttempt =
          lastAttempt && lastAttempt.timestamp >= ttsAttemptStartedAt && !lastAttempt.success;
        const expectedThisAttempt = shouldExpectFinalTtsAttempt({
          cfg,
          inboundAudio,
          sessionTtsAuto: turnTtsAuto,
          text: durableBlockFinalText,
        });
        logInfo(
          `tts: final supplement synthesis ${failedThisAttempt ? "failed" : "skipped"} path=block-stream textLength=${durableBlockFinalText.trim().length} expected=${String(expectedThisAttempt)} error=${failedThisAttempt ? (lastAttempt.error ?? "unknown") : "none"}`,
        );
        if (failedThisAttempt || expectedThisAttempt) {
          const failurePayload = markFinalTtsSupplement({
            text: "Voice note failed. Final text is above.",
            channelData: {
              openclaw: {
                ttsFailureStatus: true,
              },
            },
          });
          if (shouldRouteToOriginating && originatingChannel && originatingTo) {
            const result = await routeReply({
              payload: failurePayload,
              channel: originatingChannel,
              to: originatingTo,
              sessionKey: ctx.SessionKey,
              accountId: ctx.AccountId,
              threadId: routeThreadId,
              cfg,
              isGroup,
              groupId,
            });
            queuedFinal = result.ok || queuedFinal;
            if (result.ok) {
              routedFinalCount += 1;
            }
          } else {
            queuedFinal = dispatcher.sendFinalReply(failurePayload) || queuedFinal;
          }
        }
      }
    }
    for (const reply of replies) {
      // Suppress reasoning payloads from channel delivery — channels using this
      // generic dispatch path do not have a dedicated reasoning lane.
      if (shouldSuppressReasoningPayload(reply)) {
        continue;
      }
      const replyFinalText = reply.text?.trim();
      const shouldPreDeliverTelegramFinalText =
        shouldCaptionFinalTtsSupplement &&
        !sourceReplyPolicy.suppressAutomaticSourceDelivery &&
        Boolean(replyFinalText) &&
        !isControlCommandReplyPayload(reply) &&
        shouldExpectFinalTtsAttempt({
          cfg,
          inboundAudio,
          sessionTtsAuto: turnTtsAuto,
          text: replyFinalText ?? "",
        }) &&
        !reply.mediaUrl &&
        !(reply.mediaUrls?.length ?? 0);
      if (shouldPreDeliverTelegramFinalText && replyFinalText) {
        const durableFinalPayload = sanitizeTelegramVisiblePayload({
          ...reply,
          text: replyFinalText,
          channelData: {
            ...reply.channelData,
            openclaw: {
              ...((reply.channelData?.openclaw &&
              typeof reply.channelData.openclaw === "object" &&
              !Array.isArray(reply.channelData.openclaw)
                ? reply.channelData.openclaw
                : {}) as Record<string, unknown>),
              assistantPhase: "final_answer",
            },
          },
        });
        if (shouldRouteToOriginating && originatingChannel && originatingTo) {
          const result = await routeReply({
            payload: durableFinalPayload,
            channel: originatingChannel,
            to: originatingTo,
            sessionKey: ctx.SessionKey,
            accountId: ctx.AccountId,
            threadId: routeThreadId,
            cfg,
            isGroup,
            groupId,
          });
          if (!result.ok) {
            logVerbose(
              `dispatch-from-config: route-reply (final-text-before-tts) failed: ${result.error ?? "unknown error"}`,
            );
          }
          queuedFinal = result.ok || queuedFinal;
          if (result.ok) {
            routedFinalCount += 1;
          }
        } else {
          queuedFinal = dispatcher.sendFinalReply(durableFinalPayload) || queuedFinal;
        }
        logInfo(
          `telegram: final text ready; finalizing preview before tts textLength=${replyFinalText.length}`,
        );
        await dispatcher.finalizeBlockReply?.();
        logInfo(`telegram: final preview finalized before tts textLength=${replyFinalText.length}`);

        const ttsAttemptStartedAt = Date.now();
        const ttsReply = await maybeApplyAutomaticTts(reply, "final");
        const hasFinalTtsMedia =
          Boolean(ttsReply.mediaUrl) || (ttsReply.mediaUrls?.length ?? 0) > 0;
        if (hasFinalTtsMedia) {
          const finalTtsCaptionText =
            typeof durableFinalPayload.text === "string" && durableFinalPayload.text.trim()
              ? durableFinalPayload.text
              : replyFinalText;
          const ttsPayload = {
            ...ttsReply,
            // Match the voice-caption snippet to the already-sent final text.
            // The synthesized payload text is not authoritative for Telegram UI.
            text: buildFinalTtsCaptionPreview(finalTtsCaptionText),
          };
          const ttsSupplement = sanitizeTelegramVisiblePayload(
            shouldMarkFinalTtsSupplement ? markFinalTtsSupplement(ttsPayload) : ttsPayload,
          );
          if (shouldRouteToOriginating && originatingChannel && originatingTo) {
            const result = await routeReply({
              payload: ttsSupplement,
              channel: originatingChannel,
              to: originatingTo,
              sessionKey: ctx.SessionKey,
              accountId: ctx.AccountId,
              threadId: routeThreadId,
              cfg,
              isGroup,
              groupId,
            });
            if (!result.ok) {
              logVerbose(
                `dispatch-from-config: route-reply (final-tts-supplement) failed: ${result.error ?? "unknown error"}`,
              );
            }
            queuedFinal = result.ok || queuedFinal;
            if (result.ok) {
              routedFinalCount += 1;
            }
          } else {
            queuedFinal = dispatcher.sendFinalReply(ttsSupplement) || queuedFinal;
          }
        } else {
          const lastAttempt = getLastTtsAttempt();
          const failedThisAttempt =
            lastAttempt && lastAttempt.timestamp >= ttsAttemptStartedAt && !lastAttempt.success;
          const expectedThisAttempt = shouldExpectFinalTtsAttempt({
            cfg,
            inboundAudio,
            sessionTtsAuto: turnTtsAuto,
            text: replyFinalText,
          });
          if (failedThisAttempt || expectedThisAttempt) {
            const failurePayload = markFinalTtsSupplement({
              text: "Voice note failed. Final text is above.",
              channelData: {
                openclaw: {
                  ttsFailureStatus: true,
                },
              },
            });
            if (shouldRouteToOriginating && originatingChannel && originatingTo) {
              const result = await routeReply({
                payload: failurePayload,
                channel: originatingChannel,
                to: originatingTo,
                sessionKey: ctx.SessionKey,
                accountId: ctx.AccountId,
                threadId: routeThreadId,
                cfg,
                isGroup,
                groupId,
              });
              queuedFinal = result.ok || queuedFinal;
              if (result.ok) {
                routedFinalCount += 1;
              }
            } else {
              queuedFinal = dispatcher.sendFinalReply(failurePayload) || queuedFinal;
            }
          }
        }
        continue;
      }
      const ttsReply = await maybeApplyAutomaticTts(reply, "final");
      if (sourceReplyPolicy.suppressAutomaticSourceDelivery) {
        continue;
      }
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        // Route final reply to originating channel.
        const result = await routeReply({
          payload: sanitizeTelegramVisiblePayload(ttsReply),
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: routeThreadId,
          cfg,
          isGroup,
          groupId,
        });
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`,
          );
        }
        queuedFinal = result.ok || queuedFinal;
        if (result.ok) {
          routedFinalCount += 1;
        }
      } else {
        queuedFinal =
          dispatcher.sendFinalReply(sanitizeTelegramVisiblePayload(ttsReply)) || queuedFinal;
      }
    }

    const counts = dispatcher.getQueuedCounts();
    counts.final += routedFinalCount;
    recordProcessed(
      "completed",
      pluginFallbackReason ? { reason: pluginFallbackReason } : undefined,
    );
    markIdle("message_completed");
    return { queuedFinal, counts };
  } catch (err) {
    recordProcessed("error", { error: String(err) });
    markIdle("message_error");
    throw err;
  }
}
