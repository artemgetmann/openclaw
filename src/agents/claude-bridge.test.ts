import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearClaudeBridgeSessionsForTests, runClaudeBridgeAgent } from "./claude-bridge.js";

type SystemPromptReport = Parameters<typeof runClaudeBridgeAgent>[0]["systemPromptReport"];

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

function emitAssistantEvent(child: MockChild, text: string) {
  child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    })}\n`,
  );
}

function emitAssistantStartEvent(child: MockChild) {
  child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { role: "assistant" },
      },
    })}\n`,
  );
}

function emitTextDeltaEvent(child: MockChild, text: string) {
  child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text,
        },
      },
    })}\n`,
  );
}

function emitResultEvent(child: MockChild, text: string, sessionId: string, cacheRead = 0) {
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
      } as SystemPromptReport,
    });

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(child.stdin.writes).toHaveLength(1);
    });
    expect(spawnMock.mock.calls[0]?.[1]).toContain("--include-partial-messages");
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
      } as SystemPromptReport,
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

  it("streams assistant progress through partial and block callbacks before resolving", async () => {
    const child = new MockChild();
    const onAssistantMessageStart = vi.fn();
    const onPartialReply = vi.fn();
    const onBlockReply = vi.fn();
    spawnMock.mockReturnValue(child);

    const runPromise = runClaudeBridgeAgent({
      sessionId: "session-2",
      workspaceDir: "/tmp",
      configBackend: { command: "claude" },
      prompt: "Reply with a short sentence.",
      provider: "claude-bridge",
      model: "sonnet",
      timeoutMs: 5_000,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        sessionId: "session-2",
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
      } as SystemPromptReport,
      onAssistantMessageStart,
      onPartialReply,
      onBlockReply,
    });

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    emitAssistantEvent(child, "Hello");
    emitAssistantEvent(child, "Hello there");
    emitResultEvent(child, "Hello there.", "bridge-session-b");

    const result = await runPromise;

    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(onPartialReply.mock.calls).toEqual([
      [{ text: "Hello" }],
      [{ text: "Hello there" }],
      [{ text: "Hello there." }],
    ]);
    expect(onBlockReply.mock.calls).toEqual([
      [expect.objectContaining({ text: "Hello" })],
      [expect.objectContaining({ text: " there" })],
      [expect.objectContaining({ text: "." })],
    ]);
    expect(result.payloads?.[0]?.text).toBe("Hello there.");
  });

  it("consumes Claude partial-message stream events as incremental text", async () => {
    const child = new MockChild();
    const onAssistantMessageStart = vi.fn();
    const onPartialReply = vi.fn();
    const onBlockReply = vi.fn();
    spawnMock.mockReturnValue(child);

    const runPromise = runClaudeBridgeAgent({
      sessionId: "session-3",
      workspaceDir: "/tmp",
      configBackend: { command: "claude" },
      prompt: "Reply with a short sentence.",
      provider: "claude-bridge",
      model: "sonnet",
      timeoutMs: 5_000,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        sessionId: "session-3",
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
      } as SystemPromptReport,
      onAssistantMessageStart,
      onPartialReply,
      onBlockReply,
    });

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    emitAssistantStartEvent(child);
    emitTextDeltaEvent(child, "Hello");
    emitTextDeltaEvent(child, " there");
    emitResultEvent(child, "Hello there", "bridge-session-c");

    const result = await runPromise;

    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(onPartialReply.mock.calls).toEqual([[{ text: "Hello" }], [{ text: "Hello there" }]]);
    expect(onBlockReply.mock.calls).toEqual([
      [expect.objectContaining({ text: "Hello" })],
      [expect.objectContaining({ text: " there" })],
    ]);
    expect(result.payloads?.[0]?.text).toBe("Hello there");
  });

  it("ignores tool-style bridge events, so transcript-level tool continuity cannot be reconstructed yet", async () => {
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const runPromise = runClaudeBridgeAgent({
      sessionId: "session-tool-gap",
      workspaceDir: "/tmp",
      configBackend: { command: "claude" },
      prompt: "Use the tool and explain what happened.",
      provider: "claude-bridge",
      model: "sonnet",
      timeoutMs: 5_000,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        sessionId: "session-tool-gap",
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
      } as SystemPromptReport,
    });

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    child.stdout.emit(
      "data",
      `${JSON.stringify({
        type: "tool_call",
        id: "tool-call-1",
        name: "exec",
        arguments: { command: "echo hi" },
      })}\n`,
    );
    child.stdout.emit(
      "data",
      `${JSON.stringify({
        type: "tool_result",
        id: "tool-call-1",
        output: "hi",
      })}\n`,
    );
    emitAssistantEvent(child, "Tool finished.");
    emitResultEvent(child, "Tool finished.", "bridge-session-tool-gap");

    const result = await runPromise;

    expect(result.payloads?.[0]?.text).toBe("Tool finished.");
    expect(result.meta.agentMeta?.sessionId).toBe("bridge-session-tool-gap");
  });
});
