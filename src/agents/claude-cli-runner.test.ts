import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runClaudeCliAgent } from "./claude-cli-runner.js";
import { resetClaudeLiveSessionsForTest } from "./cli-runner/claude-live-session.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: (...args: unknown[]) => mocks.spawn(...args),
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: async () => {},
    getRecord: vi.fn(),
  }),
}));

vi.mock("../gateway/mcp-http.js", () => ({
  ensureMcpLoopbackServer: vi.fn(async () => ({ port: 9123, close: vi.fn() })),
  getActiveMcpLoopbackRuntime: vi.fn(() => ({
    port: 9123,
    ownerToken: "owner-token",
    nonOwnerToken: "non-owner-token",
  })),
  registerMcpLoopbackConfigOverride: vi.fn(() => vi.fn()),
  createMcpLoopbackServerConfig: (port: number) => ({
    mcpServers: {
      openclaw: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
      },
    },
  }),
}));

function createDeferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve: resolve as (value: T) => void,
    reject: reject as (error: unknown) => void,
  };
}

function createManagedLiveRun(payload: Promise<{ message: string; session_id: string }>) {
  const stdinWrite = vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
    cb?.();
    void payload.then((resolved) => {
      const stdout = [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: resolved.message }] },
        }),
        JSON.stringify({
          type: "result",
          session_id: resolved.session_id,
          result: resolved.message,
        }),
      ].join("\n");
      const spawnInput = mocks.spawn.mock.calls.at(-1)?.[0] as {
        onStdout?: (chunk: string) => void;
      };
      spawnInput.onStdout?.(`${stdout}\n`);
    });
  });
  return {
    runId: "run-test",
    pid: 12345,
    startedAtMs: Date.now(),
    stdin: {
      write: stdinWrite,
      end: vi.fn(),
    },
    wait: async () => await new Promise<never>(() => {}),
    cancel: vi.fn(),
  };
}

async function waitForCalls(mockFn: { mock: { calls: unknown[][] } }, count: number) {
  await vi.waitFor(
    () => {
      expect(mockFn.mock.calls.length).toBeGreaterThanOrEqual(count);
    },
    { timeout: 2_000, interval: 5 },
  );
}

describe("runClaudeCliAgent", () => {
  beforeEach(() => {
    mocks.spawn.mockClear();
  });

  afterEach(() => {
    resetClaudeLiveSessionsForTest();
  });

  it("starts a new session with --session-id when none is provided", async () => {
    mocks.spawn.mockResolvedValueOnce(
      createManagedLiveRun(Promise.resolve({ message: "ok", session_id: "sid-1" })),
    );

    await runClaudeCliAgent({
      sessionId: "openclaw-session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-1",
    });

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const spawnInput = mocks.spawn.mock.calls[0]?.[0] as {
      argv: string[];
      input?: string;
      mode: string;
      stdinMode?: string;
    };
    expect(spawnInput.mode).toBe("child");
    expect(spawnInput.argv).toContain("claude");
    expect(spawnInput.argv).not.toContain("--session-id");
    expect(spawnInput.argv).toContain("--output-format");
    expect(spawnInput.argv).toContain("stream-json");
    expect(spawnInput.argv).toContain("--input-format");
    expect(spawnInput.argv).toContain("--permission-prompt-tool");
    expect(spawnInput.argv).toContain("stdio");
    expect(spawnInput.argv).toContain("--include-partial-messages");
    expect(spawnInput.argv).toContain("--allowedTools");
    expect(spawnInput.argv).toContain("Read,mcp__openclaw__*");
    expect(spawnInput.argv).not.toContain("hi");
    expect(spawnInput.input).toBeUndefined();
    expect(spawnInput.stdinMode).toBe("pipe-open");
    const managedRun = await mocks.spawn.mock.results[0]?.value;
    expect(managedRun.stdin.write.mock.calls[0]?.[0]).toContain("hi");
  });

  it("uses --resume when a claude session id is provided", async () => {
    mocks.spawn.mockResolvedValueOnce(
      createManagedLiveRun(Promise.resolve({ message: "ok", session_id: "sid-2" })),
    );

    await runClaudeCliAgent({
      sessionId: "openclaw-session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-2",
      claudeSessionId: "c9d7b831-1c31-4d22-80b9-1e50ca207d4b",
    });

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const spawnInput = mocks.spawn.mock.calls[0]?.[0] as { argv: string[]; input?: string };
    expect(spawnInput.argv).toContain("--resume");
    expect(spawnInput.argv).toContain("c9d7b831-1c31-4d22-80b9-1e50ca207d4b");
    expect(spawnInput.argv).not.toContain("--session-id");
    expect(spawnInput.argv).not.toContain("hi");
    expect(spawnInput.input).toBeUndefined();
  });

  it("serializes concurrent claude-cli runs", async () => {
    const firstDeferred = createDeferred<{ message: string; session_id: string }>();
    const secondDeferred = createDeferred<{ message: string; session_id: string }>();

    mocks.spawn
      .mockResolvedValueOnce(createManagedLiveRun(firstDeferred.promise))
      .mockResolvedValueOnce(createManagedLiveRun(secondDeferred.promise));

    const firstRun = runClaudeCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "first",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-1",
    });

    const secondRun = runClaudeCliAgent({
      sessionId: "s2",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "second",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-2",
    });

    await waitForCalls(mocks.spawn, 1);

    firstDeferred.resolve({ message: "ok", session_id: "sid-1" });

    await waitForCalls(mocks.spawn, 2);

    secondDeferred.resolve({ message: "ok", session_id: "sid-2" });

    await Promise.all([firstRun, secondRun]);
  });
});
