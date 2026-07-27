import type { CodexNotification, CodexRpcClient } from "./app-server-client.js";

type JsonObject = Record<string, unknown>;

export type CodexThreadRunResult = {
  threadId: string;
  turnId: string;
  finalText: string;
  progress: string[];
};

export type CodexThreadSteerResult = {
  mode: "native-codex-steer";
  threadId: string;
  turnId: string;
};

export type CodexFleetSnapshot = {
  mode: "native-codex-fleet";
  counts: {
    total: number;
    active: number;
    idle: number;
    other: number;
  };
  threads: Array<{
    threadId: string;
    name?: string;
    status?: string;
    cwd?: string;
    branch?: string;
    sha?: string;
    updatedAt?: number;
  }>;
};

type ThreadServiceOptions = {
  client: () => Promise<CodexRpcClient>;
  turnTimeoutMs: number;
  defaultWorkspaceDir: string;
};

/**
 * Native thread lifecycle facade.
 *
 * The active-thread set is a process-local concurrency fence. Durable Codex
 * thread state lives in the user's Codex home, while OpenClaw conversation
 * binding data stores the thread id needed to resume after a Gateway restart.
 */
export class CodexThreadService {
  private readonly activeThreadIds = new Set<string>();
  private readonly loadedThreadIds = new Set<string>();
  private currentClient: CodexRpcClient | undefined;

  constructor(private readonly options: ThreadServiceOptions) {}

  async status(): Promise<Record<string, unknown>> {
    const client = await this.client();
    const [account, threads] = await Promise.all([
      client.request<JsonObject>("account/read", { refreshToken: false }),
      client.request<JsonObject>("thread/list", {
        limit: 1,
        sortKey: "recency_at",
        sortDirection: "desc",
        modelProviders: [],
        useStateDbOnly: true,
      }),
    ]);
    return {
      ok: true,
      serverVersion: client.getServerVersion(),
      accountType: readAccountType(account),
      threadCatalogReachable: Array.isArray(threads.data),
      activeContinuations: this.activeThreadIds.size,
      executionPolicy: "read-only/no-network/no-approval",
    };
  }

  async list(params: { search?: string; archived?: boolean; limit?: number }): Promise<unknown> {
    const client = await this.client();
    return await client.request("thread/list", {
      archived: params.archived === true,
      limit: clamp(params.limit ?? 20, 1, 100),
      modelProviders: [],
      sortKey: "recency_at",
      sortDirection: "desc",
      ...(params.search?.trim() ? { searchTerm: params.search.trim() } : {}),
    });
  }

  async fleet(limit = 30): Promise<CodexFleetSnapshot> {
    const response = asRecord(await this.list({ limit }));
    const threads = asRecords(response.data)
      .map((thread) => {
        const threadId = readString(thread.id);
        if (!threadId) {
          return undefined;
        }
        return {
          threadId,
          name: readString(thread.name) ?? readString(thread.preview),
          status: readNestedString(thread, ["status", "type"]),
          cwd: readString(thread.cwd),
          branch: readNestedString(thread, ["gitInfo", "branch"]),
          sha: readNestedString(thread, ["gitInfo", "sha"]),
          updatedAt: readNumberValue(thread.updatedAt),
        };
      })
      .filter((thread): thread is NonNullable<typeof thread> => Boolean(thread));
    const active = threads.filter((thread) => thread.status === "active").length;
    const idle = threads.filter(
      (thread) => thread.status === "idle" || thread.status === "notLoaded",
    ).length;
    return {
      mode: "native-codex-fleet",
      counts: {
        total: threads.length,
        active,
        idle,
        other: threads.length - active - idle,
      },
      threads,
    };
  }

  async read(threadId: string, includeTurns = false): Promise<unknown> {
    return await (
      await this.client()
    ).request("thread/read", {
      threadId: requireId(threadId),
      includeTurns,
    });
  }

  async create(cwd = this.options.defaultWorkspaceDir): Promise<JsonObject> {
    const client = await this.client();
    const response = await client.request<JsonObject>("thread/start", {
      cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      personality: "none",
      serviceName: "OpenClaw",
      developerInstructions:
        "This thread is controlled by the isolated OpenClaw Codex pilot. Work read-only, do not use network access, and return one concise final answer.",
      experimentalRawEvents: true,
    });
    this.loadedThreadIds.add(requireThreadId(response));
    return response;
  }

