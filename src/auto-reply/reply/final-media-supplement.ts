import type { ReplyPayload } from "../types.js";

type FinalMediaSupplementOpenClawData = {
  finalMediaSupplement?: "captionless";
};

function resolveOpenClawData(payload: ReplyPayload): Record<string, unknown> {
  const openclaw =
    payload.channelData &&
    typeof payload.channelData === "object" &&
    !Array.isArray(payload.channelData)
      ? payload.channelData.openclaw
      : undefined;
  return openclaw && typeof openclaw === "object" && !Array.isArray(openclaw)
    ? (openclaw as Record<string, unknown>)
    : {};
}

export function markCaptionlessFinalMediaSupplement(payload: ReplyPayload): ReplyPayload {
  const channelData =
    payload.channelData &&
    typeof payload.channelData === "object" &&
    !Array.isArray(payload.channelData)
      ? payload.channelData
      : {};
  return {
    ...payload,
    channelData: {
      ...channelData,
      openclaw: {
        ...resolveOpenClawData(payload),
        finalMediaSupplement: "captionless",
      } satisfies FinalMediaSupplementOpenClawData,
    },
  };
}

export function isCaptionlessFinalMediaSupplement(payload: ReplyPayload): boolean {
  const openclaw = resolveOpenClawData(payload) as FinalMediaSupplementOpenClawData;
  return openclaw.finalMediaSupplement === "captionless";
}
