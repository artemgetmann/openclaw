import { randomUUID } from "node:crypto";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  PluginCommandContext,
  PluginCommandResult,
} from "../../src/plugins/types.js";
import { CodexAppServerClient, type CodexRpcClient } from "./src/app-server-client.js";
import { CodexApprovalStore, type CodexApprovalAction } from "./src/approval-store.js";
import { CodexThreadService, requireThreadId } from "./src/thread-service.js";

type PilotConfig = {
  command: string;
  args: string[];
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  defaultWorkspaceDir: string;
};

type ToolParams = {
  action?: string;
  thread_id?: string;
  text?: string;
  workspace_dir?: string;
  search?: string;
  archived?: boolean;
  include_turns?: boolean;
  limit?: number;
};

const APPROVAL_NAMESPACE = "codexpilot";
const BINDING_KIND = "codex-app-server-pilot";

// Keep this bundled extension dependency-free. The plugin API accepts standard
// JSON Schema, so pulling TypeBox into a new workspace package would add no
// runtime value and would unnecessarily change the production dependency graph.
const ToolSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "status",
        "list",
        "fleet",
        "search",
        "read",
        "create",
        "message",
        "message_async",
        "delegate",
        "delegate_async",
        "resume",
        "fork",
      ],
    },
    thread_id: { type: "string" },
    text: { type: "string" },
    workspace_dir: { type: "string" },
    search: { type: "string" },
    archived: { type: "boolean" },
    include_turns: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

/**
 * Selective compatibility port of the official Codex extension.
 *
 * Pi remains the default agent runtime. Codex is entered only through this
 * owner-only tool, the explicit /codex command, or a conversation that was
 * explicitly approved and bound to a native Codex thread.
 */
export default function register(api: OpenClawPluginApi) {
  const config = readPilotConfig(api);
  let clientPromise: Promise<CodexRpcClient> | undefined;

  const getClient = async (): Promise<CodexRpcClient> => {
    const existing = await clientPromise?.catch(() => undefined);
    if (existing && !existing.isClosed()) {
      return existing;
    }
    clientPromise = (async () => {
      const client = new CodexAppServerClient({
        command: config.command,
        args: config.args,
        requestTimeoutMs: config.requestTimeoutMs,
      });
      try {
        await client.initialize();
        return client;
      } catch (error) {
        await client.close();
        throw explicitUnavailableError(error);
      }
    })();
    return await clientPromise;
  };

  const service = new CodexThreadService({
    client: getClient,
    turnTimeoutMs: config.turnTimeoutMs,
    defaultWorkspaceDir: config.defaultWorkspaceDir,
  });
  const approvals = new CodexApprovalStore();

  // This is deliberately not an optional plugin tool. Optional tools are
  // removed before the primary agent sees them unless an operator maintains a
  // separate allowlist, which made the normal natural-language delegation path
  // impossible in production. The factory remains the security boundary: only
  // the owner in a non-sandboxed session receives this capability.
  api.registerTool(
    ((ctx) => {
      if (ctx.senderIsOwner !== true || ctx.sandboxed) {
        return null;
      }
      return createCodexTool(service, api, ctx) as AnyAgentTool;
    }) as OpenClawPluginToolFactory,
    { name: "codex_threads" },
  );

  // The normal consumer route is natural-language delegation through Jarvis.
  // Keep this policy in the cached system prompt so the primary agent can
  // gather context and formulate a self-contained task before it calls the
  // native thread tool; a raw inbound hook cannot safely reconstruct prior
  // conversational context such as "the browser issue you just identified".
  api.on("before_prompt_build", async () => ({
    prependSystemContext: CODEX_DELEGATION_GUIDANCE,
  }));

  api.registerCommand({
    name: "codex",
    description: "Control or explicitly bind a native Codex thread",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => await handleCodexCommand(ctx, service, approvals),
  });

  api.registerInteractiveHandler({
    channel: "telegram",
    namespace: APPROVAL_NAMESPACE,
    handler: async (ctx) => {
      const parsed = parseApprovalPayload(ctx.callback.payload);
      if (!ctx.auth.isAuthorizedSender || !parsed) {
        return { handled: true };
      }
      const approval = approvals.consume({
        token: parsed.token,
        decision: parsed.decision,
        senderId: ctx.senderId,
      });
      await ctx.respond.clearButtons();
      if (!approval) {
        await ctx.respond.editMessage({ text: "Codex approval expired or was already used." });
        return { handled: true };
      }
      if (parsed.decision === "reject") {
        await ctx.respond.editMessage({
          text: `Rejected ${approval.action} for Codex thread ${approval.threadId}.`,
        });
        return { handled: true };
      }
      if (parsed.decision === "open") {
        await ctx.respond.editMessage({
          text: `Open Codex on this Mac and select thread ${approval.threadId}. No change was made.`,
        });
        return { handled: true };
      }
      try {
        await runApprovedMutation(service, approval.action, approval.threadId);
        await ctx.respond.editMessage({
          text: `${capitalize(approval.action)}d Codex thread ${approval.threadId}.`,
        });
      } catch (error) {
        await ctx.respond.editMessage({
          text: `Codex ${approval.action} failed after a fresh state check: ${formatError(error)}`,
        });
      }
      return { handled: true };
    },
  });

  api.on("inbound_claim", async (event, ctx) => {
    const bindingData = ctx.pluginBinding?.data;
    if (bindingData?.kind !== BINDING_KIND || typeof bindingData.threadId !== "string") {
      return undefined;
    }
    if (event.senderIsOwner !== true) {
      return {
        handled: true,
        reply: { text: "This Codex-bound conversation is owner-only. No task was started." },
      };
    }
    const prompt = event.bodyForAgent?.trim() || event.content.trim();
    if (!prompt) {
      return { handled: true };
    }
    if (ctx.replyProgress) {
      try {
        await ctx.replyProgress({
          text: `Codex started · ${bindingData.threadId}`,
        });
      } catch {
        // A progress transport failure must not cancel an otherwise valid
        // native turn. The terminal result still uses core-owned delivery.
      }
    }
    try {
      const result = await service.message(bindingData.threadId, prompt);
      return {
        handled: true,
        reply: {
          text: formatCodexFinal(result.threadId, result.finalText, result.progress),
        },
      };
    } catch (error) {
      return {
        handled: true,
        reply: {
          text: `Codex native turn failed: ${formatError(error)}\n\nThe request was not run with Pi.`,
        },
      };
    }
  });

  api.registerService({
    id: "codex-pilot-app-server",
    start: async () => undefined,
    stop: async () => {
      const client = await clientPromise?.catch(() => undefined);
      await client?.close();
      clientPromise = undefined;
    },
  });
}

