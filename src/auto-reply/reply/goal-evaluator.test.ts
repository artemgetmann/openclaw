import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionGoal } from "../../config/sessions/types.js";

const mocks = vi.hoisted(() => ({
  isCliProvider: vi.fn(() => false),
  runEmbeddedPiAgent: vi.fn(),
}));

vi.mock("../../agents/model-selection.js", () => ({
  isCliProvider: mocks.isCliProvider,
}));
vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: mocks.runEmbeddedPiAgent,
}));

import { collectGoalEvaluationEvidence, runIndependentGoalEvaluator } from "./goal-evaluator.js";

const goal: SessionGoal = {
  schemaVersion: 1,
  id: "goal-1",
  objective: "Prove the release is healthy.",
  status: "active",
  createdAt: 1,
  updatedAt: 2,
  tokenStart: 0,
  tokensUsed: 10,
  continuationTurns: 0,
  pendingEvaluation: {
    requestId: "claim-1",
    runId: "working-run-1",
    proposedStatus: "complete",
    reason: "The focused health check passed.",
    createdAt: 2,
  },
};

const run = {
  agentDir: "/tmp/agent",
  config: {},
  provider: "anthropic",
  model: "claude-test",
  timeoutMs: 120_000,
};

describe("independent goal evaluator", () => {
  beforeEach(() => {
    mocks.isCliProvider.mockReset().mockReturnValue(false);
    mocks.runEmbeddedPiAgent.mockReset().mockResolvedValue({
      payloads: [
        {
          text: JSON.stringify({
            verdict: "satisfied",
            reason: "The supplied health result proves the objective.",
            evidence: ["assistant_final: health check passed"],
            material_progress: true,
          }),
        },
      ],
      meta: { durationMs: 1 },
    });
  });

  it("invokes a fresh tool-disabled judge with no session or delivery authority", async () => {
    const first = await runIndependentGoalEvaluator({
      goal,
      run,
      evidence: ["assistant_final: health check passed"],
    });
    const second = await runIndependentGoalEvaluator({
      goal,
      run,
      evidence: ["assistant_final: health check passed"],
    });

    expect(first).toMatchObject({ kind: "evaluated", result: { verdict: "satisfied" } });
    expect(second).toMatchObject({ kind: "evaluated", result: { verdict: "satisfied" } });
    const firstParams = mocks.runEmbeddedPiAgent.mock.calls[0]?.[0];
    const secondParams = mocks.runEmbeddedPiAgent.mock.calls[1]?.[0];
    expect(firstParams).toMatchObject({
      disableTools: true,
      disableHooks: true,
      bootstrapContextMode: "lightweight",
      provider: "anthropic",
      model: "claude-test",
      timeoutMs: 60_000,
    });
    expect(firstParams).not.toHaveProperty("sessionKey");
    expect(firstParams).not.toHaveProperty("messageProvider");
    expect(firstParams).not.toHaveProperty("ownerNumbers");
    expect(firstParams.sessionId).not.toBe(secondParams.sessionId);
    expect(firstParams.sessionFile).not.toBe(secondParams.sessionFile);
  });

  it("fails closed without invoking a CLI provider that cannot disable tools", async () => {
    mocks.isCliProvider.mockReturnValue(true);
    await expect(
      runIndependentGoalEvaluator({
        goal,
        run: { ...run, provider: "claude-bridge" },
        evidence: ["assistant_final: health check passed"],
      }),
    ).resolves.toEqual({ kind: "unsupported_provider", provider: "claude-bridge" });
    expect(mocks.runEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("preserves deterministic approval gates without asking a model to reinterpret them", async () => {
    const result = await runIndependentGoalEvaluator({
      goal,
      run,
      evidence: ["assistant_final: approval is required"],
      deterministicApprovalPromptSent: true,
    });

    expect(result).toMatchObject({
      kind: "evaluated",
      result: { verdict: "approval_required" },
    });
    expect(mocks.runEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("fails closed on malformed or incomplete judge output", async () => {
    mocks.runEmbeddedPiAgent.mockResolvedValue({
      payloads: [{ text: '{"verdict":"satisfied"}' }],
      meta: { durationMs: 1 },
    });

    await expect(
      runIndependentGoalEvaluator({
        goal,
        run,
        evidence: ["assistant_final: health check passed"],
      }),
    ).resolves.toMatchObject({ kind: "failed" });
  });

  it("collects only bounded runtime-owned final and verified-send evidence", () => {
    expect(
      collectGoalEvaluationEvidence({
        payloads: [{ text: "Done." }],
        transcriptMessages: [
          {
            role: "toolResult",
            toolName: "exec",
            content: [{ type: "text", text: "10 tests passed" }],
          },
          {
            role: "toolResult",
            toolName: "update_goal",
            content: [{ type: "text", text: "evaluation requested" }],
          },
        ],
        messagingToolSentTexts: ["Vendor notified."],
        messagingToolSentTargets: [{ provider: "telegram", to: "123" }],
      }),
    ).toEqual([
      "tool_result:exec: 10 tests passed",
      "assistant_final: Done.",
      "verified_message_send_text: Vendor notified.",
      "verified_message_send_target: telegram:123",
    ]);
  });

  it("treats failed tool results as deterministic failure evidence", async () => {
    const evidence = collectGoalEvaluationEvidence({
      payloads: [{ text: "Done." }],
      transcriptMessages: [
        {
          role: "toolResult",
          toolName: "exec",
          isError: true,
          content: [{ type: "text", text: "tests failed" }],
        },
      ],
    });
    const result = await runIndependentGoalEvaluator({ goal, run, evidence });

    expect(result).toMatchObject({
      kind: "evaluated",
      result: { verdict: "needs_revision" },
    });
    expect(mocks.runEmbeddedPiAgent).not.toHaveBeenCalled();
  });
});
