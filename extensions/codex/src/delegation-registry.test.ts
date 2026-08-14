import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexDelegationRegistry } from "./delegation-registry.js";

async function createRegistry(now: () => number = () => 1_000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-relay-registry-"));
  const filePath = path.join(directory, "codex", "async-relays.json");
  return {
    filePath,
    registry: new CodexDelegationRegistry(filePath, now),
  };
}

describe("CodexDelegationRegistry", () => {
  it("keeps the exact accepted task for one interrupted recovery and clears it afterward", async () => {
    const { registry } = await createRegistry();
    await registry.createStarting({
      delegationId: "delegation-recovery-task",
      sessionKey: "agent:main",
      threadId: "thread-recovery-task",
      deliveryKey: "codex-relay:delegation-recovery-task",
      recoveryPolicy: "local-safe",
      taskPayload: "Inspect only fixture alpha and report its exact result.",
    });
    await registry.markAccepted("delegation-recovery-task", "turn-recovery-task");
    await registry.authorizeRecovery({
      delegationId: "delegation-recovery-task",
      threadId: "thread-recovery-task",
      turnId: "turn-recovery-task",
      policy: "local-safe",
      guidance: "Also verify fixture beta before reporting.",
    });
    await expect(registry.get("delegation-recovery-task")).resolves.toMatchObject({
      taskPayload: expect.stringContaining("Also verify fixture beta before reporting."),
    });
    await registry.markTerminal("delegation-recovery-task", "interrupted");
    await registry.claimRecovery("delegation-recovery-task", "recovery-child");
    await registry.markRecovered("delegation-recovery-task");
    expect((await registry.get("delegation-recovery-task"))?.taskPayload).toBeUndefined();
  });

  it("refuses a recovery grant when the exact original task was not durable", async () => {
    const { registry } = await createRegistry();
    await registry.createStarting({
      delegationId: "delegation-legacy",
      sessionKey: "agent:main",
      threadId: "thread-legacy",
      deliveryKey: "codex-relay:delegation-legacy",
    });
    await registry.markAccepted("delegation-legacy", "turn-legacy");
    await expect(
      registry.authorizeRecovery({
        delegationId: "delegation-legacy",
        threadId: "thread-legacy",
        turnId: "turn-legacy",
        policy: "local-safe",
        guidance: "Continue safely.",
      }),
    ).rejects.toThrow("without the original task payload");
  });

  it("claims one overdue progress update without consuming terminal authority", async () => {
    const { registry } = await createRegistry();
    await registry.createStarting({
      delegationId: "delegation-overdue",
      sessionKey: "agent:main:telegram:direct:owner",
      threadId: "thread-overdue",
      deliveryKey: "codex-relay:delegation-overdue",
    });
    await registry.markAccepted("delegation-overdue", "turn-overdue");

    await expect(registry.claimOverdueProgress("delegation-overdue")).resolves.toMatchObject({
      lifecycle: "accepted",
      overdueProgressStartedAtMs: expect.any(Number),
    });
    await expect(registry.claimOverdueProgress("delegation-overdue")).resolves.toBeUndefined();
    await registry.markOverdueProgressDelivered("delegation-overdue");
    await expect(registry.markTerminal("delegation-overdue", "completed")).resolves.toMatchObject({
      lifecycle: "terminal",
      terminalStatus: "completed",
      overdueProgressDeliveredAtMs: expect.any(Number),
    });
  });

  it("suppresses overdue progress without consuming restart decision authority", async () => {
    const { registry } = await createRegistry();
    await registry.createStarting({
      delegationId: "delegation-cleanup-failure",
      sessionKey: "agent:main:telegram:direct:owner",
      threadId: "thread-cleanup-failure",
      deliveryKey: "codex-relay:delegation-cleanup-failure",
    });
    await registry.markAccepted("delegation-cleanup-failure", "turn-cleanup-failure");

    await registry.suppressOverdueProgress("delegation-cleanup-failure");
    await expect(
      registry.claimOverdueProgress("delegation-cleanup-failure"),
    ).resolves.toBeUndefined();
    const suppressed = await registry.get("delegation-cleanup-failure");
    expect(suppressed).toMatchObject({
      lifecycle: "accepted",
      overdueProgressSuppressedAtMs: expect.any(Number),
    });
    // Optional persisted fields are omitted, not serialized as explicit
    // undefined values. Assert the semantic state directly instead of making
    // toMatchObject require a deliveryKind property to exist.
    expect(suppressed?.deliveryKind).toBeUndefined();

    // Simulate restart reconciliation after callback-route cleanup failed:
    // decision delivery remains unclaimed and therefore available exactly once.
    await expect(
      registry.claimDecisionDelivery("delegation-cleanup-failure"),
    ).resolves.toMatchObject({
      lifecycle: "delivery-started",
      deliveryKind: "decision",
    });
  });

  it("atomically persists exact accepted identity with owner-only permissions", async () => {
    let now = 1_000;
    const { filePath, registry } = await createRegistry(() => now++);

    await registry.createStarting({
      delegationId: "delegation-1",
      sessionKey: "agent:main:telegram:direct:owner",
      agentId: "main",
      threadId: "thread-1",
      deliveryKey: "codex-relay:delegation-1",
    });
    await registry.markAccepted("delegation-1", "turn-1");

    const stored = await registry.get("delegation-1");
    expect(stored).toMatchObject({
      delegationId: "delegation-1",
      sessionKey: "agent:main:telegram:direct:owner",
      agentId: "main",
      threadId: "thread-1",
      turnId: "turn-1",
      lifecycle: "accepted",
      deliveryKey: "codex-relay:delegation-1",
      createdAtMs: 1_000,
      acceptedAtMs: 1_001,
    });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      version: 1,
      records: [{ delegationId: "delegation-1", turnId: "turn-1" }],
    });
  });

  it("claims terminal delivery once and records its durable completion", async () => {
    const { registry } = await createRegistry();
    await registry.createStarting({
      delegationId: "delegation-1",
      sessionKey: "agent:main",
      threadId: "thread-1",
      deliveryKey: "codex-relay:delegation-1",
    });
    await registry.markAccepted("delegation-1", "turn-1");
    await registry.markTerminal("delegation-1", "completed");

    await expect(registry.claimTerminalDelivery("delegation-1")).resolves.toMatchObject({
      lifecycle: "delivery-started",
    });
    await expect(registry.claimTerminalDelivery("delegation-1")).resolves.toBeUndefined();
    await registry.markDelivered("delegation-1");
    await expect(registry.get("delegation-1")).resolves.toMatchObject({
      lifecycle: "delivered",
    });
  });

  it("persists spawn and heartbeat evidence without falsely finalizing delivery", async () => {
    let now = 1_000;
    const { registry } = await createRegistry(() => now++);
    await registry.createStarting({
      delegationId: "delegation-1",
      sessionKey: "agent:main",
      threadId: "thread-1",
      deliveryKey: "codex-relay:delegation-1",
    });
    await registry.markAccepted("delegation-1", "turn-1");
    await registry.markTerminal("delegation-1", "completed");
    await registry.claimTerminalDelivery("delegation-1");

    await registry.markHeartbeatQueued("delegation-1");
    const heartbeatRecord = await registry.get("delegation-1");
    if (!heartbeatRecord) {
      throw new Error("expected the queued-heartbeat record to remain persisted");
    }
    expect(heartbeatRecord).toMatchObject({
      lifecycle: "delivery-started",
      heartbeatQueuedAtMs: 1_004,
      updatedAtMs: 1_003,
    });
    expect(heartbeatRecord.deliveredAtMs).toBeUndefined();
    expect(heartbeatRecord.decisionNeededAtMs).toBeUndefined();

    await registry.markJarvisRunAccepted("delegation-1", "jarvis-run-1", "terminal");
    const acceptedRecord = await registry.get("delegation-1");
    if (!acceptedRecord) {
      throw new Error("expected the accepted Jarvis-run record to remain persisted");
    }
    expect(acceptedRecord).toMatchObject({
      lifecycle: "delivery-started",
      lastJarvisRunId: "jarvis-run-1",
      lastJarvisRunPurpose: "terminal",
      jarvisRunAcceptedAtMs: 1_005,
      updatedAtMs: 1_003,
    });
    expect(acceptedRecord.heartbeatQueuedAtMs).toBeUndefined();
    expect(acceptedRecord.deliveredAtMs).toBeUndefined();
    expect(acceptedRecord.decisionNeededAtMs).toBeUndefined();
  });

  it("atomically claims an irreversible decision-only dispatch once", async () => {
    const { registry } = await createRegistry();
    await registry.createStarting({
      delegationId: "delegation-1",
      sessionKey: "agent:main",
      threadId: "thread-1",
      deliveryKey: "codex-relay:delegation-1",
    });

    await expect(registry.claimDecisionDelivery("delegation-1")).resolves.toMatchObject({
      lifecycle: "delivery-started",
      deliveryKind: "decision",
      deliveryStartedAtMs: 1_000,
    });
    await expect(registry.claimDecisionDelivery("delegation-1")).resolves.toBeUndefined();
    await expect(registry.markDelivered("delegation-1")).rejects.toThrow(
      "cannot transition from delivery-started to delivered",
    );
    await registry.markDecisionNeeded("delegation-1");
    await expect(registry.get("delegation-1")).resolves.toMatchObject({
      lifecycle: "decision-needed",
      deliveryKind: "decision",
      decisionNeededAtMs: 1_000,
    });
  });

  it("preserves malformed entries by refusing later mutations", async () => {
    const { filePath, registry } = await createRegistry();
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        records: [{ delegationId: "broken-without-routing-identity" }],
      }),
      { mode: 0o600 },
    );

    await expect(registry.snapshot()).resolves.toMatchObject({
      records: [],
      issues: [{ index: 0, reason: expect.stringContaining("sessionKey") }],
    });
    await expect(
      registry.createStarting({
        delegationId: "delegation-2",
        sessionKey: "agent:main",
        threadId: "thread-2",
        deliveryKey: "codex-relay:delegation-2",
      }),
    ).rejects.toThrow("refusing to overwrite");
    expect(JSON.parse(await readFile(filePath, "utf8")).records).toEqual([
      { delegationId: "broken-without-routing-identity" },
    ]);
  });

  it("rejects an oversized mutation without replacing the readable registry", async () => {
    const { filePath, registry } = await createRegistry();
    const taskPayload = "x".repeat(32_768);
    let acceptedRecords = 0;

    // Fill with valid active recovery records until the next atomic document
    // would exceed the reader's one-MiB ceiling.
    for (let index = 0; index < 40; index += 1) {
      try {
        await registry.createStarting({
          delegationId: `delegation-large-${index}`,
          sessionKey: "agent:main",
          threadId: `thread-large-${index}`,
          deliveryKey: `codex-relay:delegation-large-${index}`,
          recoveryPolicy: "local-safe",
          taskPayload,
        });
        acceptedRecords += 1;
      } catch (error) {
        expect(error).toMatchObject({ message: expect.stringContaining("exceeds 1048576 bytes") });
        break;
      }
    }

    expect(acceptedRecords).toBeGreaterThan(0);
    expect(acceptedRecords).toBeLessThan(40);
    await expect(registry.snapshot()).resolves.toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({ delegationId: "delegation-large-0" }),
      ]),
      issues: [],
    });
    expect(JSON.parse(await readFile(filePath, "utf8")).records).toHaveLength(acceptedRecords);
  });
});
