import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { applyFutureThreadThinkingLevelOverride } from "./level-overrides.js";

describe("applyFutureThreadThinkingLevelOverride", () => {
  it("stores future-thread thinking default on parent sessions", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "parent-thinking-1",
      updatedAt: before,
    };

    const result = applyFutureThreadThinkingLevelOverride(entry, "high");

    expect(result.updated).toBe(true);
    expect(entry.futureThreadThinkingLevelOverride).toBe("high");
    expect((entry.updatedAt ?? 0) > before).toBe(true);
  });

  it("clears future-thread thinking default when null is provided", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "parent-thinking-2",
      updatedAt: before,
      futureThreadThinkingLevelOverride: "medium",
    };

    const result = applyFutureThreadThinkingLevelOverride(entry, null);

    expect(result.updated).toBe(true);
    expect(entry.futureThreadThinkingLevelOverride).toBeUndefined();
    expect((entry.updatedAt ?? 0) > before).toBe(true);
  });
});
