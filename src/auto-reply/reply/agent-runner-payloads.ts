import type { ReplyToMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import { formatBunFetchSocketError, isBunFetchSocketError } from "./agent-runner-utils.js";
import { createBlockReplyContentKey, type BlockReplyPipeline } from "./block-reply-pipeline.js";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
} from "./origin-routing.js";
import { normalizeReplyPayloadDirectives } from "./reply-delivery.js";
import {
  applyReplyThreading,
  filterMessagingToolDuplicates,
  filterMessagingToolMediaDuplicates,
  isRenderablePayload,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";

function hasPayloadMedia(payload: ReplyPayload): boolean {
  return Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
}

function hasOpenClawSourcePreviewMarker(payload: ReplyPayload): boolean {
  const channelData = payload.channelData;
  const openclaw =
    channelData && typeof channelData === "object" && !Array.isArray(channelData)
      ? channelData.openclaw
      : undefined;

  // Source previews are working-status payloads for transient channel previews.
  // The marker, not the text content, defines the contract; finalization must
  // never upgrade these payloads into durable replies.
  return (
    openclaw != null &&
    typeof openclaw === "object" &&
    !Array.isArray(openclaw) &&
    (openclaw as { sourcePreview?: unknown }).sourcePreview === true
  );
}

function isTextOnlyDurableFinalPayload(payload: ReplyPayload): boolean {
  return (
    typeof payload.text === "string" &&
    payload.text.trim().length > 0 &&
    !hasPayloadMedia(payload) &&
    !payload.interactive &&
    !payload.btw &&
    !payload.isError
  );
}

function keepLastTextOnlyFinalPayload(payloads: ReplyPayload[]): ReplyPayload[] {
  const lastTextOnlyIndex = payloads.findLastIndex(isTextOnlyDurableFinalPayload);
  if (lastTextOnlyIndex < 0) {
    return payloads;
  }

  // Telegram progress-preview runs can leave several model-authored status
  // snapshots in the final payload array. Only the last text final is product
  // output; earlier text-only finals are progress and must not become durable.
  return payloads.filter(
    (payload, index) => !isTextOnlyDurableFinalPayload(payload) || index === lastTextOnlyIndex,
  );
}

async function normalizeReplyPayloadMedia(params: {
  payload: ReplyPayload;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}): Promise<ReplyPayload> {
  if (!params.normalizeMediaPaths || !hasPayloadMedia(params.payload)) {
    return params.payload;
  }

  try {
    return await params.normalizeMediaPaths(params.payload);
  } catch (err) {
    logVerbose(`reply payload media normalization failed: ${String(err)}`);
    return {
      ...params.payload,
      mediaUrl: undefined,
      mediaUrls: undefined,
      audioAsVoice: false,
    };
  }
}

async function normalizeSentMediaUrlsForDedupe(params: {
  sentMediaUrls: string[];
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}): Promise<string[]> {
  if (params.sentMediaUrls.length === 0 || !params.normalizeMediaPaths) {
    return params.sentMediaUrls;
  }

  const normalizedUrls: string[] = [];
  const seen = new Set<string>();
  for (const raw of params.sentMediaUrls) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalizedUrls.push(trimmed);
    }
    try {
      const normalized = await params.normalizeMediaPaths({
        mediaUrl: trimmed,
        mediaUrls: [trimmed],
      });
      const normalizedMediaUrls = normalized.mediaUrls?.length
        ? normalized.mediaUrls
        : normalized.mediaUrl
          ? [normalized.mediaUrl]
          : [];
      for (const mediaUrl of normalizedMediaUrls) {
        const candidate = mediaUrl.trim();
        if (!candidate || seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);
        normalizedUrls.push(candidate);
      }
    } catch (err) {
      logVerbose(`messaging tool sent-media normalization failed: ${String(err)}`);
    }
  }

  return normalizedUrls;
}

