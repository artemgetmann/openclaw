import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexCallbackRouteRegistry } from "./callback-route-registry.js";

async function createRegistry(now = () => Date.now()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-callback-routes-"));
  const filePath = path.join(directory, "codex", "callback-routes.json");
  return {
    filePath,
    registry: new CodexCallbackRouteRegistry(filePath, now),
  };
}

const progress = {
  callbackId: "progress-1",
  sequence: 1,
  status: "progress" as const,
  message: "The focused tests pass; review is next.",
  proof: ["12 focused tests passed"],
  workContinues: true,
};

describe("CodexCallbackRouteRegistry", () => {
  it("reuses one durable route for the same Jarvis session and native thread", async () => {
    const { filePath, registry } = await createRegistry();
    const created = await registry.acquire({
      threadId: "thread-1",
      sessionKey: "agent:main:telegram:direct:owner",
      agentId: "main",
    });

    const restored = new CodexCallbackRouteRegistry(filePath);
    const reused = await restored.acquire({
      threadId: "thread-1",
      sessionKey: "agent:main:telegram:direct:owner",
      agentId: "main",
    });

    expect(reused).toEqual(created);
    expect(reused.nextSequence).toBe(1);
    await expect(
      restored.acquire({
        threadId: "thread-1",
        sessionKey: "agent:main:telegram:direct:other",
        agentId: "main",
      }),
    ).rejects.toThrow("already bound to another Jarvis session");
  });

  it("persists monotonic delivery and makes an exact retry idempotent", async () => {
    const { filePath, registry } = await createRegistry();
    const route = await registry.acquire({
      threadId: "thread-1",
      sessionKey: "agent:main:telegram:direct:owner",
    });
    await registry.bindTurn(route.routeId, {
      relayId: "relay-1",
      turnId: "turn-1",
    });

    const claimed = await registry.claimCallback({
      routeId: route.routeId,
      capability: route.capability,
      sourceThreadId: "thread-1",
      callback: progress,
    });
    expect(claimed).toMatchObject({
      kind: "claimed",
      envelope: {
        routeId: route.routeId,
        threadId: "thread-1",
        turnId: "turn-1",
        relayId: "relay-1",
        sequence: 1,
      },
    });
    await registry.markDelivered(route.routeId, progress.callbackId);

    const restored = new CodexCallbackRouteRegistry(filePath);
    await expect(
      restored.claimCallback({
        routeId: route.routeId,
        capability: route.capability,
        sourceThreadId: "thread-1",
        callback: progress,
      }),
    ).resolves.toMatchObject({ kind: "delivered" });
    await expect(
      restored.claimCallback({
        routeId: route.routeId,
        capability: route.capability,
        sourceThreadId: "thread-1",
        callback: { ...progress, callbackId: "progress-gap", sequence: 3 },
      }),
    ).rejects.toThrow("expected 2");
  });

  it("rejects forged identity and changed callback-id retries", async () => {
    const { registry } = await createRegistry();
    const route = await registry.acquire({
      threadId: "thread-1",
      sessionKey: "agent:main:telegram:direct:owner",
    });

    await expect(
      registry.claimCallback({
        routeId: route.routeId,
        capability: "wrong-capability",
        sourceThreadId: "thread-1",
        callback: progress,
      }),
    ).rejects.toThrow("capability is invalid");
    await expect(
      registry.claimCallback({
        routeId: route.routeId,
        capability: route.capability,
        sourceThreadId: "thread-other",
        callback: progress,
      }),
    ).rejects.toThrow("source thread does not match");

    await registry.claimCallback({
      routeId: route.routeId,
      capability: route.capability,
      sourceThreadId: "thread-1",
      callback: progress,
    });
    await expect(
      registry.claimCallback({
        routeId: route.routeId,
        capability: route.capability,
        sourceThreadId: "thread-1",
        callback: { ...progress, message: "Changed content." },
      }),
    ).rejects.toThrow("reused with different content");
  });

  it("rejects corrupt persisted routing before it can wake another session", async () => {
    const { filePath, registry } = await createRegistry();
    const route = await registry.acquire({
      threadId: "thread-1",
      sessionKey: "agent:main:telegram:direct:owner",
    });
    await registry.claimCallback({
      routeId: route.routeId,
      capability: route.capability,
      sourceThreadId: "thread-1",
      callback: progress,
    });

    // Simulate partial/corrupt owner-state, not an attacker with owner access.
    // The route must fail closed rather than trust a nested stale session key.
    const document = JSON.parse(await readFile(filePath, "utf8")) as {
      routes: Array<{ callbacks: Array<{ envelope: { sessionKey: string } }> }>;
    };
    document.routes[0]!.callbacks[0]!.envelope.sessionKey = "agent:main:telegram:direct:wrong";
    await writeFile(filePath, `${JSON.stringify(document)}\n`, "utf8");

    const restored = new CodexCallbackRouteRegistry(filePath);
    await expect(
      restored.acquire({
        threadId: "thread-1",
        sessionKey: "agent:main:telegram:direct:owner",
      }),
    ).rejects.toThrow("envelope routing is inconsistent");
  });

  it("survives an ended turn and routes the next sequence without stale turn identity", async () => {
    const { filePath, registry } = await createRegistry();
    const route = await registry.acquire({
      threadId: "thread-1",
      sessionKey: "agent:main:telegram:direct:owner",
    });
    await registry.bindTurn(route.routeId, { relayId: "relay-1", turnId: "turn-1" });
    await registry.claimCallback({
      routeId: route.routeId,
      capability: route.capability,
      sourceThreadId: "thread-1",
      callback: progress,
    });
    await registry.markDelivered(route.routeId, progress.callbackId);
    await registry.finishTurn(route.routeId, "turn-1");

    const restored = new CodexCallbackRouteRegistry(filePath);
    const completion = await restored.claimCallback({
      routeId: route.routeId,
      capability: route.capability,
      sourceThreadId: "thread-1",
      callback: {
        callbackId: "complete-2",
        sequence: 2,
        status: "complete",
        message: "The selected wording is now final.",
        workContinues: false,
      },
    });

    expect(completion).toMatchObject({
      kind: "claimed",
      envelope: {
        sequence: 2,
      },
    });
    expect(completion.envelope).not.toHaveProperty("turnId");
    expect(completion.envelope).not.toHaveProperty("relayId");
  });
});
