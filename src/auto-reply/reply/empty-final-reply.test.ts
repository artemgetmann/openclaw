import { describe, expect, it } from "vitest";
import { shouldReturnEmptyFinalFallback } from "./empty-final-reply.js";

describe("shouldReturnEmptyFinalFallback", () => {
  it("does not return the empty-visible fallback after a same-topic media-only message tool send", () => {
    expect(
      shouldReturnEmptyFinalFallback({
        isHeartbeat: false,
        rawPayloads: [{ text: "NO_REPLY" }],
        didSendVisibleReply: false,
        messageProvider: "telegram",
        originatingTo: "telegram:group:-1003783709877:topic:18926",
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "telegram",
            to: "telegram:group:-1003783709877",
            threadId: "18926",
            hasMedia: true,
            hasText: false,
          },
        ],
      }),
    ).toBe(false);
  });
});
