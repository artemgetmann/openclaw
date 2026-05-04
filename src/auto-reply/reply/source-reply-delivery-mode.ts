import { normalizeChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionSendPolicyDecision } from "../../sessions/send-policy.js";
import type { SourceReplyDeliveryMode } from "../types.js";

export type SourceReplyDeliveryModeContext = {
  ChatType?: string;
  CommandSource?: "text" | "native";
};

export function resolveSourceReplyDeliveryMode(params: {
  cfg: OpenClawConfig;
  ctx: SourceReplyDeliveryModeContext;
  requested?: SourceReplyDeliveryMode;
  messageToolAvailable?: boolean;
}): SourceReplyDeliveryMode {
  if (params.requested) {
    return params.requested;
  }
  if (params.ctx.CommandSource === "native") {
    return "automatic";
  }

  const chatType = normalizeChatType(params.ctx.ChatType);
  const configuredMode =
    chatType === "group" || chatType === "channel"
      ? (params.cfg.messages?.groupChat?.visibleReplies ?? params.cfg.messages?.visibleReplies)
      : params.cfg.messages?.visibleReplies;
  const mode = configuredMode === "message_tool" ? "message_tool_only" : "automatic";
  return mode === "message_tool_only" && params.messageToolAvailable === false ? "automatic" : mode;
}

export type SourceReplyVisibilityPolicy = {
  sourceReplyDeliveryMode: SourceReplyDeliveryMode;
  sendPolicyDenied: boolean;
  suppressAutomaticSourceDelivery: boolean;
  suppressDelivery: boolean;
  suppressHookReplyLifecycle: boolean;
  suppressTyping: boolean;
  deliverySuppressionReason: string;
};

export function resolveSourceReplyVisibilityPolicy(params: {
  cfg: OpenClawConfig;
  ctx: SourceReplyDeliveryModeContext;
  requested?: SourceReplyDeliveryMode;
  sendPolicy: SessionSendPolicyDecision;
  explicitSuppressTyping?: boolean;
  shouldSuppressTyping?: boolean;
  messageToolAvailable?: boolean;
}): SourceReplyVisibilityPolicy {
  const sourceReplyDeliveryMode = resolveSourceReplyDeliveryMode({
    cfg: params.cfg,
    ctx: params.ctx,
    requested: params.requested,
    messageToolAvailable: params.messageToolAvailable,
  });
  const sendPolicyDenied = params.sendPolicy === "deny";
  const suppressAutomaticSourceDelivery = sourceReplyDeliveryMode === "message_tool_only";
  const suppressDelivery = sendPolicyDenied || suppressAutomaticSourceDelivery;
  const deliverySuppressionReason = sendPolicyDenied
    ? "sendPolicy: deny"
    : suppressAutomaticSourceDelivery
      ? "sourceReplyDeliveryMode: message_tool_only"
      : "";

  return {
    sourceReplyDeliveryMode,
    sendPolicyDenied,
    suppressAutomaticSourceDelivery,
    suppressDelivery,
    suppressHookReplyLifecycle:
      sendPolicyDenied ||
      params.explicitSuppressTyping === true ||
      params.shouldSuppressTyping === true,
    suppressTyping:
      sendPolicyDenied ||
      params.explicitSuppressTyping === true ||
      params.shouldSuppressTyping === true,
    deliverySuppressionReason,
  };
}
