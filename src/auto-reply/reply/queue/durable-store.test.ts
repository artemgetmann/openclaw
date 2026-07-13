import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../../test-utils/env.js";

const writeGate = vi.hoisted(() => ({
  afterWrite: undefined as undefined | (() => Promise<void>),
}));

vi.mock("../../../infra/json-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../infra/json-files.js")>();
  return {
    ...actual,
    writeJsonAtomic: async (...args: Parameters<typeof actual.writeJsonAtomic>) => {
      await actual.writeJsonAtomic(...args);
      await writeGate.afterWrite?.();
    },
  };
});

import {
  ackDurableFollowup,
  ackDurableFollowupsForQueueSync,
  cleanupDurableProcessedMessages,
  completeDurableFollowup,
  DurableFollowupCancelledError,
  hydrateDurableFollowup,
  isDurableFollowupMessageProcessed,
  isDurableFollowupRecordProcessed,
  loadDurableFollowupDelivery,
  loadDurableFollowups,
  persistDurableFollowup,
  persistDurableFollowupDelivery,
} from "./durable-store.js";
import type { FollowupRun, QueueSettings } from "./types.js";

const settings: QueueSettings = {
  mode: "followup",
  debounceMs: 0,
  cap: 20,
  dropPolicy: "summarize",
};

function createRun(prompt = "queued while busy"): FollowupRun {
  return {
    prompt,
    messageId: "telegram:101",
    enqueuedAt: Date.now(),
    originatingChannel: "telegram",
    originatingTo: "-100123",
    originatingAccountId: "default",
    originatingThreadId: 42,
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:group:-100123:topic:42",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      config: {},
      provider: "test",
      model: "test",
      timeoutMs: 30_000,
      blockReplyBreak: "message_end",
    },
  };
}

/** Explicit test-only rendezvous; avoids relying on newer Promise helpers. */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = () => resolvePromise();
  });
  return { promise, resolve };
}

