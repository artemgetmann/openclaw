import { normalizeCommandBody } from "../../../src/auto-reply/commands-registry.js";
import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../../src/auto-reply/envelope.js";
import {
  buildPendingHistoryContextFromMap,
  type HistoryEntry,
} from "../../../src/auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../../src/auto-reply/reply/inbound-context.js";
import { toLocationContext } from "../../../src/channels/location.js";
import { recordInboundSession } from "../../../src/channels/session.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { readSessionUpdatedAt, resolveStorePath } from "../../../src/config/sessions.js";
import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../../../src/config/types.js";
import { logVerbose, shouldLogVerbose } from "../../../src/globals.js";
import { loadMonitorStore, resolveMonitorStorePath } from "../../../src/monitor/store.js";
import type { MonitorRecord } from "../../../src/monitor/types.js";
import type { ResolvedAgentRoute } from "../../../src/routing/resolve-route.js";
import { resolveInboundLastRouteSessionKey } from "../../../src/routing/resolve-route.js";
import { resolvePinnedMainDmOwnerFromAllowlist } from "../../../src/security/dm-policy-shared.js";
import { normalizeAllowFrom } from "./bot-access.js";
import type {
  TelegramMediaRef,
  TelegramMessageContextOptions,
} from "./bot-message-context.types.js";
import {
  buildGroupLabel,
  buildSenderLabel,
  buildSenderName,
  buildTelegramGroupFrom,
  describeReplyTarget,
  normalizeForwardedContext,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { resolveTelegramGroupPromptSettings } from "./group-config-helpers.js";

const MONITOR_CONTEXT_LIMIT = 5;
const MONITOR_FIELD_LIMIT = 220;

function compactMonitorField(value: unknown, maxChars = MONITOR_FIELD_LIMIT): string | undefined {
  const text =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? JSON.stringify(value)
        : undefined;
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}...` : normalized;
}

export function buildTelegramMonitorAwarenessNote(params: {
  monitors: MonitorRecord[];
  sessionKey: string;
}): string | undefined {
  const active = params.monitors
    .filter(
      (monitor) => monitor.status === "active" && monitor.originSessionKey === params.sessionKey,
    )
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, MONITOR_CONTEXT_LIMIT);
  if (active.length === 0) {
    return undefined;
  }

  const lines = active.map((monitor) => {
    const label = compactMonitorField(monitor.name) ?? monitor.monitorId;
    const source = compactMonitorField(monitor.sourceTarget, 140);
    const checkpoint = monitor.lastCheckpoint as Record<string, unknown> | undefined;
    const summary = compactMonitorField(checkpoint?.summary ?? monitor.lastCheckpoint);
    const nextStep = compactMonitorField(checkpoint?.suggestedNextStep);
    const rawRef = compactMonitorField(checkpoint?.rawRef, 140);
    return [
      `- ${label} (monitorId=${monitor.monitorId})`,
      source ? `source: ${source}` : undefined,
      summary ? `last: ${summary}` : undefined,
      nextStep ? `next: ${nextStep}` : undefined,
      rawRef ? `rawRef: ${rawRef}` : undefined,
    ]
      .filter(Boolean)
      .join("; ");
  });

  return [
    "[Active monitor context]",
    "These are compact status notes for monitors tied to this Telegram session. Use them before older chat memory when the user asks about watched people/tasks or replies to monitor updates.",
    ...lines,
    "[/Active monitor context]",
  ].join("\n");
}

async function resolveTelegramMonitorAwarenessNote(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): Promise<string | undefined> {
  try {
    const storePath = resolveMonitorStorePath({ cronStorePath: params.cfg.cron?.store });
    const store = await loadMonitorStore(storePath);
    return buildTelegramMonitorAwarenessNote({
      monitors: store.monitors,
      sessionKey: params.sessionKey,
    });
  } catch (err) {
    logVerbose(`telegram: failed loading monitor awareness context: ${String(err)}`);
    return undefined;
  }
}

export async function buildTelegramInboundContextPayload(params: {
  cfg: OpenClawConfig;
  primaryCtx: TelegramContext;
  msg: TelegramContext["message"];
  allMedia: TelegramMediaRef[];
  replyMedia: TelegramMediaRef[];
  isGroup: boolean;
  isForum: boolean;
  chatId: number | string;
  senderId: string;
  senderUsername: string;
  resolvedThreadId?: number;
  dmThreadId?: number;
  threadSpec: TelegramThreadSpec;
  route: ResolvedAgentRoute;
  rawBody: string;
  bodyText: string;
  historyKey?: string;
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  stickerCacheHit: boolean;
  effectiveWasMentioned: boolean;
  commandAuthorized: boolean;
  locationData?: import("../../../src/channels/location.js").NormalizedLocation;
  options?: TelegramMessageContextOptions;
  dmAllowFrom?: Array<string | number>;
  ownerAllowFrom?: Array<string | number>;
  contextAllowFrom?: Array<string | number>;
}): Promise<{
  ctxPayload: ReturnType<typeof finalizeInboundContext>;
  skillFilter: string[] | undefined;
}> {
  const {
    cfg,
    primaryCtx,
    msg,
    allMedia,
    replyMedia,
    isGroup,
    isForum,
    chatId,
    senderId,
    senderUsername,
    resolvedThreadId,
    dmThreadId,
    threadSpec,
    route,
    rawBody,
    bodyText,
    historyKey,
    historyLimit,
    groupHistories,
    groupConfig,
    topicConfig,
    stickerCacheHit,
    effectiveWasMentioned,
    commandAuthorized,
    locationData,
    options,
    dmAllowFrom,
    ownerAllowFrom,
    contextAllowFrom,
  } = params;
  const replyTarget = describeReplyTarget(msg);
  const forwardOrigin = normalizeForwardedContext(msg);
  const replyForwardAnnotation = replyTarget?.forwardedFrom
    ? `[Forwarded from ${replyTarget.forwardedFrom.from}${
        replyTarget.forwardedFrom.date
          ? ` at ${new Date(replyTarget.forwardedFrom.date * 1000).toISOString()}`
          : ""
      }]\n`
    : "";
  const replySuffix = replyTarget
    ? replyTarget.kind === "quote"
      ? `\n\n[Quoting ${replyTarget.sender}${
          replyTarget.id ? ` id:${replyTarget.id}` : ""
        }]\n${replyForwardAnnotation}"${replyTarget.body}"\n[/Quoting]`
      : `\n\n[Replying to ${replyTarget.sender}${
          replyTarget.id ? ` id:${replyTarget.id}` : ""
        }]\n${replyForwardAnnotation}${replyTarget.body}\n[/Replying]`
    : "";
  const forwardPrefix = forwardOrigin
    ? `[Forwarded from ${forwardOrigin.from}${
        forwardOrigin.date ? ` at ${new Date(forwardOrigin.date * 1000).toISOString()}` : ""
      }]\n`
    : "";
  const groupLabel = isGroup ? buildGroupLabel(msg, chatId, resolvedThreadId) : undefined;
  const senderName = buildSenderName(msg);
  const conversationLabel = isGroup
    ? (groupLabel ?? `group:${chatId}`)
    : buildSenderLabel(msg, senderId || chatId);
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = formatInboundEnvelope({
    channel: "Telegram",
    from: conversationLabel,
    timestamp: msg.date ? msg.date * 1000 : undefined,
    body: `${forwardPrefix}${bodyText}${replySuffix}`,
    chatType: isGroup ? "group" : "direct",
    sender: {
      name: senderName,
      username: senderUsername || undefined,
      id: senderId || undefined,
    },
    previousTimestamp,
    envelope: envelopeOptions,
  });
  // Put compact monitor state in the same turn as the user's Telegram message.
  // This keeps natural-language replies grounded without stuffing monitor
  // transcripts into the main chat or relying on the model to remember a tool call.
  const monitorAwarenessNote = await resolveTelegramMonitorAwarenessNote({
    cfg,
    sessionKey: route.sessionKey,
  });
  let combinedBody = monitorAwarenessNote ? `${monitorAwarenessNote}\n\n${body}` : body;
  if (isGroup && historyKey && historyLimit > 0) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Telegram",
          from: groupLabel ?? `group:${chatId}`,
          timestamp: entry.timestamp,
          body: `${entry.body} [id:${entry.messageId ?? "unknown"} chat:${chatId}]`,
          chatType: "group",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }

  const { skillFilter, groupSystemPrompt } = resolveTelegramGroupPromptSettings({
    groupConfig,
    topicConfig,
  });
  const commandBody = normalizeCommandBody(rawBody, {
    botUsername: primaryCtx.me?.username?.toLowerCase(),
  });
  const inboundHistory =
    isGroup && historyKey && historyLimit > 0
      ? (groupHistories.get(historyKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;
  const currentMediaForContext = stickerCacheHit ? [] : allMedia;
  const contextMedia = [...currentMediaForContext, ...replyMedia];
  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: bodyText,
    InboundHistory: inboundHistory,
    RawBody: rawBody,
    CommandBody: commandBody,
    From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
    To: `telegram:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: conversationLabel,
    GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
    GroupSystemPrompt: isGroup || (!isGroup && groupConfig) ? groupSystemPrompt : undefined,
    SenderName: senderName,
    SenderId: senderId || undefined,
    SenderUsername: senderUsername || undefined,
    Provider: "telegram",
    Surface: "telegram",
    BotUsername: primaryCtx.me?.username ?? undefined,
    MessageSid: options?.messageIdOverride ?? String(msg.message_id),
    ReplyToId: replyTarget?.id,
    ReplyToBody: replyTarget?.body,
    ReplyToSender: replyTarget?.sender,
    ReplyToIsQuote: replyTarget?.kind === "quote" ? true : undefined,
    ReplyToQuoteText: replyTarget?.quoteText,
    ReplyToQuotePosition: replyTarget?.quotePosition,
    ReplyToQuoteEntities: replyTarget?.quoteEntities,
    ReplyToForwardedFrom: replyTarget?.forwardedFrom?.from,
    ReplyToForwardedFromType: replyTarget?.forwardedFrom?.fromType,
    ReplyToForwardedFromId: replyTarget?.forwardedFrom?.fromId,
    ReplyToForwardedFromUsername: replyTarget?.forwardedFrom?.fromUsername,
    ReplyToForwardedFromTitle: replyTarget?.forwardedFrom?.fromTitle,
    ReplyToForwardedDate: replyTarget?.forwardedFrom?.date
      ? replyTarget.forwardedFrom.date * 1000
      : undefined,
    ForwardedFrom: forwardOrigin?.from,
    ForwardedFromType: forwardOrigin?.fromType,
    ForwardedFromId: forwardOrigin?.fromId,
    ForwardedFromUsername: forwardOrigin?.fromUsername,
    ForwardedFromTitle: forwardOrigin?.fromTitle,
    ForwardedFromSignature: forwardOrigin?.fromSignature,
    ForwardedFromChatType: forwardOrigin?.fromChatType,
    ForwardedFromMessageId: forwardOrigin?.fromMessageId,
    ForwardedDate: forwardOrigin?.date ? forwardOrigin.date * 1000 : undefined,
    Timestamp: msg.date ? msg.date * 1000 : undefined,
    WasMentioned: isGroup ? effectiveWasMentioned : undefined,
    MediaPath: contextMedia.length > 0 ? contextMedia[0]?.path : undefined,
    MediaType: contextMedia.length > 0 ? contextMedia[0]?.contentType : undefined,
    MediaUrl: contextMedia.length > 0 ? contextMedia[0]?.path : undefined,
    MediaPaths: contextMedia.length > 0 ? contextMedia.map((m) => m.path) : undefined,
    MediaUrls: contextMedia.length > 0 ? contextMedia.map((m) => m.path) : undefined,
    MediaTypes:
      contextMedia.length > 0
        ? (contextMedia.map((m) => m.contentType).filter(Boolean) as string[])
        : undefined,
    Sticker: allMedia[0]?.stickerMetadata,
    StickerMediaIncluded: allMedia[0]?.stickerMetadata ? !stickerCacheHit : undefined,
    ...(locationData ? toLocationContext(locationData) : undefined),
    CommandAuthorized: commandAuthorized,
    OwnerAllowFrom: ownerAllowFrom,
    ContextAllowFrom: contextAllowFrom,
    MessageThreadId: threadSpec.id,
    IsForum: isForum,
    OriginatingChannel: "telegram" as const,
    OriginatingTo: `telegram:${chatId}`,
  });

  const pinnedMainDmOwner = !isGroup
    ? resolvePinnedMainDmOwnerFromAllowlist({
        dmScope: cfg.session?.dmScope,
        allowFrom: dmAllowFrom,
        normalizeEntry: (entry) => normalizeAllowFrom([entry]).entries[0],
      })
    : null;
  const updateLastRouteSessionKey = resolveInboundLastRouteSessionKey({
    route,
    sessionKey: route.sessionKey,
  });

  await recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    // A brand-new DM topic must inherit model/thinking from its parent before
    // metadata writes create the child entry. Otherwise the child exists as a
    // blank session and later session init correctly skips inheritance because
    // it no longer looks brand new.
    createIfMissing: !(threadSpec.scope === "dm" && threadSpec.id != null),
    updateLastRoute: !isGroup
      ? {
          sessionKey: updateLastRouteSessionKey,
          channel: "telegram",
          to: `telegram:${chatId}`,
          accountId: route.accountId,
          threadId: dmThreadId != null ? String(dmThreadId) : undefined,
          mainDmOwnerPin:
            updateLastRouteSessionKey === route.mainSessionKey && pinnedMainDmOwner && senderId
              ? {
                  ownerRecipient: pinnedMainDmOwner,
                  senderRecipient: senderId,
                  onSkip: ({ ownerRecipient, senderRecipient }) => {
                    logVerbose(
                      `telegram: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                    );
                  },
                }
              : undefined,
        }
      : undefined,
    onRecordError: (err) => {
      logVerbose(`telegram: failed updating session meta: ${String(err)}`);
    },
  });

  if (replyTarget && shouldLogVerbose()) {
    const preview = replyTarget.body.replace(/\s+/g, " ").slice(0, 120);
    logVerbose(
      `telegram reply-context: replyToId=${replyTarget.id} replyToSender=${replyTarget.sender} replyToBody="${preview}"`,
    );
  }

  if (forwardOrigin && shouldLogVerbose()) {
    logVerbose(
      `telegram forward-context: forwardedFrom="${forwardOrigin.from}" type=${forwardOrigin.fromType}`,
    );
  }

  if (shouldLogVerbose()) {
    const preview = body.slice(0, 200).replace(/\n/g, "\\n");
    const mediaInfo = allMedia.length > 1 ? ` mediaCount=${allMedia.length}` : "";
    const topicInfo = resolvedThreadId != null ? ` topic=${resolvedThreadId}` : "";
    logVerbose(
      `telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length}${mediaInfo}${topicInfo} preview="${preview}"`,
    );
  }

  return {
    ctxPayload,
    skillFilter,
  };
}
