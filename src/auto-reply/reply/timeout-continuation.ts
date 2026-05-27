import type { MessagingToolSend } from "../../agents/pi-embedded-runner.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { isRenderablePayload, shouldSuppressMessagingToolReplies } from "./reply-payloads.js";

const TIMEOUT_PREFIX = "Request timed out before a response was generated.";

export const DEFAULT_REPLY_TIMEOUT_CONTINUATION_STATUS_TEXT = "";
// Total attempts include the original user-triggered run. With the default 600s
// run timeout, 5 total attempts keeps the task under the roughly one-hour cap.
export const DEFAULT_REPLY_TIMEOUT_CONTINUATION_MAX_ATTEMPTS = 5;
export const DEFAULT_REPLY_TIMEOUT_CONTINUATION_MAX_WALL_CLOCK_MS = 60 * 60 * 1000;
export const REPLY_TIMEOUT_CONTINUATION_PROMPT =
  "Continue the previous user task from the last known state. Do not ask the user to confirm. Provide the final answer when done.";

export type ReplyTimeoutContinuationConfig = {
  enabled: boolean;
  maxAttempts: number;
  maxWallClockMs: number;
  statusText: string;
};

type TimeoutContinuationConfigRecord = {
  enabled?: boolean;
  maxAttempts?: number;
  maxWallClockMs?: number;
  statusText?: string;
};

function readContinuationConfig(cfg: OpenClawConfig): TimeoutContinuationConfigRecord | undefined {
  return cfg.agents?.defaults?.replyTimeoutContinuation;
}

export function resolveReplyTimeoutContinuationConfig(
  cfg: OpenClawConfig,
): ReplyTimeoutContinuationConfig {
  const raw = readContinuationConfig(cfg);
  const maxAttempts =
    typeof raw?.maxAttempts === "number" && Number.isFinite(raw.maxAttempts) && raw.maxAttempts > 0
      ? Math.floor(raw.maxAttempts)
      : DEFAULT_REPLY_TIMEOUT_CONTINUATION_MAX_ATTEMPTS;
  const maxWallClockMs =
    typeof raw?.maxWallClockMs === "number" &&
    Number.isFinite(raw.maxWallClockMs) &&
    raw.maxWallClockMs > 0
      ? Math.floor(raw.maxWallClockMs)
      : DEFAULT_REPLY_TIMEOUT_CONTINUATION_MAX_WALL_CLOCK_MS;
  return {
    enabled: raw?.enabled !== false,
    maxAttempts,
    maxWallClockMs,
    statusText: raw?.statusText?.trim() || DEFAULT_REPLY_TIMEOUT_CONTINUATION_STATUS_TEXT,
  };
}

function isUserVisibleRun(opts: GetReplyOptions | undefined, isHeartbeat: boolean): boolean {
  if (isHeartbeat || opts?.isHeartbeat === true) {
    return false;
  }
  if (opts?.typingPolicy === "system_event" || opts?.typingPolicy === "heartbeat") {
    return false;
  }
  return true;
}

export function isExplicitAgentTimeoutPayload(payload: ReplyPayload): boolean {
  return payload.isError === true && payload.text?.trim().startsWith(TIMEOUT_PREFIX) === true;
}

export function shouldContinueAfterReplyTimeout(params: {
  cfg: OpenClawConfig;
  opts?: GetReplyOptions;
  isHeartbeat: boolean;
  payloads: ReplyPayload[];
  didSendFinalVisibleReply: boolean;
  messagingToolSentTargets?: MessagingToolSend[];
  messageProvider?: string;
  originatingTo?: string;
  accountId?: string;
}): { shouldContinue: boolean; config: ReplyTimeoutContinuationConfig } {
  const config = resolveReplyTimeoutContinuationConfig(params.cfg);
  if (!config.enabled) {
    return { shouldContinue: false, config };
  }
  if (!isUserVisibleRun(params.opts, params.isHeartbeat) || params.didSendFinalVisibleReply) {
    return { shouldContinue: false, config };
  }
  if (
    shouldSuppressMessagingToolReplies({
      messageProvider: params.messageProvider,
      messagingToolSentTargets: params.messagingToolSentTargets,
      originatingTo: params.originatingTo,
      accountId: params.accountId,
    })
  ) {
    return { shouldContinue: false, config };
  }
  if (params.payloads.length !== 1 || !isExplicitAgentTimeoutPayload(params.payloads[0])) {
    return { shouldContinue: false, config };
  }
  // Defensive guard: the timeout payload itself is renderable, but any additional
  // renderable payload means the run produced a real user-facing answer/error.
  if (
    params.payloads.some(
      (payload) => !isExplicitAgentTimeoutPayload(payload) && isRenderablePayload(payload),
    )
  ) {
    return { shouldContinue: false, config };
  }
  return { shouldContinue: true, config };
}
