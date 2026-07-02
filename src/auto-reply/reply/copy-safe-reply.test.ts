import { describe, expect, it } from "vitest";
import { isCopySafeDraftReplyPayload, markCopySafeDraftReplyPayload } from "./copy-safe-reply.js";

describe("copy-safe reply markers", () => {
  it("marks draft payloads structurally without touching text", () => {
    const payload = markCopySafeDraftReplyPayload({
      text: "Draft body",
      channelData: {
        openclaw: {
          assistantPhase: "final_answer",
        },
      },
    });

    expect(payload.text).toBe("Draft body");
    expect(payload.channelData).toEqual({
      openclaw: {
        assistantPhase: "final_answer",
        copySafeDraft: true,
      },
    });
    expect(isCopySafeDraftReplyPayload(payload)).toBe(true);
  });

  it("does not infer copy-safe handling from unmarked payloads", () => {
    expect(isCopySafeDraftReplyPayload({ text: "Draft body" })).toBe(false);
    expect(
      isCopySafeDraftReplyPayload({
        text: "Draft body",
        channelData: { openclaw: { assistantPhase: "final_answer" } },
      }),
    ).toBe(false);
  });
});
