import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createPendingRestartConfirmation,
  loadSessionStore,
  saveSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createGatewayTool } from "./tools/gateway-tool.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(async (method: string) => {
    if (method === "config.get") {
      return { hash: "hash-1" };
    }
    if (method === "config.schema.lookup") {
      return {
        path: "gateway.auth",
        schema: {
          type: "object",
        },
        hint: { label: "Gateway Auth" },
        hintPath: "gateway.auth",
        children: [
          {
            key: "token",
            path: "gateway.auth.token",
            type: "string",
            required: true,
            hasChildren: false,
            hint: { label: "Token", sensitive: true },
            hintPath: "gateway.auth.token",
          },
        ],
      };
    }
    return { ok: true };
  }),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

function requireGatewayTool(agentSessionKey?: string, config?: OpenClawConfig) {
  return createGatewayTool({
    ...(agentSessionKey ? { agentSessionKey } : {}),
    config: config ?? { commands: { restart: true } },
  });
}

async function createSessionStoreFixture(params?: {
  sessionKey?: string;
  entry?: SessionEntry;
}): Promise<{ storePath: string; sessionKey: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-sessions-"));
  const storePath = path.join(root, "sessions.json");
  const sessionKey = params?.sessionKey ?? "agent:main:telegram:dm:+15555550123";
  const entry: SessionEntry =
    params?.entry ??
    ({
      sessionId: "session-1",
      updatedAt: Date.now(),
    } satisfies SessionEntry);
  await saveSessionStore(storePath, {
    [sessionKey]: entry,
  });
  return { storePath, sessionKey };
}

