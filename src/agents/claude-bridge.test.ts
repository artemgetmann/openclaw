import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearClaudeBridgeSessionsForTests, runClaudeBridgeAgent } from "./claude-bridge.js";

const spawnMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

class MockChild extends EventEmitter {
  stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
  stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
  stdin = Object.assign(new EventEmitter(), {
    writes: [] as string[],
    write: (data: string, cb?: (error?: Error | null) => void) => {
      this.stdin.writes.push(data);
      cb?.(null);
      return true;
    },
  });
  kill = vi.fn();
  constructor() {
    super();
    this.stdout.setEncoding = vi.fn();
    this.stderr.setEncoding = vi.fn();
  }
}

function emitTurn(child: MockChild, text: string, sessionId: string, cacheRead = 0) {
  child.stdout.emit(
    "data",
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`,
  );
  child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", isUsingOverage: false },
    })}\n`,
  );
  child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "result",
      result: text,
      session_id: sessionId,
      usage: {
        input_tokens: 3,
        output_tokens: 6,
        cache_read_input_tokens: cacheRead,
        cache_write_input_tokens: 4,
        total_tokens: 9,
      },
    })}\n`,
  );
}

describe("runClaudeBridgeAgent", () => {
  beforeEach(async () => {
    spawnMock.mockReset();
    await clearClaudeBridgeSessionsForTests();
  });

  it("reuses one live child and captures stream-json result usage", async () => {
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const first = runClaudeBridgeAgent({
      sessionId: "session-1",
      workspaceDir: "/tmp",
      configBackend: { command: "claude" },
      prompt: "Reply with exactly ONE.",
      provider: "claude-bridge",
      model: "sonnet",
      timeoutMs: 5_000,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        sessionId: "session-1",
        provider: "claude-bridge",
        model: "sonnet",
        workspaceDir: "/tmp",
        bootstrapMaxChars: 1,
        bootstrapTotalMaxChars: 1,
        sandbox: { mode: "off", sandboxed: false },
        systemPrompt: "",
        bootstrapFiles: [],
        injectedFiles: [],
        skillsPrompt: "",
        tools: [],
      },
    });

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(child.stdin.writes).toHaveLength(1);
    });
    emitTurn(child, "ONE", "bridge-session-a");

    const firstResult = await first;
    expect(firstResult.payloads?.[0]?.text).toBe("ONE");
    expect(firstResult.meta.agentMeta?.sessionId).toBe("bridge-session-a");
    expect(firstResult.meta.agentMeta?.usage?.cacheRead).toBe(0);

    const second = runClaudeBridgeAgent({
      sessionId: "session-1",
      workspaceDir: "/tmp",
      configBackend: { command: "claude" },
      prompt: "Reply with exactly TWO.",
      provider: "claude-bridge",
      model: "sonnet",
      timeoutMs: 5_000,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        sessionId: "session-1",
        provider: "claude-bridge",
        model: "sonnet",
        workspaceDir: "/tmp",
        bootstrapMaxChars: 1,
        bootstrapTotalMaxChars: 1,
        sandbox: { mode: "off", sandboxed: false },
        systemPrompt: "",
        bootstrapFiles: [],
        injectedFiles: [],
        skillsPrompt: "",
        tools: [],
      },
    });

    await vi.waitFor(() => {
      expect(child.stdin.writes).toHaveLength(2);
    });
    emitTurn(child, "TWO", "bridge-session-a", 17);
    const secondResult = await second;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child.stdin.writes).toHaveLength(2);
    expect(secondResult.payloads?.[0]?.text).toBe("TWO");
    expect(secondResult.meta.agentMeta?.usage?.cacheRead).toBe(17);
  });
});
