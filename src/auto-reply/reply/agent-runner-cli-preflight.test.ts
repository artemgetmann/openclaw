import { describe, expect, it } from "vitest";
import { evaluateCliHardReservePrecheck } from "./agent-runner-cli-preflight.js";

describe("evaluateCliHardReservePrecheck", () => {
  it("requests a CLI session reset when persisted prompt tokens breach the reserve", () => {
    const result = evaluateCliHardReservePrecheck({
      provider: "claude-cli",
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

  it("does not trigger for non-CLI providers", () => {
    expect(
      evaluateCliHardReservePrecheck({
        provider: "openai",
        modelId: "gpt-5.5",
        cfg: {},
        prompt: "hello",
        persistedPromptTokens: 202_908,
        contextTokenBudget: 200_000,
      }),
    ).toBeNull();
  });

  it("does not trigger below the reserve-adjusted budget", () => {
    expect(
      evaluateCliHardReservePrecheck({
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
