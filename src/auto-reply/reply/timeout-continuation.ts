import type { MessagingToolSend } from "../../agents/pi-embedded-runner.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { isRenderablePayload, shouldSuppressMessagingToolReplies } from "./reply-payloads.js";

const TIMEOUT_PREFIX = "Request timed out before a response was generated.";

export const DEFAULT_REPLY_TIMEOUT_CONTINUATION_STATUS_TEXT =
  "Still working. I hit the run limit and am continuing automatically.";
// Continuation attempts are runs after the original user-triggered run. With the
// default 600s run timeout, 5 continuations gives roughly one hour total budget:
// original run + 5 continuation runs.
export const DEFAULT_REPLY_TIMEOUT_CONTINUATION_MAX_ATTEMPTS = 5;
export const REPLY_TIMEOUT_CONTINUATION_PROMPT =
  "Continue the previous user task from the last known state. Do not ask the user to confirm. Provide the final answer when done.";

export type ReplyTimeoutContinuationConfig = {
  enabled: boolean;
  maxAttempts: number;
  statusText: string;
};

type TimeoutContinuationConfigRecord = {
  enabled?: boolean;
  maxAttempts?: number;
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
  return {
    enabled: raw?.enabled !== false,
    maxAttempts,
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
  attemptsUsed: number;
  payloads: ReplyPayload[];
  messagingToolSentTargets?: MessagingToolSend[];
  messageProvider?: string;
  originatingTo?: string;
  accountId?: string;
}): { shouldContinue: boolean; config: ReplyTimeoutContinuationConfig } {
  const config = resolveReplyTimeoutContinuationConfig(params.cfg);
  if (!config.enabled || params.attemptsUsed >= config.maxAttempts) {
    return { shouldContinue: false, config };
  }
  if (!isUserVisibleRun(params.opts, params.isHeartbeat)) {
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
  // A streamed/block progress update is not a final answer. Browser-heavy tasks
  // commonly send "still working" status before the run timeout; treating that
  // as completion strands the task after the timeout instead of resuming it.
  //
  // Still require the terminal payload list to be only the explicit timeout.
  // That keeps real final answers/errors from being auto-continued.
  if (
    params.payloads.some(
      (payload) => !isExplicitAgentTimeoutPayload(payload) && isRenderablePayload(payload),
    )
  ) {
    return { shouldContinue: false, config };
  }
  return { shouldContinue: true, config };
}
