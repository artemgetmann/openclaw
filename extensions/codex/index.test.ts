import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { updateSessionStore } from "../../src/config/sessions/store.js";
import { createMonitorAuthorityGrant } from "../../src/monitor/authority.js";
import {
  createMonitorRecord,
  loadMonitorStore,
  resolveMonitorStorePath,
  saveMonitorStore,
} from "../../src/monitor/store.js";
import { CODEX_THREAD_UNARCHIVE_RESUME_ACTION } from "../../src/monitor/types.js";
import type { AnyAgentTool, OpenClawPluginToolFactory } from "../../src/plugins/types.js";
import { createTestPluginApi } from "../test-utils/plugin-api.js";
import { CodexDelegationRegistry } from "./src/delegation-registry.js";

type TestGatewayHandler = (options: {
  params: Record<string, unknown>;
  respond: (ok: boolean, payload: unknown) => void;
}) => Promise<void> | void;

function readCallbackRoute(prompt: string | undefined): {
  routeId: string;
  capability: string;
} {
  const routeId = prompt?.match(/- Durable callback route: ([^\n]+)/)?.[1];
  const capability = prompt?.match(/- Scoped callback capability: ([^\n]+)/)?.[1];
  if (!routeId || !capability) {
    throw new Error("delegated prompt omitted its durable callback route");
  }
  return { routeId, capability };
}

async function callGatewayHandler(
  handler: TestGatewayHandler | undefined,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; payload: unknown }> {
  if (!handler) {
    throw new Error("codex.callback Gateway handler was not registered");
  }
  let response: { ok: boolean; payload: unknown } | undefined;
  await handler({
    params,
    respond(ok, payload) {
      response = { ok, payload };
    },
  });
  if (!response) {
    throw new Error("codex.callback Gateway handler did not respond");
  }
  return response;
}

const appServer = vi.hoisted(() => {
  const requests: Array<{ method: string; params: unknown }> = [];
  let handlers = new Set<
    (notification: { method: string; params?: Record<string, unknown> }) => void
  >();
  let serverRequestHandlers = new Set<
    (request: { method: string; params?: Record<string, unknown> }) => Promise<unknown>
  >();
  let autoComplete = true;
  let threadReadResponse: unknown = undefined;
  let failCompletedAuthorityReceipt = false;
  let failTurnStartAmbiguously = false;
  const disabledCronJobIds: string[] = [];
  return {
    requests,
    handlers,
    serverRequestHandlers,
    autoComplete,
    threadReadResponse,
    failCompletedAuthorityReceipt,
    failTurnStartAmbiguously,
    disabledCronJobIds,
  };
});

vi.mock("../../src/cron/active-runtime.js", () => ({
  disableActiveCronJob: vi.fn(async (jobId: string) => {
    appServer.disabledCronJobIds.push(jobId);
  }),
}));

vi.mock("../../src/monitor/authority.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/monitor/authority.js")>();
  return {
    ...actual,
    finalizeMonitorAuthorityAction: async (
      params: Parameters<typeof actual.finalizeMonitorAuthorityAction>[0],
    ) => {
      if (appServer.failCompletedAuthorityReceipt && params.outcome === "completed") {
        appServer.failCompletedAuthorityReceipt = false;
        throw new Error("simulated completed receipt persistence failure");
      }
      return await actual.finalizeMonitorAuthorityAction(params);
    },
  };
});

vi.mock("./src/app-server-client.js", () => ({
  CodexRpcResponseError: class extends Error {
    readonly method: string;

    constructor(method: string, message: string) {
      super(message);
      this.method = method;
    }
  },
  CodexAppServerClient: class {
    async initialize() {}
    async request(method: string, params?: unknown) {
      appServer.requests.push({ method, params });
      if (method === "thread/start") {
        const request = params as {
          cwd?: string;
          approvalPolicy?: string;
          approvalsReviewer?: string;
          sandbox?: string;
        };
        return {
          thread: { id: "thread-natural" },
          cwd: request.cwd,
          approvalPolicy: request.approvalPolicy,
          approvalsReviewer: request.approvalsReviewer,
          sandbox: request.sandbox,
        };
      }
      if (method === "thread/resume") {
        return { thread: { id: "thread-natural", status: { type: "idle" } } };
      }
      if (method === "thread/read") {
        return (
          appServer.threadReadResponse ?? {
            thread: {
              id: "thread-natural",
              status: { type: "idle" },
              archived: true,
              turns: [],
            },
          }
        );
      }
      if (method === "thread/unarchive") {
        return {};
      }
      if (method === "thread/list") {
        return {
          data: [
            {
              id: "thread-active",
              name: "Active fleet worker",
              status: { type: "active", activeFlags: [] },
              cwd: "/repo/openclaw",
            },
          ],
        };
      }
      if (method === "turn/start") {
        if (appServer.failTurnStartAmbiguously) {
          appServer.failTurnStartAmbiguously = false;
          throw new Error("simulated turn/start timeout");
        }
        // The service registers its collector before starting the turn. Delay
        // the terminal notification one event-loop tick so it first records
        // the turn id returned by the App Server.
        if (appServer.autoComplete) {
          setTimeout(() => {
            finishNaturalTurn();
          }, 0);
        }
        return { turn: { id: "turn-natural" } };
      }
      if (method === "turn/steer") {
        return { turnId: "turn-natural" };
      }
      throw new Error(`unexpected request: ${method}`);
    }
    onNotification(
      handler: (notification: { method: string; params?: Record<string, unknown> }) => void,
    ) {
      appServer.handlers.add(handler);
      return () => appServer.handlers.delete(handler);
    }
    onServerRequest(
      handler: (request: { method: string; params?: Record<string, unknown> }) => Promise<unknown>,
    ) {
      appServer.serverRequestHandlers.add(handler);
      return () => appServer.serverRequestHandlers.delete(handler);
    }
    getServerVersion() {
      return "test";
    }
    isClosed() {
      return false;
    }
    async close() {}
  },
}));

function finishNaturalTurn() {
  for (const handler of appServer.handlers) {
    handler({
      method: "item/completed",
      params: {
        threadId: "thread-natural",
        turnId: "turn-natural",
        item: { id: "answer", type: "agentMessage", text: "Browser issue isolated." },
      },
    });
    handler({
      method: "turn/completed",
      params: {
        threadId: "thread-natural",
        turnId: "turn-natural",
        turn: { status: "completed" },
      },
    });
  }
}

async function createRelayState() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-relay-index-"));
  return { resolveStateDir: () => stateDir };
}

const { buildCodexLaunchReceipt, default: registerCodex } = await import("./index.js");

