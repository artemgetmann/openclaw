import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./app-server-client.js";
import { CodexCallbackRouter } from "./callback-router.js";

const grant = {
  delegationId: "delegation-1",
  threadId: "thread-1",
  turnId: "turn-1",
  sessionKey: "agent:main:telegram:direct:owner",
  agentId: "main",
};

function callbackRequest(
  overrides: Partial<{
    threadId: string;
    turnId: string;
    delegation_id: string;
    callback_id: string;
    sequence: number;
    status: string;
    message: string;
  }> = {},
) {
  return {
    method: "item/tool/call",
    params: {
      tool: "jarvis_callback",
      threadId: overrides.threadId ?? grant.threadId,
      turnId: overrides.turnId ?? grant.turnId,
      callId: "call-1",
      arguments: {
        delegation_id: overrides.delegation_id ?? grant.delegationId,
        callback_id: overrides.callback_id ?? "callback-1",
        sequence: overrides.sequence ?? 1,
        status: overrides.status ?? "progress",
        message: overrides.message ?? "\nI mapped the callback seam and kept this spacing.\n",
        changed_files: ["extensions/codex/index.ts"],
        proof: ["Protocol schema inspected"],
        next_action: "Implement the narrow router.",
        work_continues: true,
      },
    },
  };
}

describe("CodexCallbackRouter", () => {
  it("preserves natural prose and binds routing to the active server-owned turn", async () => {
    const dispatch = vi.fn(async () => undefined);
    const router = new CodexCallbackRouter({ dispatch });
    router.register(grant);

    await expect(router.handleServerRequest(callbackRequest())).resolves.toMatchObject({
      success: true,
    });
    expect(dispatch).toHaveBeenCalledWith({
      delegationId: "delegation-1",
      callbackId: "callback-1",
      sequence: 1,
      status: "progress",
      message: "\nI mapped the callback seam and kept this spacing.\n",
      changedFiles: ["extensions/codex/index.ts"],
      proof: ["Protocol schema inspected"],
      nextAction: "Implement the narrow router.",
      workContinues: true,
      threadId: "thread-1",
      turnId: "turn-1",
      sessionKey: "agent:main:telegram:direct:owner",
      agentId: "main",
    });
  });

  it("deduplicates an exact retry and rejects sequence or callback-id reuse", async () => {
    const dispatch = vi.fn(async () => undefined);
    const router = new CodexCallbackRouter({ dispatch });
    router.register(grant);

    await router.handleServerRequest(callbackRequest());
    await expect(router.handleServerRequest(callbackRequest())).resolves.toMatchObject({
      success: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);

    await expect(
      router.handleServerRequest(callbackRequest({ callback_id: "callback-2", sequence: 1 })),
    ).rejects.toThrow("expected 2");
    await expect(
      router.handleServerRequest(callbackRequest({ message: "Different content." })),
    ).rejects.toThrow("reused with different content");
  });

  it.each([
    ["wrong delegation", { delegation_id: "forged" }, "stale or unknown"],
    ["wrong thread", { threadId: "thread-forged" }, "does not match"],
    ["wrong turn", { turnId: "turn-forged" }, "does not match"],
    ["gap", { sequence: 2 }, "expected 1"],
    ["invalid status", { status: "telemetry" }, "status must be"],
    ["receipt", { message: "Acknowledged." }, "not only a receipt"],
  ])("rejects %s callbacks", async (_name, overrides, expected) => {
    const router = new CodexCallbackRouter({ dispatch: async () => undefined });
    router.register(grant);
    await expect(router.handleServerRequest(callbackRequest(overrides))).rejects.toThrow(expected);
  });

  it("rejects model-supplied routing authority", async () => {
    const router = new CodexCallbackRouter({ dispatch: async () => undefined });
    router.register(grant);
    const request = callbackRequest();
    // Widen only this forged test input; the accepted callback schema must not
    // gain model-controlled routing authority.
    const forgedArguments: Record<string, unknown> = request.params.arguments;
    forgedArguments.session_key = "agent:main:telegram:direct:attacker";

    await expect(router.handleServerRequest(request)).rejects.toThrow(
      "unexpected Codex callback field: session_key",
    );
  });

  it("exposes steering only to the exact originating Jarvis session", () => {
    const router = new CodexCallbackRouter({ dispatch: async () => undefined });
    router.register(grant);

    expect(
      router.findActiveTurn({
        threadId: "thread-1",
        sessionKey: "agent:main:telegram:direct:owner",
      }),
    ).toEqual({
      delegationId: "delegation-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(
      router.findActiveTurn({
        threadId: "thread-1",
        sessionKey: "agent:main:telegram:direct:attacker",
      }),
    ).toBeUndefined();
  });

  it("reports complete delivery only after the accepted callback drains", async () => {
    const router = new CodexCallbackRouter({ dispatch: async () => undefined });
    router.register(grant);
    await router.handleServerRequest(
      callbackRequest({ status: "complete", message: "The requested work is complete." }),
    );
    await expect(
      router.handleServerRequest(
        callbackRequest({
          callback_id: "progress-after-complete",
          sequence: 2,
          message: "More progress after completion.",
        }),
      ),
    ).rejects.toThrow("already delivered completion");

    await expect(router.finish(grant)).resolves.toEqual({ completeDelivered: true });
    await expect(router.handleServerRequest(callbackRequest())).rejects.toThrow("stale or unknown");
  });
});

describe("Codex App Server callback requests", () => {
  it("returns a dynamic tool result through the owned JSON-RPC connection", async () => {
    // The child is a minimal protocol peer: it completes initialization, asks
    // the client to execute jarvis_callback, then projects the client's reply
    // back as a notification that the test can inspect.
    const script = String.raw`
      const readline = require("node:readline");
      const lines = readline.createInterface({ input: process.stdin });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "initialize") {
          process.stdout.write(JSON.stringify({
            id: message.id,
            result: { serverInfo: { version: "test" } }
          }) + "\n");
          process.stdout.write(JSON.stringify({
            id: 91,
            method: "item/tool/call",
            params: {
              tool: "jarvis_callback",
              callId: "call-1",
              threadId: "thread-1",
              turnId: "turn-1",
              arguments: {}
            }
          }) + "\n");
          return;
        }
        if (message.id === 91) {
          process.stdout.write(JSON.stringify({
            method: "test/server-response",
            params: { response: message }
          }) + "\n");
        }
      });
    `;
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: ["-e", script],
      requestTimeoutMs: 2_000,
    });
    const response = new Promise<Record<string, unknown>>((resolve) => {
      client.onNotification((notification) => {
        if (notification.method === "test/server-response") {
          resolve(notification.params ?? {});
        }
      });
    });
    client.onServerRequest(async (request) => {
      if (request.method !== "item/tool/call") {
        return undefined;
      }
      return {
        success: true,
        contentItems: [{ type: "inputText", text: "Delivered." }],
      };
    });

    try {
      await client.initialize();
      await expect(response).resolves.toMatchObject({
        response: {
          id: 91,
          result: {
            success: true,
            contentItems: [{ type: "inputText", text: "Delivered." }],
          },
        },
      });
    } finally {
      await client.close();
    }
  });
});
