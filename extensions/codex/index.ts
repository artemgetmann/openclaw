import { randomUUID } from "node:crypto";
import path from "node:path";
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
import {
  CodexCallbackRouter,
  JARVIS_CALLBACK_DYNAMIC_TOOL,
  type CodexCallbackEnvelope,
} from "./src/callback-router.js";
import {
  CodexDelegationRegistry,
  type CodexRelayJarvisRunPurpose,
  type CodexRelayRecord,
} from "./src/delegation-registry.js";
import {
  reconcileCodexRelays,
  type CodexRelayDispatchOutcome,
} from "./src/relay-reconciliation.js";
import {
  CodexThreadService,
  CodexTurnTerminalError,
  requireThreadId,
} from "./src/thread-service.js";
import {
  CodexWorkspaceManager,
  type CodexTaskMode,
  type CodexWorkspaceMode,
  type PreparedCodexWorkspace,
} from "./src/workspace-manager.js";

type PilotConfig = {
  command: string;
  args: string[];
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  defaultWorkspaceDir: string;
  worktreesRoot?: string;
  protectedWorkspaceDirs: string[];
};

type ToolParams = {
  action?: string;
  thread_id?: string;
  text?: string;
  workspace_dir?: string;
  project_dir?: string;
  task_mode?: CodexTaskMode;
  workspace_mode?: CodexWorkspaceMode;
  feature_name?: string;
  search?: string;
  archived?: boolean;
  include_turns?: boolean;
  limit?: number;
};

const APPROVAL_NAMESPACE = "codexpilot";
const BINDING_KIND = "codex-app-server-pilot";
const JARVIS_RELAY_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

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
    project_dir: { type: "string" },
    task_mode: { type: "string", enum: ["analysis", "implementation"] },
    workspace_mode: { type: "string", enum: ["isolated", "direct"] },
    feature_name: { type: "string" },
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
  let registry: CodexDelegationRegistry | undefined;
  const getRegistry = () => {
    registry ??= new CodexDelegationRegistry(
      path.join(api.runtime.state.resolveStateDir(), "codex", "async-relays.json"),
    );
    return registry;
  };
  const callbacks = new CodexCallbackRouter({
    dispatch: async (callback) => {
      if (callback.status !== "complete") {
        const outcome = await dispatchCodexCallbackToJarvis({
          api,
          registry: getRegistry(),
          callback,
        });
        if (outcome !== "completed") {
          throw new Error(
            `Codex callback ${callback.callbackId} was queued without durable Jarvis completion evidence`,
          );
        }
        return;
      }
      // A complete proactive callback suppresses the terminal fallback. Claim
      // and persist that delivery too, or a restart between callback delivery
      // and turn/completed could relay the same result a second time.
      const claimed = await getRegistry().claimCallbackDelivery(callback.delegationId);
      if (!claimed) {
        throw new Error(
          `Codex completion callback ${callback.callbackId} delivery is already finalized or ambiguous`,
        );
      }
      const outcome = await dispatchCodexCallbackToJarvis({
        api,
        registry: getRegistry(),
        callback,
      });
      if (outcome !== "completed") {
        throw new Error(
          `Codex completion callback ${callback.callbackId} was queued without durable Jarvis completion evidence`,
        );
      }
      await getRegistry().markDelivered(callback.delegationId);
    },
  });

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
      client.onServerRequest(async (request) => await callbacks.handleServerRequest(request));
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

  const workspaceManager = new CodexWorkspaceManager({
    defaultWorkspaceDir: config.defaultWorkspaceDir,
    worktreesRoot: config.worktreesRoot,
    protectedWorkspaceDirs: config.protectedWorkspaceDirs,
  });
  const service = new CodexThreadService({
    client: getClient,
    turnTimeoutMs: config.turnTimeoutMs,
    defaultWorkspaceDir: config.defaultWorkspaceDir,
    dynamicTools: [JARVIS_CALLBACK_DYNAMIC_TOOL],
    workspaceManager,
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
      return createCodexTool(service, callbacks, getRegistry, api, ctx) as AnyAgentTool;
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
    start: async () => {
      try {
        const result = await reconcileCodexRelays({
          registry: getRegistry(),
          inspectTurn: async (threadId, turnId) =>
            await service.inspectPersistedTurn(threadId, turnId),
          dispatchTerminal: async (record, finalText) => {
            return await dispatchCodexRelayToJarvis({
              api,
              registry: getRegistry(),
              record,
              status: "completed",
              text: finalText,
            });
          },
          dispatchDecisionNeeded: async (record, reason) => {
            return await dispatchCodexDecisionNeededToJarvis({
              api,
              registry: getRegistry(),
              record,
              reason,
            });
          },
          onMalformedEntry: (issue) => {
            api.logger.error(
              `Codex relay registry entry ${issue.index} is malformed and was not reconciled: ${issue.reason}`,
            );
          },
          onRecordError: (record, error) => {
            api.logger.error(
              `Codex relay ${record.delegationId} reconciliation failed closed and later records will continue: ${formatError(error)}`,
            );
          },
        });
        if (
          result.inspected ||
          result.delivered ||
          result.decisionNeeded ||
          result.malformed ||
          result.failed
        ) {
          api.logger.info(
            `Codex relay reconciliation: inspected=${result.inspected} delivered=${result.delivered} decision-needed=${result.decisionNeeded} malformed=${result.malformed} failed=${result.failed}`,
          );
        }
      } catch (error) {
        // A corrupt store or unavailable App Server must not prevent Gateway
        // startup. The registry remains untouched and no completion is inferred.
        api.logger.error(`Codex relay reconciliation failed closed: ${formatError(error)}`);
      }
    },
    stop: async () => {
      const client = await clientPromise?.catch(() => undefined);
      await client?.close();
      clientPromise = undefined;
    },
  });
}

