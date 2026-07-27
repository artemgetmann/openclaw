import { describe, expect, it } from "vitest";
import type { CodexNotification, CodexRpcClient } from "./app-server-client.js";
import { CodexThreadService, requireThreadId } from "./thread-service.js";

class FakeCodexClient implements CodexRpcClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly handlers = new Set<(notification: CodexNotification) => void>();
  closed = false;
  holdTurn = false;
  listedThreads: Array<Record<string, unknown>> = [];
  readStatus = "idle";
  readTurns: Array<Record<string, unknown>> = [];
  steerTurnId: string | undefined;

  async initialize() {}

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    const record = asRecord(params);
    const threadId = typeof record.threadId === "string" ? record.threadId : "thread-new";
    if (method === "account/read") {
      return { account: { type: "chatgpt" } } as T;
    }
    if (method === "thread/list") {
      return { data: this.listedThreads } as T;
    }
    if (method === "thread/start") {
      return { thread: { id: "thread-new", status: { type: "idle" } } } as T;
    }
    if (method === "thread/read") {
      return {
        thread: {
          id: threadId,
          status: { type: this.readStatus },
          turns: this.readTurns,
        },
      } as T;
    }
    if (method === "thread/resume") {
      return { thread: { id: threadId, status: { type: "idle" } } } as T;
    }
    if (method === "thread/fork") {
      return { thread: { id: "thread-fork", status: { type: "idle" } } } as T;
    }
    if (method === "turn/start") {
      if (!this.holdTurn) {
        queueMicrotask(() => this.finishTurn(threadId));
      }
      return { turn: { id: "turn-1" } } as T;
    }
    if (method === "turn/steer") {
      return { turnId: this.steerTurnId ?? record.expectedTurnId } as T;
    }
    return {} as T;
  }

  onNotification(handler: (notification: CodexNotification) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  getServerVersion() {
    return "0.144.1";
  }

  isClosed() {
    return this.closed;
  }

  async close() {
    this.closed = true;
  }

  finishTurn(threadId: string) {
    this.emit({
      method: "item/started",
      params: {
        threadId,
        turnId: "turn-1",
        item: { id: "command-1", type: "commandExecution" },
      },
    });
    this.emit({
      method: "item/agentMessage/delta",
      params: {
        threadId,
        turnId: "turn-1",
        itemId: "assistant-1",
        delta: "stable final",
      },
    });
    this.emit({
      method: "turn/completed",
      params: {
        threadId,
        turn: { id: "turn-1", status: "completed", items: [] },
      },
    });
  }

  private emit(notification: CodexNotification) {
    for (const handler of this.handlers) {
      handler(notification);
    }
  }
}

function createService(client: FakeCodexClient) {
  return new CodexThreadService({
    client: async () => client,
    turnTimeoutMs: 5_000,
    defaultWorkspaceDir: "/tmp/codex-pilot",
  });
}

