import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  runCliAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn - complex reminder agent task", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("passes preserved complex reminder intent into the Claude CLI agent prompt", async () => {
    const task = "go to my Twitter profile, click on the first post, and check the first comment";
    isCliProviderMock.mockReturnValue(true);
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "First comment checked: no public action taken." }],
      meta: { agentMeta: { sessionId: "claude-reminder-run", usage: { input: 5, output: 10 } } },
    });
    runWithModelFallbackMock.mockImplementationOnce(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        const result = await params.run("claude-cli", "sonnet");
        return { result, provider: "claude-cli", model: "sonnet", attempts: [] };
      },
    );

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        message: `Scheduled task due now. Perform this task and report the result: ${task}`,
        job: makeIsolatedAgentTurnJob({
          id: "complex-reminder",
          name: "Reminder: complex browser task",
          payload: {
            kind: "agentTurn",
            message: `Scheduled task due now. Perform this task and report the result: ${task}`,
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    const prompt = runCliAgentMock.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("Scheduled task due now. Perform this task and report the result:");
    expect(prompt).toContain(task);
  });
});