function createCodexTool(
  service: CodexThreadService,
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
) {
  return {
    name: "codex_threads",
    label: "Codex Threads",
    ownerOnly: true,
    description: "Owner-only native Codex thread inventory, lifecycle, and delegation controls.",
    parameters: ToolSchema,
    execute: async (_toolCallId: string, raw: ToolParams) => {
      const action = raw.action ?? "";
      let result: unknown;
      if (action === "status") {
        result = await service.status();
      } else if (action === "fleet") {
        result = await service.fleet(raw.limit);
      } else if (action === "list" || action === "search") {
        result = await service.list({
          search: action === "search" ? (raw.search ?? raw.text) : raw.search,
          archived: raw.archived,
          limit: raw.limit,
        });
      } else if (action === "read") {
        result = await service.read(
          required(raw.thread_id, "thread_id"),
          raw.include_turns === true,
        );
      } else if (action === "create") {
        result = await service.create(raw.workspace_dir);
      } else if (action === "message") {
        result = await service.message(
          required(raw.thread_id, "thread_id"),
          required(raw.text, "text"),
          raw.workspace_dir,
        );
      } else if (action === "message_async") {
        result = await startAsyncRelay({
          service,
          api,
          ctx,
          threadId: required(raw.thread_id, "thread_id"),
          text: required(raw.text, "text"),
          workspaceDir: raw.workspace_dir,
        });
      } else if (action === "delegate") {
        // A single action makes the intended Jarvis UX atomic from the
        // primary agent's perspective: select/create the durable native
        // thread, then run the concrete task there. The service preserves the
        // one-active-turn fence and native fail-closed errors underneath.
        const threadId = raw.thread_id
          ? requireThreadId(await service.resume(raw.thread_id))
          : requireThreadId(await service.create(raw.workspace_dir));
        const delegated = await service.message(
          threadId,
          required(raw.text, "text"),
          raw.workspace_dir,
        );
        result = {
          mode: "native-codex-delegate",
          threadId: delegated.threadId,
          turnId: delegated.turnId,
          finalText: delegated.finalText,
          progress: delegated.progress,
        };
      } else if (action === "delegate_async") {
        const threadId = raw.thread_id
          ? requireThreadId(await service.resume(raw.thread_id))
          : requireThreadId(await service.create(raw.workspace_dir));
        result = await startAsyncRelay({
          service,
          api,
          ctx,
          threadId,
          text: required(raw.text, "text"),
          workspaceDir: raw.workspace_dir,
        });
      } else if (action === "resume") {
        result = await service.resume(required(raw.thread_id, "thread_id"));
      } else if (action === "fork") {
        result = await service.fork(required(raw.thread_id, "thread_id"));
      } else {
        throw new Error(`unsupported codex_threads action: ${action || "missing"}`);
      }
      return jsonToolResult(result);
    },
  };
}