function createCodexTool(
  service: CodexThreadService,
  callbacks: CodexCallbackRouter,
  getRegistry: () => CodexDelegationRegistry,
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
        const threadId = required(raw.thread_id, "thread_id");
        const text = requiredPayload(raw.text, "text");
        const sessionKey = ctx.sessionKey?.trim();
        const active = sessionKey && callbacks.findActiveTurn({ threadId, sessionKey });
        if (active) {
          const steered = await service.steer(active.threadId, active.turnId, text);
          result = {
            mode: "native-codex-async-steer",
            status: "accepted",
            delegationId: active.delegationId,
            threadId: steered.threadId,
            turnId: steered.turnId,
          };
        } else {
          result = await startAsyncRelay({
            service,
            callbacks,
            getRegistry,
            api,
            ctx,
            threadId,
            text,
            execution: raw.workspace_dir,
          });
        }
      } else if (action === "delegate") {
        // A single action makes the intended Jarvis UX atomic from the
        // primary agent's perspective: select/create the durable native
        // thread, then run the concrete task there. The service preserves the
        // one-active-turn fence and native fail-closed errors underneath.
        result = raw.thread_id
          ? await service.message(
              requireThreadId(await service.resume(raw.thread_id)),
              required(raw.text, "text"),
            )
          : await service.delegate(delegateRequest(raw));
      } else if (action === "delegate_async") {
        requireAsyncSession(ctx);
        const prepared = raw.thread_id
          ? undefined
          : await service.createDelegateThread(delegateRequest(raw));
        const threadId = raw.thread_id
          ? requireThreadId(await service.resume(raw.thread_id))
          : prepared!.threadId;
        result = await startAsyncRelay({
          service,
          callbacks,
          getRegistry,
          api,
          ctx,
          threadId,
          text: requiredPayload(raw.text, "text"),
          execution: prepared?.execution,
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
  callbacks: CodexCallbackRouter;
  getRegistry: () => CodexDelegationRegistry;
  api: OpenClawPluginApi;
  ctx: OpenClawPluginToolContext;
  threadId: string;
  text: string;
  execution?: PreparedCodexWorkspace | string;
}) {
  const sessionKey = requireAsyncSession(params.ctx);

  const delegationId = randomUUID();
  const registry = params.getRegistry();
  await registry.createStarting({
    delegationId,
    sessionKey,
    ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
    threadId: params.threadId,
    deliveryKey: `codex-relay:${delegationId}`,
  });
  const workerPrompt = buildAsyncWorkerPrompt({
    delegationId,
    threadId: params.threadId,
    text: params.text,
    execution: typeof params.execution === "string" ? undefined : params.execution,
  });
  const started = await params.service.startMessage(
    params.threadId,
    workerPrompt,
    params.execution,
  );
  // This durable transition is the acceptance boundary. Never tell Jarvis the
  // relay was accepted until its exact native thread and turn can survive a
  // process restart.
  try {
    await registry.markAccepted(delegationId, started.turnId);
  } catch (error) {
    // The App Server may have accepted work even if the durable acceptance
    // write fails. Do not return "accepted" and do not replay it; retain the
    // starting record for a precise restart ambiguity report.
    void started.completion.catch((completionError: unknown) => {
      params.api.logger.error(
        `Untracked Codex relay ${delegationId} terminated after acceptance persistence failed: ${formatError(completionError)}`,
      );
    });
    throw error;
  }
  params.callbacks.register({
    delegationId,
    threadId: started.threadId,
    turnId: started.turnId,
    sessionKey,
    ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
  });

  // The completion handler deliberately does not send to Telegram directly.
  // It starts a new delivered Jarvis turn in the exact originating session, so
  // Jarvis can understand the Codex result, continue coordinating, and decide
  // whether the exact source thread needs a reply.
  void started.completion
    .then(
      async (completed) => {
        const callbackState = await params.callbacks.finish({
          delegationId,
          threadId: completed.threadId,
          turnId: completed.turnId,
        });
        const durableState = await registry.get(delegationId);
        if (!durableState) {
          throw new Error(`Codex relay ${delegationId} disappeared before terminal handback`);
        }
        if (callbackState.completeDelivered) {
          if (durableState.lifecycle !== "delivered" || durableState.deliveryKind !== "callback") {
            throw new Error(
              `Codex relay ${delegationId} callback completion was not durably delivered`,
            );
          }
          return;
        }
        if (
          durableState.lifecycle === "delivery-started" &&
          durableState.deliveryKind === "callback"
        ) {
          await claimAndDispatchCodexDecisionNeededToJarvis({
            api: params.api,
            registry,
            record: durableState,
            reason:
              "A completion callback delivery attempt became ambiguous before the native turn ended. The terminal result was not replayed.",
          });
          return;
        }
        await registry.markTerminal(delegationId, "completed");
        const claimed = await registry.claimTerminalDelivery(delegationId);
        if (!claimed) {
          return;
        }
        const outcome = await dispatchCodexRelayToJarvis({
          api: params.api,
          registry,
          record: claimed,
          status: "completed",
          text: completed.finalText,
        });
        if (outcome === "completed") {
          await registry.markDelivered(delegationId);
        }
      },
      async (error: unknown) => {
        await params.callbacks.finish({
          delegationId,
          threadId: started.threadId,
          turnId: started.turnId,
        });
        if (error instanceof CodexTurnTerminalError) {
          await registry.markTerminal(delegationId, error.terminalStatus);
        }
        const record = await registry.get(delegationId);
        if (!record) {
          throw new Error(`Codex relay ${delegationId} disappeared before failure handback`);
        }
        await claimAndDispatchCodexDecisionNeededToJarvis({
          api: params.api,
          registry,
          record,
          reason:
            error instanceof CodexTurnTerminalError
              ? `The exact native turn is ${error.terminalStatus} (${formatError(error)}). It was not retried automatically.`
              : `The process-local terminal listener stopped with an ambiguous error (${formatError(error)}). Native completion was not inferred and the task was not retried.`,
        });
      },
    )
    .catch((error: unknown) => {
      params.api.logger.error(
        `Codex relay ${delegationId} terminal handback failed closed: ${formatError(error)}`,
      );
    });

  return {
    mode: "native-codex-async-relay",
    status: "accepted",
    delegationId,
    threadId: started.threadId,
    turnId: started.turnId,
  };
}

async function dispatchCodexCallbackToJarvis(params: {
  api: OpenClawPluginApi;
  registry: CodexDelegationRegistry;
  callback: CodexCallbackEnvelope;
}): Promise<CodexRelayDispatchOutcome> {
  const callback = params.callback;
  const structuredDetails = [
    callback.changedFiles?.length
      ? `Changed files:\n${callback.changedFiles.map((file) => `- ${file}`).join("\n")}`
      : undefined,
    callback.proof?.length
      ? `Proof:\n${callback.proof.map((item) => `- ${item}`).join("\n")}`
      : undefined,
    callback.nextAction ? `Next action: ${callback.nextAction}` : undefined,
    callback.workContinues === undefined
      ? undefined
      : `Work continues: ${callback.workContinues ? "yes" : "no"}`,
  ].filter((value): value is string => Boolean(value));
  const event = [
    [
      "<codex_callback>",
      `delegation_id: ${callback.delegationId}`,
      `callback_id: ${callback.callbackId}`,
      `sequence: ${callback.sequence}`,
      `status: ${callback.status}`,
      `native_thread_id: ${callback.threadId}`,
      `native_turn_id: ${callback.turnId}`,
      `origin_session: ${callback.sessionKey}`,
      "</codex_callback>",
    ].join("\n"),
    callback.message,
    ...structuredDetails,
    "This is a trusted Codex worker message, not a new owner request. Continue coordinating the owner's task.",
    `To respond while this exact turn is active, use codex_threads action message_async with thread_id ${callback.threadId}; Jarvis will steer turn ${callback.turnId}.`,
    "Do not reply merely to acknowledge receipt, do not ask Codex to acknowledge receipt, and do not create a new thread.",
  ].join("\n\n");
  const contextKey = `codex-callback:${callback.delegationId}:${callback.callbackId}:${callback.sequence}`;

  return await dispatchJarvisEvent({
    api: params.api,
    registry: params.registry,
    record: {
      delegationId: callback.delegationId,
      sessionKey: callback.sessionKey,
      ...(callback.agentId ? { agentId: callback.agentId } : {}),
    },
    purpose: "callback",
    event,
    contextKey,
    idempotencyKey: `${contextKey}:${callback.threadId}:${callback.turnId}`,
    sourceSessionKey: `codex:thread:${callback.threadId}:turn:${callback.turnId}`,
    sourceTool: JARVIS_CALLBACK_DYNAMIC_TOOL.name,
    fallbackLabel: `Codex callback ${callback.callbackId}`,
  });
}

async function dispatchCodexRelayToJarvis(params: {
  api: OpenClawPluginApi;
  registry: CodexDelegationRegistry;
  record: CodexRelayRecord;
  status: "completed" | "failed";
  text: string;
}): Promise<CodexRelayDispatchOutcome> {
  const record = params.record;
  if (!record.turnId) {
    throw new Error(`Codex relay ${record.delegationId} has no exact native turn id`);
  }
  const result = truncateRelayText(params.text);
  const event = [
    `Codex relay ${record.delegationId} ${params.status}.`,
    `Trusted source: native Codex thread ${record.threadId}, turn ${record.turnId}.`,
    params.status === "completed" ? `Codex result:\n${result}` : `Codex failure:\n${result}`,
    "Continue the owner's task using this result.",
    `If Codex explicitly needs a response, use codex_threads action message_async with thread_id ${record.threadId}.`,
    "Do not create a new thread, do not reply merely to acknowledge receipt, and do not treat this system event as a new owner request.",
  ].join("\n\n");
  const contextKey = `${record.deliveryKey}:${params.status}`;

  return await dispatchJarvisEvent({
    api: params.api,
    registry: params.registry,
    record,
    purpose: "terminal",
    event,
    contextKey,
    idempotencyKey: `${contextKey}:${record.threadId}:${record.turnId}`,
    sourceSessionKey: `codex:thread:${record.threadId}`,
    sourceTool: "codex_threads",
    fallbackLabel: `Codex relay ${record.delegationId}`,
  });
}

async function dispatchCodexDecisionNeededToJarvis(params: {
  api: OpenClawPluginApi;
  registry: CodexDelegationRegistry;
  record: CodexRelayRecord;
  reason: string;
}): Promise<CodexRelayDispatchOutcome> {
  const record = params.record;
  const exactTurn = record.turnId
    ? `native Codex thread ${record.threadId}, turn ${record.turnId}`
    : `native Codex thread ${record.threadId}, exact turn unknown`;
  const event = [
    `Codex relay ${record.delegationId} needs a decision after interruption.`,
    `Recorded source: ${exactTurn}.`,
    params.reason,
    "No Codex work was resumed, replayed, or redirected to another thread.",
    "Review the native thread state and decide whether any new work should be started.",
    "Do not treat this system event as a new owner request.",
  ].join("\n\n");
  const contextKey = `${record.deliveryKey}:decision-needed`;

  return await dispatchJarvisEvent({
    api: params.api,
    registry: params.registry,
    record,
    purpose: "decision",
    event,
    contextKey,
    idempotencyKey: `${contextKey}:${record.threadId}:${record.turnId ?? "unknown"}`,
    sourceSessionKey: record.turnId
      ? `codex:thread:${record.threadId}:turn:${record.turnId}`
      : `codex:thread:${record.threadId}`,
    sourceTool: "codex_threads",
    fallbackLabel: `Codex relay ${record.delegationId} decision handback`,
  });
}

async function claimAndDispatchCodexDecisionNeededToJarvis(params: {
  api: OpenClawPluginApi;
  registry: CodexDelegationRegistry;
  record: CodexRelayRecord;
  reason: string;
}): Promise<void> {
  // Persist the irreversible decision-only classification and sole dispatch
  // claim before crossing into Jarvis. A crash after this point must not make
  // the native turn eligible for later inspection or result delivery.
  const claimed = await params.registry.claimDecisionDelivery(params.record.delegationId);
  if (!claimed) {
    return;
  }
  const outcome = await dispatchCodexDecisionNeededToJarvis({
    ...params,
    record: claimed,
  });
  if (outcome === "completed") {
    await params.registry.markDecisionNeeded(params.record.delegationId);
  }
}

async function dispatchJarvisEvent(params: {
  api: OpenClawPluginApi;
  registry: CodexDelegationRegistry;
  record: Pick<CodexRelayRecord, "delegationId" | "sessionKey" | "agentId">;
  purpose: CodexRelayJarvisRunPurpose;
  event: string;
  contextKey: string;
  idempotencyKey: string;
  sourceSessionKey: string;
  sourceTool: string;
  fallbackLabel: string;
}): Promise<CodexRelayDispatchOutcome> {
  let accepted: { runId: string };
  try {
    // run() acknowledges only spawn acceptance. The durable record is not
    // finalized until agent.wait proves the exact Jarvis run reached a terminal
    // ok state after session processing and its deliver:true attempt.
    accepted = await params.api.runtime.subagent.run({
      sessionKey: params.record.sessionKey,
      message: params.event,
      deliver: true,
      idempotencyKey: params.idempotencyKey,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: "codex",
        sourceTool: params.sourceTool,
      },
    });
  } catch (error) {
    params.api.logger.warn(
      `${params.fallbackLabel} direct continuation was not accepted; using volatile heartbeat fallback: ${formatError(error)}`,
    );
    const enqueued = params.api.runtime.system.enqueueSystemEvent(params.event, {
      sessionKey: params.record.sessionKey,
      contextKey: params.contextKey,
    });
    if (!enqueued) {
      throw error;
    }
    params.api.runtime.system.requestHeartbeatNow({
      reason: params.contextKey,
      sessionKey: params.record.sessionKey,
      ...(params.record.agentId ? { agentId: params.record.agentId } : {}),
    });
    // Queue acceptance is not delivery evidence. Preserve the non-final
    // lifecycle so restart reconciliation can report or retry safely.
    await params.registry.markHeartbeatQueued(params.record.delegationId);
    return "queued";
  }

  await params.registry.markJarvisRunAccepted(
    params.record.delegationId,
    accepted.runId,
    params.purpose,
  );
  const completed = await params.api.runtime.subagent.waitForRun({
    runId: accepted.runId,
    timeoutMs: JARVIS_RELAY_WAIT_TIMEOUT_MS,
  });
  if (completed.status !== "ok") {
    throw new Error(
      `${params.fallbackLabel} Jarvis run ${accepted.runId} ended with ${completed.status}${
        completed.error ? `: ${completed.error}` : ""
      }`,
    );
  }
  return "completed";
}

