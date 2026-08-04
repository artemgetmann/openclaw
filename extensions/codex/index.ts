import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadConfig } from "../../src/config/config.js";
import { resolveStorePath as resolveSessionStorePath } from "../../src/config/sessions/paths.js";
import { loadSessionStore } from "../../src/config/sessions/store.js";
import { disableActiveCronJob } from "../../src/cron/active-runtime.js";
import { resolveCronStorePath } from "../../src/cron/store.js";
import {
  claimMonitorAuthorityAction,
  finalizeMonitorAuthorityAction,
} from "../../src/monitor/authority.js";
import { resolveMonitorStorePath } from "../../src/monitor/store.js";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  PluginCommandContext,
  PluginCommandResult,
} from "../../src/plugins/types.js";
import { parseAgentSessionKey } from "../../src/sessions/session-key-utils.js";
import { CodexAppServerClient, type CodexRpcClient } from "./src/app-server-client.js";
import { CodexApprovalStore, type CodexApprovalAction } from "./src/approval-store.js";
import { registerCodexCallbackCli } from "./src/callback-cli.js";
import {
  CodexCallbackRouteRegistry,
  type CodexDurableCallbackEnvelope,
  type CodexDurableCallbackInput,
} from "./src/callback-route-registry.js";
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
  codexWorkerExecutionPolicy,
  CodexTurnStartAcceptanceAmbiguousError,
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
  idempotency_key?: string;
};

const APPROVAL_NAMESPACE = "codexpilot";
const BINDING_KIND = "codex-app-server-pilot";
const JARVIS_RELAY_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const MONITOR_READ_ONLY_ACTIONS = new Set(["status", "fleet", "list", "search", "read"]);

