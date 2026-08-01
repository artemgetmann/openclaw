import { describe, expect, it } from "vitest";
import type {
  CodexNotification,
  CodexRpcClient,
  CodexServerRequestHandler,
} from "./app-server-client.js";
import { CodexThreadService, requireThreadId } from "./thread-service.js";

class FakeCodexClient implements CodexRpcClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly handlers = new Set<(notification: CodexNotification) => void>();
  closed = false;
  holdTurn = false;
  persistedThreadResponse: Record<string, unknown> | undefined;
  threadStartResponseOverrides: Record<string, unknown> | undefined;
  archivedThreadIds = new Set<string>();
  listedThreads: Array<Record<string, unknown>> = [];
  listedThreadPages = new Map<
    string,
    { data: Array<Record<string, unknown>>; nextCursor?: string }
  >();

  async initialize() {}

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    const record = asRecord(params);
    const threadId = typeof record.threadId === "string" ? record.threadId : "thread-new";
    if (method === "account/read") {
      return { account: { type: "chatgpt" } } as T;
    }
    if (method === "thread/list") {
      const cursor = typeof record.cursor === "string" ? record.cursor : "";
      const page = this.listedThreadPages.get(cursor);
      if (page) {
        return { data: page.data, nextCursor: page.nextCursor ?? null } as T;
      }
      return { data: this.listedThreads } as T;
    }
    if (method === "thread/start") {
      return {
        thread: { id: "thread-new", status: { type: "idle" } },
        cwd: record.cwd,
        approvalPolicy: record.approvalPolicy,
        approvalsReviewer: record.approvalsReviewer,
        sandbox: record.sandbox,
        ...this.threadStartResponseOverrides,
      } as T;
    }
    if (method === "thread/read") {
      return (this.persistedThreadResponse ?? {
        thread: {
          id: threadId,
          status: { type: "idle" },
          archived: this.archivedThreadIds.has(threadId),
          turns: [],
        },
      }) as T;
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
      return { turnId: "turn-1" } as T;
    }
    return {} as T;
  }

  onNotification(handler: (notification: CodexNotification) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onServerRequest(_handler: CodexServerRequestHandler): () => void {
    return () => undefined;
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

  finishTurn(threadId: string, status: "completed" | "failed" | "interrupted" = "completed") {
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
        turn: {
          id: "turn-1",
          status,
          items: [],
          ...(status === "failed" ? { error: { message: "native failure" } } : {}),
        },
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
  it("reports the exact analysis and implementation execution policies", async () => {
    const service = createService(new FakeCodexClient());

    await expect(service.status()).resolves.toMatchObject({
      ok: true,
      executionPolicy:
        "analysis=read-only/network-off/approval-never; implementation=isolated-worktree/workspace-write/network-on/approval-on-request/auto-review",
    });
  });

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
    expect(client.requests[0]).toMatchObject({
      method: "thread/start",
      params: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "read-only",
      },
    });
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

  it("starts a native turn without holding the caller until completion", async () => {
    const client = new FakeCodexClient();
    client.holdTurn = true;
    const service = createService(client);

    const started = await service.startMessage("thread-async", "Work independently.");
    expect(started).toMatchObject({
      threadId: "thread-async",
      turnId: "turn-1",
    });

    // The active-turn fence remains held after startMessage returns. Releasing
    // the Jarvis caller must not allow a second turn into the same thread.
    await expect(service.message("thread-async", "overlap")).rejects.toThrow(
      "already has an active continuation",
    );
    client.finishTurn("thread-async");
    await expect(started.completion).resolves.toMatchObject({
      threadId: "thread-async",
      finalText: "stable final",
    });
  });

  it("does not infer successful completion from an interrupted terminal event", async () => {
    const client = new FakeCodexClient();
    client.holdTurn = true;
    const service = createService(client);
    const started = await service.startMessage("thread-interrupted", "Work independently.");

    client.finishTurn("thread-interrupted", "interrupted");

    await expect(started.completion).rejects.toMatchObject({
      name: "CodexTurnTerminalError",
      terminalStatus: "interrupted",
    });
  });

  it("reads one exact persisted terminal turn without resuming or subscribing", async () => {
    const client = new FakeCodexClient();
    client.persistedThreadResponse = {
      thread: {
        id: "thread-durable",
        turns: [
          {
            id: "turn-other",
            status: "completed",
            items: [{ type: "agentMessage", text: "Unrelated result." }],
          },
          {
            id: "turn-durable",
            status: "completed",
            items: [
              { type: "agentMessage", text: "Progress text." },
              {
                type: "agentMessage",
                phase: "final_answer",
                text: "Exact terminal result.",
              },
            ],
          },
        ],
      },
    };
    const service = createService(client);

    await expect(service.inspectPersistedTurn("thread-durable", "turn-durable")).resolves.toEqual({
      kind: "completed",
      threadId: "thread-durable",
      turnId: "turn-durable",
      finalText: "Exact terminal result.",
    });
    expect(client.requests).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-durable", includeTurns: true },
      },
    ]);
    expect(client.handlers).toHaveLength(0);
  });

  it("fails closed for missing, mismatched, and nonterminal persisted turns", async () => {
    const client = new FakeCodexClient();
    const service = createService(client);

    client.persistedThreadResponse = {
      thread: {
        id: "thread-other",
        turns: [{ id: "turn-1", status: "completed", items: [] }],
      },
    };
    await expect(service.inspectPersistedTurn("thread-1", "turn-1")).resolves.toMatchObject({
      kind: "mismatch",
      expectedThreadId: "thread-1",
      actualThreadId: "thread-other",
    });

    client.persistedThreadResponse = { thread: { id: "thread-1", turns: [] } };
    await expect(service.inspectPersistedTurn("thread-1", "turn-1")).resolves.toMatchObject({
      kind: "missing",
      threadId: "thread-1",
      turnId: "turn-1",
    });

    client.persistedThreadResponse = {
      thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress" }] },
    };
    await expect(service.inspectPersistedTurn("thread-1", "turn-1")).resolves.toMatchObject({
      kind: "nonterminal",
      status: "inProgress",
    });
  });

  it("steers only the exact active native turn", async () => {
    const client = new FakeCodexClient();
    client.holdTurn = true;
    const service = createService(client);
    const started = await service.startMessage("thread-async", "Work independently.");

    await expect(
      service.steer("thread-async", "turn-1", "Use the narrow callback contract."),
    ).resolves.toEqual({
      threadId: "thread-async",
      turnId: "turn-1",
    });
    expect(client.requests.at(-1)).toEqual({
      method: "turn/steer",
      params: {
        threadId: "thread-async",
        expectedTurnId: "turn-1",
        input: [
          {
            type: "text",
            text: "Use the narrow callback contract.",
            text_elements: [],
          },
        ],
      },
    });
    await expect(service.steer("thread-other", "turn-1", "Do not redirect this.")).rejects.toThrow(
      "has no active continuation to steer",
    );

    client.finishTurn("thread-async");
    await started.completion;
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
      omittedInactive: 0,
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
      params: expect.objectContaining({ limit: 100 }),
    });
  });

  it("paginates the catalog and never trims an older active thread", async () => {
    const client = new FakeCodexClient();
    client.listedThreadPages.set("", {
      data: [
        {
          id: "thread-recent-idle",
          status: { type: "idle" },
          updatedAt: 200,
        },
      ],
      nextCursor: "page-2",
    });
    client.listedThreadPages.set("page-2", {
      data: [
        {
          id: "thread-older-active",
          status: { type: "active", activeFlags: [] },
          updatedAt: 100,
        },
        {
          id: "thread-older-idle",
          status: { type: "notLoaded" },
          updatedAt: 50,
        },
      ],
    });
    const service = createService(client);

    await expect(service.fleet(1)).resolves.toEqual({
      mode: "native-codex-fleet",
      counts: { total: 3, active: 1, idle: 2, other: 0 },
      omittedInactive: 2,
      threads: [
        expect.objectContaining({
          threadId: "thread-older-active",
          status: "active",
        }),
      ],
    });
    expect(client.requests.slice(-2)).toEqual([
      {
        method: "thread/list",
        params: expect.objectContaining({
          sourceKinds: expect.arrayContaining(["cli", "exec", "subAgent", "subAgentThreadSpawn"]),
          useStateDbOnly: true,
        }),
      },
      {
        method: "thread/list",
        params: expect.objectContaining({
          cursor: "page-2",
          sourceKinds: expect.arrayContaining(["cli", "exec", "subAgent", "subAgentThreadSpawn"]),
          useStateDbOnly: true,
        }),
      },
    ]);
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
    expect(client.requests[1]).toEqual({
      method: "turn/start",
      params: expect.not.objectContaining({
        approvalPolicy: expect.anything(),
        approvalsReviewer: expect.anything(),
      }),
    });
  });

  it("isolates an implementation delegate without installing process-local tools", async () => {
    const client = new FakeCodexClient();
    const service = new CodexThreadService({
      client: async () => client,
      turnTimeoutMs: 5_000,
      defaultWorkspaceDir: "/repo/openclaw",
      workspaceManager: {
        prepare: async () => ({
          taskMode: "implementation",
          workspaceMode: "isolated",
          projectDir: "/repo/openclaw",
          workspaceDir: "/worktrees/browser-fix",
          worktreeCreated: true,
          baseSha: "abc123",
          branch: "codex/browser-fix",
        }),
      },
    });

    await service.delegate({
      text: "Fix the browser bug.",
      taskMode: "implementation",
      projectDir: "/repo/openclaw",
    });

    expect(client.requests[0]).toEqual({
      method: "thread/start",
      params: expect.objectContaining({
        cwd: "/worktrees/browser-fix",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
      }),
    });
    expect(client.requests[1]).toEqual({
      method: "turn/start",
      params: expect.objectContaining({
        cwd: "/worktrees/browser-fix",
        input: [
          expect.objectContaining({
            text: expect.stringContaining("Read repository policy and adopt its setup"),
          }),
        ],
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/worktrees/browser-fix"],
          networkAccess: true,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        },
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
      }),
    });
  });

  it("fails closed when App Server silently downgrades an implementation worker", async () => {
    const client = new FakeCodexClient();
    client.threadStartResponseOverrides = { approvalsReviewer: "user" };
    const service = new CodexThreadService({
      client: async () => client,
      turnTimeoutMs: 5_000,
      defaultWorkspaceDir: "/repo/openclaw",
      workspaceManager: {
        prepare: async () => ({
          taskMode: "implementation",
          workspaceMode: "isolated",
          projectDir: "/repo/openclaw",
          workspaceDir: "/worktrees/policy-check",
          worktreeCreated: true,
        }),
        discard: async () => undefined,
      },
    });

    await expect(
      service.createDelegateThread({
        taskMode: "implementation",
        projectDir: "/repo/openclaw",
      }),
    ).rejects.toThrow("did not apply the requested approval reviewer");
    expect(client.requests).toHaveLength(1);
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

  it("unarchives only when the fresh native thread state is archived", async () => {
    const client = new FakeCodexClient();
    client.archivedThreadIds.add("thread-1");
    const service = createService(client);

    await expect(service.unarchiveIfNeeded("thread-1")).resolves.toEqual({ changed: true });
    expect(client.requests.slice(-2)).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: false },
      },
      {
        method: "thread/unarchive",
        params: { threadId: "thread-1" },
      },
    ]);
  });

  it("does not repeat unarchive for an already active thread", async () => {
    const client = new FakeCodexClient();
    const service = createService(client);

    await expect(service.unarchiveIfNeeded("thread-1")).resolves.toEqual({ changed: false });
    expect(client.requests).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: false },
      },
    ]);
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
