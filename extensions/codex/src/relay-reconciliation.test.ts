import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_RELAY_MAX_RECONCILE_AGE_MS,
  CodexDelegationRegistry,
  type CodexRelayRecord,
} from "./delegation-registry.js";
import { reconcileCodexRelays } from "./relay-reconciliation.js";

async function acceptedRegistry(now = 1_000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-relay-reconcile-"));
  const filePath = path.join(directory, "async-relays.json");
  const registry = new CodexDelegationRegistry(filePath, () => now);
  await registry.createStarting({
    delegationId: "delegation-1",
    sessionKey: "agent:main:telegram:direct:owner",
    agentId: "main",
    threadId: "thread-1",
    deliveryKey: "codex-relay:delegation-1",
  });
  await registry.markAccepted("delegation-1", "turn-1");
  return { filePath, registry };
}

async function addAcceptedRelay(
  registry: CodexDelegationRegistry,
  params: { delegationId: string; threadId: string; turnId: string },
) {
  await registry.createStarting({
    delegationId: params.delegationId,
    sessionKey: "agent:main:telegram:direct:owner",
    agentId: "main",
    threadId: params.threadId,
    deliveryKey: `codex-relay:${params.delegationId}`,
  });
  await registry.markAccepted(params.delegationId, params.turnId);
}