describe("CodexThreadService", () => {
  it("routes native lifecycle operations to the exact requested thread", async () => {
    const client = new FakeCodexClient();
    const service = createService(client);

    expect(requireThreadId(await service.create())).toBe("thread-new");
    expect(requireThreadId(await service.resume("thread-existing"))).toBe("thread-existing");
    expect(requireThreadId(await service.fork("thread-existing"))).toBe("thread-fork");
    await service.list({ search: "pilot", limit: 5 });

    expect(client.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "thread/start" }),
        expect.objectContaining({
          method: "thread/resume",
          params: expect.objectContaining({ threadId: "thread-existing" }),
        }),
        expect.objectContaining({
          method: "thread/fork",
          params: expect.objectContaining({ threadId: "thread-existing" }),
        }),
        expect.objectContaining({
          method: "thread/list",
          params: expect.objectContaining({ searchTerm: "pilot", limit: 5 }),
        }),
      ]),
    );
  });

  it("projects selected progress while delivering one stable final", async () => {
    const service = createService(new FakeCodexClient());

    await expect(service.message("thread-1", "Reply exactly.")).resolves.toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      finalText: "stable final",
      progress: ["started:commandExecution"],
    });
  });

  it("returns a compact fleet snapshot without loading every thread transcript", async () => {
    const client = new FakeCodexClient();
    client.listedThreads = [
      {
        id: "thread-active",
        name: "Package Jarvis",
        status: { type: "active", activeFlags: [] },
        cwd: "/repo/worktree-a",
        gitInfo: { branch: "codex/a", sha: "abc123" },
        updatedAt: 123,
        turns: [{ id: "large-transcript-that-must-not-leak" }],
      },
      {
        id: "thread-idle",
        preview: "Review the docs",
        status: { type: "idle" },
        cwd: "/repo/worktree-b",
      },
    ];
    const service = createService(client);

    await expect(service.fleet(50)).resolves.toEqual({
      mode: "native-codex-fleet",
      counts: { total: 2, active: 1, idle: 1, other: 0 },
      threads: [
        {
          threadId: "thread-active",
          name: "Package Jarvis",
          status: "active",
          cwd: "/repo/worktree-a",
          branch: "codex/a",
          sha: "abc123",
          updatedAt: 123,
        },
        {
          threadId: "thread-idle",
          name: "Review the docs",
          status: "idle",
          cwd: "/repo/worktree-b",
          branch: undefined,
          sha: undefined,
          updatedAt: undefined,
        },
      ],
    });
    expect(client.requests.at(-1)).toEqual({
      method: "thread/list",
      params: expect.objectContaining({ limit: 50 }),
    });
  });

  it("steers only the freshly observed active turn", async () => {
    const client = new FakeCodexClient();
    client.readStatus = "active";
    client.readTurns = [
      { id: "turn-old", status: "completed" },
      { id: "turn-active", status: "inProgress" },
    ];
    const service = createService(client);

    await expect(service.steer("thread-1", "Stop before deployment.")).resolves.toEqual({
      mode: "native-codex-steer",
      threadId: "thread-1",
      turnId: "turn-active",
    });
    expect(client.requests.slice(-2)).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: true },
      },
      {
        method: "turn/steer",
        params: {
          threadId: "thread-1",
          expectedTurnId: "turn-active",
          input: [{ type: "text", text: "Stop before deployment.", text_elements: [] }],
        },
      },
    ]);
  });

  it("does not turn failed steering into queued future work", async () => {
    const client = new FakeCodexClient();
    client.readStatus = "idle";
    const service = createService(client);

    await expect(service.steer("thread-1", "Do not deploy.")).rejects.toThrow(
      "cannot steer Codex thread thread-1 while status is idle",
    );
    expect(client.requests.map((request) => request.method)).toEqual(["thread/read"]);
  });

  it("rejects a steering response for a different active turn", async () => {
    const client = new FakeCodexClient();
    client.readStatus = "active";
    client.readTurns = [{ id: "turn-active", status: "inProgress" }];
    client.steerTurnId = "turn-replacement";
    const service = createService(client);

    await expect(service.steer("thread-1", "Pause.")).rejects.toThrow("steered a different turn");
  });

  it("starts the first turn on a freshly created empty thread without resuming it", async () => {
    const client = new FakeCodexClient();
    const service = createService(client);

    const created = await service.create();
    await service.message(requireThreadId(created), "first turn");

    expect(client.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
    ]);
  });

  it("allows only one active continuation per native thread", async () => {
    const client = new FakeCodexClient();
    client.holdTurn = true;
    const service = createService(client);

    const first = service.message("thread-1", "first");
    await Promise.resolve();
    await expect(service.message("thread-1", "second")).rejects.toThrow(
      "already has an active continuation",
    );
    client.finishTurn("thread-1");
    await expect(first).resolves.toMatchObject({ finalText: "stable final" });
  });

  it("resumes the durable thread id after a process-local client replacement", async () => {
    const firstClient = new FakeCodexClient();
    const replacementClient = new FakeCodexClient();
    let currentClient = firstClient;
    const service = new CodexThreadService({
      client: async () => currentClient,
      turnTimeoutMs: 5_000,
      defaultWorkspaceDir: "/tmp/codex-pilot",
    });

    await service.message("thread-recovered", "before restart");
    currentClient = replacementClient;
    await service.message("thread-recovered", "after restart");

    expect(replacementClient.requests[0]).toEqual({
      method: "thread/resume",
      params: expect.objectContaining({ threadId: "thread-recovered" }),
    });
  });

  it("fresh-checks idle state immediately before archive", async () => {
    const client = new FakeCodexClient();
    const service = createService(client);

    await service.archive("thread-1");

    expect(client.requests.slice(-2)).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: false },
      },
      {
        method: "thread/archive",
        params: { threadId: "thread-1" },
      },
    ]);
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
