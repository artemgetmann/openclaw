import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";

/**
 * Restore non-renderable control outcomes needed by reply orchestration.
 *
 * The embedded runner deliberately removes NO_REPLY from transport payloads.
 * Timeout and empty-final policy still need to distinguish that intentional
 * silence from a provider that returned nothing, so the control token lives
 * only inside the reply runner and is normalized away again before delivery.
 */
export function resolveReplyRunPayloads(runResult: {
  payloads?: ReplyPayload[];
  meta?: { silentReply?: boolean };
}): ReplyPayload[] {
  if (runResult.payloads?.length) {
    return runResult.payloads;
  }
  return runResult.meta?.silentReply ? [{ text: SILENT_REPLY_TOKEN }] : [];
}
