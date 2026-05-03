import type { MessagingToolSend } from "../../agents/pi-embedded-runner.js";
import { HEARTBEAT_TOKEN, isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { isRenderablePayload, shouldSuppressMessagingToolReplies } from "./reply-payloads.js";

export const EMPTY_FINAL_REPLY_TEXT =
  "I finished the run, but the model did not return a visible reply.";

function isIntentionalSilentPayload(payload: ReplyPayload): boolean {
  const text = payload.text?.trim();
  if (!text) {
    return false;
  }
  return isSilentReplyText(text, SILENT_REPLY_TOKEN) || isSilentReplyText(text, HEARTBEAT_TOKEN);
}

function isUserVisibleRun(opts: GetReplyOptions | undefined, isHeartbeat: boolean): boolean {
  if (isHeartbeat || opts?.isHeartbeat === true) {
    return false;
  }
  // Cron/system turns can legitimately do nothing. Only user-facing turns get
  // the fallback so background no-ops stay quiet.
  if (opts?.typingPolicy === "system_event" || opts?.typingPolicy === "heartbeat") {
    return false;
  }
  return true;
}

export function shouldReturnEmptyFinalFallback(params: {
  opts?: GetReplyOptions;
  isHeartbeat: boolean;
  rawPayloads: ReplyPayload[];
  replyPayloads?: ReplyPayload[];
  didSendVisibleReply: boolean;
  messagingToolSentTargets?: MessagingToolSend[];
  messageProvider?: string;
  originatingTo?: string;
  accountId?: string;
}): boolean {
  if (!isUserVisibleRun(params.opts, params.isHeartbeat)) {
    return false;
  }
  if (params.didSendVisibleReply) {
    return false;
  }
  if (
    shouldSuppressMessagingToolReplies({
      messageProvider: params.messageProvider,
      messagingToolSentTargets: params.messagingToolSentTargets,
      originatingTo: params.originatingTo,
      accountId: params.accountId,
    })
  ) {
    return false;
  }
  if (params.replyPayloads?.some(isRenderablePayload)) {
    return false;
  }
  if (params.rawPayloads.some(isIntentionalSilentPayload)) {
    return false;
  }
  return true;
}

export function buildEmptyFinalFallbackPayload(): ReplyPayload {
  return { text: EMPTY_FINAL_REPLY_TEXT };
}
