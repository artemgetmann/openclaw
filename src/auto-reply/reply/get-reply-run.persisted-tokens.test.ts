import { describe, expect, it } from "vitest";
import { resolvePersistedPromptTokensForRun } from "./get-reply-run.js";

describe("resolvePersistedPromptTokensForRun", () => {
  it("prefers a fresh compacted total over a larger cumulative input counter", () => {
    expect(
      resolvePersistedPromptTokensForRun({
        sessionId: "topic-17730",
        updatedAt: Date.now(),
        totalTokens: 204_755,
        inputTokens: 374_764,
        totalTokensFresh: true,
      }),
    ).toBe(204_755);
  });

  it("falls back to the largest provider counter when the total is not fresh", () => {
    expect(
      resolvePersistedPromptTokensForRun({
        sessionId: "topic-17730",
        updatedAt: Date.now(),
        totalTokens: 204_755,
        inputTokens: 374_764,
        totalTokensFresh: false,
      }),
    ).toBe(374_764);
  });
});
