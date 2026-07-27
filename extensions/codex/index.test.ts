import { describe, expect, it, vi } from "vitest";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
} from "../../src/plugins/types.js";
import { createTestPluginApi } from "../test-utils/plugin-api.js";

const appServer = vi.hoisted(() => {
  const requests: Array<{ method: string; params: unknown }> = [];
  let handlers = new Set<
    (notification: { method: string; params?: Record<string, unknown> }) => void
  >();
  let autoComplete = true;
  return { requests, handlers, autoComplete };
});

vi.mock("./src/app-server-client.js", () => ({
  CodexAppServerClient: class {
    async initialize() {}
    async request(method: string, params?: unknown) {
      appServer.requests.push({ method, params });
      if (method === "thread/start") {
        return { thread: { id: "thread-natural" } };
      }
      if (method === "thread/resume") {
        return { thread: { id: "thread-natural", status: { type: "idle" } } };
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
      throw new Error(`unexpected request: ${method}`);
    }
    onNotification(
      handler: (notification: { method: string; params?: Record<string, unknown> }) => void,
    ) {
      appServer.handlers.add(handler);
      return () => appServer.handlers.delete(handler);
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

const { default: registerCodex } = await import("./index.js");

describe("Codex natural-language delegation", () => {
  it("guides Jarvis to delegate without a conversation binding and runs one native task", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
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
        pluginConfig: { command: "fake-codex", defaultWorkspaceDir: "/repo/openclaw" },
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
      }) as OpenClawPluginApi,
    );

    await expect(beforePromptBuild?.({}, {})).resolves.toMatchObject({
      prependSystemContext: expect.stringContaining("ordinary language"),
    });
    // The production agent must receive this tool without a separate
    // allowlist; owner and sandbox checks live in the factory below.
    expect(toolOptions).toEqual({ name: "codex_threads" });

    const tool = factory?.({ senderIsOwner: true, sandboxed: false }) as AnyAgentTool;
    const result = await tool.execute("delegate-1", {
      action: "delegate",
      text: "Inspect the OpenClaw browser issue and return the concrete root cause.",
      workspace_dir: "/repo/openclaw",
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
          cwd: "/repo/openclaw",
        }),
      }),
    ]);
  });

  it("returns immediately and wakes the exact Jarvis session when Codex completes", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
    appServer.autoComplete = false;
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeatNow = vi.fn();
    const run = vi.fn(async () => ({ runId: "jarvis-relay-run" }));
    let factory: OpenClawPluginToolFactory | undefined;

    registerCodex(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { command: "fake-codex", defaultWorkspaceDir: "/repo/openclaw" },
        runtime: {
          subagent: { run },
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
      }) as OpenClawPluginApi,
    );

    const tool = factory?.({
      senderIsOwner: true,
      sandboxed: false,
      sessionKey: "agent:main:telegram:direct:owner",
      agentId: "main",
    }) as AnyAgentTool;
    const accepted = await tool.execute("delegate-async-1", {
      action: "delegate_async",
      text: "Inspect the browser issue without blocking Jarvis.",
      workspace_dir: "/repo/openclaw",
    });

    expect(accepted).toMatchObject({
      details: {
        mode: "native-codex-async-relay",
        status: "accepted",
        threadId: "thread-natural",
        turnId: "turn-natural",
      },
    });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

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
  });

  it("routes an async Jarvis reply back to the exact source Codex thread", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
    appServer.autoComplete = false;
    const run = vi.fn(async () => ({ runId: "jarvis-reply-run" }));
    let factory: OpenClawPluginToolFactory | undefined;

    registerCodex(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { command: "fake-codex" },
        runtime: {
          subagent: { run },
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
      }) as OpenClawPluginApi,
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
              text: "Use the approved option and report back when finished.",
            }),
          ],
        }),
      },
    ]);

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
      }) as OpenClawPluginApi,
    );

    const tool = factory?.({ senderIsOwner: true, sandboxed: false }) as AnyAgentTool;
    await expect(
      tool.execute("delegate-async-no-session", {
        action: "delegate_async",
        text: "Do not orphan this work.",
      }),
    ).rejects.toThrow("requires a stable Jarvis session");
    expect(appServer.requests).toEqual([]);
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
      }) as OpenClawPluginApi,
    );

    expect(factory?.({ senderIsOwner: false, sandboxed: false })).toBeNull();
  });

  it("gives the owner a compact read-only fleet roster", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
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
      }) as OpenClawPluginApi,
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
