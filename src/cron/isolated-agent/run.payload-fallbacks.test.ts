import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  resolveAgentModelFallbacksOverrideMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — payload.fallbacks", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it.each([
    {
      name: "passes payload.fallbacks as fallbacksOverride when defined",
      payload: {
        kind: "agentTurn",
        message: "test",
        fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5"],
      },
      expectedFallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5"],
    },
    {
      name: "falls back to agent-level fallbacks when payload.fallbacks is undefined",
      payload: { kind: "agentTurn", message: "test" },
      agentFallbacks: ["openai/gpt-4o"],
      expectedFallbacks: ["openai/gpt-4o"],
    },
    {
      name: "payload.fallbacks=[] disables fallbacks even when agent config has them",
      payload: { kind: "agentTurn", message: "test", fallbacks: [] },
      agentFallbacks: ["openai/gpt-4o"],
      expectedFallbacks: [],
    },
  ])("$name", async ({ payload, agentFallbacks, expectedFallbacks }) => {
    if (agentFallbacks) {
      resolveAgentModelFallbacksOverrideMock.mockReturnValue(agentFallbacks);
    }

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({ payload }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(runWithModelFallbackMock.mock.calls[0][0].fallbacksOverride).toEqual(expectedFallbacks);
  });

  it("retries fallback candidates when the embedded runner returns a fatal model timeout payload", async () => {
    let firstAttemptError: unknown;

    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "LLM request timed out.", isError: true }],
        meta: {},
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "fallback answered" }],
        meta: { agentMeta: { usage: { input: 12, output: 3 } } },
      });

    runWithModelFallbackMock.mockImplementation(async ({ run }) => {
      try {
        await run("openai-codex", "gpt-5.5");
      } catch (err) {
        firstAttemptError = err;
      }

      const result = await run("openai", "gpt-5");
      return { result, provider: "openai", model: "gpt-5", attempts: [] };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          payload: {
            kind: "agentTurn",
            message: "test",
            fallbacks: ["openai/gpt-5"],
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(firstAttemptError).toMatchObject({
      name: "FailoverError",
      message: "LLM request timed out.",
      reason: "timeout",
      provider: "openai-codex",
      model: "gpt-5.5",
      status: 408,
    });
  });
});
