import {
  type CodexNotification,
  type CodexRpcClient,
  CodexRpcResponseError,
} from "./app-server-client.js";
import {
  type CodexTaskMode,
  type CodexWorkspaceMode,
  type PrepareWorkspaceRequest,
  type PreparedCodexWorkspace,
} from "./workspace-manager.js";

type JsonObject = Record<string, unknown>;

const ALL_CODEX_THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
] as const;

export type CodexThreadRunResult = {
  threadId: string;
  turnId: string;
  finalText: string;
  progress: string[];
};

export type CodexThreadStarted = {
  threadId: string;
  turnId: string;
  completion: Promise<CodexThreadRunResult>;
};

export class CodexTurnStartAcceptanceAmbiguousError extends Error {
  constructor(cause: unknown) {
    super("Codex turn acceptance became ambiguous while starting the native turn", { cause });
    this.name = "CodexTurnStartAcceptanceAmbiguousError";
  }
}

export type CodexDelegateRequest = {
  text: string;
  taskMode: CodexTaskMode;
  projectDir?: string;
  workspaceDir?: string;
  workspaceMode?: CodexWorkspaceMode;
  featureName?: string;
};

export type CodexDelegateResult = CodexThreadRunResult & {
  mode: "native-codex-delegate";
  execution: PreparedCodexWorkspace;
};

export class CodexTurnTerminalError extends Error {
  constructor(
    readonly terminalStatus: "failed" | "interrupted",
    message: string,
  ) {
    super(message);
    this.name = "CodexTurnTerminalError";
  }
}

export type CodexPersistedTurnInspection =
  | {
      kind: "completed";
      threadId: string;
      turnId: string;
      finalText: string;
    }
  | {
      kind: "failed";
      threadId: string;
      turnId: string;
      error?: string;
    }
  | {
      kind: "interrupted";
      threadId: string;
      turnId: string;
    }
  | {
      kind: "nonterminal";
      threadId: string;
      turnId: string;
      status: string;
    }
  | {
      kind: "missing";
      threadId: string;
      turnId: string;
    }
  | {
      kind: "mismatch";
      expectedThreadId: string;
      actualThreadId?: string;
      turnId: string;
    }
  | {
      kind: "invalid";
      threadId: string;
      turnId: string;
      reason: string;
    };

