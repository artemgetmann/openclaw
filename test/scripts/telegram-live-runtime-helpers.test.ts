import { describe, expect, it } from "vitest";
import {
  deriveTelegramLiveRuntimeProfile,
  selectTelegramTesterToken,
} from "../../scripts/lib/telegram-live-runtime-helpers.mjs";

describe("deriveTelegramLiveRuntimeProfile", () => {
  it("returns stable deterministic profile fields for the same worktree path", () => {
    const worktreePath = "/tmp/openclaw/worktrees/runtime-a";
    const first = deriveTelegramLiveRuntimeProfile({ worktreePath });
    const second = deriveTelegramLiveRuntimeProfile({ worktreePath });

    expect(second).toEqual(first);
    expect(first.profileId).toMatch(/^tg-live-[a-f0-9]{10}$/);
    expect(first.runtimePort).toBeGreaterThanOrEqual(20000);
    expect(first.runtimePort).toBeLessThan(30000);
    expect(first.runtimePort).not.toBe(18789);
  });

  it("produces different profile IDs for different worktree paths", () => {
    const a = deriveTelegramLiveRuntimeProfile({ worktreePath: "/tmp/openclaw/worktrees/a" });
    const b = deriveTelegramLiveRuntimeProfile({ worktreePath: "/tmp/openclaw/worktrees/b" });

    expect(a.profileId).not.toBe(b.profileId);
  });
});

describe("selectTelegramTesterToken", () => {
  it("retains the current worktree token when it remains available", () => {
    const result = selectTelegramTesterToken({
      poolTokens: ["token-a", "token-b", "token-c"],
      claimedTokens: ["token-b"],
      currentToken: "token-a",
    });

    expect(result).toEqual({
      ok: true,
      action: "retain",
      reason: "current_available",
      selectedToken: "token-a",
    });
  });

  it("reassigns when current token is conflicting or invalid", () => {
    const result = selectTelegramTesterToken({
      poolTokens: ["token-a", "token-b", "token-c"],
      claimedTokens: ["token-b", "token-c"],
      currentToken: "token-b",
    });

    expect(result).toEqual({
      ok: true,
      action: "assign",
      reason: "reassign_conflict_or_invalid",
      selectedToken: "token-a",
    });
  });

  it("hard-fails when the tester pool is exhausted", () => {
    const result = selectTelegramTesterToken({
      poolTokens: ["token-a", "token-b"],
      claimedTokens: ["token-a", "token-b"],
      currentToken: "",
    });

    expect(result).toEqual({
      ok: false,
      action: "fail",
      reason: "pool_exhausted",
      selectedToken: null,
    });
  });
});
