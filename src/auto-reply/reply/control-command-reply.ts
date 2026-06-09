import type { ReplyPayload } from "../types.js";

const CONTROL_COMMAND_REPLY_MARKER = "controlCommandReply";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isControlCommandReplyPayload(payload: ReplyPayload): boolean {
  const channelData = payload.channelData;
  if (!isRecord(channelData)) {
    return false;
  }
  const openclaw = channelData.openclaw;
  return isRecord(openclaw) && openclaw[CONTROL_COMMAND_REPLY_MARKER] === true;
}

export function markControlCommandReplyPayload(payload: ReplyPayload): ReplyPayload {
  const channelData = isRecord(payload.channelData) ? payload.channelData : {};
  const openclaw = isRecord(channelData.openclaw) ? channelData.openclaw : {};

  // Command replies are product-control UI. Mark them structurally so later
  // delivery layers can keep text visible without guessing from English copy or
  // command names.
  return {
    ...payload,
    channelData: {
      ...channelData,
      openclaw: {
        ...openclaw,
        [CONTROL_COMMAND_REPLY_MARKER]: true,
      },
    },
  };
}

export function markControlCommandReplyPayloads(
  reply: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | ReplyPayload[] | undefined {
  if (Array.isArray(reply)) {
    return reply.map((payload) => markControlCommandReplyPayload(payload));
  }
  return reply ? markControlCommandReplyPayload(reply) : reply;
}
