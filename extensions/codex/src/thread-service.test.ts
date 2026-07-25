import { describe, expect, it } from "vitest";
import type { CodexNotification, CodexRpcClient } from "./app-server-client.js";
import { CodexThreadService, requireThreadId } from "./thread-service.js";

class FakeCodexClient implements CodexRpcClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly handlers = new Set<(notification: CodexNotification) => void>();
  closed = false;
  holdTurn = false;

  async initialize() {}

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    const record = asRecord(params);
    const threadId = typeof record.threadId === "string" ? record.threadId : "thread-new";
    if (method === "account/read") {
      return { account: { type: "chatgpt" } } as T;
    }
    if (method === "thread/list") {
      return { data: [] } as T;
    }
    if (method === "thread/start") {
      return { thread: { id: "thread-new", status: { type: "idle" } } } as T;
    }
    if (method === "thread/read" || method === "thread/resume") {
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
