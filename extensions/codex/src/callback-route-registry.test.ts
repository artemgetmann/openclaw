import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  it("rotates an exact interrupted turn after listener cleanup to a fresh identity", async () => {
    const { filePath, registry } = await createRegistry();
    const prior = await registry.acquire({
      threadId: "thread-1",
      sessionKey: "agent:main:telegram:direct:owner",
      agentId: "main",
    });
    await registry.bindTurn(prior.routeId, { relayId: "relay-1", turnId: "turn-1" });
    await registry.finishTurn(prior.routeId, "turn-1");

    // Reopen from disk to prove the closed identity survives a process restart.
    const restarted = new CodexCallbackRouteRegistry(filePath);
    const recovery = await restarted.replaceInterruptedTurn({
      threadId: "thread-1",
      sessionKey: "agent:main:telegram:direct:owner",
      agentId: "main",
      relayId: "relay-1",
      turnId: "turn-1",
    });

    expect(recovery).toMatchObject({ threadId: "thread-1", nextSequence: 1 });
    expect(recovery.routeId).not.toBe(prior.routeId);
    expect(recovery.capability).not.toBe(prior.capability);
    await expect(
      restarted.replaceInterruptedTurn({
        threadId: "thread-1",
        sessionKey: "agent:main:telegram:direct:owner",
        agentId: "main",
        relayId: "relay-1",
        turnId: "turn-1",
      }),
    ).rejects.toThrow("does not match recovery claim");
  });

  it("rotates a route when restart happened after relay acceptance but before binding", async () => {
    const { filePath, registry } = await createRegistry();
    const prior = await registry.acquire({
      threadId: "thread-1",
      sessionKey: "agent:main:telegram:direct:owner",
      agentId: "main",
    });

    const restarted = new CodexCallbackRouteRegistry(filePath);
    const recovery = await restarted.replaceInterruptedTurn({
      threadId: "thread-1",
      sessionKey: "agent:main:telegram:direct:owner",
      agentId: "main",
      relayId: "relay-durably-accepted",
      turnId: "turn-durably-accepted",
    });

    expect(recovery.routeId).not.toBe(prior.routeId);
    expect(recovery.capability).not.toBe(prior.capability);
  });

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
    await expect(
      registry.isSilentActiveTurn({
        routeId: route.routeId,
        relayId: "relay-1",
        turnId: "turn-1",
      }),
    ).resolves.toBe(false);
    await registry.finishTurn(route.routeId, "turn-1");
    await expect(
      registry.isSilentActiveTurn({
        routeId: route.routeId,
        relayId: "relay-1",
        turnId: "turn-1",
      }),
    ).resolves.toBe(false);

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

  it("rejects a different callback while one delivery claim is ambiguous", async () => {
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

    await expect(
      registry.claimCallback({
        routeId: route.routeId,
        capability: route.capability,
        sourceThreadId: "thread-1",
        callback: { ...progress, callbackId: "different-progress" },
      }),
    ).rejects.toThrow("only its exact retry is allowed");

    // The rejected claim must not poison shared state for this or any other
    // route when a new process reconstructs the registry.
    const restored = new CodexCallbackRouteRegistry(filePath);
    await expect(
      restored.acquire({
        threadId: "thread-2",
        sessionKey: "agent:main:telegram:direct:owner",
      }),
    ).resolves.toMatchObject({ threadId: "thread-2" });
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

  it("prunes completed routes before the bounded registry blocks new work", async () => {
    const now = 3_000_000_000;
    const { filePath, registry } = await createRegistry(() => now);
    const routes = Array.from({ length: 1_000 }, (_, index) => {
      const callback = {
        callbackId: `complete-${index}`,
        sequence: 1,
        status: "complete" as const,
        message: `Completed route ${index}.`,
      };
      const routeId = `route-${index}`;
      const threadId = `thread-${index}`;
      const sessionKey = `agent:main:test:${index}`;
      return {
        routeId,
        capability: `capability-${index}`,
        threadId,
        sessionKey,
        nextSequence: 2,
        callbacks: [
          {
            callbackId: callback.callbackId,
            sequence: 1,
            fingerprint: JSON.stringify(callback),
            delivery: "delivered",
            envelope: { ...callback, routeId, threadId, sessionKey },
            startedAtMs: now - index - 1,
            deliveredAtMs: now - index,
          },
        ],
        createdAtMs: now - index - 1,
        updatedAtMs: now - index,
        completedAtMs: now - index,
      };
    });
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify({ version: 1, routes })}\n`, "utf8");

    await expect(
      registry.acquire({
        threadId: "thread-new",
        sessionKey: "agent:main:telegram:direct:owner",
      }),
    ).resolves.toMatchObject({ threadId: "thread-new" });
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { routes: unknown[] };
    expect(persisted.routes).toHaveLength(1_000);
  });
});