async function createDurableAuthorityFixture(label: string) {
  appServer.requests.splice(0);
  appServer.handlers = new Set();
  appServer.serverRequestHandlers = new Set();
  appServer.autoComplete = false;
  appServer.threadReadResponse = undefined;
  appServer.failCompletedAuthorityReceipt = false;
  appServer.failTurnStartAmbiguously = false;
  appServer.disabledCronJobIds.splice(0);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-codex-authority-${label}-`));
  const cronStorePath = path.join(dir, "cron.json");
  const sessionStorePath = path.join(dir, "sessions.json");
  const monitorStorePath = resolveMonitorStorePath({ cronStorePath });
  const relayRegistry = new CodexDelegationRegistry(path.join(dir, "codex", "async-relays.json"));
  const sessionKey = `agent:main:monitor:${label}`;
  const originSessionKey = `agent:main:telegram:direct:${label}`;
  const text = `Run the deferred ${label} proof exactly once.`;
  const idempotencyKey = `${label}:thread-natural`;
  const grantInput = {
    purposeKey: `release:${label}`,
    action: {
      kind: CODEX_THREAD_UNARCHIVE_RESUME_ACTION,
      threadId: "thread-natural",
      prompt: text,
    },
    idempotencyKey,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    stopCondition: "Accept the exact Codex continuation once.",
  };
  const approvedGrant = { ...grantInput, maxExecutions: 1 as const };
  const goal = {
    id: `goal-${label}`,
    objective: `Verify ${label}.`,
    autonomy: {
      level: "act_within_scope" as const,
      allowedActions: [CODEX_THREAD_UNARCHIVE_RESUME_ACTION],
      authorityGrants: [approvedGrant],
    },
  };
  const grant = createMonitorAuthorityGrant({
    input: grantInput,
    goal,
    nowMs: Date.now(),
  });
  await updateSessionStore(sessionStorePath, (store) => {
    store[originSessionKey] = {
      sessionId: `origin-${label}`,
      updatedAt: Date.now(),
      goal: {
        schemaVersion: 1,
        ...goal,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tokenStart: 0,
        tokensUsed: 0,
        continuationTurns: 0,
      },
    };
  });
  const monitor = createMonitorRecord(
    {
      monitorId: `monitor-${label}`,
      agentId: "main",
      instructions: `Watch for ${label}, then resume the exact verification thread.`,
      originSessionKey,
      monitorSessionKey: sessionKey,
      sourceType: "github-release",
      sourceTarget: { repo: "artemgetmann/openclaw" },
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "notify_only",
      goal,
      authority: grant,
      cronJobId: `cron-${label}`,
    },
    Date.now(),
  );
  await saveMonitorStore(monitorStorePath, { version: 1, monitors: [monitor] });

  let factory: OpenClawPluginToolFactory | undefined;
  registerCodex(
    createTestPluginApi({
      id: "codex",
      name: "Codex",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {
        state: { resolveStateDir: () => dir },
        subagent: {
          run: vi.fn(async () => ({ runId: "relay" })),
          waitForRun: vi.fn(async () => ({ status: "ok" as const })),
        },
        system: {
          enqueueSystemEvent: vi.fn(() => true),
          requestHeartbeatNow: vi.fn(),
        },
      } as never,
      registerTool(next) {
        if (typeof next === "function") {
          factory = next;
        }
      },
    }),
  );
  const tool = factory?.({
    senderIsOwner: true,
    sandboxed: false,
    sessionKey,
    agentId: "main",
    config: {
      cron: { store: cronStorePath },
      session: { store: sessionStorePath },
    },
  }) as AnyAgentTool;
  return { dir, idempotencyKey, monitorStorePath, relayRegistry, text, tool };
}

describe("Codex worker launch receipts", () => {
  it("shows the resolved project, isolated worktree, permissions, and native thread", () => {
    expect(
      buildCodexLaunchReceipt("thread-implementation", {
        taskMode: "implementation",
        workspaceMode: "isolated",
        projectDir: "/Users/artem/Programming_Projects/openclaw",
        workspaceDir: "/Users/artem/.codex/worktrees/task/openclaw",
        worktreeCreated: true,
        branch: "codex/task",
      }),
    ).toEqual({
      launchSummary:
        "Started native Codex thread thread-implementation for project openclaw. Source project: /Users/artem/Programming_Projects/openclaw. Assigned isolated worktree: /Users/artem/.codex/worktrees/task/openclaw. Access: workspace-write; network: on; Auto-Review: on-request via auto_review.",
      launch: {
        launchMode: "new-delegation",
        nativeThreadId: "thread-implementation",
        projectName: "openclaw",
        sourceProjectDir: "/Users/artem/Programming_Projects/openclaw",
        assignedWorkspaceDir: "/Users/artem/.codex/worktrees/task/openclaw",
        assignedWorktreeDir: "/Users/artem/.codex/worktrees/task/openclaw",
        workspaceMode: "isolated",
        taskMode: "implementation",
        readWriteMode: "workspace-write",
        networkAccess: true,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        autoReview: true,
      },
    });
  });
});

describe("Codex natural-language delegation", () => {
  it("guides Jarvis to delegate without a conversation binding and runs one native task", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
    appServer.serverRequestHandlers = new Set();
    appServer.autoComplete = true;
    let factory: OpenClawPluginToolFactory | undefined;
    let toolOptions: { name?: string; optional?: boolean } | undefined;
    let beforePromptBuild: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;

    registerCodex(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { command: "fake-codex", defaultWorkspaceDir: process.cwd() },
        runtime: {} as never,
        registerTool(next, options) {
          toolOptions = options;
          if (typeof next === "function") {
            factory = next;
          }
        },
        on(name, handler) {
          if (name === "before_prompt_build") {
            beforePromptBuild = handler as typeof beforePromptBuild;
          }
        },
      }),
    );

    await expect(beforePromptBuild?.({}, {})).resolves.toMatchObject({
      prependSystemContext: expect.stringContaining("ordinary language"),
    });
    await expect(beforePromptBuild?.({}, {})).resolves.toMatchObject({
      prependSystemContext: expect.stringContaining("defaults to a full implementation worker"),
    });
    // The production agent must receive this tool without a separate
    // allowlist; owner and sandbox checks live in the factory below.
    expect(toolOptions).toEqual({ name: "codex_threads" });

    const tool = factory?.({ senderIsOwner: true, sandboxed: false }) as AnyAgentTool;
    const result = await tool.execute("delegate-1", {
      action: "delegate",
      text: "Inspect the OpenClaw browser issue and return the concrete root cause.",
      task_mode: "analysis",
      project_dir: process.cwd(),
    });

    expect(result).toMatchObject({
      details: {
        mode: "native-codex-delegate",
        threadId: "thread-natural",
        finalText: "Browser issue isolated.",
      },
    });
    expect(appServer.requests).toEqual([
      expect.objectContaining({ method: "thread/start" }),
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({
          threadId: "thread-natural",
          cwd: process.cwd(),
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        }),
      }),
    ]);
  });

  it("defaults an unqualified launch to an isolated full-capability worker", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
    appServer.serverRequestHandlers = new Set();
    appServer.autoComplete = true;
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-default-"));
    const projectDir = path.join(temp, "project");
    const worktreesRoot = path.join(temp, "worktrees");
    let factory: OpenClawPluginToolFactory | undefined;

    try {
      // A real Git repository exercises the public delegation boundary through
      // the same isolated-worktree manager used by Jarvis in production.
      await fs.mkdir(projectDir);
      await fs.writeFile(path.join(projectDir, "README.md"), "test project\n");
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir });
      execFileSync("git", ["add", "README.md"], { cwd: projectDir });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Codex Test",
          "-c",
          "user.email=codex-test@example.invalid",
          "commit",
          "-m",
          "test: initialize fixture",
        ],
        { cwd: projectDir },
      );
      const canonicalProjectDir = await fs.realpath(projectDir);

      registerCodex(
        createTestPluginApi({
          id: "codex",
          name: "Codex",
          source: "test",
          config: {},
          pluginConfig: {
            command: "fake-codex",
            defaultWorkspaceDir: projectDir,
            worktreesRoot,
          },
          runtime: {} as never,
          registerTool(next) {
            if (typeof next === "function") {
              factory = next;
            }
          },
        }),
      );

      const tool = factory?.({ senderIsOwner: true, sandboxed: false }) as AnyAgentTool;
      const result = await tool.execute("delegate-default-implementation", {
        action: "delegate",
        text: "Inspect this project and implement the requested change.",
        project_dir: projectDir,
      });

      expect(result).toMatchObject({
        details: {
          execution: {
            taskMode: "implementation",
            workspaceMode: "isolated",
            projectDir: canonicalProjectDir,
            worktreeCreated: true,
          },
        },
      });
      const threadStart = appServer.requests.find((request) => request.method === "thread/start");
      expect(threadStart).toMatchObject({
        params: {
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
        },
      });
      const turnStart = appServer.requests.find((request) => request.method === "turn/start");
      expect(turnStart).toMatchObject({
        params: {
          sandboxPolicy: expect.objectContaining({
            type: "workspaceWrite",
            networkAccess: true,
          }),
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
        },
      });
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it("returns immediately and wakes the exact Jarvis session when Codex completes", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
    appServer.serverRequestHandlers = new Set();
    appServer.autoComplete = false;
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeatNow = vi.fn();
    const run = vi.fn(async () => ({ runId: "jarvis-relay-run" }));
    const waitForRun = vi.fn(async () => ({ status: "ok" as const }));
    const state = await createRelayState();
    let factory: OpenClawPluginToolFactory | undefined;

    registerCodex(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { command: "fake-codex", defaultWorkspaceDir: "/repo/openclaw" },
        runtime: {
          state,
          subagent: { run, waitForRun },
          system: {
            enqueueSystemEvent,
            requestHeartbeatNow,
          },
        } as never,
        registerTool(next) {
          if (typeof next === "function") {
            factory = next;
          }
        },
      }),
    );

    const tool = factory?.({
      senderIsOwner: true,
      sandboxed: false,
      sessionKey: "agent:main:telegram:direct:owner",
      agentId: "main",
    }) as AnyAgentTool;
    const accepted = await tool.execute("delegate-async-1", {
      action: "delegate_async",
      text: "\nInspect the browser issue without blocking Jarvis.\nKeep this spacing.\n",
      task_mode: "analysis",
      project_dir: process.cwd(),
    });

    expect(accepted).toMatchObject({
      details: {
        mode: "native-codex-async-relay",
        status: "accepted",
        threadId: "thread-natural",
        turnId: "turn-natural",
        launchSummary: expect.stringContaining(`for project ${path.basename(process.cwd())}`),
        launch: {
          launchMode: "new-delegation",
          nativeThreadId: "thread-natural",
          projectName: path.basename(process.cwd()),
          sourceProjectDir: process.cwd(),
          assignedWorkspaceDir: process.cwd(),
          workspaceMode: "direct",
          taskMode: "analysis",
          readWriteMode: "read-only",
          networkAccess: false,
          approvalPolicy: "never",
          approvalsReviewer: "user",
          autoReview: false,
        },
      },
    });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    const delegatedTurn = appServer.requests.find((request) => request.method === "turn/start");
    const delegatedPrompt = (
      delegatedTurn?.params as {
        input?: Array<{ text?: string }>;
      }
    )?.input?.[0]?.text;
    expect(delegatedPrompt).toMatch(
      /Jarvis-owned Codex worker return contract:[\s\S]*Native Codex thread ID: thread-natural/,
    );
    expect(delegatedPrompt).toContain(
      "Proactive return route: use the shipped `openclaw codex-callback` command",
    );
    expect(delegatedPrompt).toContain("Durable callback route:");
    expect(delegatedPrompt).toContain("Scoped callback capability:");
    expect(delegatedPrompt).toContain("Never send a callback merely to acknowledge receipt");
    expect(delegatedPrompt).toContain(
      "- Permissions: read-only; network disabled; approval prompts disabled.",
    );
    expect(delegatedPrompt).toContain(
      "- Start the terminal handback with exactly one of: STATUS: complete, STATUS: blocked, or STATUS: decision-needed.",
    );
    const delegatedBoundary = delegatedPrompt?.match(
      /-----BEGIN (JARVIS_TASK_PAYLOAD_[^\n]+)-----/,
    )?.[1];
    expect(delegatedBoundary).toBeTruthy();
    expect(delegatedPrompt).toContain(
      `-----BEGIN ${delegatedBoundary}-----\n\nInspect the browser issue without blocking Jarvis.\nKeep this spacing.\n\n-----END ${delegatedBoundary}-----`,
    );
    const delegatedId = delegatedPrompt?.match(/- Delegation ID: ([^\n]+)/)?.[1];
    expect(delegatedId).toBeTruthy();
    expect(accepted).toMatchObject({
      details: {
        delegationId: delegatedId,
      },
    });

    finishNaturalTurn();
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          deliver: true,
          idempotencyKey: expect.stringMatching(
            /^codex-relay:.*:completed:thread-natural:turn-natural$/,
          ),
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: "codex:thread:thread-natural",
            sourceChannel: "codex",
            sourceTool: "codex_threads",
          },
          message: expect.stringContaining("Trusted source: native Codex thread thread-natural"),
          sessionKey: "agent:main:telegram:direct:owner",
        }),
      );
    });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    expect(waitForRun).toHaveBeenCalledWith({
      runId: "jarvis-relay-run",
      timeoutMs: 5 * 60 * 1000,
    });
  });

  it("keeps spawn-accepted handback non-final until the exact Jarvis run completes", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
    appServer.serverRequestHandlers = new Set();
    appServer.autoComplete = false;
    const state = await createRelayState();
    const run = vi.fn(async () => ({ runId: "jarvis-pending-run" }));
    let completeJarvisRun!: (value: { status: "ok" }) => void;
    const waitForRun = vi.fn(
      async () =>
        await new Promise<{ status: "ok" }>((resolve) => {
          completeJarvisRun = resolve;
        }),
    );
    let factory: OpenClawPluginToolFactory | undefined;

    registerCodex(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { command: "fake-codex" },
        runtime: {
          state,
          subagent: { run, waitForRun },
          system: {
            enqueueSystemEvent: vi.fn(() => true),
            requestHeartbeatNow: vi.fn(),
          },
        } as never,
        registerTool(next) {
          if (typeof next === "function") {
            factory = next;
          }
        },
      }),
    );

    const tool = factory?.({
      senderIsOwner: true,
      sandboxed: false,
      sessionKey: "agent:main:telegram:direct:owner",
    }) as AnyAgentTool;
    const accepted = await tool.execute("delegate-async-pending-delivery", {
      action: "delegate_async",
      text: "Finish, then hand back through the exact Jarvis run.",
      task_mode: "analysis",
    });
    const delegationId = (accepted as { details?: { delegationId?: string } }).details
      ?.delegationId;
    expect(delegationId).toBeTruthy();

    finishNaturalTurn();
    await vi.waitFor(() => expect(waitForRun).toHaveBeenCalledTimes(1));
    const registry = new CodexDelegationRegistry(
      path.join(state.resolveStateDir(), "codex", "async-relays.json"),
    );
    await expect(registry.get(delegationId!)).resolves.toMatchObject({
      lifecycle: "delivery-started",
      lastJarvisRunId: "jarvis-pending-run",
      lastJarvisRunPurpose: "terminal",
    });

    completeJarvisRun({ status: "ok" });
    await vi.waitFor(async () => {
      await expect(registry.get(delegationId!)).resolves.toMatchObject({
        lifecycle: "delivered",
      });
    });
  });

  it("keeps queued heartbeat handback non-final across the restart crash window", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
    appServer.serverRequestHandlers = new Set();
    appServer.autoComplete = false;
    const state = await createRelayState();
    const run = vi.fn(async () => {
      throw new Error("Jarvis run spawn unavailable");
    });
    const waitForRun = vi.fn();
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeatNow = vi.fn();
    let factory: OpenClawPluginToolFactory | undefined;

    registerCodex(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { command: "fake-codex" },
        runtime: {
          state,
          subagent: { run, waitForRun },
          system: { enqueueSystemEvent, requestHeartbeatNow },
        } as never,
        registerTool(next) {
          if (typeof next === "function") {
            factory = next;
          }
        },
      }),
    );

    const tool = factory?.({
      senderIsOwner: true,
      sandboxed: false,
      sessionKey: "agent:main:telegram:direct:owner",
    }) as AnyAgentTool;
    const accepted = await tool.execute("delegate-async-heartbeat-window", {
      action: "delegate_async",
      text: "Finish, then exercise the volatile heartbeat fallback.",
      task_mode: "analysis",
    });
    const delegationId = (accepted as { details?: { delegationId?: string } }).details
      ?.delegationId;
    expect(delegationId).toBeTruthy();

    finishNaturalTurn();
    await vi.waitFor(() => expect(enqueueSystemEvent).toHaveBeenCalledTimes(1));
    const registry = new CodexDelegationRegistry(
      path.join(state.resolveStateDir(), "codex", "async-relays.json"),
    );
    await expect(registry.get(delegationId!)).resolves.toMatchObject({
      lifecycle: "delivery-started",
      deliveryKind: "terminal",
      heartbeatQueuedAtMs: expect.any(Number),
    });
    expect(waitForRun).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);
  });

  it("accepts a natural proactive callback once and steers the exact active turn", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
    appServer.serverRequestHandlers = new Set();
    appServer.autoComplete = false;
    const run = vi.fn(async () => ({ runId: "jarvis-callback-run" }));
    const waitForRun = vi.fn(async () => ({ status: "ok" as const }));
    const state = await createRelayState();
    let factory: OpenClawPluginToolFactory | undefined;
    let callbackHandler: TestGatewayHandler | undefined;

    registerCodex(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { command: "fake-codex", defaultWorkspaceDir: "/repo/openclaw" },
        runtime: {
          state,
          subagent: { run, waitForRun },
          system: {
            enqueueSystemEvent: vi.fn(() => true),
            requestHeartbeatNow: vi.fn(),
          },
        } as never,
        registerTool(next) {
          if (typeof next === "function") {
            factory = next;
          }
        },
        registerGatewayMethod(method, handler) {
          if (method === "codex.callback") {
            callbackHandler = handler as TestGatewayHandler;
          }
        },
      }),
    );

    const tool = factory?.({
      senderIsOwner: true,
      sandboxed: false,
      sessionKey: "agent:main:telegram:direct:owner",
      agentId: "main",
    }) as AnyAgentTool;
    const accepted = await tool.execute("delegate-async-callback", {
      action: "delegate_async",
      text: "Map the callback seam and report progress naturally.",
      task_mode: "analysis",
      project_dir: process.cwd(),
    });
    const delegationId = (accepted as { details?: { delegationId?: string } }).details
      ?.delegationId;
    expect(delegationId).toBeTruthy();
    const delegatedTurn = appServer.requests.find((request) => request.method === "turn/start");
    expect(delegatedTurn).not.toHaveProperty("params.dynamicTools");
    const delegatedPrompt = (delegatedTurn?.params as { input?: Array<{ text?: string }> })
      ?.input?.[0]?.text;
    const callbackRoute = readCallbackRoute(delegatedPrompt);
    const callbackRequest = {
      routeId: callbackRoute.routeId,
      capability: callbackRoute.capability,
      sourceThreadId: "thread-natural",
      callbackId: "progress-1",
      sequence: 1,
      status: "decision-needed",
      message: "\nThe architecture is clean. Choose whether to keep the API narrow.\n",
      changedFiles: ["extensions/codex/index.ts"],
      proof: ["Exact App Server turn identity verified"],
      nextAction: "Wait for Jarvis steering.",
      workContinues: true,
    };
    await expect(callGatewayHandler(callbackHandler, callbackRequest)).resolves.toMatchObject({
      ok: true,
      payload: { status: "delivered" },
    });
    await expect(callGatewayHandler(callbackHandler, callbackRequest)).resolves.toMatchObject({
      ok: true,
      payload: { status: "already-delivered" },
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:owner",
        deliver: true,
        idempotencyKey: expect.stringContaining(
          `codex-callback:${callbackRoute.routeId}:progress-1:1:thread-natural`,
        ),
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "codex:thread:thread-natural:turn:turn-natural",
          sourceChannel: "codex",
          sourceTool: "codex-callback",
        },
        message: expect.stringContaining(
          "\nThe architecture is clean. Choose whether to keep the API narrow.\n",
        ),
      }),
    );

    await expect(
      tool.execute("message-async-steer", {
        action: "message_async",
        thread_id: "thread-natural",
        text: "Keep the API narrow and continue.",
      }),
    ).resolves.toMatchObject({
      details: {
        mode: "native-codex-async-steer",
        status: "accepted",
        delegationId,
        threadId: "thread-natural",
        turnId: "turn-natural",
      },
    });
    expect(appServer.requests.at(-1)).toEqual({
      method: "turn/steer",
      params: {
        threadId: "thread-natural",
        expectedTurnId: "turn-natural",
        input: [{ type: "text", text: "Keep the API narrow and continue.", text_elements: [] }],
      },
    });
  });

  it("keeps one callback route across plugin restart and same-thread resume", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
    appServer.serverRequestHandlers = new Set();
    appServer.autoComplete = false;
    let runCount = 0;
    const run = vi.fn(
      async (_payload: {
        sessionKey: string;
        message: string;
        inputProvenance?: { sourceTool?: string; sourceSessionKey?: string };
      }) => ({ runId: `jarvis-run-${++runCount}` }),
    );
    const waitForRun = vi.fn(async () => ({ status: "ok" as const }));
    const state = await createRelayState();
    const callbackHandlers: TestGatewayHandler[] = [];

    const registerInstance = () => {
      let factory: OpenClawPluginToolFactory | undefined;
      registerCodex(
        createTestPluginApi({
          id: "codex",
          name: "Codex",
          source: "test",
          config: {},
          pluginConfig: { command: "fake-codex", defaultWorkspaceDir: "/repo/openclaw" },
          runtime: {
            state,
            subagent: { run, waitForRun },
            system: {
              enqueueSystemEvent: vi.fn(() => true),
              requestHeartbeatNow: vi.fn(),
            },
          } as never,
          registerTool(next) {
            if (typeof next === "function") {
              factory = next;
            }
          },
          registerGatewayMethod(method, handler) {
            if (method === "codex.callback") {
              callbackHandlers.push(handler as TestGatewayHandler);
            }
          },
        }),
      );
      return factory?.({
        senderIsOwner: true,
        sandboxed: false,
        sessionKey: "agent:main:telegram:direct:owner",
        agentId: "main",
      }) as AnyAgentTool;
    };

    const firstTool = registerInstance();
    await firstTool.execute("delegate-before-restart", {
      action: "delegate_async",
      text: "Send one progress update, then finish this turn.",
      task_mode: "analysis",
      project_dir: process.cwd(),
    });
    const firstPrompt = (
      appServer.requests.find((request) => request.method === "turn/start")?.params as {
        input?: Array<{ text?: string }>;
      }
    )?.input?.[0]?.text;
    const firstRoute = readCallbackRoute(firstPrompt);
    await expect(
      callGatewayHandler(callbackHandlers[0], {
        ...firstRoute,
        sourceThreadId: "thread-natural",
        callbackId: "progress-before-restart",
        sequence: 1,
        status: "progress",
        message: "The first turn proved its durable callback route.",
        workContinues: true,
      }),
    ).resolves.toMatchObject({ ok: true, payload: { status: "delivered" } });
    finishNaturalTurn();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    // Re-registering the plugin creates fresh process-local objects while both
    // durable registries remain on disk. This is the relevant Gateway restart
    // boundary; the resumed worker may arrive through a different host.
    const resumedTool = registerInstance();
    await resumedTool.execute("resume-after-restart", {
      action: "message_async",
      thread_id: "thread-natural",
      text: "Resume the same thread and send the next update.",
    });
    const resumedTurn = appServer.requests
      .filter((request) => request.method === "turn/start")
      .at(-1);
    const resumedPrompt = (resumedTurn?.params as { input?: Array<{ text?: string }> })?.input?.[0]
      ?.text;
    const resumedRoute = readCallbackRoute(resumedPrompt);
    expect(resumedRoute).toEqual(firstRoute);
    expect(resumedPrompt).toContain("Next callback sequence: 2");

    const secondCallback = {
      ...resumedRoute,
      sourceThreadId: "thread-natural",
      callbackId: "decision-after-restart",
      sequence: 2,
      status: "decision-needed",
      message: "The same native thread resumed; Jarvis must choose the final wording.",
      nextAction: "Choose the final wording.",
      workContinues: false,
    };
    await expect(callGatewayHandler(callbackHandlers[1], secondCallback)).resolves.toMatchObject({
      ok: true,
      payload: { status: "delivered" },
    });
    await expect(callGatewayHandler(callbackHandlers[1], secondCallback)).resolves.toMatchObject({
      ok: true,
      payload: { status: "already-delivered" },
    });

    const callbackRuns = run.mock.calls.filter(
      ([payload]) => payload.inputProvenance?.sourceTool === "codex-callback",
    );
    expect(callbackRuns).toHaveLength(2);
    expect(callbackRuns[1]?.[0]).toMatchObject({
      sessionKey: "agent:main:telegram:direct:owner",
      inputProvenance: {
        sourceSessionKey: "codex:thread:thread-natural:turn:turn-natural",
      },
      message: expect.stringContaining(
        "The same native thread resumed; Jarvis must choose the final wording.",
      ),
    });
  });

  it("uses terminal completion only as fallback after a delivered complete callback", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
    appServer.serverRequestHandlers = new Set();
    appServer.autoComplete = false;
    const run = vi.fn(async (_payload: { message: string }) => ({
      runId: "jarvis-complete-callback-run",
    }));
    const waitForRun = vi.fn(async () => ({ status: "ok" as const }));
    const state = await createRelayState();
    let factory: OpenClawPluginToolFactory | undefined;
    let callbackHandler: TestGatewayHandler | undefined;
    registerCodex(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { command: "fake-codex" },
        runtime: {
          state,
          subagent: { run, waitForRun },
          system: {
            enqueueSystemEvent: vi.fn(() => true),
            requestHeartbeatNow: vi.fn(),
          },
        } as never,
        registerTool(next) {
          if (typeof next === "function") {
            factory = next;
          }
        },
        registerGatewayMethod(method, handler) {
          if (method === "codex.callback") {
            callbackHandler = handler as TestGatewayHandler;
          }
        },
      }),
    );
    const tool = factory?.({
      senderIsOwner: true,
      sandboxed: false,
      sessionKey: "agent:main:telegram:direct:owner",
    }) as AnyAgentTool;
    const accepted = await tool.execute("delegate-async-complete", {
      action: "delegate_async",
      text: "Complete the bounded task.",
      task_mode: "analysis",
    });
    expect(accepted).toMatchObject({ details: { status: "accepted" } });
    const delegatedTurn = appServer.requests.find((request) => request.method === "turn/start");
    const delegatedPrompt = (delegatedTurn?.params as { input?: Array<{ text?: string }> })
      ?.input?.[0]?.text;
    const callbackRoute = readCallbackRoute(delegatedPrompt);
    await callGatewayHandler(callbackHandler, {
      routeId: callbackRoute.routeId,
      capability: callbackRoute.capability,
      sourceThreadId: "thread-natural",
      callbackId: "complete-1",
      sequence: 1,
      status: "complete",
      message: "The bounded task is complete with focused proof.",
      workContinues: false,
    });
    finishNaturalTurn();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringContaining("status: complete"),
    });
  });

  it("reconciles a proven persisted terminal turn once at service startup", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
    appServer.serverRequestHandlers = new Set();
    appServer.autoComplete = false;
    const state = await createRelayState();
    const registry = new CodexDelegationRegistry(
      path.join(state.resolveStateDir(), "codex", "async-relays.json"),
      Date.now,
    );
    await registry.createStarting({
      delegationId: "delegation-restart",
      sessionKey: "agent:main:telegram:direct:owner",
      agentId: "main",
      threadId: "thread-natural",
      deliveryKey: "codex-relay:delegation-restart",
    });
    await registry.markAccepted("delegation-restart", "turn-natural");
    appServer.threadReadResponse = {
      thread: {
        id: "thread-natural",
        turns: [
          {
            id: "turn-natural",
            status: "completed",
            items: [
              {
                type: "agentMessage",
                phase: "final_answer",
                text: "Persisted exact result.",
              },
            ],
          },
        ],
      },
    };
    const run = vi.fn(async () => ({ runId: "jarvis-reconciled-run" }));
    const waitForRun = vi.fn(async () => ({ status: "ok" as const }));
    let startService: (() => Promise<void>) | undefined;

    registerCodex(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { command: "fake-codex" },
        runtime: {
          state,
          subagent: { run, waitForRun },
          system: {
            enqueueSystemEvent: vi.fn(() => true),
            requestHeartbeatNow: vi.fn(),
          },
        } as never,
        registerService(service) {
          startService = async () => await service.start({} as never);
        },
      }),
    );

    await startService?.();
    await startService?.();

    expect(appServer.requests.filter((request) => request.method === "thread/read")).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-natural", includeTurns: true },
      },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:owner",
        idempotencyKey: "codex-relay:delegation-restart:completed:thread-natural:turn-natural",
        message: expect.stringContaining("Persisted exact result."),
      }),
    );
    await expect(registry.get("delegation-restart")).resolves.toMatchObject({
      lifecycle: "delivered",
    });
  });

  it("keeps terminal fallback for resumed threads without sending unsupported dynamic tools", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
    appServer.serverRequestHandlers = new Set();
    appServer.autoComplete = false;
    const run = vi.fn(async () => ({ runId: "jarvis-reply-run" }));
    const waitForRun = vi.fn(async () => ({ status: "ok" as const }));
    const state = await createRelayState();
    let factory: OpenClawPluginToolFactory | undefined;

    registerCodex(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { command: "fake-codex" },
        runtime: {
          state,
          subagent: { run, waitForRun },
          system: {
            enqueueSystemEvent: vi.fn(() => true),
            requestHeartbeatNow: vi.fn(),
          },
        } as never,
        registerTool(next) {
          if (typeof next === "function") {
            factory = next;
          }
        },
      }),
    );

    const tool = factory?.({
      senderIsOwner: true,
      sandboxed: false,
      sessionKey: "agent:main:telegram:direct:owner",
    }) as AnyAgentTool;
    const accepted = await tool.execute("message-async-1", {
      action: "message_async",
      thread_id: "thread-natural",
      text: "Use the approved option and report back when finished.",
    });

    expect(accepted).toMatchObject({
      details: {
        mode: "native-codex-async-relay",
        status: "accepted",
        threadId: "thread-natural",
        launch: {
          launchMode: "resumed-existing-thread",
          nativeThreadId: "thread-natural",
          policySource: "saved-thread",
        },
        launchSummary: expect.stringContaining(
          "saved project and permission policy remain in effect",
        ),
      },
    });
    expect(appServer.requests.slice(0, 2)).toEqual([
      {
        method: "thread/resume",
        params: expect.objectContaining({ threadId: "thread-natural" }),
      },
      {
        method: "turn/start",
        params: expect.objectContaining({
          threadId: "thread-natural",
          input: [
            expect.objectContaining({
              text: expect.stringMatching(
                /Jarvis-owned Codex worker return contract:[\s\S]*Native Codex thread ID: thread-natural/,
              ),
            }),
          ],
        }),
      },
    ]);
    expect(appServer.requests[0]).not.toHaveProperty("params.dynamicTools");
    expect(appServer.requests[1]).not.toHaveProperty("params.approvalPolicy");
    expect(appServer.requests[1]).not.toHaveProperty("params.approvalsReviewer");
    const followupPrompt = (
      appServer.requests[1]?.params as {
        input?: Array<{ text?: string }>;
      }
    )?.input?.[0]?.text;
    expect(followupPrompt).toContain(
      "The launcher also watches this exact turn and relays terminal output when no complete callback was delivered.",
    );
    expect(followupPrompt).toContain(
      "The command reads exact native thread identity from CODEX_THREAD_ID and remains valid after this turn ends when the same thread later resumes through Slingshot.",
    );
    expect(followupPrompt).toContain(
      "Never use a persisted `jarvis_callback` dynamic-tool schema.",
    );
    const followupBoundary = followupPrompt?.match(
      /-----BEGIN (JARVIS_TASK_PAYLOAD_[^\n]+)-----/,
    )?.[1];
    expect(followupBoundary).toBeTruthy();
    expect(followupPrompt).toContain(
      `-----BEGIN ${followupBoundary}-----\nUse the approved option and report back when finished.\n-----END ${followupBoundary}-----`,
    );
    const followupId = followupPrompt?.match(/- Delegation ID: ([^\n]+)/)?.[1];
    expect(followupId).toBeTruthy();
    expect(accepted).toMatchObject({
      details: {
        delegationId: followupId,
      },
    });

    finishNaturalTurn();
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          inputProvenance: expect.objectContaining({
            sourceSessionKey: "codex:thread:thread-natural",
          }),
          message: expect.stringContaining(
            "If Codex explicitly needs a response, use codex_threads action message_async with thread_id thread-natural.",
          ),
        }),
      );
    });
  });

  it("refuses detached delegation when no exact Jarvis return session exists", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
    appServer.serverRequestHandlers = new Set();
    appServer.autoComplete = false;
    let factory: OpenClawPluginToolFactory | undefined;
    registerCodex(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { command: "fake-codex" },
        runtime: {} as never,
        registerTool(next) {
          if (typeof next === "function") {
            factory = next;
          }
        },
      }),
    );

    const tool = factory?.({ senderIsOwner: true, sandboxed: false }) as AnyAgentTool;
    await expect(
      tool.execute("delegate-async-no-session", {
        action: "delegate_async",
        text: "Do not orphan this work.",
      }),
    ).rejects.toThrow("requires a stable Jarvis session");
    expect(appServer.requests.filter((request) => request.method === "turn/start")).toEqual([]);
  });

  it("blocks generic mutating Codex actions from durable monitor sessions", async () => {
    let factory: OpenClawPluginToolFactory | undefined;
    registerCodex(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerTool(next) {
          if (typeof next === "function") {
            factory = next;
          }
        },
      }),
    );
    const tool = factory?.({
      senderIsOwner: true,
      sandboxed: false,
      sessionKey: "agent:main:monitor:release-proof",
    }) as AnyAgentTool;

    await expect(
      tool.execute("monitor-generic-resume", {
        action: "resume",
        thread_id: "thread-natural",
      }),
    ).rejects.toThrow("must use a durable authority grant");
    await expect(
      tool.execute("monitor-read", {
        action: "list",
      }),
    ).resolves.toBeDefined();
  });

  it("keeps transitive monitor descendants read-only", async () => {
    appServer.requests.splice(0);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-monitor-descendant-"));
    const sessionStorePath = path.join(dir, "sessions.json");
    const parentKey = "agent:main:subagent:monitor-child";
    const childKey = "agent:main:subagent:monitor-grandchild";
    await updateSessionStore(sessionStorePath, (store) => {
      store[parentKey] = {
        sessionId: "monitor-child",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:monitor:release-proof",
      };
      store[childKey] = {
        sessionId: "monitor-grandchild",
        updatedAt: Date.now(),
        spawnedBy: parentKey,
      };
    });

    try {
      let factory: OpenClawPluginToolFactory | undefined;
      registerCodex(
        createTestPluginApi({
          id: "codex",
          name: "Codex",
          source: "test",
          config: {},
          pluginConfig: {},
          runtime: {} as never,
          registerTool(next) {
            if (typeof next === "function") {
              factory = next;
            }
          },
        }),
      );
      const tool = factory?.({
        senderIsOwner: true,
        sandboxed: false,
        sessionKey: childKey,
        agentId: "main",
        config: { session: { store: sessionStorePath } },
      }) as AnyAgentTool;

      await expect(
        tool.execute("monitor-descendant-mutation", {
          action: "message_async",
          thread_id: "thread-natural",
          text: "Bypass the parent monitor grant.",
        }),
      ).rejects.toThrow("descended from a durable monitor");
      expect(appServer.requests).toEqual([]);
      await expect(
        tool.execute("monitor-descendant-read", {
          action: "list",
        }),
      ).resolves.toBeDefined();

      const orphanTool = factory?.({
        senderIsOwner: true,
        sandboxed: false,
        sessionKey: "agent:main:subagent:missing-lineage",
        agentId: "main",
        config: { session: { store: sessionStorePath } },
      }) as AnyAgentTool;
      await expect(
        orphanTool.execute("ambiguous-descendant-mutation", {
          action: "message_async",
          thread_id: "thread-natural",
          text: "Mutate without a durable ancestry record.",
        }),
      ).rejects.toThrow("descended from a durable monitor");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it("consumes exact durable authority before unarchiving and starting one continuation", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
    appServer.serverRequestHandlers = new Set();
    appServer.autoComplete = false;
    appServer.threadReadResponse = undefined;
    appServer.disabledCronJobIds.splice(0);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-authority-"));
    const cronStorePath = path.join(dir, "cron.json");
    const sessionStorePath = path.join(dir, "sessions.json");
    const monitorStorePath = resolveMonitorStorePath({ cronStorePath });
    const sessionKey = "agent:main:monitor:release-proof";
    const text = "The Mac release is available. Run the deferred verification now.";
    const idempotencyKey = "release-2026-08:thread-natural";
    const grantInput = {
      purposeKey: "mac-release:verify-login-item-fix",
      action: {
        kind: CODEX_THREAD_UNARCHIVE_RESUME_ACTION,
        threadId: "thread-natural",
        prompt: text,
      },
      idempotencyKey,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      stopCondition: "Accept the exact Codex continuation once.",
    };
    const approvedGrant = { ...grantInput, maxExecutions: 1 as const };
    const grant = createMonitorAuthorityGrant({
      input: grantInput,
      goal: {
        id: "goal-release",
        objective: "Verify the next release.",
        autonomy: {
          level: "act_within_scope",
          allowedActions: [CODEX_THREAD_UNARCHIVE_RESUME_ACTION],
          authorityGrants: [approvedGrant],
        },
      },
      nowMs: Date.now(),
    });
    await updateSessionStore(sessionStorePath, (store) => {
      store["agent:main:telegram:direct:owner"] = {
        sessionId: "origin-session",
        updatedAt: Date.now(),
        goal: {
          schemaVersion: 1,
          id: grant.goalId,
          objective: "Verify the next release.",
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          tokenStart: 0,
          tokensUsed: 0,
          continuationTurns: 0,
          autonomy: {
            level: "act_within_scope",
            allowedActions: [CODEX_THREAD_UNARCHIVE_RESUME_ACTION],
            authorityGrants: [approvedGrant],
          },
        },
      };
    });
    const monitor = createMonitorRecord(
      {
        monitorId: "monitor-release",
        agentId: "main",
        instructions: "Watch for the release and resume the exact verification thread.",
        originSessionKey: "agent:main:telegram:direct:owner",
        monitorSessionKey: sessionKey,
        sourceType: "github-release",
        sourceTarget: { repo: "artemgetmann/openclaw" },
        cadence: { kind: "every", everyMs: 300_000 },
        actionPolicy: "notify_only",
        goal: {
          id: grant.goalId,
          objective: "Verify the next release.",
          autonomy: {
            level: "act_within_scope",
            allowedActions: [CODEX_THREAD_UNARCHIVE_RESUME_ACTION],
            authorityGrants: [approvedGrant],
          },
        },
        authority: grant,
        cronJobId: "cron-release",
      },
      Date.now(),
    );
    await saveMonitorStore(monitorStorePath, { version: 1, monitors: [monitor] });

    let factory: OpenClawPluginToolFactory | undefined;
    const run = vi.fn(async () => ({ runId: "relay" }));
    const waitForRun = vi.fn(async () => ({ status: "ok" as const }));
    registerCodex(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {
          state: { resolveStateDir: () => dir },
          subagent: { run, waitForRun },
          system: {
            enqueueSystemEvent: vi.fn(() => true),
            requestHeartbeatNow: vi.fn(),
          },
        } as never,
        registerTool(next) {
          if (typeof next === "function") {
            factory = next;
          }
        },
      }),
    );
    const tool = factory?.({
      senderIsOwner: true,
      sandboxed: false,
      sessionKey,
      agentId: "main",
      config: {
        cron: { store: cronStorePath },
        session: { store: sessionStorePath },
      },
    }) as AnyAgentTool;

    const accepted = await tool.execute("authorized-resume", {
      action: "unarchive_resume_authorized_once",
      thread_id: "thread-natural",
      text,
      idempotency_key: idempotencyKey,
    });
    expect(accepted).toMatchObject({
      details: {
        mode: "durable-monitor-authority",
        monitorId: "monitor-release",
        threadId: "thread-natural",
        turnId: "turn-natural",
        unarchived: true,
      },
    });
    expect(appServer.requests.map((request) => request.method)).toEqual([
      "thread/read",
      "thread/unarchive",
      "thread/resume",
      "turn/start",
    ]);
    expect(appServer.disabledCronJobIds).toEqual(["cron-release"]);
    expect((await loadMonitorStore(monitorStorePath)).monitors[0]).toMatchObject({
      status: "completed",
      authority: {
        execution: { status: "completed", executions: 1, externalRef: "turn-natural" },
      },
    });

    appServer.requests.splice(0);
    await expect(
      tool.execute("authorized-resume-retry", {
        action: "unarchive_resume_authorized_once",
        thread_id: "thread-natural",
        text,
        idempotency_key: idempotencyKey,
      }),
    ).resolves.toMatchObject({
      details: {
        status: "completed",
        executed: false,
      },
    });
    expect(appServer.requests).toEqual([]);
    expect(appServer.disabledCronJobIds).toEqual(["cron-release", "cron-release"]);
    finishNaturalTurn();
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:telegram:direct:owner",
          deliver: true,
        }),
      );
    });
    await fs.rm(dir, { recursive: true });
  });

  it("keeps authority consumed when relay acceptance persistence is ambiguous", async () => {
    const fixture = await createDurableAuthorityFixture("ambiguous-acceptance");
    const markAccepted = vi
      .spyOn(CodexDelegationRegistry.prototype, "markAccepted")
      .mockRejectedValueOnce(new Error("simulated acceptance persistence failure"));
    try {
      await expect(
        fixture.tool.execute("authorized-resume-ambiguous", {
          action: "unarchive_resume_authorized_once",
          thread_id: "thread-natural",
          text: fixture.text,
          idempotency_key: fixture.idempotencyKey,
        }),
      ).rejects.toThrow("acceptance became ambiguous");
      expect(appServer.requests.map((request) => request.method)).toEqual([
        "thread/read",
        "thread/unarchive",
        "thread/resume",
        "turn/start",
      ]);
      expect((await loadMonitorStore(fixture.monitorStorePath)).monitors[0]).toMatchObject({
        status: "stopped",
        authority: {
          execution: { status: "consumed", executions: 1 },
        },
      });

      appServer.requests.splice(0);
      await expect(
        fixture.tool.execute("authorized-resume-ambiguous-retry", {
          action: "unarchive_resume_authorized_once",
          thread_id: "thread-natural",
          text: fixture.text,
          idempotency_key: fixture.idempotencyKey,
        }),
      ).resolves.toMatchObject({
        details: {
          status: "consumed",
          executed: false,
        },
      });
      expect(appServer.requests).toEqual([]);
      finishNaturalTurn();
    } finally {
      markAccepted.mockRestore();
      await fs.rm(fixture.dir, { recursive: true });
    }
  });

  it("keeps authority consumed when turn-start acceptance times out ambiguously", async () => {
    const fixture = await createDurableAuthorityFixture("ambiguous-turn-start");
    appServer.failTurnStartAmbiguously = true;
    try {
      await expect(
        fixture.tool.execute("authorized-resume-turn-start-timeout", {
          action: "unarchive_resume_authorized_once",
          thread_id: "thread-natural",
          text: fixture.text,
          idempotency_key: fixture.idempotencyKey,
        }),
      ).rejects.toThrow("turn acceptance became ambiguous");
      expect((await loadMonitorStore(fixture.monitorStorePath)).monitors[0]).toMatchObject({
        status: "stopped",
        authority: {
          execution: { status: "consumed", executions: 1 },
        },
      });
      expect(appServer.disabledCronJobIds).toEqual(["cron-ambiguous-turn-start"]);

      appServer.requests.splice(0);
      await expect(
        fixture.tool.execute("authorized-resume-turn-start-timeout-retry", {
          action: "unarchive_resume_authorized_once",
          thread_id: "thread-natural",
          text: fixture.text,
          idempotency_key: fixture.idempotencyKey,
        }),
      ).resolves.toMatchObject({
        details: {
          status: "consumed",
          executed: false,
        },
      });
      expect(appServer.requests).toEqual([]);
      expect(appServer.disabledCronJobIds).toEqual([
        "cron-ambiguous-turn-start",
        "cron-ambiguous-turn-start",
      ]);
    } finally {
      appServer.failTurnStartAmbiguously = false;
      await fs.rm(fixture.dir, { recursive: true });
    }
  });

  it("keeps authority consumed when the completed receipt cannot be persisted", async () => {
    const fixture = await createDurableAuthorityFixture("ambiguous-completed-receipt");
    appServer.failCompletedAuthorityReceipt = true;
    try {
      await expect(
        fixture.tool.execute("authorized-resume-ambiguous-receipt", {
          action: "unarchive_resume_authorized_once",
          thread_id: "thread-natural",
          text: fixture.text,
          idempotency_key: fixture.idempotencyKey,
        }),
      ).rejects.toThrow("receipt became ambiguous");
      expect(appServer.requests.map((request) => request.method)).toEqual([
        "thread/read",
        "thread/unarchive",
        "thread/resume",
        "turn/start",
      ]);
      expect((await loadMonitorStore(fixture.monitorStorePath)).monitors[0]).toMatchObject({
        status: "stopped",
        authority: {
          execution: { status: "consumed", executions: 1 },
        },
      });

      appServer.requests.splice(0);
      await expect(
        fixture.tool.execute("authorized-resume-ambiguous-receipt-retry", {
          action: "unarchive_resume_authorized_once",
          thread_id: "thread-natural",
          text: fixture.text,
          idempotency_key: fixture.idempotencyKey,
        }),
      ).resolves.toMatchObject({
        details: {
          status: "consumed",
          executed: false,
        },
      });
      expect(appServer.requests).toEqual([]);
      finishNaturalTurn();
      // Terminal handback writes asynchronously after the App Server event.
      // Wait for its durable boundary before deleting the fixture directory.
      await vi.waitFor(async () => {
        const snapshot = await fixture.relayRegistry.snapshot();
        expect(snapshot.records).toHaveLength(1);
        expect(snapshot.records[0]).toMatchObject({
          lifecycle: "delivered",
          terminalStatus: "completed",
        });
      });
    } finally {
      appServer.failCompletedAuthorityReceipt = false;
      await fs.rm(fixture.dir, { recursive: true });
    }
  });

  it("does not expose the native delegate tool to non-owners", () => {
    let factory: OpenClawPluginToolFactory | undefined;
    registerCodex(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerTool(next) {
          if (typeof next === "function") {
            factory = next;
          }
        },
      }),
    );

    expect(factory?.({ senderIsOwner: false, sandboxed: false })).toBeNull();
  });

  it("gives the owner a compact read-only fleet roster", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
    appServer.serverRequestHandlers = new Set();
    appServer.autoComplete = true;
    let factory: OpenClawPluginToolFactory | undefined;
    let beforePromptBuild: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
    registerCodex(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { command: "fake-codex" },
        runtime: {} as never,
        registerTool(next) {
          if (typeof next === "function") {
            factory = next;
          }
        },
        on(name, handler) {
          if (name === "before_prompt_build") {
            beforePromptBuild = handler as typeof beforePromptBuild;
          }
        },
      }),
    );

    await expect(beforePromptBuild?.({}, {})).resolves.toMatchObject({
      prependSystemContext: expect.stringContaining("coordinate multiple active Codex tasks"),
    });
    const tool = factory?.({ senderIsOwner: true, sandboxed: false }) as AnyAgentTool;
    await expect(tool.execute("fleet-1", { action: "fleet", limit: 40 })).resolves.toMatchObject({
      details: {
        mode: "native-codex-fleet",
        counts: { total: 1, active: 1 },
        omittedInactive: 0,
        threads: [{ threadId: "thread-active", status: "active" }],
      },
    });
    expect(appServer.requests.at(-1)).toMatchObject({
      method: "thread/list",
      params: { useStateDbOnly: true },
    });
  });
});
