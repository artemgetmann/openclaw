import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import type { SessionEntry, SessionOrigin } from "../../config/sessions/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { DeliverOutboundPayloadsParams, OutboundSendDeps } from "./deliver.js";
import { deliverOutboundPayloads } from "./deliver.js";

const log = createSubsystemLogger("outbound/source-receipt");

export type HeartbeatSourceReceiptContext = NonNullable<
  ChannelThreadingToolContext["sourceReceipt"]
>;

export type SourceReceiptDelivery = {
  status: "sent" | "skipped" | "failed";
  reason?: string;
  link?: string;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseTelegramTarget(raw: string): { to: string; threadId?: string } {
  const stripped = raw
    .trim()
    .replace(/^telegram:/i, "")
    .replace(/^group:/i, "")
    .replace(/^channel:/i, "")
    .trim();
  const topicMatch = /^(.*):topic:([^:]+)$/i.exec(stripped);
  if (!topicMatch) {
    return { to: stripped };
  }
  return {
    to: topicMatch[1]?.trim() ?? stripped,
    threadId: topicMatch[2]?.trim() || undefined,
  };
}

function normalizeTelegramTarget(raw: string): string {
  return parseTelegramTarget(raw).to;
}

function resolveTelegramThreadId(
  explicitThreadId: string | number | undefined,
  rawTarget: string,
): string | number | undefined {
  if (explicitThreadId != null && String(explicitThreadId).trim()) {
    return explicitThreadId;
  }
  return parseTelegramTarget(rawTarget).threadId;
}

function normalizeTelegramUsername(raw: string): string | undefined {
  const trimmed = raw.trim();
  const tmeMatch = /^https?:\/\/t\.me\/([^/\s?#]+)/i.exec(trimmed);
  const value = (tmeMatch?.[1] ?? trimmed.replace(/^@/, "")).trim();
  return /^[a-zA-Z][\w\d_]{4,31}$/.test(value) ? value : undefined;
}

function sameTelegramSurface(params: {
  deliveryTo?: string;
  sourceTo: string;
  deliveryThreadId?: string | number;
  sourceThreadId?: string | number;
}): boolean {
  if (!params.deliveryTo?.trim()) {
    return false;
  }
  // Telegram targets appear in both raw and OpenClaw-prefixed forms depending
  // on where they came from, so compare the transport ids instead of strings.
  const deliveryThreadId = resolveTelegramThreadId(
    params.deliveryThreadId,
    params.deliveryTo ?? "",
  );
  const sourceThreadId = resolveTelegramThreadId(params.sourceThreadId, params.sourceTo);
  return (
    normalizeTelegramTarget(params.deliveryTo) === normalizeTelegramTarget(params.sourceTo) &&
    String(deliveryThreadId ?? "") === String(sourceThreadId ?? "")
  );
}

export function buildTelegramSourceLink(params: {
  to: string;
  threadId?: string | number;
}): string | undefined {
  const parsed = parseTelegramTarget(params.to);
  const target = parsed.to;
  const threadId = resolveTelegramThreadId(params.threadId, params.to);
  const privateSupergroup = /^-100(\d+)$/.exec(target);
  if (privateSupergroup && threadId) {
    return `https://t.me/c/${privateSupergroup[1]}/${encodeURIComponent(threadId)}`;
  }
  const username = normalizeTelegramUsername(target);
  if (username) {
    return threadId
      ? `https://t.me/${username}/${encodeURIComponent(threadId)}`
      : `https://t.me/${username}`;
  }
  return undefined;
}

function sourceFromOrigin(origin?: SessionOrigin): HeartbeatSourceReceiptContext | null {
  if (normalizeMessageChannel(origin?.provider) !== "telegram") {
    return null;
  }
  const sourceTo = readString(origin?.to);
  if (!sourceTo) {
    return null;
  }
  return {
    kind: "heartbeat",
    sourceChannel: "telegram",
    sourceTo,
    sourceAccountId: readString(origin?.accountId),
    sourceThreadId: resolveTelegramThreadId(origin?.threadId, sourceTo),
    sourceLabel: readString(origin?.label),
  };
}

export function resolveHeartbeatSourceReceiptContext(params: {
  entry?: SessionEntry;
  sessionKey: string;
  agentId: string;
  heartbeatDelivery?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
}): HeartbeatSourceReceiptContext | undefined {
  const originSource = sourceFromOrigin(params.entry?.origin);
  if (!originSource) {
    return undefined;
  }

  const deliveryChannel = normalizeMessageChannel(params.heartbeatDelivery?.channel);
  const deliveryTo = readString(params.heartbeatDelivery?.to);
  const deliveryThreadId = params.heartbeatDelivery?.threadId;
  const sameSurface = Boolean(
    deliveryChannel === "telegram" &&
    sameTelegramSurface({
      deliveryTo,
      sourceTo: originSource.sourceTo,
      deliveryThreadId,
      sourceThreadId: originSource.sourceThreadId,
    }),
  );
  if (sameSurface) {
    return undefined;
  }

  return {
    ...originSource,
    sourceLabel:
      originSource.sourceLabel ??
      readString(params.entry?.displayName) ??
      readString(params.entry?.label) ??
      readString(params.entry?.groupChannel) ??
      readString(params.entry?.subject),
    sourceSessionKey: params.sessionKey,
    agentId: params.agentId,
  };
}

function formatChannelName(channel: string): string {
  if (channel.toLowerCase() === "whatsapp") {
    return "WhatsApp";
  }
  if (channel.toLowerCase() === "telegram") {
    return "Telegram";
  }
  return channel;
}

function formatSentContent(params: { message: string; mediaUrls?: string[] }): string {
  const parts: string[] = [];
  const message = params.message.trim();
  if (message) {
    parts.push(message);
  }
  if (params.mediaUrls?.length) {
    parts.push(`Media: ${params.mediaUrls.join(", ")}`);
  }
  return parts.join("\n");
}

export function buildHeartbeatSourceReceiptPayload(params: {
  source: HeartbeatSourceReceiptContext;
  sentChannel: string;
  sentTo: string;
  message: string;
  mediaUrls?: string[];
}): ReplyPayload {
  const sentContent = formatSentContent({
    message: params.message,
    mediaUrls: params.mediaUrls,
  });
  const target = params.sentTo.trim();
  const channel = formatChannelName(params.sentChannel);
  const link = buildTelegramSourceLink({
    to: params.source.sourceTo,
    threadId: params.source.sourceThreadId,
  });
  const sourceTarget = normalizeTelegramTarget(params.source.sourceTo);
  const sourceThreadId = resolveTelegramThreadId(
    params.source.sourceThreadId,
    params.source.sourceTo,
  );
  const sourceBits = [
    params.source.sourceLabel?.trim(),
    link,
    !link
      ? `telegram:${sourceTarget}${sourceThreadId != null ? ` thread ${sourceThreadId}` : ""}`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  const sourceLine = sourceBits.length ? `\nSource: ${sourceBits.join(" | ")}` : "";
  const body = sentContent || "(no text content)";
  return {
    text: [
      `The user approved/sent this exact message via ${channel}${target ? ` to ${target}` : ""}:`,
      body,
      sourceLine.trimEnd(),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export async function deliverHeartbeatSourceReceipt(params: {
  cfg: DeliverOutboundPayloadsParams["cfg"];
  toolContext?: ChannelThreadingToolContext;
  sentChannel: string;
  sentTo: string;
  message: string;
  mediaUrls?: string[];
  deps?: OutboundSendDeps;
  deliver?: typeof deliverOutboundPayloads;
}): Promise<SourceReceiptDelivery> {
  const source = params.toolContext?.sourceReceipt;
  if (!source) {
    return { status: "skipped", reason: "missing-source" };
  }
  if (source.kind !== "heartbeat" || source.sourceChannel !== "telegram") {
    return { status: "skipped", reason: "unsupported-source" };
  }
  if (!source.sourceTo.trim()) {
    return { status: "skipped", reason: "missing-source-target" };
  }
  const sourceTarget = normalizeTelegramTarget(source.sourceTo);
  const sourceThreadId = resolveTelegramThreadId(source.sourceThreadId, source.sourceTo);

  const payload = buildHeartbeatSourceReceiptPayload({
    source,
    sentChannel: params.sentChannel,
    sentTo: params.sentTo,
    message: params.message,
    mediaUrls: params.mediaUrls,
  });
  const deliver = params.deliver ?? deliverOutboundPayloads;
  try {
    const results = await deliver({
      cfg: params.cfg,
      channel: "telegram",
      to: sourceTarget,
      accountId: source.sourceAccountId,
      threadId: sourceThreadId,
      payloads: [payload],
      deps: params.deps,
      mirror:
        source.agentId && source.sourceSessionKey
          ? {
              agentId: source.agentId,
              sessionKey: source.sourceSessionKey,
              text: payload.text ?? "",
              idempotencyKey: [
                "heartbeat-source-receipt",
                sourceTarget,
                String(sourceThreadId ?? ""),
                params.sentChannel,
                params.sentTo,
                params.message,
              ].join(":"),
            }
          : undefined,
    });
    const delivered = results.some((result) => result.messageId.trim());
    if (!delivered) {
      return { status: "skipped", reason: "unconfirmed-receipt" };
    }
    return {
      status: "sent",
      link: buildTelegramSourceLink({
        to: source.sourceTo,
        threadId: source.sourceThreadId,
      }),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(`failed to deliver heartbeat source receipt: ${reason}`);
    return { status: "failed", reason };
  }
}