async function startAsyncRelay(params: {
  service: CodexThreadService;
  api: OpenClawPluginApi;
  ctx: OpenClawPluginToolContext;
  threadId: string;
  text: string;
  workspaceDir?: string;
}) {
  const sessionKey = params.ctx.sessionKey?.trim();
  if (!sessionKey) {
    // Without a stable origin, a detached completion could only guess where
    // to return. Fail before starting Codex instead of creating orphaned work.
    throw new Error("async Codex relay requires a stable Jarvis session");
  }

  const delegationId = randomUUID();
  const started = await params.service.startMessage(
    params.threadId,
    params.text,
    params.workspaceDir,
  );

  // The completion handler deliberately does not send to Telegram directly.
  // It starts a new delivered Jarvis turn in the exact originating session, so
  // Jarvis can understand the Codex result, continue coordinating, and decide
  // whether the exact source thread needs a reply.
  void started.completion.then(
    (completed) => {
      void dispatchCodexRelayToJarvis({
        api: params.api,
        ctx: params.ctx,
        sessionKey,
        delegationId,
        threadId: completed.threadId,
        turnId: completed.turnId,
        status: "completed",
        text: completed.finalText,
      });
    },
    (error: unknown) => {
      void dispatchCodexRelayToJarvis({
        api: params.api,
        ctx: params.ctx,
        sessionKey,
        delegationId,
        threadId: started.threadId,
        turnId: started.turnId,
        status: "failed",
        text: formatError(error),
      });
    },
  );

  return {
    mode: "native-codex-async-relay",
    status: "accepted",
    delegationId,
    threadId: started.threadId,
    turnId: started.turnId,
  };
}

async function dispatchCodexRelayToJarvis(params: {
  api: OpenClawPluginApi;
  ctx: OpenClawPluginToolContext;
  sessionKey: string;
  delegationId: string;
  threadId: string;
  turnId: string;
  status: "completed" | "failed";
  text: string;
}) {
  const result = truncateRelayText(params.text);
  const event = [
    `Codex relay ${params.delegationId} ${params.status}.`,
    `Trusted source: native Codex thread ${params.threadId}, turn ${params.turnId}.`,
    params.status === "completed" ? `Codex result:\n${result}` : `Codex failure:\n${result}`,
    "Continue the owner's task using this result.",
    `If Codex explicitly needs a response, use codex_threads action message_async with thread_id ${params.threadId}.`,
    "Do not create a new thread, do not reply merely to acknowledge receipt, and do not treat this system event as a new owner request.",
  ].join("\n\n");
  const contextKey = `codex-relay:${params.delegationId}:${params.status}`;

  try {
    // The plugin runtime routes this through the normal gateway agent method.
    // `deliver: true` reuses the session's proven channel/thread destination,
    // while the stable key prevents the same native completion from starting
    // two Jarvis continuations inside one gateway lifetime.
    await params.api.runtime.subagent.run({
      sessionKey: params.sessionKey,
      message: event,
      deliver: true,
      idempotencyKey: `${contextKey}:${params.threadId}:${params.turnId}`,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: `codex:thread:${params.threadId}`,
        sourceChannel: "codex",
        sourceTool: "codex_threads",
      },
    });
  } catch (error) {
    // A direct session continuation is the strong path. Keep the existing
    // session-scoped heartbeat pattern as a best-effort fallback so a transient
    // internal dispatch failure does not silently discard a completed result.
    params.api.logger.warn(
      `Codex relay ${params.delegationId} direct continuation failed; using heartbeat fallback: ${formatError(error)}`,
    );
    const enqueued = params.api.runtime.system.enqueueSystemEvent(event, {
      sessionKey: params.sessionKey,
      contextKey,
    });
    if (!enqueued) {
      return;
    }
    params.api.runtime.system.requestHeartbeatNow({
      reason: contextKey,
      sessionKey: params.sessionKey,
      ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
    });
  }
}