export type CodexFleetSnapshot = {
  mode: "native-codex-fleet";
  counts: {
    total: number;
    active: number;
    idle: number;
    other: number;
  };
  omittedInactive: number;
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
  dynamicTools?: readonly Record<string, unknown>[];
  workspaceManager?: {
    prepare(request: PrepareWorkspaceRequest): Promise<PreparedCodexWorkspace>;
    discard?(prepared: PreparedCodexWorkspace): Promise<void>;
  };
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
      executionPolicy:
        "analysis=read-only; implementation=isolated-worktree/workspace-write; no-network/no-approval",
    };
  }

  async list(params: {
    search?: string;
    archived?: boolean;
    limit?: number;
    cursor?: string;
    sourceKinds?: readonly string[];
    useStateDbOnly?: boolean;
  }): Promise<unknown> {
    const client = await this.client();
    return await client.request("thread/list", {
      archived: params.archived === true,
      limit: clamp(params.limit ?? 20, 1, 100),
      modelProviders: [],
      sortKey: "recency_at",
      sortDirection: "desc",
      ...(params.cursor ? { cursor: params.cursor } : {}),
      ...(params.sourceKinds ? { sourceKinds: params.sourceKinds } : {}),
      ...(params.useStateDbOnly === true ? { useStateDbOnly: true } : {}),
      ...(params.search?.trim() ? { searchTerm: params.search.trim() } : {}),
    });
  }

  async fleet(limit = 30): Promise<CodexFleetSnapshot> {
    const rosterLimit = clamp(limit, 1, 100);
    const catalog: JsonObject[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    // Active work can be older than the first recency-sorted page. Walk the
    // metadata-only catalog so an active lane cannot disappear merely because
    // many newer idle threads exist. Cursor repetition fails closed instead of
    // returning a plausible but incomplete fleet.
    do {
      const response = asRecord(
        await this.list({
          limit: 100,
          cursor,
          // App Server defaults to interactive sources only. A fleet roster
          // must also include exec and every sub-agent source or it can hide
          // the exact workers the coordinator is responsible for.
          sourceKinds: ALL_CODEX_THREAD_SOURCE_KINDS,
          // Fleet pagination is inventory, not metadata repair. Re-scanning
          // rollout JSONL once per page can create severe I/O pressure on a
          // large catalog and is unnecessary for live status coordination.
          useStateDbOnly: true,
        }),
      );
      catalog.push(...asRecords(response.data));
      const nextCursor = readString(response.nextCursor);
      if (!nextCursor) {
        cursor = undefined;
        break;
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error("Codex App Server repeated a fleet catalog cursor");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);

    const allThreads = catalog
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
    const activeThreads = allThreads.filter((thread) => thread.status === "active");
    const inactiveThreads = allThreads.filter((thread) => thread.status !== "active");
    const threads = [
      ...activeThreads,
      ...inactiveThreads.slice(0, Math.max(0, rosterLimit - activeThreads.length)),
    ];
    const active = activeThreads.length;
    const idle = allThreads.filter(
      (thread) => thread.status === "idle" || thread.status === "notLoaded",
    ).length;
    return {
      mode: "native-codex-fleet",
      counts: {
        total: allThreads.length,
        active,
        idle,
        other: allThreads.length - active - idle,
      },
      omittedInactive: allThreads.length - threads.length,
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

  async delegate(request: CodexDelegateRequest): Promise<CodexDelegateResult> {
    const { execution, threadId } = await this.createDelegateThread(request);
    const task =
      execution.taskMode === "implementation"
        ? buildImplementationPrompt(request.text, execution)
        : request.text;
    const completed = await this.message(threadId, task, execution);
    return { mode: "native-codex-delegate", ...completed, execution };
  }

  async createDelegateThread(
    request: Omit<CodexDelegateRequest, "text">,
  ): Promise<{ threadId: string; execution: PreparedCodexWorkspace }> {
    const workspaceManager = this.options.workspaceManager;
    if (!workspaceManager) {
      throw new Error("Codex workspace manager is unavailable");
    }
    const execution = await workspaceManager.prepare({
      taskMode: request.taskMode,
      projectDir: request.projectDir,
      workspaceDir: request.workspaceDir,
      workspaceMode: request.workspaceMode,
      featureName: request.featureName,
    });
    try {
      const created = await this.createForExecution(execution);
      return { threadId: requireThreadId(created), execution };
    } catch (error) {
      await workspaceManager.discard?.(execution).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Inspect one exact persisted turn without loading, resuming, or observing it.
   *
   * Reconciliation must not attach a fresh listener to work accepted by a dead
   * Gateway: an "active" status does not prove that the new process owns that
   * execution. thread/read(includeTurns) is the deliberately read-only seam.
   */
  async inspectPersistedTurn(
    threadId: string,
    turnId: string,
  ): Promise<CodexPersistedTurnInspection> {
    const expectedThreadId = requireId(threadId);
    const expectedTurnId = requireId(turnId);
    const response = asRecord(
      await (
        await this.client()
      ).request("thread/read", {
        threadId: expectedThreadId,
        includeTurns: true,
      }),
    );
    const thread = asRecord(response.thread);
    const actualThreadId = readString(thread.id);
    if (actualThreadId !== expectedThreadId) {
      return {
        kind: "mismatch",
        expectedThreadId,
        ...(actualThreadId ? { actualThreadId } : {}),
        turnId: expectedTurnId,
      };
    }
    const turn = asRecords(thread.turns).find((candidate) => candidate.id === expectedTurnId);
    if (!turn) {
      return {
        kind: "missing",
        threadId: expectedThreadId,
        turnId: expectedTurnId,
      };
    }
    const actualTurnId = readString(turn.id);
    if (actualTurnId !== expectedTurnId) {
      return {
        kind: "invalid",
        threadId: expectedThreadId,
        turnId: expectedTurnId,
        reason: "persisted turn identity did not match the requested turn",
      };
    }
    const status = readString(turn.status);
    if (!status) {
      return {
        kind: "invalid",
        threadId: expectedThreadId,
        turnId: expectedTurnId,
        reason: "persisted turn did not include a status",
      };
    }
    if (status === "completed") {
      const finalText = readPersistedFinalText(turn);
      if (!finalText) {
        return {
          kind: "invalid",
          threadId: expectedThreadId,
          turnId: expectedTurnId,
          reason: "completed persisted turn did not include a final agent message",
        };
      }
      return {
        kind: "completed",
        threadId: expectedThreadId,
        turnId: expectedTurnId,
        finalText,
      };
    }
    if (status === "failed") {
      return {
        kind: "failed",
        threadId: expectedThreadId,
        turnId: expectedTurnId,
        ...(readNestedString(turn, ["error", "message"])
          ? { error: readNestedString(turn, ["error", "message"]) }
          : {}),
      };
    }
    if (status === "interrupted") {
      return {
        kind: "interrupted",
        threadId: expectedThreadId,
        turnId: expectedTurnId,
      };
    }
    return {
      kind: "nonterminal",
      threadId: expectedThreadId,
      turnId: expectedTurnId,
      status,
    };
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
      developerInstructions: ANALYSIS_DEVELOPER_INSTRUCTIONS,
      experimentalRawEvents: true,
      ...(this.options.dynamicTools?.length ? { dynamicTools: this.options.dynamicTools } : {}),
    });
    this.loadedThreadIds.add(requireThreadId(response));
    return response;
  }

  async resume(threadId: string): Promise<JsonObject> {
    const client = await this.client();
    const response = await client.request<JsonObject>("thread/resume", {
      threadId: requireId(threadId),
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
      threadSource: "appServer",
      excludeTurns: true,
    });
    this.loadedThreadIds.add(requireThreadId(response));
    return response;
  }

  async message(
    threadId: string,
    text: string,
    execution?: PreparedCodexWorkspace | string,
  ): Promise<CodexThreadRunResult> {
    return await (
      await this.startMessage(threadId, text, execution)
    ).completion;
  }

  /**
   * Start one native turn and return as soon as App Server accepts it.
   *
   * The separate completion promise lets Jarvis release its current agent run,
   * remain responsive to new owner messages, and project the eventual Codex
   * result back through a session-scoped wake. Synchronous callers keep using
   * message(), which deliberately preserves the older wait-for-final contract.
   */
  async startMessage(
    threadId: string,
    text: string,
    execution?: PreparedCodexWorkspace | string,
  ): Promise<CodexThreadStarted> {
    const normalizedThreadId = requireId(threadId);
    const prompt = text.trim();
    if (!prompt) {
      throw new Error("text is required");
    }
    if (this.activeThreadIds.has(normalizedThreadId)) {
      throw new Error(`Codex thread ${normalizedThreadId} already has an active continuation`);
    }
    this.activeThreadIds.add(normalizedThreadId);
    let stopNotifications: (() => void) | undefined;
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
      stopNotifications = client.onNotification(collector.handleNotification);
      let response: JsonObject;
      try {
        response = await client.request<JsonObject>("turn/start", {
          threadId: normalizedThreadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          // Continuations intentionally omit cwd/sandbox so App Server preserves
          // the durable thread policy. A prepared first turn supplies the exact
          // isolated write boundary.
          ...buildTurnExecutionOverrides(execution),
          approvalPolicy: "never",
          approvalsReviewer: "user",
          personality: "none",
        });
      } catch (error) {
        // A JSON-RPC application error proves the server rejected the request.
        // Timeout, transport loss, or malformed transport after write cannot
        // prove non-acceptance and therefore must never be made retryable.
        if (error instanceof CodexRpcResponseError && error.method === "turn/start") {
          throw error;
        }
        throw new CodexTurnStartAcceptanceAmbiguousError(error);
      }
      const turnId = readNestedString(response, ["turn", "id"]);
      if (!turnId) {
        throw new CodexTurnStartAcceptanceAmbiguousError(
          new Error("Codex App Server turn/start response did not include a turn id"),
        );
      }
      collector.setTurnId(turnId);

      // Own cleanup on the detached completion promise. This keeps the
      // one-active-turn fence held until the native turn actually terminates,
      // even though the caller is no longer awaiting that work inline.
      const completion = collector.wait(this.options.turnTimeoutMs).finally(() => {
        stopNotifications?.();
        this.activeThreadIds.delete(normalizedThreadId);
      });
      return {
        threadId: normalizedThreadId,
        turnId,
        completion,
      };
    } catch (error) {
      stopNotifications?.();
      this.activeThreadIds.delete(normalizedThreadId);
      throw error;
    }
  }

  /**
   * Add coordinator guidance to the exact active native turn.
   *
   * App Server enforces expectedTurnId as a compare-and-steer precondition, so
   * a stale callback can never redirect text into a newer turn on the thread.
   */
  async steer(
    threadId: string,
    turnId: string,
    text: string,
  ): Promise<{
    threadId: string;
    turnId: string;
  }> {
    const normalizedThreadId = requireId(threadId);
    const normalizedTurnId = requireId(turnId);
    const prompt = text.trim();
    if (!prompt) {
      throw new Error("text is required");
    }
    if (!this.activeThreadIds.has(normalizedThreadId)) {
      throw new Error(`Codex thread ${normalizedThreadId} has no active continuation to steer`);
    }
    const response = await (
      await this.client()
    ).request<JsonObject>("turn/steer", {
      threadId: normalizedThreadId,
      expectedTurnId: normalizedTurnId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    const returnedTurnId = readString(response.turnId);
    if (returnedTurnId !== normalizedTurnId) {
      throw new Error("Codex App Server steered a different turn than requested");
    }
    return {
      threadId: normalizedThreadId,
      turnId: normalizedTurnId,
    };
  }

  private async createForExecution(execution: PreparedCodexWorkspace): Promise<JsonObject> {
    const implementation = execution.taskMode === "implementation";
    const response = await (
      await this.client()
    ).request<JsonObject>("thread/start", {
      cwd: execution.workspaceDir,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: implementation ? "workspace-write" : "read-only",
      personality: "none",
      serviceName: "OpenClaw",
      developerInstructions: implementation
        ? IMPLEMENTATION_DEVELOPER_INSTRUCTIONS
        : ANALYSIS_DEVELOPER_INSTRUCTIONS,
      experimentalRawEvents: true,
      ...(this.options.dynamicTools?.length ? { dynamicTools: this.options.dynamicTools } : {}),
    });
    this.loadedThreadIds.add(requireThreadId(response));
    return response;
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

  async unarchiveIfNeeded(threadId: string): Promise<{ changed: boolean }> {
    const normalizedThreadId = requireId(threadId);
    const response = asRecord(await this.read(normalizedThreadId, false));
    const returnedId = readNestedString(response, ["thread", "id"]);
    if (returnedId !== normalizedThreadId) {
      throw new Error("Codex App Server returned a different thread while checking unarchive");
    }
    const thread = asRecord(response.thread);
    if (thread.archived !== true) {
      return { changed: false };
    }
    await (
      await this.client()
    ).request("thread/unarchive", {
      threadId: normalizedThreadId,
    });
    return { changed: true };
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

const ANALYSIS_DEVELOPER_INSTRUCTIONS = [
  "You are a native Codex analysis worker for Jarvis.",
  "Keep the selected project read-only. Inspect and report evidence; do not edit files, create worktrees, install dependencies, or mutate Git state.",
].join(" ");

const IMPLEMENTATION_DEVELOPER_INSTRUCTIONS = [
  "You are a native Codex implementation worker for Jarvis.",
  "You were launched in an isolated worktree with workspace-write access only to that worktree.",
  "Before editing, read the repository-local policy and adopt its required setup/workflow when safe within your sandbox.",
  "Never edit the source checkout, shared runtime, or any path outside the assigned worktree.",
].join(" ");

function buildImplementationPrompt(text: string, execution: PreparedCodexWorkspace): string {
  return [
    "Jarvis implementation execution contract:",
    `- Assigned worktree: ${execution.workspaceDir}`,
    `- Source project: ${execution.projectDir}`,
    `- Base commit: ${execution.baseSha ?? "unknown"}`,
    `- Branch: ${execution.branch ?? "unknown"}`,
    "- Read repository policy and adopt its setup before implementation.",
    "- Keep all writes inside the assigned worktree and report any policy/setup blocker.",
    "",
    "Task:",
    text,
  ].join("\n");
}

function buildTurnExecutionOverrides(
  execution: PreparedCodexWorkspace | string | undefined,
): JsonObject {
  if (!execution) {
    return {};
  }
  if (typeof execution === "string") {
    return {
      cwd: execution,
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    };
  }
  if (execution.taskMode === "implementation") {
    return {
      cwd: execution.workspaceDir,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [execution.workspaceDir],
        networkAccess: false,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
      },
    };
  }
  return {
    cwd: execution.workspaceDir,
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  };
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
      failure = new CodexTurnTerminalError(
        "failed",
        readNestedString(turn, ["error", "message"]) ?? "Codex App Server turn failed",
      );
      settle();
      return;
    }
    if (status === "interrupted") {
      failure = new CodexTurnTerminalError("interrupted", "Codex App Server turn was interrupted");
      settle();
      return;
    }
    if (status !== "completed") {
      failure = new Error(
        `Codex App Server turn completed with ambiguous status ${status ?? "unknown"}`,
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

function readPersistedFinalText(turn: JsonObject): string | undefined {
  const messages = asRecords(turn.items).filter(
    (item) => readString(item.type) === "agentMessage" && readString(item.text),
  );
  // Newer App Server versions label the authoritative terminal response. The
  // last agent message is the compatible fallback for older persisted turns.
  const final =
    messages.findLast((item) => readString(item.phase) === "final_answer") ?? messages.at(-1);
  return readString(final?.text)?.trim();
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
