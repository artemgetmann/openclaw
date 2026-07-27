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
  return { requests, handlers };
});

vi.mock("./src/app-server-client.js", () => ({
  CodexAppServerClient: class {
    async initialize() {}
    async request(method: string, params?: unknown) {
      appServer.requests.push({ method, params });
      if (method === "thread/start") {
        return { thread: { id: "thread-natural" } };
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
      if (method === "thread/read") {
        return {
          thread: {
            id: "thread-active",
            status: { type: "active", activeFlags: [] },
            turns: [{ id: "turn-active", status: "inProgress", items: [] }],
          },
        };
      }
      if (method === "turn/steer") {
        return { turnId: "turn-active" };
      }
      if (method === "turn/start") {
        // The service registers its collector before starting the turn. Delay
        // the terminal notification one event-loop tick so it first records
        // the turn id returned by the App Server.
        setTimeout(() => {
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
        }, 0);
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

const { default: registerCodex } = await import("./index.js");

describe("Codex natural-language delegation", () => {
  it("guides Jarvis to delegate without a conversation binding and runs one native task", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
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

  it("gives the owner a compact fleet roster and race-safe steering", async () => {
    appServer.requests.splice(0);
    appServer.handlers = new Set();
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
        threads: [{ threadId: "thread-active", status: "active" }],
      },
    });
    await expect(
      tool.execute("steer-1", {
        action: "steer",
        thread_id: "thread-active",
        text: "Do not deploy; hand back source proof only.",
      }),
    ).resolves.toMatchObject({
      details: {
        mode: "native-codex-steer",
        threadId: "thread-active",
        turnId: "turn-active",
      },
    });
    expect(appServer.requests.slice(-2)).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-active", includeTurns: true },
      },
      {
        method: "turn/steer",
        params: expect.objectContaining({
          threadId: "thread-active",
          expectedTurnId: "turn-active",
        }),
      },
    ]);
  });
});