function expectConfigMutationCall(params: {
  callGatewayTool: {
    mock: {
      calls: Array<readonly unknown[]>;
    };
  };
  action: "config.apply" | "config.patch";
  raw: string;
  sessionKey: string;
}) {
  expect(params.callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
  expect(params.callGatewayTool).toHaveBeenCalledWith(
    params.action,
    expect.any(Object),
    expect.objectContaining({
      raw: params.raw.trim(),
      baseHash: "hash-1",
      sessionKey: params.sessionKey,
    }),
  );
}

describe("gateway tool", () => {
  it("marks gateway as owner-only", async () => {
    const tool = requireGatewayTool();
    expect(tool.ownerOnly).toBe(true);
  });

  it("schedules SIGUSR1 restart", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));

    try {
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_PROFILE: "isolated" },
        async () => {
          const tool = requireGatewayTool();

          const result = await tool.execute("call1", {
            action: "restart",
            delayMs: 0,
          });
          expect(result.details).toMatchObject({
            ok: true,
            pid: process.pid,
            signal: "SIGUSR1",
            delayMs: 0,
          });

          const sentinelPath = path.join(stateDir, "restart-sentinel.json");
          const raw = await fs.readFile(sentinelPath, "utf-8");
          const parsed = JSON.parse(raw) as {
            payload?: { kind?: string; doctorHint?: string | null };
          };
          expect(parsed.payload?.kind).toBe("restart");
          expect(parsed.payload?.doctorHint).toBe(
            "Run: openclaw --profile isolated doctor --non-interactive",
          );

          expect(kill).not.toHaveBeenCalled();
          await vi.runAllTimersAsync();
          expect(kill).toHaveBeenCalledWith(process.pid, "SIGUSR1");
        },
      );
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes config.apply through gateway call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool();

    const raw = '{\n  agents: { defaults: { workspace: "~/openclaw" } }\n}\n';
    await tool.execute("call2", {
      action: "config.apply",
      raw,
      sessionKey,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.apply",
      raw,
      sessionKey,
    });
  });

  it("passes config.patch through gateway call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool();

    const raw = '{\n  channels: { telegram: { groups: { "*": { requireMention: false } } } }\n}\n';
    await tool.execute("call4", {
      action: "config.patch",
      raw,
      sessionKey,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.patch",
      raw,
      sessionKey,
    });
  });

  it("passes update.run through gateway call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool();

    await tool.execute("call3", {
      action: "update.run",
      note: "test update",
      sessionKey,
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "update.run",
      expect.any(Object),
      expect.objectContaining({
        note: "test update",
        sessionKey,
      }),
    );
    const updateCall = vi
      .mocked(callGatewayTool)
      .mock.calls.find((call) => call[0] === "update.run");
    expect(updateCall).toBeDefined();
    if (updateCall) {
      const [, opts, params] = updateCall;
      expect(opts).toMatchObject({ timeoutMs: 20 * 60_000 });
      expect(params).toMatchObject({ timeoutMs: 20 * 60_000 });
    }
  });

  it("returns a path-scoped schema lookup result", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tool = requireGatewayTool();

    const result = await tool.execute("call5", {
      action: "config.schema.lookup",
      path: "gateway.auth",
    });

    expect(callGatewayTool).toHaveBeenCalledWith("config.schema.lookup", expect.any(Object), {
      path: "gateway.auth",
    });
    expect(result.details).toMatchObject({
      ok: true,
      result: {
        path: "gateway.auth",
        hintPath: "gateway.auth",
        children: [
          expect.objectContaining({
            key: "token",
            path: "gateway.auth.token",
            required: true,
            hintPath: "gateway.auth.token",
          }),
        ],
      },
    });
    const schema = (result.details as { result?: { schema?: { properties?: unknown } } }).result
      ?.schema;
    expect(schema?.properties).toBeUndefined();
  });

  it("arms a pending restart confirmation for the current live chat session", async () => {
    const { storePath, sessionKey } = await createSessionStoreFixture();
    const tool = requireGatewayTool(sessionKey, {
      commands: { restart: true },
      session: { store: storePath },
    });

    const result = await tool.execute("confirm1", {
      action: "restart.request_confirmation",
    });

    expect(result.details).toMatchObject({
      ok: true,
      sessionKey,
    });
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[sessionKey]?.pendingRestartConfirmation).toMatchObject({
      scope: "gateway-restart-capable",
    });
  });

  it("arms restart confirmation in the agent-specific session store", async () => {
    const sessionKey = "agent:atlas:telegram:dm:+15555550123";
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-agent-store-"));
    const agentStorePath = path.join(root, "atlas", "sessions.json");
    await saveSessionStore(agentStorePath, {
      [sessionKey]: {
        sessionId: "session-atlas-1",
        updatedAt: Date.now(),
      },
    });
    const tool = requireGatewayTool(sessionKey, {
      commands: { restart: true },
      session: { store: path.join(root, "{agentId}", "sessions.json") },
    });

    await tool.execute("confirm-agent-store", {
      action: "restart.request_confirmation",
    });

    const agentScopedStore = loadSessionStore(agentStorePath, { skipCache: true });
    expect(agentScopedStore[sessionKey]?.pendingRestartConfirmation).toMatchObject({
      scope: "gateway-restart-capable",
    });
  });

  it("blocks restart-capable actions without a pending confirmation", async () => {
    const { storePath, sessionKey } = await createSessionStoreFixture();
    const tool = requireGatewayTool(sessionKey, {
      commands: { restart: true },
      session: { store: storePath },
    });

    await expect(
      tool.execute("confirm2", {
        action: "config.patch",
        raw: '{\n  gateway: { logLevel: "debug" }\n}\n',
      }),
    ).rejects.toThrow("Restart confirmation required for live chat sessions");
  });

  it("consumes a valid confirmation on the next user turn for config.patch", async () => {
    const pending = createPendingRestartConfirmation({ now: Date.now() - 1_000 });
    const { storePath, sessionKey } = await createSessionStoreFixture({
      entry: {
        sessionId: "session-1",
        updatedAt: pending.requestedAt + 1_000,
        pendingRestartConfirmation: pending,
      },
    });
    const tool = requireGatewayTool(sessionKey, {
      commands: { restart: true },
      session: { store: storePath },
    });

    await tool.execute("confirm3", {
      action: "config.patch",
      raw: '{\n  gateway: { logLevel: "debug" }\n}\n',
    });

    const { callGatewayTool } = await import("./tools/gateway.js");
    expect(callGatewayTool).toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.objectContaining({
        sessionKey,
      }),
    );
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[sessionKey]?.pendingRestartConfirmation).toBeUndefined();
  });

  it("does not allow consuming the confirmation in the same turn it was armed", async () => {
    const pending = createPendingRestartConfirmation({ now: Date.now() });
    const { storePath, sessionKey } = await createSessionStoreFixture({
      entry: {
        sessionId: "session-1",
        updatedAt: pending.requestedAt,
        pendingRestartConfirmation: pending,
      },
    });
    const tool = requireGatewayTool(sessionKey, {
      commands: { restart: true },
      session: { store: storePath },
    });

    await expect(
      tool.execute("confirm4", {
        action: "update.run",
      }),
    ).rejects.toThrow("cannot consume it in the same turn");
  });
});