type CodexMonitorScope =
  | "direct-monitor"
  | "monitor-descendant"
  | "unrestricted"
  | "ambiguous-descendant";

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
        "unarchive_resume_authorized_once",
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
    idempotency_key: { type: "string" },
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
  let callbackRoutes: CodexCallbackRouteRegistry | undefined;
  const getRegistry = () => {
    registry ??= new CodexDelegationRegistry(
      path.join(api.runtime.state.resolveStateDir(), "codex", "async-relays.json"),
    );
    return registry;
  };
  const getCallbackRoutes = () => {
    callbackRoutes ??= new CodexCallbackRouteRegistry(
      path.join(api.runtime.state.resolveStateDir(), "codex", "callback-routes.json"),
    );
    return callbackRoutes;
  };

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

  const workspaceManager = new CodexWorkspaceManager({
    defaultWorkspaceDir: config.defaultWorkspaceDir,
    worktreesRoot: config.worktreesRoot,
    protectedWorkspaceDirs: config.protectedWorkspaceDirs,
  });
  const service = new CodexThreadService({
    client: getClient,
    turnTimeoutMs: config.turnTimeoutMs,
    defaultWorkspaceDir: config.defaultWorkspaceDir,
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
      return createCodexTool(service, getCallbackRoutes, getRegistry, api, ctx) as AnyAgentTool;
    }) as OpenClawPluginToolFactory,
    { name: "codex_threads" },
  );

  api.registerGatewayMethod("codex.callback", async ({ params, respond }) => {
    try {
      const result = await handleDurableCodexCallback({
        api,
        callbackRoutes: getCallbackRoutes(),
        relayRegistry: getRegistry(),
        params: params as Record<string, unknown>,
      });
      respond(true, result);
    } catch (error) {
      respond(false, { error: formatError(error) });
    }
  });

  api.registerCli(({ program, config }) => registerCodexCallbackCli({ program, config }), {
    commands: ["codex-callback"],
  });

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
  getCallbackRoutes: () => CodexCallbackRouteRegistry,
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
      const monitorScope = resolveCodexMonitorScope(ctx);
      if (
        monitorScope === "direct-monitor" &&
        !MONITOR_READ_ONLY_ACTIONS.has(action) &&
        action !== "unarchive_resume_authorized_once"
      ) {
        throw new Error(
          `monitor sessions must use a durable authority grant for mutating Codex action ${action}`,
        );
      }
      if (
        (monitorScope === "monitor-descendant" || monitorScope === "ambiguous-descendant") &&
        !MONITOR_READ_ONLY_ACTIONS.has(action)
      ) {
        // A spawned child gets a fresh subagent/acp session key, so the key
        // prefix alone cannot prove it is outside a monitor's authority scope.
        // Descendants stay read-only; ambiguous lineage also fails closed.
        throw new Error(
          `sessions descended from a durable monitor cannot use mutating Codex action ${action}`,
        );
      }
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
        const active =
          sessionKey && (await getCallbackRoutes().findActiveTurn({ threadId, sessionKey }));
        if (active) {
          const steered = await service.steer(active.threadId, active.turnId, text);
          result = {
            mode: "native-codex-async-steer",
            status: "accepted",
            delegationId: active.relayId,
            threadId: steered.threadId,
            turnId: steered.turnId,
          };
        } else {
          result = await startAsyncRelay({
            service,
            callbackRoutes: getCallbackRoutes(),
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
          callbackRoutes: getCallbackRoutes(),
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
      } else if (action === "unarchive_resume_authorized_once") {
        const sessionKey = required(ctx.sessionKey?.trim(), "monitor session");
        const threadId = required(raw.thread_id, "thread_id");
        const text = requiredPayload(raw.text, "text");
        const idempotencyKey = required(raw.idempotency_key, "idempotency_key");
        const cfg = ctx.config ?? loadConfig();
        const storePath = resolveMonitorStorePath({
          cronStorePath: resolveCronStorePath(cfg.cron?.store),
        });
        const claim = await claimMonitorAuthorityAction({
          storePath,
          sessionStorePath: resolveSessionStorePath(cfg.session?.store, {
            agentId: ctx.agentId,
          }),
          monitorSessionKey: sessionKey,
          threadId,
          prompt: text,
          idempotencyKey,
        });
        // Claiming authority makes the monitor terminal before any Codex
        // mutation. Disable its exact scheduler job through the live
        // CronService as part of that same fail-closed boundary. Exact retries
        // repeat this safe repair step without repeating the continuation.
        await disableActiveCronJob(claim.cronJobId);
        if (!claim.execute) {
          result = {
            mode: "durable-monitor-authority",
            status: claim.status,
            monitorId: claim.monitorId,
            grantId: claim.grantId,
            executed: false,
          };
        } else {
          try {
            const unarchive = await service.unarchiveIfNeeded(threadId);
            const resumedThreadId = requireThreadId(await service.resume(threadId));
            if (resumedThreadId !== threadId) {
              throw new Error("Codex App Server resumed a different thread than authorized");
            }
            const started = await startAsyncRelay({
              service,
              callbackRoutes: getCallbackRoutes(),
              getRegistry,
              api,
              // Terminal results belong in the owner session that created the
              // goal, not in the now-stopped monitor continuation session.
              ctx: { ...ctx, sessionKey: claim.originSessionKey },
              threadId,
              text: claim.prompt,
            });
            try {
              await finalizeMonitorAuthorityAction({
                storePath,
                monitorSessionKey: sessionKey,
                grantId: claim.grantId,
                outcome: "completed",
                externalRef: started.turnId,
              });
            } catch (error) {
              // The native turn is already durably accepted. If recording the
              // terminal monitor receipt fails, the safe truth is "consumed
              // with an ambiguous receipt"—never "failed and retryable."
              throw new CodexAuthorityReceiptAmbiguousError(error);
            }
            result = {
              ...started,
              mode: "durable-monitor-authority",
              monitorId: claim.monitorId,
              grantId: claim.grantId,
              unarchived: unarchive.changed,
            };
          } catch (error) {
            if (
              !(error instanceof CodexRelayAcceptanceAmbiguousError) &&
              !(error instanceof CodexAuthorityReceiptAmbiguousError) &&
              !(error instanceof CodexTurnStartAcceptanceAmbiguousError)
            ) {
              await finalizeMonitorAuthorityAction({
                storePath,
                monitorSessionKey: sessionKey,
                grantId: claim.grantId,
                outcome: "failed",
                error: formatError(error),
              });
            }
            // Acceptance ambiguity must remain consumed: the App Server may
            // already be running the turn, so neither "failed" nor replay is
            // truthful or safe.
            throw error;
          }
        }
      } else {
        throw new Error(`unsupported codex_threads action: ${action || "missing"}`);
      }
      return jsonToolResult(result);
    },
  };
}

