import { afterEach, expect, test } from "vitest";
import { abortProcessSessionsForScope } from "./bash-process-abort.js";
import {
  getFinishedSession,
  getSession,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec.js";
import { killProcessTree } from "./shell-utils.js";

const BACKGROUND_HOLD_CMD = 'node -e "setTimeout(() => {}, 5000)"';
const ABORT_SETTLE_MS = process.platform === "win32" ? 200 : 25;
const ABORT_WAIT_TIMEOUT_MS = process.platform === "win32" ? 1_500 : 240;
const POLL_INTERVAL_MS = 15;
const FINISHED_WAIT_TIMEOUT_MS = process.platform === "win32" ? 8_000 : 600;
const BACKGROUND_TIMEOUT_SEC = process.platform === "win32" ? 0.2 : 0.05;
const TEST_EXEC_DEFAULTS = {
  security: "full" as const,
  ask: "off" as const,
};

const createTestExecTool = (
  defaults?: Parameters<typeof createExecTool>[0],
): ReturnType<typeof createExecTool> => createExecTool({ ...TEST_EXEC_DEFAULTS, ...defaults });

afterEach(() => {
  resetProcessRegistryForTests();
});

async function waitForFinishedSession(sessionId: string) {
  let finished = getFinishedSession(sessionId);
  await expect
    .poll(
      () => {
        finished = getFinishedSession(sessionId);
        return Boolean(finished);
      },
      {
        timeout: FINISHED_WAIT_TIMEOUT_MS,
        interval: POLL_INTERVAL_MS,
      },
    )
    .toBe(true);
  return finished;
}

function cleanupRunningSession(sessionId: string) {
  const running = getSession(sessionId);
  const pid = running?.pid;
  if (pid) {
    killProcessTree(pid);
  }
  return running;
}

async function expectBackgroundSessionSurvivesAbort(params: {
  tool: ReturnType<typeof createExecTool>;
  executeParams: Record<string, unknown>;
}) {
  const abortController = new AbortController();
  const result = await params.tool.execute(
    "toolcall",
    params.executeParams,
    abortController.signal,
  );
  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;

  abortController.abort();
  const startedAt = Date.now();
  await expect
    .poll(
      () => {
        const running = getSession(sessionId);
        const finished = getFinishedSession(sessionId);
        return Date.now() - startedAt >= ABORT_SETTLE_MS && !finished && running?.exited === false;
      },
      { timeout: ABORT_WAIT_TIMEOUT_MS, interval: POLL_INTERVAL_MS },
    )
    .toBe(true);

  const running = getSession(sessionId);
  const finished = getFinishedSession(sessionId);
  try {
    expect(finished).toBeUndefined();
    expect(running?.exited).toBe(false);
  } finally {
    cleanupRunningSession(sessionId);
  }
}

async function expectBackgroundSessionTimesOut(params: {
  tool: ReturnType<typeof createExecTool>;
  executeParams: Record<string, unknown>;
  signal?: AbortSignal;
  abortAfterStart?: boolean;
}) {
  const abortController = new AbortController();
  const signal = params.signal ?? abortController.signal;
  const result = await params.tool.execute("toolcall", params.executeParams, signal);
  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;

  if (params.abortAfterStart) {
    abortController.abort();
  }

  const finished = await waitForFinishedSession(sessionId);
  try {
    expect(finished).toBeTruthy();
    expect(finished?.status).toBe("failed");
  } finally {
    cleanupRunningSession(sessionId);
  }
}

test("background exec is not killed when tool signal aborts", async () => {
  const tool = createTestExecTool({ allowBackground: true, backgroundMs: 0 });
  await expectBackgroundSessionSurvivesAbort({
    tool,
    executeParams: { command: BACKGROUND_HOLD_CMD, background: true },
  });
});

test("manual agent-run abort kills backgrounded exec", async () => {
  const tool = createTestExecTool({ allowBackground: true, backgroundMs: 0 });
  const abortController = new AbortController();
  const result = await tool.execute(
    "toolcall",
    { command: BACKGROUND_HOLD_CMD, background: true },
    abortController.signal,
  );
  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;
  const reason = new Error("CLI run aborted") as Error & { code?: string };
  reason.code = "OPENCLAW_AGENT_RUN_ABORT";

  abortController.abort(reason);

  const finished = await waitForFinishedSession(sessionId);
  try {
    expect(finished?.status).toBe("failed");
    expect(finished?.exitSignal).toBeTruthy();
  } finally {
    cleanupRunningSession(sessionId);
  }
});

test("active run abort kills scoped backgrounded exec sessions", async () => {
  const scopeKey = "agent:main:telegram-proof";
  const tool = createTestExecTool({ allowBackground: true, backgroundMs: 0, scopeKey });
  const result = await tool.execute("toolcall", {
    command: BACKGROUND_HOLD_CMD,
    background: true,
  });
  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;

  expect(abortProcessSessionsForScope(scopeKey)).toBe(1);

  const finished = await waitForFinishedSession(sessionId);
  try {
    expect(finished?.status).toBe("failed");
    expect(finished?.exitSignal).toBeTruthy();
  } finally {
    cleanupRunningSession(sessionId);
  }
});

test("pty background exec is not killed when tool signal aborts", async () => {
  const tool = createTestExecTool({ allowBackground: true, backgroundMs: 0 });
  await expectBackgroundSessionSurvivesAbort({
    tool,
    executeParams: { command: BACKGROUND_HOLD_CMD, background: true, pty: true },
  });
});

test("background exec still times out after tool signal abort", async () => {
  const tool = createTestExecTool({ allowBackground: true, backgroundMs: 0 });
  await expectBackgroundSessionTimesOut({
    tool,
    executeParams: {
      command: BACKGROUND_HOLD_CMD,
      background: true,
      timeout: BACKGROUND_TIMEOUT_SEC,
    },
    abortAfterStart: true,
  });
});

test("background exec without explicit timeout ignores default timeout", async () => {
  const tool = createTestExecTool({
    allowBackground: true,
    backgroundMs: 0,
    timeoutSec: BACKGROUND_TIMEOUT_SEC,
  });
  const result = await tool.execute("toolcall", { command: BACKGROUND_HOLD_CMD, background: true });
  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;
  const waitMs = Math.max(ABORT_SETTLE_MS + 80, BACKGROUND_TIMEOUT_SEC * 1000 + 80);

  const startedAt = Date.now();
  await expect
    .poll(
      () => {
        const running = getSession(sessionId);
        const finished = getFinishedSession(sessionId);
        return Date.now() - startedAt >= waitMs && !finished && running?.exited === false;
      },
      {
        timeout: waitMs + ABORT_WAIT_TIMEOUT_MS,
        interval: POLL_INTERVAL_MS,
      },
    )
    .toBe(true);

  cleanupRunningSession(sessionId);
});

test("yielded background exec still times out", async () => {
  const tool = createTestExecTool({ allowBackground: true, backgroundMs: 10 });
  await expectBackgroundSessionTimesOut({
    tool,
    executeParams: {
      command: BACKGROUND_HOLD_CMD,
      yieldMs: 5,
      timeout: BACKGROUND_TIMEOUT_SEC,
    },
  });
});
