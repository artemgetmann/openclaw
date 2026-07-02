import type { ReplyPayload } from "../types.js";

const COPY_SAFE_DRAFT_MARKER = "copySafeDraft";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isCopySafeDraftReplyPayload(payload: ReplyPayload): boolean {
  const channelData = payload.channelData;
  if (!isRecord(channelData)) {
    return false;
  }
  const openclaw = channelData.openclaw;
  return isRecord(openclaw) && openclaw[COPY_SAFE_DRAFT_MARKER] === true;
}

export function markCopySafeDraftReplyPayload(payload: ReplyPayload): ReplyPayload {
  const channelData = isRecord(payload.channelData) ? payload.channelData : {};
  const openclaw = isRecord(channelData.openclaw) ? channelData.openclaw : {};

  // Copyable drafts are a transport/rendering contract, not a prompt contract.
  // Callers that know a payload is meant to be pasted elsewhere can mark it
  // structurally so Telegram avoids native rich-message behavior and preserves
  // literal URLs inside copyable code blocks.
  return {
    ...payload,
    channelData: {
      ...channelData,
      openclaw: {
        ...openclaw,
        [COPY_SAFE_DRAFT_MARKER]: true,
      },
    },
  };
}
