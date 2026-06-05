import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  createPrePromptOverflowErrorIfNeeded,
  estimatePrePromptTokens,
  PREEMPTIVE_OVERFLOW_ERROR_TEXT,
  resolvePrePromptReserveTokens,
  shouldPreemptivelyCompactBeforePrompt,
} from "./preemptive-compaction.js";

function makeAssistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeToolResultMessage(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

describe("preemptive compaction preflight", () => {
  it("exports a context-overflow-compatible precheck error", () => {
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("Context overflow:");
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("(precheck)");
  });

  it("asks for preemptive compaction when prompt budget is exceeded", () => {
    const decision = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        makeAssistantMessage("history ".repeat(900)),
        makeToolResultMessage("tool ".repeat(900)),
      ],
      systemPrompt: "system ".repeat(150),
      prompt: "continue ".repeat(150),
      contextTokenBudget: 1_000,
      reserveTokens: 200,
    });

    expect(decision.shouldCompact).toBe(true);
    expect(decision.estimatedPromptTokens).toBeGreaterThan(decision.promptBudgetBeforeReserve);
    expect(decision.overflowTokens).toBeGreaterThan(0);
  });

  it("lets the caller skip activeSession.prompt when precheck returns an overflow error", async () => {
    const prompt = vi.fn(async () => {
      throw new Error("provider should not be called");
    });
    const precheck = createPrePromptOverflowErrorIfNeeded({
      messages: [makeAssistantMessage("history ".repeat(1_500))],
      systemPrompt: "system ".repeat(150),
      prompt: "continue ".repeat(150),
      contextTokenBudget: 1_000,
      reserveTokens: 200,
    });

    expect(precheck?.error.message).toBe(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
    if (!precheck) {
      await prompt();
    }
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not trigger when the prompt fits below the reserve-adjusted budget", () => {
    const decision = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantMessage("short history")],
      systemPrompt: "system",
      prompt: "hello",
      contextTokenBudget: 20_000,
      reserveTokens: 2_000,
    });

    expect(decision.shouldCompact).toBe(false);
    expect(decision.overflowTokens).toBe(0);
    expect(decision.estimatedPromptTokens).toBeLessThan(decision.promptBudgetBeforeReserve);
  });

  it("asks for compaction when persisted token metadata is already over budget", () => {
    const decision = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantMessage("short history")],
      systemPrompt: "system",
      prompt: "hello",
      persistedPromptTokens: 200_470,
      contextTokenBudget: 200_000,
      reserveTokens: 20_000,
    });

    expect(decision.shouldCompact).toBe(true);
    expect(decision.estimatedPromptTokens).toBeLessThan(decision.promptBudgetBeforeReserve);
    expect(decision.persistedPromptTokens).toBe(200_470);
    expect(decision.effectivePromptTokens).toBe(200_470);
    expect(decision.overflowTokens).toBe(20_470);
  });

  it("uses the Codex GPT-5.5 effective budget with the existing 20k reserve threshold", () => {
    const decision = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantMessage("short history")],
      systemPrompt: "system",
      prompt: "hello",
      persistedPromptTokens: 238_401,
      contextTokenBudget: 258_400,
      reserveTokens: 20_000,
    });

    expect(decision.promptBudgetBeforeReserve).toBe(238_400);
    expect(decision.effectiveReserveTokens).toBe(20_000);
    expect(decision.shouldCompact).toBe(true);
    expect(decision.effectivePromptTokens).toBe(238_401);
    expect(decision.overflowTokens).toBe(1);
  });

  it("does not let low persisted token metadata inflate the estimate", () => {
    const decision = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantMessage("short history")],
      systemPrompt: "system",
      prompt: "hello",
      persistedPromptTokens: 1_000,
      contextTokenBudget: 20_000,
      reserveTokens: 2_000,
    });

    expect(decision.shouldCompact).toBe(false);
    expect(decision.effectivePromptTokens).toBeGreaterThanOrEqual(decision.estimatedPromptTokens);
    expect(decision.effectivePromptTokens).toBeLessThan(decision.promptBudgetBeforeReserve);
  });

  it("uses configured reserveTokens before the reserveTokensFloor fallback", () => {
    expect(
      resolvePrePromptReserveTokens({
        agents: { defaults: { compaction: { reserveTokens: 12_000, reserveTokensFloor: 20_000 } } },
      }),
    ).toBe(12_000);
  });

  it("falls back to reserveTokensFloor and then the default 20k reserve", () => {
    expect(
      resolvePrePromptReserveTokens({
        agents: { defaults: { compaction: { reserveTokensFloor: 15_000 } } },
      }),
    ).toBe(15_000);
    expect(resolvePrePromptReserveTokens({})).toBe(20_000);
  });

  it("caps the effective reserve so the context window keeps usable prompt space", () => {
    const decision = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantMessage("small")],
      systemPrompt: "system",
      prompt: "hello",
      contextTokenBudget: 16_000,
      reserveTokens: 20_000,
    });

    expect(decision.requestedReserveTokens).toBe(20_000);
    expect(decision.effectiveReserveTokens).toBe(8_000);
    expect(decision.promptBudgetBeforeReserve).toBe(8_000);
  });

  it("counts object-heavy tool payloads instead of trusting text-only history size", () => {
    const payload = {
      rows: Array.from({ length: 60 }, (_, index) => ({
        path: `/tmp/generated-${index}.txt`,
        body: "x".repeat(1_000),
      })),
    };
    const message = {
      role: "toolResult",
      toolCallId: "call_2",
      toolName: "json_tool",
      content: [{ type: "json", payload }],
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    expect(
      estimatePrePromptTokens({
        messages: [message],
        systemPrompt: "system",
        prompt: "continue",
      }),
    ).toBeGreaterThan(20_000);
  });
});
