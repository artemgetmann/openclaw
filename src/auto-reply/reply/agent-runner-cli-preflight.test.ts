import { describe, expect, it } from "vitest";
import { evaluateReplyHardReservePrecheck } from "./agent-runner-cli-preflight.js";

describe("evaluateReplyHardReservePrecheck", () => {
  it("requests a session reset when persisted prompt tokens breach the reserve", () => {
    const result = evaluateReplyHardReservePrecheck({
      provider: "openai-codex",
      modelId: "opus-4.5",
      cfg: { agents: { defaults: { compaction: { reserveTokensFloor: 20_000 } } } },
      prompt: "hello",
      persistedPromptTokens: 202_908,
      contextTokenBudget: 200_000,
      sessionKey: "main",
      sessionId: "session",
      sessionFile: "/tmp/session.jsonl",
    });

    expect(result?.decision.shouldCompact).toBe(true);
    expect(result?.decision.promptBudgetBeforeReserve).toBe(180_000);
    expect(result?.decision.overflowTokens).toBe(22_908);
    expect(result?.logLine).toContain("[context-overflow-precheck]");
    expect(result?.logLine).toContain("persistedPromptTokens=202908");
  });

  it("does not trigger without reliable persisted prompt tokens", () => {
    expect(
      evaluateReplyHardReservePrecheck({
        provider: "openai",
        modelId: "gpt-5.5",
        cfg: {},
        prompt: "hello",
        persistedPromptTokens: undefined,
        contextTokenBudget: 200_000,
      }),
    ).toBeNull();
  });

  it("does not trigger below the reserve-adjusted budget", () => {
    expect(
      evaluateReplyHardReservePrecheck({
        provider: "claude-cli",
        modelId: "opus-4.5",
        cfg: { agents: { defaults: { compaction: { reserveTokensFloor: 20_000 } } } },
        prompt: "hello",
        persistedPromptTokens: 120_000,
        contextTokenBudget: 200_000,
      }),
    ).toBeNull();
  });
});