describe("reconcileCodexRelays", () => {
  it("delivers a proven terminal turn once across duplicate startup reconciliation", async () => {
    const { registry } = await acceptedRegistry();
    const inspectTurn = vi.fn(async () => ({
      kind: "completed" as const,
      threadId: "thread-1",
      turnId: "turn-1",
      finalText: "Exact persisted result.",
    }));
    const dispatchTerminal = vi.fn(
      async (_record: CodexRelayRecord, _text: string) => "completed" as const,
    );
    const dispatchDecisionNeeded = vi.fn();
    const options = {
      registry,
      inspectTurn,
      dispatchTerminal,
      dispatchDecisionNeeded,
      now: () => 2_000,
    };

    await expect(reconcileCodexRelays(options)).resolves.toMatchObject({ delivered: 1 });
    await expect(reconcileCodexRelays(options)).resolves.toMatchObject({
      delivered: 0,
      skipped: 1,
    });
    expect(dispatchTerminal).toHaveBeenCalledTimes(1);
    expect(dispatchTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        delegationId: "delegation-1",
        threadId: "thread-1",
        turnId: "turn-1",
        lifecycle: "delivery-started",
      }),
      "Exact persisted result.",
    );
    expect(dispatchDecisionNeeded).not.toHaveBeenCalled();
  });

  it("reports an accepted nonterminal turn without resuming or replaying it", async () => {
    const { registry } = await acceptedRegistry();
    const dispatchTerminal = vi.fn();
    const dispatchDecisionNeeded = vi.fn(async () => "completed" as const);

    await expect(
      reconcileCodexRelays({
        registry,
        inspectTurn: async () => ({
          kind: "nonterminal",
          threadId: "thread-1",
          turnId: "turn-1",
          status: "inProgress",
        }),
        dispatchTerminal,
        dispatchDecisionNeeded,
        now: () => 2_000,
      }),
    ).resolves.toMatchObject({ decisionNeeded: 1, delivered: 0 });
    expect(dispatchTerminal).not.toHaveBeenCalled();
    expect(dispatchDecisionNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ delegationId: "delegation-1" }),
      expect.stringContaining("cannot prove it owns"),
    );
    await expect(registry.get("delegation-1")).resolves.toMatchObject({
      lifecycle: "decision-needed",
    });
  });

  it("does not replay a durably delivered complete callback", async () => {
    const { registry } = await acceptedRegistry();
    await registry.claimCallbackDelivery("delegation-1");
    await registry.markDelivered("delegation-1");
    const inspectTurn = vi.fn();
    const dispatchTerminal = vi.fn();
    const dispatchDecisionNeeded = vi.fn();

    await expect(
      reconcileCodexRelays({
        registry,
        inspectTurn,
        dispatchTerminal,
        dispatchDecisionNeeded,
      }),
    ).resolves.toMatchObject({ skipped: 1, delivered: 0 });
    expect(inspectTurn).not.toHaveBeenCalled();
    expect(dispatchTerminal).not.toHaveBeenCalled();
    expect(dispatchDecisionNeeded).not.toHaveBeenCalled();
  });

  it("rejects an unrelated thread response", async () => {
    const { registry } = await acceptedRegistry();
    const dispatchDecisionNeeded = vi.fn(async () => "completed" as const);

    await reconcileCodexRelays({
      registry,
      inspectTurn: async () => ({
        kind: "mismatch",
        expectedThreadId: "thread-1",
        actualThreadId: "thread-unrelated",
        turnId: "turn-1",
      }),
      dispatchTerminal: vi.fn(),
      dispatchDecisionNeeded,
      now: () => 2_000,
    });

    expect(dispatchDecisionNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1" }),
      expect.stringContaining("thread-unrelated"),
    );
  });

  it.each([
    [
      "missing",
      { kind: "missing" as const, threadId: "thread-1", turnId: "turn-1" },
      "did not contain",
    ],
    [
      "failed",
      {
        kind: "failed" as const,
        threadId: "thread-1",
        turnId: "turn-1",
        error: "native failure",
      },
      "not retried",
    ],
    [
      "interrupted",
      { kind: "interrupted" as const, threadId: "thread-1", turnId: "turn-1" },
      "not resumed",
    ],
  ])("reports exact %s state as decision-needed", async (_label, inspection, phrase) => {
    const { registry } = await acceptedRegistry();
    const dispatchTerminal = vi.fn();
    const dispatchDecisionNeeded = vi.fn(async () => "completed" as const);

    await reconcileCodexRelays({
      registry,
      inspectTurn: async () => inspection,
      dispatchTerminal,
      dispatchDecisionNeeded,
      now: () => 2_000,
    });

    expect(dispatchTerminal).not.toHaveBeenCalled();
    expect(dispatchDecisionNeeded).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(phrase),
    );
  });

  it("turns crash-after-delivery-start into an ambiguity report instead of replay", async () => {
    const { registry } = await acceptedRegistry();
    await registry.markTerminal("delegation-1", "completed");
    await registry.claimTerminalDelivery("delegation-1");
    const inspectTurn = vi.fn();
    const dispatchTerminal = vi.fn();
    const dispatchDecisionNeeded = vi.fn(async () => "completed" as const);

    await reconcileCodexRelays({
      registry,
      inspectTurn,
      dispatchTerminal,
      dispatchDecisionNeeded,
      now: () => 2_000,
    });

    expect(inspectTurn).not.toHaveBeenCalled();
    expect(dispatchTerminal).not.toHaveBeenCalled();
    expect(dispatchDecisionNeeded).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("cannot prove whether Jarvis processed it"),
    );
  });

  it("keeps spawn-accepted terminal delivery non-final and reports ambiguity after restart", async () => {
    const { registry } = await acceptedRegistry();
    // This is the durable state after run() accepted the exact Jarvis
    // continuation but before agent.wait produced a completion receipt.
    await registry.markTerminal("delegation-1", "completed");
    await registry.claimTerminalDelivery("delegation-1");
    await registry.markJarvisRunAccepted("delegation-1", "jarvis-run-1", "terminal");
    await expect(registry.get("delegation-1")).resolves.toMatchObject({
      lifecycle: "delivery-started",
      lastJarvisRunId: "jarvis-run-1",
      lastJarvisRunPurpose: "terminal",
    });

    const dispatchTerminal = vi.fn();
    const restartDecision = vi.fn(async () => "completed" as const);
    const restartOptions = {
      registry,
      inspectTurn: vi.fn(),
      dispatchTerminal,
      dispatchDecisionNeeded: restartDecision,
      now: () => 3_000,
    };
    await expect(reconcileCodexRelays(restartOptions)).resolves.toMatchObject({
      delivered: 0,
      decisionNeeded: 1,
    });
    await expect(reconcileCodexRelays(restartOptions)).resolves.toMatchObject({
      decisionNeeded: 0,
      skipped: 1,
    });
    expect(dispatchTerminal).not.toHaveBeenCalled();
    expect(restartDecision).toHaveBeenCalledTimes(1);
    expect(restartDecision).toHaveBeenCalledWith(
      expect.objectContaining({ lastJarvisRunId: "jarvis-run-1" }),
      expect.stringContaining("cannot prove whether Jarvis processed it"),
    );
  });

  it("keeps a queued heartbeat non-final and never replays its terminal result", async () => {
    const { registry } = await acceptedRegistry();
    // This is the durable state after the old Gateway queued a volatile
    // heartbeat and stopped before any Jarvis completion evidence existed.
    await registry.markTerminal("delegation-1", "completed");
    await registry.claimTerminalDelivery("delegation-1");
    await registry.markHeartbeatQueued("delegation-1");
    await expect(registry.get("delegation-1")).resolves.toMatchObject({
      lifecycle: "delivery-started",
      heartbeatQueuedAtMs: 1_000,
    });

    const dispatchTerminal = vi.fn();
    const restartDecision = vi.fn(async () => "completed" as const);
    const restartOptions = {
      registry,
      inspectTurn: vi.fn(),
      dispatchTerminal,
      dispatchDecisionNeeded: restartDecision,
      now: () => 3_000,
    };
    await reconcileCodexRelays(restartOptions);
    await reconcileCodexRelays(restartOptions);
    expect(dispatchTerminal).not.toHaveBeenCalled();
    expect(restartDecision).toHaveBeenCalledTimes(1);
    expect(restartDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("volatile heartbeat"),
    );
  });

  it("does not resend after a crash following the durable decision preclaim", async () => {
    const { registry } = await acceptedRegistry();
    await expect(registry.claimDecisionDelivery("delegation-1")).resolves.toMatchObject({
      lifecycle: "delivery-started",
      deliveryKind: "decision",
    });
    const inspectTurn = vi.fn();
    const dispatchTerminal = vi.fn();
    const dispatchDecisionNeeded = vi.fn();

    await expect(
      reconcileCodexRelays({
        registry,
        inspectTurn,
        dispatchTerminal,
        dispatchDecisionNeeded,
        now: () => 2_000,
      }),
    ).resolves.toMatchObject({ inspected: 0, decisionNeeded: 0, skipped: 1 });
    expect(inspectTurn).not.toHaveBeenCalled();
    expect(dispatchTerminal).not.toHaveBeenCalled();
    expect(dispatchDecisionNeeded).not.toHaveBeenCalled();
  });

  it("does not resend after decision delivery completed before its final mark", async () => {
    const { registry } = await acceptedRegistry();
    await registry.claimDecisionDelivery("delegation-1");
    // agent.wait completed in the old process, but it crashed before
    // markDecisionNeeded could persist the final completion timestamp.
    await registry.markJarvisRunAccepted("delegation-1", "jarvis-decision-run", "decision");
    const inspectTurn = vi.fn();
    const dispatchTerminal = vi.fn();
    const dispatchDecisionNeeded = vi.fn();

    await reconcileCodexRelays({
      registry,
      inspectTurn,
      dispatchTerminal,
      dispatchDecisionNeeded,
      now: () => 2_000,
    });
    expect(inspectTurn).not.toHaveBeenCalled();
    expect(dispatchTerminal).not.toHaveBeenCalled();
    expect(dispatchDecisionNeeded).not.toHaveBeenCalled();
    const record = await registry.get("delegation-1");
    if (!record) {
      throw new Error("expected the preclaimed decision record to remain persisted");
    }
    expect(record).toMatchObject({
      lifecycle: "delivery-started",
      deliveryKind: "decision",
      lastJarvisRunId: "jarvis-decision-run",
    });
    expect(record.decisionNeededAtMs).toBeUndefined();
  });

  it("claims a queued decision once across duplicate startup reconciliation", async () => {
    const { registry } = await acceptedRegistry();
    const inspectTurn = vi.fn(async () => ({
      kind: "nonterminal" as const,
      threadId: "thread-1",
      turnId: "turn-1",
      status: "inProgress",
    }));
    const dispatchDecisionNeeded = vi.fn(async () => "queued" as const);
    const options = {
      registry,
      inspectTurn,
      dispatchTerminal: vi.fn(),
      dispatchDecisionNeeded,
      now: () => 2_000,
    };

    await expect(reconcileCodexRelays(options)).resolves.toMatchObject({ skipped: 1 });
    await expect(reconcileCodexRelays(options)).resolves.toMatchObject({ skipped: 1 });
    expect(inspectTurn).toHaveBeenCalledTimes(1);
    expect(dispatchDecisionNeeded).toHaveBeenCalledTimes(1);
    await expect(registry.get("delegation-1")).resolves.toMatchObject({
      lifecycle: "delivery-started",
      deliveryKind: "decision",
    });
  });

  it("contains an earlier decision dispatch failure and delivers a later terminal record", async () => {
    const { registry } = await acceptedRegistry();
    await addAcceptedRelay(registry, {
      delegationId: "delegation-2",
      threadId: "thread-2",
      turnId: "turn-2",
    });
    const inspectTurn = vi.fn(async (_threadId: string, turnId: string) =>
      turnId === "turn-1"
        ? {
            kind: "nonterminal" as const,
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
          }
        : {
            kind: "completed" as const,
            threadId: "thread-2",
            turnId: "turn-2",
            finalText: "Later exact terminal result.",
          },
    );
    const dispatchDecisionNeeded = vi.fn(async (record: CodexRelayRecord) => {
      throw new Error(`decision dispatch failed for ${record.delegationId}`);
    });
    const dispatchTerminal = vi.fn(async () => "completed" as const);
    const onRecordError = vi.fn();

    await expect(
      reconcileCodexRelays({
        registry,
        inspectTurn,
        dispatchTerminal,
        dispatchDecisionNeeded,
        onRecordError,
        now: () => 2_000,
      }),
    ).resolves.toMatchObject({ failed: 1, delivered: 1 });
    expect(onRecordError).toHaveBeenCalledWith(
      expect.objectContaining({ delegationId: "delegation-1" }),
      expect.objectContaining({ message: expect.stringContaining("decision dispatch failed") }),
    );
    expect(dispatchTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ delegationId: "delegation-2" }),
      "Later exact terminal result.",
    );
    await expect(registry.get("delegation-1")).resolves.toMatchObject({
      lifecycle: "delivery-started",
      deliveryKind: "decision",
    });
    await expect(registry.get("delegation-2")).resolves.toMatchObject({
      lifecycle: "delivered",
    });
  });

  it("contains an earlier terminal dispatch failure and reports a later decision record", async () => {
    const { registry } = await acceptedRegistry();
    await addAcceptedRelay(registry, {
      delegationId: "delegation-2",
      threadId: "thread-2",
      turnId: "turn-2",
    });
    const inspectTurn = vi.fn(async (_threadId: string, turnId: string) =>
      turnId === "turn-1"
        ? {
            kind: "completed" as const,
            threadId: "thread-1",
            turnId: "turn-1",
            finalText: "First result cannot dispatch.",
          }
        : {
            kind: "nonterminal" as const,
            threadId: "thread-2",
            turnId: "turn-2",
            status: "inProgress",
          },
    );
    const dispatchTerminal = vi.fn(async () => {
      throw new Error("terminal dispatch failed");
    });
    const dispatchDecisionNeeded = vi.fn(async () => "completed" as const);
    const onRecordError = vi.fn();

    await expect(
      reconcileCodexRelays({
        registry,
        inspectTurn,
        dispatchTerminal,
        dispatchDecisionNeeded,
        onRecordError,
        now: () => 2_000,
      }),
    ).resolves.toMatchObject({ failed: 1, decisionNeeded: 1 });
    expect(onRecordError).toHaveBeenCalledWith(
      expect.objectContaining({ delegationId: "delegation-1" }),
      expect.objectContaining({ message: "terminal dispatch failed" }),
    );
    expect(dispatchDecisionNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ delegationId: "delegation-2" }),
      expect.stringContaining("cannot prove it owns"),
    );
    await expect(registry.get("delegation-1")).resolves.toMatchObject({
      lifecycle: "delivery-started",
      deliveryKind: "terminal",
    });
    await expect(registry.get("delegation-2")).resolves.toMatchObject({
      lifecycle: "decision-needed",
      deliveryKind: "decision",
    });
  });

  it("keeps stale classification decision-only when diagnostic writes and dispatch fail", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-relay-stale-clock-"));
    let clock = 0;
    const registry = new CodexDelegationRegistry(
      path.join(directory, "async-relays.json"),
      () => clock,
    );
    await registry.createStarting({
      delegationId: "delegation-stale",
      sessionKey: "agent:main:telegram:direct:owner",
      threadId: "thread-stale",
      deliveryKey: "codex-relay:delegation-stale",
    });
    await registry.markAccepted("delegation-stale", "turn-stale");
    clock = CODEX_RELAY_MAX_RECONCILE_AGE_MS + 1;
    await registry.markJarvisRunAccepted("delegation-stale", "diagnostic-run", "callback");
    await registry.markHeartbeatQueued("delegation-stale");
    await expect(registry.get("delegation-stale")).resolves.toMatchObject({
      lifecycle: "accepted",
      updatedAtMs: 0,
      jarvisRunAcceptedAtMs: clock,
      heartbeatQueuedAtMs: clock,
    });

    const inspectTurn = vi.fn();
    const failedDecision = vi.fn(async () => {
      throw new Error("decision dispatch failed");
    });
    const onRecordError = vi.fn();
    await expect(
      reconcileCodexRelays({
        registry,
        inspectTurn,
        dispatchTerminal: vi.fn(),
        dispatchDecisionNeeded: failedDecision,
        onRecordError,
        now: () => clock,
      }),
    ).resolves.toMatchObject({ failed: 1 });
    expect(onRecordError).toHaveBeenCalledWith(
      expect.objectContaining({ delegationId: "delegation-stale" }),
      expect.objectContaining({ message: "decision dispatch failed" }),
    );
    await expect(registry.get("delegation-stale")).resolves.toMatchObject({
      lifecycle: "delivery-started",
      deliveryKind: "decision",
    });

    const laterInspection = vi.fn(async () => ({
      kind: "completed" as const,
      threadId: "thread-stale",
      turnId: "turn-stale",
      finalText: "Late native completion must not be relayed.",
    }));
    const laterDecision = vi.fn();
    await reconcileCodexRelays({
      registry,
      inspectTurn: laterInspection,
      dispatchTerminal: vi.fn(),
      dispatchDecisionNeeded: laterDecision,
      now: () => clock + 1,
    });
    expect(inspectTurn).not.toHaveBeenCalled();
    expect(laterInspection).not.toHaveBeenCalled();
    expect(failedDecision).toHaveBeenCalledTimes(1);
    expect(laterDecision).not.toHaveBeenCalled();
  });

  it("fails closed for stale and malformed registry entries", async () => {
    const stale = await acceptedRegistry(0);
    const staleDecision = vi.fn(async () => "completed" as const);
    const inspectTurn = vi.fn();
    await reconcileCodexRelays({
      registry: stale.registry,
      inspectTurn,
      dispatchTerminal: vi.fn(),
      dispatchDecisionNeeded: staleDecision,
      now: () => CODEX_RELAY_MAX_RECONCILE_AGE_MS + 1,
    });
    expect(inspectTurn).not.toHaveBeenCalled();
    expect(staleDecision).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("stale"));

    const malformedDir = await mkdtemp(path.join(os.tmpdir(), "codex-relay-malformed-"));
    const malformedPath = path.join(malformedDir, "async-relays.json");
    await writeFile(
      malformedPath,
      JSON.stringify({ version: 1, records: [{ delegationId: "incomplete" }] }),
      { mode: 0o600 },
    );
    const malformed = new CodexDelegationRegistry(malformedPath);
    const onMalformedEntry = vi.fn();
    await expect(
      reconcileCodexRelays({
        registry: malformed,
        inspectTurn,
        dispatchTerminal: vi.fn(),
        dispatchDecisionNeeded: vi.fn(),
        onMalformedEntry,
      }),
    ).resolves.toMatchObject({ malformed: 1, inspected: 0 });
    expect(onMalformedEntry).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, reason: expect.stringContaining("sessionKey") }),
    );
  });
});