export async function buildReplyPayloads(params: {
  payloads: ReplyPayload[];
  isHeartbeat: boolean;
  didLogHeartbeatStrip: boolean;
  blockStreamingEnabled: boolean;
  blockReplyPipeline: BlockReplyPipeline | null;
  /** Payload keys sent directly (not via pipeline) during tool flush. */
  directlySentBlockKeys?: Set<string>;
  replyToMode: ReplyToMode;
  replyToChannel?: OriginatingChannelType;
  currentMessageId?: string;
  messageProvider?: string;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: Parameters<
    typeof shouldSuppressMessagingToolReplies
  >[0]["messagingToolSentTargets"];
  preserveFinalPayloadsAfterBlockStreaming?: boolean;
  originatingChannel?: OriginatingChannelType;
  originatingTo?: string;
  accountId?: string;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}): Promise<{ replyPayloads: ReplyPayload[]; didLogHeartbeatStrip: boolean }> {
  let didLogHeartbeatStrip = params.didLogHeartbeatStrip;
  const sanitizedPayloads = params.isHeartbeat
    ? params.payloads
    : params.payloads.flatMap((payload) => {
        let text = payload.text;

        if (payload.isError && text && isBunFetchSocketError(text)) {
          text = formatBunFetchSocketError(text);
        }

        if (!text || !text.includes("HEARTBEAT_OK")) {
          return [{ ...payload, text }];
        }
        const stripped = stripHeartbeatToken(text, { mode: "message" });
        if (stripped.didStrip && !didLogHeartbeatStrip) {
          didLogHeartbeatStrip = true;
          logVerbose("Stripped stray HEARTBEAT_OK token from reply");
        }
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        if (stripped.shouldSkip && !hasMedia) {
          return [];
        }
        return [{ ...payload, text: stripped.text }];
      });

  const replyTaggedPayloads = (
    await Promise.all(
      applyReplyThreading({
        payloads: sanitizedPayloads,
        replyToMode: params.replyToMode,
        replyToChannel: params.replyToChannel,
        currentMessageId: params.currentMessageId,
      }).map(async (payload) => {
        const parsed = normalizeReplyPayloadDirectives({
          payload,
          currentMessageId: params.currentMessageId,
          silentToken: SILENT_REPLY_TOKEN,
          parseMode: "always",
        }).payload;
        return await normalizeReplyPayloadMedia({
          payload: parsed,
          normalizeMediaPaths: params.normalizeMediaPaths,
        });
      }),
    )
  ).filter(isRenderablePayload);

  // Drop final payloads only when block streaming succeeded end-to-end.
  // If streaming aborted (e.g., timeout), fall back to final payloads.
  const shouldDropFinalPayloads =
    !params.preserveFinalPayloadsAfterBlockStreaming &&
    params.blockStreamingEnabled &&
    Boolean(params.blockReplyPipeline?.didStream()) &&
    !params.blockReplyPipeline?.isAborted();
  const messagingToolSentTexts = params.messagingToolSentTexts ?? [];
  const messagingToolSentTargets = params.messagingToolSentTargets ?? [];
  const suppressMessagingToolReplies = shouldSuppressMessagingToolReplies({
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: params.originatingChannel,
      provider: params.messageProvider,
    }),
    messagingToolSentTargets,
    originatingTo: resolveOriginMessageTo({
      originatingTo: params.originatingTo,
    }),
    accountId: resolveOriginAccountId({
      originatingAccountId: params.accountId,
    }),
  });
  // Only dedupe against messaging tool sends for the same origin target.
  // Cross-target sends (for example posting to another channel) must not
  // suppress the current conversation's final reply.
  // If target metadata is unavailable, keep legacy dedupe behavior.
  const dedupeMessagingToolPayloads =
    suppressMessagingToolReplies || messagingToolSentTargets.length === 0;
  const messagingToolSentMediaUrls = dedupeMessagingToolPayloads
    ? await normalizeSentMediaUrlsForDedupe({
        sentMediaUrls: params.messagingToolSentMediaUrls ?? [],
        normalizeMediaPaths: params.normalizeMediaPaths,
      })
    : (params.messagingToolSentMediaUrls ?? []);
  const dedupedPayloads = dedupeMessagingToolPayloads
    ? filterMessagingToolDuplicates({
        payloads: replyTaggedPayloads,
        sentTexts: messagingToolSentTexts,
      })
    : replyTaggedPayloads;
  const mediaFilteredPayloads = dedupeMessagingToolPayloads
    ? filterMessagingToolMediaDuplicates({
        payloads: dedupedPayloads,
        sentMediaUrls: messagingToolSentMediaUrls,
      })
    : dedupedPayloads;
  const durablePayloads = mediaFilteredPayloads.filter(
    (payload) => !hasOpenClawSourcePreviewMarker(payload),
  );
  const preservedFinalPayloads = params.preserveFinalPayloadsAfterBlockStreaming
    ? keepLastTextOnlyFinalPayload(durablePayloads)
    : durablePayloads;
  // Filter out payloads already sent via pipeline or directly during tool flush.
  const filteredPayloads = shouldDropFinalPayloads
    ? []
    : params.blockStreamingEnabled
      ? preservedFinalPayloads.filter(
          (payload) => !params.blockReplyPipeline?.hasSentPayload(payload),
        )
      : params.directlySentBlockKeys?.size
        ? preservedFinalPayloads.filter(
            (payload) => !params.directlySentBlockKeys!.has(createBlockReplyContentKey(payload)),
          )
        : preservedFinalPayloads;
  const replyPayloads = suppressMessagingToolReplies ? [] : filteredPayloads;

  return {
    replyPayloads,
    didLogHeartbeatStrip,
  };
}
