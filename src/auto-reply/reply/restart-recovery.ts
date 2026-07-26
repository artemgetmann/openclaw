import type { ReplyPayload } from "../types.js";

/**
 * Durable terminal receipt used when a restart can make an unfinished turn's
 * side effects ambiguous. Recovery sends this instead of replaying model/tool
 * work that may already have changed external state.
 */
export const RESTART_INTERRUPTED_TURN_PAYLOAD: ReplyPayload = {
  text:
    "I was interrupted after accepting your message. " +
    "I did not repeat the unfinished actions because their outcome may be ambiguous. " +
    "Send “Continue” and I’ll inspect the current state before proceeding.",
  isError: true,
};