  async resume(threadId: string): Promise<JsonObject> {
    const client = await this.client();
    const response = await client.request<JsonObject>("thread/resume", {
      threadId: requireId(threadId),
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      excludeTurns: true,
      initialTurnsPage: {
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
    });
    this.loadedThreadIds.add(requireThreadId(response));
    return response;
  }

  async fork(threadId: string): Promise<JsonObject> {
    const sourceId = requireId(threadId);
    await this.assertIdle(sourceId, "fork");
    const response = await (
      await this.client()
    ).request<JsonObject>("thread/fork", {
      threadId: sourceId,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      threadSource: "appServer",
      excludeTurns: true,
    });
    this.loadedThreadIds.add(requireThreadId(response));
    return response;
  }

  async message(
    threadId: string,
    text: string,
    cwd = this.options.defaultWorkspaceDir,
  ): Promise<CodexThreadRunResult> {
    const normalizedThreadId = requireId(threadId);
    const prompt = text.trim();
    if (!prompt) {
      throw new Error("text is required");
    }
    if (this.activeThreadIds.has(normalizedThreadId)) {
      throw new Error(`Codex thread ${normalizedThreadId} already has an active continuation`);
    }
    this.activeThreadIds.add(normalizedThreadId);
    try {
      const client = await this.client();
      // A just-created empty thread is already loaded but has no rollout yet,
      // so attempting thread/resume would fail. After a client replacement the
      // generation fence clears this set and forces a durable resume.
      if (!this.loadedThreadIds.has(normalizedThreadId)) {
        const resumed = await this.resume(normalizedThreadId);
        assertThreadNotActive(resumed, normalizedThreadId);
      }
      const collector = createTurnCollector(normalizedThreadId);
      const stopNotifications = client.onNotification(collector.handleNotification);
      try {
        const response = await client.request<JsonObject>("turn/start", {
          threadId: normalizedThreadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          // A delegate can target the current project explicitly. Existing
          // binding/message callers retain the configured default workspace.
          cwd,
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          personality: "none",
        });
        const turnId = readNestedString(response, ["turn", "id"]);
        if (!turnId) {
          throw new Error("Codex App Server turn/start response did not include a turn id");
        }
        collector.setTurnId(turnId);
        return await collector.wait(this.options.turnTimeoutMs);
      } finally {
        stopNotifications();
      }
    } finally {
      this.activeThreadIds.delete(normalizedThreadId);
    }
  }

  async steer(threadId: string, text: string): Promise<CodexThreadSteerResult> {
    const normalizedThreadId = requireId(threadId);
    const prompt = text.trim();
    if (!prompt) {
      throw new Error("text is required");
    }

    // Read and steer through one App Server generation. The active turn id is
    // an optimistic-concurrency token: if the worker finishes or a replacement
    // turn starts after this read, turn/steer fails instead of modifying the
    // wrong work. Never fall back to turn/start because that would silently
    // change an immediate coordination instruction into queued future work.
    const client = await this.client();
    const response = asRecord(
      await client.request("thread/read", {
        threadId: normalizedThreadId,
        includeTurns: true,
      }),
    );
    const returnedThreadId = readNestedString(response, ["thread", "id"]);
    if (returnedThreadId !== normalizedThreadId) {
      throw new Error("Codex App Server returned a different thread while preparing steering");
    }
    const status = readNestedString(response, ["thread", "status", "type"]);
    if (status !== "active") {
      throw new Error(
        `cannot steer Codex thread ${normalizedThreadId} while status is ${status ?? "unknown"}`,
      );
    }
    const activeTurnIds = asRecords(asRecord(response.thread).turns)
      .filter((turn) => readString(turn.status) === "inProgress")
      .map((turn) => readString(turn.id))
      .filter((turnId): turnId is string => Boolean(turnId));
    if (activeTurnIds.length !== 1) {
      throw new Error(
        `cannot steer Codex thread ${normalizedThreadId}: expected one active turn, found ${activeTurnIds.length}`,
      );
    }
    const expectedTurnId = activeTurnIds[0];
    const steered = asRecord(
      await client.request("turn/steer", {
        threadId: normalizedThreadId,
        expectedTurnId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      }),
    );
    const returnedTurnId = readString(steered.turnId);
    if (returnedTurnId !== expectedTurnId) {
      throw new Error("Codex App Server steered a different turn than requested");
    }
    return {
      mode: "native-codex-steer",
      threadId: normalizedThreadId,
      turnId: expectedTurnId,
    };
  }

  async archive(threadId: string): Promise<void> {
    const normalizedThreadId = requireId(threadId);
    await this.assertIdle(normalizedThreadId, "archive");
    await (
      await this.client()
    ).request("thread/archive", {
      threadId: normalizedThreadId,
    });
  }

  async unarchive(threadId: string): Promise<void> {
    const normalizedThreadId = requireId(threadId);
    // A fresh read proves the target exists before the separate mutation. The
    // one-time approval token owns the remaining cross-client race.
    await this.read(normalizedThreadId, false);
    await (
      await this.client()
    ).request("thread/unarchive", {
      threadId: normalizedThreadId,
    });
  }

  private async assertIdle(threadId: string, action: string): Promise<void> {
    const response = asRecord(await this.read(threadId, false));
    const returnedId = readNestedString(response, ["thread", "id"]);
    if (returnedId !== threadId) {
      throw new Error(`Codex App Server returned a different thread while checking ${action}`);
    }
    const status = readNestedString(response, ["thread", "status", "type"]);
    if (status !== "idle" && status !== "notLoaded") {
      throw new Error(
        `cannot ${action} Codex thread ${threadId} while status is ${status ?? "unknown"}`,
      );
    }
  }

  private async client(): Promise<CodexRpcClient> {
    const client = await this.options.client();
    if (client !== this.currentClient) {
      // App Server loaded-thread state is process-local. Never carry it across
      // a replacement child; durable threads must be resumed on the new client.
      this.currentClient = client;
      this.loadedThreadIds.clear();
    }
    return client;
  }
}

function createTurnCollector(threadId: string) {
  let turnId: string | undefined;
  let completed: CodexThreadRunResult | undefined;
  let failure: Error | undefined;
  let resolveWait: ((result: CodexThreadRunResult) => void) | undefined;
  let rejectWait: ((error: Error) => void) | undefined;
  const assistantText = new Map<string, string>();
  const assistantOrder: string[] = [];
  const progress: string[] = [];
  const pending: CodexNotification[] = [];

  const rememberProgress = (value: string) => {
    if (value && progress.at(-1) !== value && progress.length < 24) {
      progress.push(value);
    }
  };
  const rememberAssistant = (itemId: string, text: string, append: boolean) => {
    if (!assistantOrder.includes(itemId)) {
      assistantOrder.push(itemId);
    }
    assistantText.set(itemId, append ? `${assistantText.get(itemId) ?? ""}${text}` : text);
  };
  const settle = () => {
    if (failure) {
      rejectWait?.(failure);
    } else if (completed) {
      resolveWait?.(completed);
    }
  };
  const handleNotification = (notification: CodexNotification) => {
    const params = notification.params;
    if (!params || params.threadId !== threadId) {
      return;
    }
    const notificationTurnId =
      readString(params.turnId) ?? readNestedString(params, ["turn", "id"]);
    if (!turnId) {
      pending.push(notification);
      return;
    }
    if (notificationTurnId && notificationTurnId !== turnId) {
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      rememberAssistant(
        readString(params.itemId) ?? "assistant",
        readString(params.delta) ?? "",
        true,
      );
      return;
    }
    if (notification.method === "item/started") {
      const itemType = readNestedString(params, ["item", "type"]);
      if (itemType && itemType !== "agentMessage") {
        rememberProgress(`started:${itemType}`);
      }
      return;
    }
    if (notification.method === "item/completed") {
      const item = asRecord(params.item);
      const itemType = readString(item.type);
      if (itemType === "agentMessage") {
        rememberAssistant(readString(item.id) ?? "assistant", readString(item.text) ?? "", false);
      } else if (itemType) {
        rememberProgress(`completed:${itemType}`);
      }
      return;
    }
    if (notification.method !== "turn/completed") {
      return;
    }
    const turn = asRecord(params.turn);
    const status = readString(turn.status);
    if (status === "failed") {
      failure = new Error(
        readNestedString(turn, ["error", "message"]) ?? "Codex App Server turn failed",
      );
      settle();
      return;
    }
    const finalText =
      assistantOrder
        .map((itemId) => assistantText.get(itemId)?.trim())
        .filter((value): value is string => Boolean(value))
        .at(-1) ?? "";
    completed = {
      threadId,
      turnId,
      finalText: finalText || "Codex completed without a text reply.",
      progress,
    };
    settle();
  };

  return {
    handleNotification,
    setTurnId(id: string) {
      turnId = id;
      for (const notification of pending.splice(0)) {
        handleNotification(notification);
      }
    },
    wait(timeoutMs: number): Promise<CodexThreadRunResult> {
      if (failure) {
        return Promise.reject(failure);
      }
      if (completed) {
        return Promise.resolve(completed);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Codex thread ${threadId} turn timed out`)),
          timeoutMs,
        );
        timer.unref?.();
        resolveWait = (result) => {
          clearTimeout(timer);
          resolve(result);
        };
        rejectWait = (error) => {
          clearTimeout(timer);
          reject(error);
        };
      });
    },
  };
}

function assertThreadNotActive(response: JsonObject, threadId: string): void {
  const returnedId = requireThreadId(response);
  if (returnedId !== threadId) {
    throw new Error("Codex App Server resumed a different thread than requested");
  }
  const status = readNestedString(response, ["thread", "status", "type"]);
  if (status === "active") {
    throw new Error(`Codex thread ${threadId} already has an active turn`);
  }
}

export function requireThreadId(value: unknown): string {
  const id = readNestedString(asRecord(value), ["thread", "id"]);
  if (!id) {
    throw new Error("Codex App Server response did not include a thread id");
  }
  return id;
}

function readAccountType(account: JsonObject): string | undefined {
  return (
    readNestedString(account, ["account", "type"]) ??
    readNestedString(account, ["account", "planType"])
  );
}

function requireId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("thread_id is required");
  }
  return normalized;
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asRecords(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNestedString(value: JsonObject, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)[key];
  }
  return readString(current);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