describe("durable followup queue", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let stateDir: string;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-followup-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    writeGate.afterWrite = undefined;
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("atomically persists a complete replay record", async () => {
    const key = `durable-success-${Date.now()}`;
    const record = await persistDurableFollowup({ queueKey: key, run: createRun(), settings });
    const loaded = await loadDurableFollowups();
    expect(loaded).toEqual([record]);
    expect(loaded[0]?.run.durableId).toBe(record.id);
  });

  it("never writes config secrets and hydrates replay from current config", async () => {
    const run = createRun();
    run.run.config = { channels: { telegram: { botToken: "super-secret-token" } } };
    const record = await persistDurableFollowup({ queueKey: "sanitized", run, settings });
    const files = await fs.readdir(path.join(stateDir, "followup-queue"));
    const raw = await fs.readFile(path.join(stateDir, "followup-queue", files[0] ?? ""), "utf8");
    expect(raw).not.toContain("super-secret-token");
    expect(raw).not.toContain("botToken");

    const currentConfig = { channels: { telegram: { enabled: true } } };
    expect(hydrateDurableFollowup(record, currentConfig).run.config).toBe(currentConfig);
  });

  it("transitions constituent inputs into one delivery-only carrier", async () => {
    const first = await persistDurableFollowup({
      queueKey: "delivery-stage",
      run: createRun("first input"),
      settings,
    });
    const second = await persistDurableFollowup({
      queueKey: "delivery-stage",
      run: { ...createRun("second input"), messageId: "telegram:102" },
      settings,
    });
    const synthetic = createRun("collected input");
    synthetic.durableIds = [first.id, second.id];
    synthetic.run.config = { channels: { telegram: { botToken: "must-not-persist" } } };

    const delivery = await persistDurableFollowupDelivery({
      run: synthetic,
      payloads: [{ text: "completed model output" }],
    });

    expect(delivery?.delivery?.sourceDurableIds).toEqual([first.id, second.id]);
    expect(delivery?.delivery?.processedMessageKeys).toHaveLength(2);
    await expect(loadDurableFollowups()).resolves.toEqual([delivery]);
    await expect(loadDurableFollowupDelivery([second.id, first.id])).resolves.toEqual(delivery);
    await expect(fs.readdir(path.join(stateDir, "followup-queue"))).resolves.toEqual([
      `${delivery?.id}.json`,
    ]);
    const raw = await fs.readFile(
      path.join(stateDir, "followup-queue", `${delivery?.id}.json`),
      "utf8",
    );
    expect(raw).not.toContain("must-not-persist");
    expect(hydrateDurableFollowup(delivery!, {}).deliveryPayloads).toEqual([
      { text: "completed model output" },
    ]);
    await ackDurableFollowup(delivery?.id);
    await expect(loadDurableFollowups()).resolves.toEqual([]);
  });

  it("matches a staged delivery only to its exact retry batch", async () => {
    const queueKey = "delivery-stage-exact-batch";
    const first = await persistDurableFollowup({
      queueKey,
      run: createRun("first input"),
      settings,
    });
    const second = await persistDurableFollowup({
      queueKey,
      run: { ...createRun("second input"), messageId: "telegram:102" },
      settings,
    });
    const delivery = await persistDurableFollowupDelivery({
      run: { ...createRun("original collected input"), durableIds: [first.id, second.id] },
      payloads: [{ text: "original completed output" }],
    });
    const later = await persistDurableFollowup({
      queueKey,
      run: { ...createRun("later input"), messageId: "telegram:103" },
      settings,
    });

    // The expanded collect wrapper did not produce the staged output and must
    // not use it to acknowledge the later input.
    await expect(
      loadDurableFollowupDelivery([first.id, second.id, later.id]),
    ).resolves.toBeUndefined();

    // The original retry batch still owns its completed output. Draining it
    // leaves the later FIFO input durable for its own subsequent turn.
    await expect(loadDurableFollowupDelivery([second.id, first.id])).resolves.toEqual(delivery);
    await completeDurableFollowup(delivery?.id);
    await expect(loadDurableFollowups()).resolves.toEqual([later]);
  });

  it("repairs partial collect receipts without replaying completed delivery", async () => {
    const queueKey = "partial-processed-receipts";
    const firstRun = createRun("first input");
    const secondRun = { ...createRun("second input"), messageId: "telegram:102" };
    const first = await persistDurableFollowup({ queueKey, run: firstRun, settings });
    const second = await persistDurableFollowup({ queueKey, run: secondRun, settings });
    const delivery = await persistDurableFollowupDelivery({
      run: { ...createRun("collected input"), durableIds: [first.id, second.id] },
      payloads: [{ text: "completed output" }],
    });
    expect(delivery).toBeDefined();

    // Simulate a crash during multi-receipt publication: only the first
    // constituent's hash landed. Recovery must treat that as proof the carrier
    // already drained, repair the second receipt, and never resend the carrier.
    const duplicateFirst = await persistDurableFollowup({ queueKey, run: firstRun, settings });
    await completeDurableFollowup(duplicateFirst.id);
    await expect(isDurableFollowupRecordProcessed(delivery!)).resolves.toBe(true);
    await expect(isDurableFollowupMessageProcessed({ queueKey, run: firstRun })).resolves.toBe(
      true,
    );
    await expect(isDurableFollowupMessageProcessed({ queueKey, run: secondRun })).resolves.toBe(
      true,
    );
    await expect(fs.readdir(path.join(stateDir, "followup-queue-processed"))).resolves.toHaveLength(
      2,
    );
  });

  it("prunes expired processed receipts during startup load", async () => {
    const record = await persistDurableFollowup({
      queueKey: "expired-receipt",
      run: createRun(),
      settings,
    });
    await completeDurableFollowup(record.id);
    const receiptDir = path.join(stateDir, "followup-queue-processed");
    const [receiptName] = await fs.readdir(receiptDir);
    const receiptPath = path.join(receiptDir, receiptName ?? "missing");
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(receiptPath, JSON.stringify({ ...receipt, expiresAt: 1 }));

    await expect(cleanupDurableProcessedMessages(process.env, 2)).resolves.toBeUndefined();
    await expect(fs.readdir(receiptDir)).resolves.toEqual([]);
  });

  it("skips ordinary receipt scans and retries due maintenance failures", async () => {
    const receiptDir = path.join(stateDir, "followup-queue-processed");
    await cleanupDurableProcessedMessages();
    await fs.mkdir(receiptDir, { recursive: true });
    const malformedReceiptPath = path.join(receiptDir, "malformed.json");
    await fs.writeFile(malformedReceiptPath, "not-json");

    const first = await persistDurableFollowup({
      queueKey: "amortized-pruning",
      run: { ...createRun(), messageId: "telegram:prune-0" },
      settings,
    });
    await completeDurableFollowup(first.id);

    // An ordinary success publishes its receipt without parsing the directory.
    await expect(fs.stat(malformedReceiptPath)).resolves.toBeDefined();

    // Seed startup's exact state with an expiry boundary that is due now.
    await fs.rm(malformedReceiptPath);
    const expiredKey = "a".repeat(64);
    await fs.writeFile(
      path.join(receiptDir, `${expiredKey}.json`),
      JSON.stringify({ version: 1, key: expiredKey, processedAt: 0, expiresAt: 1 }),
    );
    await cleanupDurableProcessedMessages(process.env, 0);
    await fs.writeFile(malformedReceiptPath, "not-json");

    const readdir = vi
      .spyOn(fs, "readdir")
      .mockRejectedValueOnce(new Error("simulated maintenance failure"));
    const due = await persistDurableFollowup({
      queueKey: "amortized-pruning",
      run: { ...createRun(), messageId: "telegram:prune-due" },
      settings,
    });
    await completeDurableFollowup(due.id);

    // Maintenance is best effort after the receipts are durable, but the
    // threshold remains armed so the next completion retries the failed scan.
    await expect(fs.stat(malformedReceiptPath)).resolves.toBeDefined();
    expect(readdir).toHaveBeenCalledTimes(1);
    const retry = await persistDurableFollowup({
      queueKey: "amortized-pruning",
      run: {
        ...createRun(),
        messageId: "telegram:prune-retry",
      },
      settings,
    });
    await completeDurableFollowup(retry.id);

    // The bounded retry performs the full TTL/max-size maintenance pass.
    await expect(fs.stat(malformedReceiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(readdir).toHaveBeenCalledTimes(2);
    readdir.mockRestore();
    await expect(fs.readdir(receiptDir)).resolves.toHaveLength(3);
  });

  it("does not route a carrier rewritten after its queue was cancelled", async () => {
    const carrier = await persistDurableFollowup({
      queueKey: "cancelled-delivery-stage",
      run: createRun("input to cancel"),
      settings,
    });
    const enteredDeliveryWrite = createDeferred();
    const resumeDeliveryWrite = createDeferred();
    writeGate.afterWrite = async () => {
      enteredDeliveryWrite.resolve();
      await resumeDeliveryWrite.promise;
    };

    const delivery = persistDurableFollowupDelivery({
      run: { ...createRun("completed input"), durableId: carrier.id },
      payloads: [{ text: "must not be delivered" }],
    });
    await enteredDeliveryWrite.promise;
    // This is the real problematic interleaving: cancellation scans away the
    // old carrier after delivery read it, then delivery resumes and rewrites it.
    ackDurableFollowupsForQueueSync("cancelled-delivery-stage");
    resumeDeliveryWrite.resolve();

    await expect(delivery).rejects.toBeInstanceOf(DurableFollowupCancelledError);
    await expect(loadDurableFollowups()).resolves.toEqual([]);
    await expect(fs.readdir(path.join(stateDir, "followup-queue"))).resolves.toEqual([]);
  });

  it("rejects a failed durable write so callers cannot acknowledge transport input", async () => {
    const notADirectory = path.join(stateDir, "state-file");
    await fs.writeFile(notADirectory, "not a directory");
    process.env.OPENCLAW_STATE_DIR = notADirectory;

    await expect(
      persistDurableFollowup({ queueKey: "failed", run: createRun(), settings }),
    ).rejects.toThrow();
  });

  it("deletes stale records instead of replaying old user intent", async () => {
    await persistDurableFollowup({
      queueKey: "stale",
      settings,
      run: createRun(),
      now: 100,
      ttlMs: 1,
    });

    await expect(loadDurableFollowups({ now: 102 })).resolves.toEqual([]);
    await expect(loadDurableFollowups({ now: 102 })).resolves.toEqual([]);
  });

  it("keeps a record across reloads until the successful drain explicitly acknowledges it", async () => {
    const record = await persistDurableFollowup({
      queueKey: "reload",
      settings,
      run: createRun("survive restart"),
    });

    await expect(loadDurableFollowups()).resolves.toEqual([record]);
    await expect(loadDurableFollowups()).resolves.toEqual([record]);
    await ackDurableFollowup(record.id);
    await expect(loadDurableFollowups()).resolves.toEqual([]);
  });
});
