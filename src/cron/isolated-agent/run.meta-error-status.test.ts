import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import { loadRunCronIsolatedAgentTurn, runWithModelFallbackMock } from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn - run-level error status", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("marks a run-level error with empty payloads as a cron error", async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [],
        meta: {
          error: { kind: "provider_error", message: "model provider unreachable" },
          agentMeta: { usage: { input: 0, output: 0 } },
        },
      },
      provider: "openai",
      model: "gpt-4",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated run failed: model provider unreachable");
    expect(result.outputText).toBe("cron isolated run failed: model provider unreachable");
    expect(result.delivered).toBe(false);
    expect(result.deliveryAttempted).toBe(false);
  });

  it("does not record partial success text as ok when a run-level error is present", async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [{ text: "I tried to send the email, but Gmail returned invalid_grant." }],
        meta: {
          error: { kind: "tool_error", message: "Google OAuth invalid_grant" },
          agentMeta: { usage: { input: 0, output: 0 } },
        },
      },
      provider: "openai",
      model: "gpt-4",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated run failed: Google OAuth invalid_grant");
    expect(result.outputText).toBe("cron isolated run failed: Google OAuth invalid_grant");
    expect(result.summary).toBe("cron isolated run failed: Google OAuth invalid_grant");
    expect(result.delivered).toBe(false);
    expect(result.deliveryAttempted).toBe(false);
  });
});