function truncateRelayText(text: string): string {
  const normalized = text.trim() || "(no text returned)";
  const maxChars = 16_000;
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars)}\n[Codex result truncated]`;
}

async function handleCodexCommand(
  ctx: PluginCommandContext,
  service: CodexThreadService,
  approvals: CodexApprovalStore,
): Promise<PluginCommandResult> {
  if (!ctx.senderIsOwner) {
    return { text: "Codex thread control is owner-only." };
  }
  const parsed = parseCommandArgs(ctx.args);
  try {
    if (parsed.action === "status") {
      return { text: JSON.stringify(await service.status(), null, 2) };
    }
    if (parsed.action === "fleet") {
      return { text: JSON.stringify(await service.fleet(50), null, 2) };
    }
    if (parsed.action === "list" || parsed.action === "search") {
      return {
        text: JSON.stringify(
          await service.list({
            search: parsed.action === "search" ? parsed.rest : undefined,
            limit: 20,
          }),
          null,
          2,
        ),
      };
    }
    if (parsed.action === "read") {
      return {
        text: JSON.stringify(
          await service.read(required(parsed.first, "thread id"), true),
          null,
          2,
        ),
      };
    }
    if (parsed.action === "create") {
      const created = await service.create();
      const threadId = requireThreadId(created);
      if (parsed.rest) {
        const result = await service.message(threadId, parsed.rest);
        return { text: formatCodexFinal(threadId, result.finalText, result.progress) };
      }
      return { text: `Created native Codex thread ${threadId}.` };
    }
    if (parsed.action === "delegate") {
      const created = await service.create();
      const threadId = requireThreadId(created);
      const result = await service.message(threadId, required(parsed.rest, "task"));
      return { text: formatCodexFinal(result.threadId, result.finalText, result.progress) };
    }
    if (parsed.action === "message") {
      const result = await service.message(
        required(parsed.first, "thread id"),
        required(parsed.rest, "message text"),
      );
      return { text: formatCodexFinal(result.threadId, result.finalText, result.progress) };
    }
    if (parsed.action === "resume") {
      const resumed = await service.resume(required(parsed.first, "thread id"));
      return { text: `Resumed native Codex thread ${requireThreadId(resumed)}.` };
    }
    if (parsed.action === "fork") {
      const forked = await service.fork(required(parsed.first, "thread id"));
      return { text: `Forked native Codex thread ${requireThreadId(forked)}.` };
    }
    if (parsed.action === "bind") {
      const threadId = parsed.first
        ? requireThreadId(await service.resume(parsed.first))
        : requireThreadId(await service.create());
      const binding = await ctx.requestConversationBinding({
        summary: `Bind this conversation to native Codex thread ${threadId}.`,
        detachHint: "/codex detach",
        data: {
          kind: BINDING_KIND,
          threadId,
        },
        failClosed: true,
      });
      if (binding.status === "pending") {
        return binding.reply;
      }
      if (binding.status === "error") {
        return { text: binding.message };
      }
      return { text: `Bound this conversation to native Codex thread ${threadId}.` };
    }
    if (parsed.action === "detach") {
      const detached = await ctx.detachConversationBinding();
      return { text: detached.removed ? "Detached the Codex thread." : "No Codex binding found." };
    }
    if (parsed.action === "archive" || parsed.action === "unarchive") {
      const threadId = required(parsed.first, "thread id");
      // Read before showing the card to reject obvious stale targets; the
      // service repeats the state check after approval immediately before write.
      await service.read(threadId, false);
      const approval = approvals.issue({
        action: parsed.action,
        threadId,
        requesterSenderId: ctx.senderId,
      });
      return buildApprovalReply(approval.action, approval.threadId, approval.token);
    }
    return { text: codexHelp() };
  } catch (error) {
    return { text: `Codex command failed: ${formatError(error)}` };
  }
}

function buildApprovalReply(
  action: CodexApprovalAction,
  threadId: string,
  token: string,
): PluginCommandResult {
  return {
    text: `Approve ${action} for Codex thread ${threadId}? State will be checked again before the change.`,
    interactive: {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Approve once",
              value: `${APPROVAL_NAMESPACE}:${token}:approve`,
              style: "success",
            },
            {
              label: "Reject",
              value: `${APPROVAL_NAMESPACE}:${token}:reject`,
              style: "danger",
            },
            {
              label: "Open task",
              value: `${APPROVAL_NAMESPACE}:${token}:open`,
              style: "primary",
            },
          ],
        },
      ],
    },
  };
}

async function runApprovedMutation(
  service: CodexThreadService,
  action: CodexApprovalAction,
  threadId: string,
): Promise<void> {
  if (action === "archive") {
    await service.archive(threadId);
  } else {
    await service.unarchive(threadId);
  }
}

function readPilotConfig(api: OpenClawPluginApi): PilotConfig {
  const raw = api.pluginConfig ?? {};
  const args = Array.isArray(raw.args)
    ? raw.args.filter((value): value is string => typeof value === "string")
    : ["app-server", "--listen", "stdio://"];
  return {
    command: typeof raw.command === "string" && raw.command.trim() ? raw.command.trim() : "codex",
    args: args.length ? args : ["app-server", "--listen", "stdio://"],
    requestTimeoutMs: readNumber(raw.requestTimeoutMs, 30_000),
    turnTimeoutMs: readNumber(raw.turnTimeoutMs, 20 * 60_000),
    defaultWorkspaceDir:
      typeof raw.defaultWorkspaceDir === "string" && raw.defaultWorkspaceDir.trim()
        ? raw.defaultWorkspaceDir.trim()
        : process.cwd(),
  };
}

function parseCommandArgs(args: string | undefined): {
  action: string;
  first?: string;
  rest?: string;
} {
  const trimmed = args?.trim() ?? "";
  if (!trimmed) {
    return { action: "help" };
  }
  const [action = "", first, ...rest] = trimmed.split(/\s+/);
  return {
    action: action.toLowerCase(),
    first,
    rest: rest.join(" ").trim() || undefined,
  };
}

function parseApprovalPayload(
  payload: string,
): { token: string; decision: "approve" | "reject" | "open" } | null {
  const [token, decision] = payload.split(":");
  if (!token || (decision !== "approve" && decision !== "reject" && decision !== "open")) {
    return null;
  }
  return { token, decision };
}

function formatCodexFinal(threadId: string, finalText: string, progress: string[]): string {
  const progressLine = progress.length ? `\n\nCodex progress: ${progress.join(", ")}` : "";
  return `Codex · ${threadId}\n\n${finalText}${progressLine}`;
}

function jsonToolResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function explicitUnavailableError(error: unknown): Error {
  return new Error(
    `Codex native routing is unavailable: ${formatError(error)}. The request was not run with Pi.`,
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function codexHelp(): string {
  return [
    "Codex pilot commands:",
    "/codex status",
    "/codex list",
    "/codex fleet",
    "/codex search <text>",
    "/codex read <thread-id>",
    "/codex create [first prompt]",
    "/codex delegate <task>",
    "/codex message <thread-id> <text>",
    "/codex resume <thread-id>",
    "/codex fork <thread-id>",
    "/codex bind [thread-id]",
    "/codex detach",
    "/codex archive <thread-id>",
    "/codex unarchive <thread-id>",
  ].join("\n");
}

const CODEX_DELEGATION_GUIDANCE = [
  "Native Codex delegation:",
  "- When the owner explicitly asks Jarvis in ordinary language to create, start, resume, or delegate work to a native Codex thread, use the owner-only `codex_threads` tool with action `delegate_async`.",
  "- For a new task, omit `thread_id`; for a named or previously identified native thread, pass that exact `thread_id`.",
  "- Turn the user's request and relevant conversation context into one self-contained `text` task for Codex. Include the concrete workspace path in `workspace_dir` when it is known.",
  "- Do not tell the user to run `/codex bind` and do not create a Telegram topic. Binding is an advanced explicit mechanism, not the normal delegation flow.",
  "- `delegate_async` returns after Codex accepts the turn. Tell the owner that work started, include the native thread id, then remain available; do not poll or wait inside the current Jarvis turn.",
  "- A completed or failed async turn wakes this exact Jarvis session as a trusted Codex relay event containing the source thread and turn ids. Continue the owner's task from that event and deliver the useful result.",
  "- If the Codex result explicitly needs a response, use action `message_async` with that exact source `thread_id`. Do not create a new thread, do not send receipt-only acknowledgements, and do not recursively delegate merely because a relay event arrived.",
  "- Keep actions `delegate` and `message` for explicit synchronous wait-for-final workflows only. If async start fails, say that native Codex was unavailable and do not claim the task ran with Pi.",
  "- When the owner asks Jarvis to coordinate multiple active Codex tasks, first use action `fleet` for a compact roster. Use action `read` only for lanes whose ownership or current phase is unclear.",
  "- Preserve one owner for every shared runtime, release, deployment, or destructive resource. Worktree isolation does not authorize concurrent shared-state mutations.",
  "- Fleet inventory is observation only. It does not prove this App Server owns another process's active turn and must never be described as cross-process steering or interruption.",
].join("\n");