function resolveCodexMonitorScope(ctx: OpenClawPluginToolContext): CodexMonitorScope {
  const initialSessionKey = ctx.sessionKey?.trim();
  if (!initialSessionKey) {
    return "unrestricted";
  }
  const initialParsed = parseAgentSessionKey(initialSessionKey);
  if (!initialParsed) {
    return "unrestricted";
  }
  if (initialParsed.rest.startsWith("monitor:")) {
    return "direct-monitor";
  }
  if (!initialParsed.rest.startsWith("subagent:") && !initialParsed.rest.startsWith("acp:")) {
    return "unrestricted";
  }

  const cfg = ctx.config ?? loadConfig();
  const visited = new Set<string>();
  let sessionKey = initialSessionKey;

  // Spawn depth is bounded elsewhere, but keep this walk independently
  // bounded and cycle-safe because it is part of a permission decision.
  for (let hop = 0; hop < 32; hop += 1) {
    if (visited.has(sessionKey)) {
      return "ambiguous-descendant";
    }
    visited.add(sessionKey);

    const parsed = parseAgentSessionKey(sessionKey);
    if (!parsed) {
      return "ambiguous-descendant";
    }
    if (parsed.rest.startsWith("monitor:")) {
      return "monitor-descendant";
    }
    if (!parsed.rest.startsWith("subagent:") && !parsed.rest.startsWith("acp:")) {
      return "unrestricted";
    }

    // Skip the shared cache so a child cannot race the durable spawnedBy write
    // that established its authority ancestry.
    const store = loadSessionStore(
      resolveSessionStorePath(cfg.session?.store, { agentId: parsed.agentId }),
      { skipCache: true },
    );
    const spawnedBy = store[sessionKey]?.spawnedBy?.trim();
    if (!spawnedBy) {
      return "ambiguous-descendant";
    }
    sessionKey = spawnedBy;
  }

  return "ambiguous-descendant";
}

class CodexRelayAcceptanceAmbiguousError extends Error {
  constructor(cause: unknown) {
    super("Codex relay acceptance became ambiguous after the native turn started", { cause });
    this.name = "CodexRelayAcceptanceAmbiguousError";
  }
}

class CodexAuthorityReceiptAmbiguousError extends Error {
  constructor(cause: unknown) {
    super("Codex authority receipt became ambiguous after the native turn was accepted", { cause });
    this.name = "CodexAuthorityReceiptAmbiguousError";
  }
}