function buildAsyncWorkerPrompt(params: {
  delegationId: string;
  threadId: string;
  text: string;
  execution?: PreparedCodexWorkspace;
}): string {
  // The task text is untrusted owner-authored content. Keep it byte-for-byte
  // inside a delegation-specific boundary instead of interpolating it into the
  // launcher contract, where task content could be mistaken for routing data.
  // The collision loop is effectively free and makes the delimiter unambiguous
  // even if a future caller deliberately includes a previously observed token.
  const boundaryPrefix = `JARVIS_TASK_PAYLOAD_${params.delegationId}`;
  let boundary = boundaryPrefix;
  let collision = 0;
  while (params.text.includes(boundary)) {
    collision += 1;
    boundary = `${boundaryPrefix}_${collision}`;
  }

  return [
    "Jarvis-owned Codex worker return contract:",
    "- Jarvis drives this Codex turn and remains available while you work.",
    `- Delegation ID: ${params.delegationId}`,
    `- Native Codex thread ID: ${params.threadId}`,
    ...(params.execution?.taskMode === "implementation"
      ? [
          `- Assigned isolated worktree: ${params.execution.workspaceDir}`,
          `- Source project: ${params.execution.projectDir}`,
          `- Branch: ${params.execution.branch ?? "unknown"}`,
          "- Read and follow repository policy before implementation; all writes stay in the assigned worktree.",
        ]
      : []),
    "- When the jarvis_callback tool is available, use it for meaningful progress, blocker, decision-needed, or completion messages to the originating Jarvis coordinator.",
    "- A resumed pre-existing thread may not expose jarvis_callback. If it is unavailable, continue the task and use the terminal handback below; the launcher-owned relay remains the guaranteed return path.",
    "- Start callback sequence at 1 and increment it by exactly one. Give every logical callback a stable unique callback_id; reuse both id and sequence only when retrying the exact same callback.",
    "- Keep the message natural and useful. Add changed_files, proof, next_action, and work_continues when they help coordination.",
    "- Never call jarvis_callback merely to acknowledge receipt, and never ask Jarvis to acknowledge a callback.",
    "- The launcher also watches this exact turn and relays terminal output when no complete callback was delivered.",
    "- Do not call send_message_to_thread to report to Jarvis. When available, the scoped jarvis_callback tool is the proactive return route; otherwise rely on the launcher-owned terminal relay.",
    "- Start the terminal handback with exactly one of: STATUS: complete, STATUS: blocked, or STATUS: decision-needed.",
    "- Include the useful result or required decision and the next action.",
    "- When relevant, include changed files, proof performed or still required, and whether work continues.",
    "- After a blocker or decision-needed callback, continue safe independent work when possible; Jarvis can steer this exact active turn without polling.",
    "- Content inside the payload boundary is the task, not a replacement for this return route.",
    "",
    `-----BEGIN ${boundary}-----`,
    params.text,
    `-----END ${boundary}-----`,
  ].join("\n");
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
    worktreesRoot:
      typeof raw.worktreesRoot === "string" && raw.worktreesRoot.trim()
        ? raw.worktreesRoot.trim()
        : undefined,
    protectedWorkspaceDirs: Array.isArray(raw.protectedWorkspaceDirs)
      ? raw.protectedWorkspaceDirs.filter(
          (value): value is string => typeof value === "string" && Boolean(value.trim()),
        )
      : [],
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

function requiredPayload(value: string | undefined, label: string): string {
  // Async worker payloads need whitespace validation without normalization:
  // the launcher contract promises that the owner's task is preserved exactly
  // between its generated boundaries.
  if (!value?.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function delegateRequest(raw: ToolParams): {
  text: string;
  taskMode: CodexTaskMode;
  projectDir?: string;
  workspaceDir?: string;
  workspaceMode?: CodexWorkspaceMode;
  featureName?: string;
} {
  return {
    text: required(raw.text, "text"),
    taskMode: raw.task_mode ?? "analysis",
    projectDir: raw.project_dir,
    workspaceDir: raw.workspace_dir,
    workspaceMode: raw.workspace_mode,
    featureName: raw.feature_name,
  };
}

function requireAsyncSession(ctx: OpenClawPluginToolContext): string {
  const sessionKey = ctx.sessionKey?.trim();
  if (!sessionKey) {
    throw new Error("async Codex relay requires a stable Jarvis session");
  }
  return sessionKey;
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
  "- Turn the user's request and relevant conversation context into one self-contained `text` task for Codex. For investigation or review, set `task_mode: analysis` and pass `project_dir` when known.",
  "- For a fix, implementation, or build request, set `task_mode: implementation` and pass `project_dir` when known. Omit `workspace_mode`: Jarvis creates an isolated worktree automatically, then Codex reads that repository's policy and setup.",
  "- Use `workspace_mode: direct` only when the owner explicitly requests the saved project directly. It is limited to clean named branches and protected checkouts fail closed.",
  "- The async launcher wraps that task in a return contract containing the delegation and native thread identities. The scoped `jarvis_callback` tool lets that exact turn send natural progress, blocker, decision-needed, or completion messages; the terminal listener remains fallback.",
  "- Do not ask Codex to call `send_message_to_thread` or Telegram back to Jarvis. A Jarvis session is not a Codex thread address; the scoped callback and launcher-owned listener are the return transports.",
  "- Do not tell the user to run `/codex bind` and do not create a Telegram topic. Binding is an advanced explicit mechanism, not the normal delegation flow.",
  "- `delegate_async` returns after Codex accepts the turn. Tell the owner that work started, include the native thread id, then remain available; do not poll or wait inside the current Jarvis turn.",
  "- A valid callback or terminal relay wakes this exact Jarvis session with trusted source thread and turn ids. Continue the owner's task from the natural message and deliver only what is useful.",
  "- If Codex explicitly needs a response, use action `message_async` with that exact source `thread_id`. Jarvis steers the exact active turn when possible and otherwise starts the normal same-thread follow-up. Do not create a new thread, send receipt-only acknowledgements, or recursively delegate merely because a callback arrived.",
  "- Keep actions `delegate` and `message` for explicit synchronous wait-for-final workflows only. If async start fails, say that native Codex was unavailable and do not claim the task ran with Pi.",
  "- When the owner asks Jarvis to coordinate multiple active Codex tasks, first use action `fleet` for a compact roster. Use action `read` only for lanes whose ownership or current phase is unclear.",
  "- Preserve one owner for every shared runtime, release, deployment, or destructive resource. Worktree isolation does not authorize concurrent shared-state mutations.",
  "- Fleet inventory is observation only. It does not prove this App Server owns another process's active turn and must never be described as cross-process steering or interruption.",
].join("\n");
