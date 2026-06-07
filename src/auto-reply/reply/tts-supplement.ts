import type { ReplyPayload } from "../types.js";

export function hasReplyPayloadMedia(payload: ReplyPayload): boolean {
  return Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
}

export function buildTtsAudioSupplementPayload(params: {
  sourcePayload: ReplyPayload;
  ttsPayload: ReplyPayload;
}): ReplyPayload | undefined {
  const { sourcePayload, ttsPayload } = params;
  if (hasReplyPayloadMedia(sourcePayload) || !hasReplyPayloadMedia(ttsPayload)) {
    return undefined;
  }

  const supplement: ReplyPayload = {};
  if (ttsPayload.mediaUrl) {
    supplement.mediaUrl = ttsPayload.mediaUrl;
  }
  if (ttsPayload.mediaUrls?.length) {
    supplement.mediaUrls = ttsPayload.mediaUrls;
  }
  if (ttsPayload.audioAsVoice !== undefined) {
    supplement.audioAsVoice = ttsPayload.audioAsVoice;
  }
  return supplement;
}