async function startAsyncRelay(params: {
  service: CodexThreadService;
  callbackRoutes: CodexCallbackRouteRegistry;
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
  const callbackRoute = await params.callbackRoutes.acquire({
    threadId: params.threadId,
    sessionKey,
    ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
  });
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
    callbackRoute,
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
    throw new CodexRelayAcceptanceAmbiguousError(error);
  }
  await params.callbackRoutes.bindTurn(callbackRoute.routeId, {
    relayId: delegationId,
    turnId: started.turnId,
  });

  // The completion handler deliberately does not send to Telegram directly.
  // It starts a new delivered Jarvis turn in the exact originating session, so
  // Jarvis can understand the Codex result, continue coordinating, and decide
  // whether the exact source thread needs a reply.
  void started.completion
    .then(
      async (completed) => {
        await params.callbackRoutes.finishTurn(callbackRoute.routeId, completed.turnId);
        const durableState = await registry.get(delegationId);
        if (!durableState) {
          throw new Error(`Codex relay ${delegationId} disappeared before terminal handback`);
        }
        if (durableState.lifecycle === "delivered" && durableState.deliveryKind === "callback") {
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
        await params.callbackRoutes.finishTurn(callbackRoute.routeId, started.turnId);
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
    ...buildCodexLaunchReceipt(started.threadId, params.execution),
  };
}

export function buildCodexLaunchReceipt(
  threadId: string,
  execution: PreparedCodexWorkspace | string | undefined,
): {
  launchSummary: string;
  launch: Record<string, unknown>;
} {
  if (!execution || typeof execution === "string") {
    return {
      launchSummary: `Continued existing native Codex thread ${threadId}. Its saved project and permission policy remain in effect.`,
      launch: {
        launchMode: "resumed-existing-thread",
        nativeThreadId: threadId,
        policySource: "saved-thread",
      },
    };
  }

  const policy = codexWorkerExecutionPolicy(execution);
  const projectName = path.basename(execution.projectDir);
  const networkLabel = policy.networkAccess ? "on" : "off";
  const autoReviewLabel = policy.autoReview
    ? `${policy.approvalPolicy} via ${policy.approvalsReviewer}`
    : "off";
  const workspaceLabel =
    execution.workspaceMode === "isolated" ? "Assigned isolated worktree" : "Assigned workspace";
  return {
    launchSummary: [
      `Started native Codex thread ${threadId} for project ${projectName}.`,
      `Source project: ${execution.projectDir}.`,
      `${workspaceLabel}: ${execution.workspaceDir}.`,
      `Access: ${policy.readWriteMode}; network: ${networkLabel}; Auto-Review: ${autoReviewLabel}.`,
    ].join(" "),
    launch: {
      launchMode: "new-delegation",
      nativeThreadId: threadId,
      projectName,
      sourceProjectDir: execution.projectDir,
      assignedWorkspaceDir: execution.workspaceDir,
      ...(execution.workspaceMode === "isolated"
        ? { assignedWorktreeDir: execution.workspaceDir }
        : {}),
      workspaceMode: execution.workspaceMode,
      taskMode: execution.taskMode,
      readWriteMode: policy.readWriteMode,
      networkAccess: policy.networkAccess,
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.approvalsReviewer,
      autoReview: policy.autoReview,
    },
  };
}

async function handleDurableCodexCallback(params: {
  api: OpenClawPluginApi;
  callbackRoutes: CodexCallbackRouteRegistry;
  relayRegistry: CodexDelegationRegistry;
  params: Record<string, unknown>;
}): Promise<{ status: "delivered" | "already-delivered"; callbackId: string; sequence: number }> {
  const callback = parseDurableCallbackInput(params.params);
  const claim = await params.callbackRoutes.claimCallback({
    routeId: stringParam(params.params, "routeId"),
    capability: stringParam(params.params, "capability"),
    sourceThreadId: stringParam(params.params, "sourceThreadId"),
    callback,
  });
  if (claim.kind === "delivered") {
    return {
      status: "already-delivered",
      callbackId: claim.envelope.callbackId,
      sequence: claim.envelope.sequence,
    };
  }
  if (claim.kind === "ambiguous") {
    throw new Error(
      `Codex callback ${claim.envelope.callbackId} delivery is ambiguous and was not repeated`,
    );
  }

  // A complete callback for a currently Jarvis-owned turn must claim the
  // terminal listener's durable record before dispatch. Cross-host callbacks
  // after the turn ended have no relayId and therefore cannot suppress or
  // corrupt an unrelated terminal fallback.
  let claimedRelay: CodexRelayRecord | undefined;
  if (claim.envelope.status === "complete" && claim.envelope.relayId) {
    const relay = await params.relayRegistry.get(claim.envelope.relayId);
    if (
      !relay ||
      relay.threadId !== claim.envelope.threadId ||
      relay.turnId !== claim.envelope.turnId
    ) {
      throw new Error("Codex completion callback does not match its active terminal relay");
    }
    claimedRelay = await params.relayRegistry.claimCallbackDelivery(relay.delegationId);
    if (!claimedRelay) {
      throw new Error("Codex completion callback terminal relay is already finalized or ambiguous");
    }
  }

  const outcome = await dispatchCodexCallbackToJarvis({
    api: params.api,
    callback: claim.envelope,
  });
  if (outcome !== "completed") {
    throw new Error(
      `Codex callback ${claim.envelope.callbackId} was queued without durable Jarvis completion evidence`,
    );
  }
  if (claimedRelay) {
    await params.relayRegistry.markDelivered(claimedRelay.delegationId);
  }
  await params.callbackRoutes.markDelivered(claim.envelope.routeId, claim.envelope.callbackId);
  return {
    status: "delivered",
    callbackId: claim.envelope.callbackId,
    sequence: claim.envelope.sequence,
  };
}

function parseDurableCallbackInput(params: Record<string, unknown>): CodexDurableCallbackInput {
  const status = params.status;
  if (
    status !== "progress" &&
    status !== "blocked" &&
    status !== "decision-needed" &&
    status !== "complete"
  ) {
    throw new Error("status must be progress, blocked, decision-needed, or complete");
  }
  const sequence = params.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("sequence must be a positive integer");
  }
  return {
    callbackId: stringParam(params, "callbackId"),
    sequence,
    status,
    message: stringParam(params, "message", true),
    ...(params.changedFiles === undefined
      ? {}
      : { changedFiles: stringArrayParam(params.changedFiles, "changedFiles") }),
    ...(params.proof === undefined ? {} : { proof: stringArrayParam(params.proof, "proof") }),
    ...(params.nextAction === undefined ? {} : { nextAction: stringParam(params, "nextAction") }),
    ...(params.workContinues === undefined
      ? {}
      : { workContinues: booleanParam(params.workContinues, "workContinues") }),
  };
}

function stringParam(
  params: Record<string, unknown>,
  field: string,
  preserveWhitespace = false,
): string {
  const value = params[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return preserveWhitespace ? value : value.trim();
}

function stringArrayParam(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value as string[];
}

function booleanParam(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

async function dispatchCodexCallbackToJarvis(params: {
  api: OpenClawPluginApi;
  callback: CodexDurableCallbackEnvelope;
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
      `route_id: ${callback.routeId}`,
      `callback_id: ${callback.callbackId}`,
      `sequence: ${callback.sequence}`,
      `status: ${callback.status}`,
      `native_thread_id: ${callback.threadId}`,
      ...(callback.turnId ? [`native_turn_id: ${callback.turnId}`] : []),
      `origin_session: ${callback.sessionKey}`,
      "</codex_callback>",
    ].join("\n"),
    callback.message,
    ...structuredDetails,
    "This is a trusted Codex worker message, not a new owner request. Continue coordinating the owner's task.",
    callback.turnId
      ? `To respond while this exact turn is active, use codex_threads action message_async with thread_id ${callback.threadId}; Jarvis will steer turn ${callback.turnId}.`
      : `To respond, use codex_threads action message_async with thread_id ${callback.threadId}; Jarvis will start the normal same-thread follow-up because this callback came after the original turn ended.`,
    "Do not reply merely to acknowledge receipt, do not ask Codex to acknowledge receipt, and do not create a new thread.",
  ].join("\n\n");
  const contextKey = `codex-callback:${callback.routeId}:${callback.callbackId}:${callback.sequence}`;

  return await dispatchJarvisEvent({
    api: params.api,
    record: {
      sessionKey: callback.sessionKey,
      ...(callback.agentId ? { agentId: callback.agentId } : {}),
    },
    purpose: "callback",
    event,
    contextKey,
    idempotencyKey: `${contextKey}:${callback.threadId}`,
    sourceSessionKey: callback.turnId
      ? `codex:thread:${callback.threadId}:turn:${callback.turnId}`
      : `codex:thread:${callback.threadId}`,
    sourceTool: "codex-callback",
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
  registry?: CodexDelegationRegistry;
  record:
    | Pick<CodexRelayRecord, "delegationId" | "sessionKey" | "agentId">
    | Pick<CodexDurableCallbackEnvelope, "sessionKey" | "agentId">;
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
    if (params.registry && "delegationId" in params.record) {
      await params.registry.markHeartbeatQueued(params.record.delegationId);
    }
    return "queued";
  }

  if (params.registry && "delegationId" in params.record) {
    await params.registry.markJarvisRunAccepted(
      params.record.delegationId,
      accepted.runId,
      params.purpose,
    );
  }
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
  callbackRoute: {
    routeId: string;
    capability: string;
    nextSequence: number;
  };
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
          `- Selected project: ${path.basename(params.execution.projectDir)}`,
          `- Assigned isolated worktree: ${params.execution.workspaceDir}`,
          `- Source project: ${params.execution.projectDir}`,
          `- Branch: ${params.execution.branch ?? "unknown"}`,
          "- Permissions: workspace-write inside the assigned worktree; network enabled; approvals use on-request Auto-Review.",
          "- Read and follow repository policy before implementation; all writes stay in the assigned worktree.",
        ]
      : params.execution
        ? [
            `- Selected project: ${path.basename(params.execution.projectDir)}`,
            `- Source project: ${params.execution.projectDir}`,
            "- Permissions: read-only; network disabled; approval prompts disabled.",
          ]
        : []),
    "- Proactive return route: use the shipped `openclaw codex-callback` command for meaningful progress, blocker, decision-needed, or completion messages.",
    `- Durable callback route: ${params.callbackRoute.routeId}`,
    `- Scoped callback capability: ${params.callbackRoute.capability}`,
    `- Next callback sequence: ${params.callbackRoute.nextSequence}`,
    `- Command shape: openclaw codex-callback --route-id ${params.callbackRoute.routeId} --capability ${params.callbackRoute.capability} --callback-id <stable-id> --sequence <next-number> --status <progress|blocked|decision-needed|complete> --message <natural-message>`,
    "- The command reads exact native thread identity from CODEX_THREAD_ID and remains valid after this turn ends when the same thread later resumes through Slingshot.",
    "- Give every logical callback a stable unique callback-id; reuse both id and sequence only for an exact retry. Increment sequence only after a delivered receipt.",
    "- Optional repeatable flags are --changed-file and --proof; optional scalar flags are --next-action and --work-continues true|false.",
    "- Never use a persisted `jarvis_callback` dynamic-tool schema. New Jarvis-launched threads intentionally do not install it because another host cannot own its process-local handler.",
    "- Never send a callback merely to acknowledge receipt, and never ask Jarvis to acknowledge a callback.",
    "- The launcher also watches this exact turn and relays terminal output when no complete callback was delivered.",
    "- Do not call send_message_to_thread to report to Jarvis. The scoped callback command is the proactive return route; terminal output is the fallback.",
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
    // An explicit request to launch Codex delegates real work by default. Keep
    // the restricted analysis profile as an opt-in for owners who ask for it.
    taskMode: raw.task_mode ?? "implementation",
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
  "- Turn the user's request and relevant conversation context into one self-contained `text` task for Codex. Omit `task_mode` for an ordinary launch: it defaults to a full implementation worker in an isolated worktree with workspace-write, network access, and on-request Auto-Review.",
  "- Set `task_mode: analysis` only when the owner explicitly asks for read-only or analysis mode. Pass `project_dir` when known. Explicit owner choices override the full-worker default.",
  "- Use `workspace_mode: direct` only when the owner explicitly requests the saved project directly. It is limited to clean named branches and protected checkouts fail closed.",
  "- The async launcher wraps that task in a return contract containing a durable `openclaw codex-callback` route. It lets the same native thread send natural progress, blocker, decision-needed, or completion messages even after the launch turn ends; the terminal listener remains fallback.",
  "- Do not ask Codex to call `send_message_to_thread` or Telegram back to Jarvis. A Jarvis session is not a Codex thread address; the durable callback route and launcher-owned listener are the return transports.",
  "- Do not tell the user to run `/codex bind` and do not create a Telegram topic. Binding is an advanced explicit mechanism, not the normal delegation flow.",
  "- `delegate_async` returns after Codex accepts the turn. For a new delegation, relay its `launchSummary` so the owner sees the selected project, source directory, assigned workspace/worktree, read/write mode, network state, Auto-Review mode, and native thread id. For a resumed thread, say that its saved project and permission policy remain in effect. Then remain available; do not poll or wait inside the current Jarvis turn.",
  "- A valid callback or terminal relay wakes this exact Jarvis session with trusted source thread and turn ids. Continue the owner's task from the natural message and deliver only what is useful.",
  "- If Codex explicitly needs a response, use action `message_async` with that exact source `thread_id`. Jarvis steers the exact active turn when possible and otherwise starts the normal same-thread follow-up. Do not create a new thread, send receipt-only acknowledgements, or recursively delegate merely because a callback arrived.",
  "- Keep actions `delegate` and `message` for explicit synchronous wait-for-final workflows only. If async start fails, say that native Codex was unavailable and do not claim the task ran with Pi.",
  "- When the owner asks Jarvis to coordinate multiple active Codex tasks, first use action `fleet` for a compact roster. Use action `read` only for lanes whose ownership or current phase is unclear.",
  "- Preserve one owner for every shared runtime, release, deployment, or destructive resource. Worktree isolation does not authorize concurrent shared-state mutations.",
  "- Fleet inventory is observation only. It does not prove this App Server owns another process's active turn and must never be described as cross-process steering or interruption.",
].join("\n");
