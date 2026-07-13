import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../../test-utils/env.js";
import { retainSummarizedDurableFollowups, scheduleFollowupDrain } from "./drain.js";
import {
  DURABLE_FOLLOWUP_RETRY_MAX_MS,
  hydrateDurableFollowup,
  loadDurableFollowups,
  persistDurableFollowup,
  scheduleDurableFollowupRetries,
} from "./durable-store.js";
import { enqueueFollowupRun, restoreDurableFollowupRuns } from "./enqueue.js";
import { clearFollowupQueue, FOLLOWUP_QUEUES } from "./state.js";
import type { FollowupRun, QueueSettings } from "./types.js";

const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 20 };

function createRun(params?: { prompt?: string; messageId?: string }): FollowupRun {
  return {
    prompt: params?.prompt ?? "retry me",
    messageId: params?.messageId ?? "telegram:retry",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "retry-session",
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

describe("durable followup retry backoff", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let stateDir: string;
  let key: string;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-followup-retry-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    key = `retry-${Date.now()}`;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
  });

  afterEach(async () => {
    clearFollowupQueue(key);
    FOLLOWUP_QUEUES.delete(key);
    vi.useRealTimers();
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("delays the first retry instead of hot-looping when debounce is zero", async () => {
    const failedAt = Date.now();
    const record = await persistDurableFollowup({ queueKey: key, run: createRun(), settings });
    enqueueFollowupRun(key, hydrateDurableFollowup(record, {}), settings, "none");
    const runFollowup = vi
      .fn<(run: FollowupRun) => Promise<void>>()
      .mockRejectedValueOnce(new Error("provider failed"))
      .mockResolvedValue(undefined);

    scheduleFollowupDrain(key, runFollowup);
    await vi.advanceTimersByTimeAsync(0);
    // Staged-head discovery now performs an async durable-store read before
    // ordinary processing. Wait for that I/O boundary instead of assuming the
    // first callback is reachable in a single timer microtask.
    await vi.waitFor(() => expect(runFollowup).toHaveBeenCalledTimes(1));
    let failed = (await loadDurableFollowups())[0];
    await vi.waitFor(
      async () => {
        failed = (await loadDurableFollowups())[0];
        expect(failed?.retryCount).toBe(1);
      },
      { interval: 1, timeout: 100 },
    );
    // `vi.waitFor` advances fake time while the new durable read settles. The
    // retry delay is still measured from the actual failure boundary, so prove
    // the full one-second floor without coupling to that test-poll interval.
    expect((failed?.nextAttemptAt ?? failedAt) - failedAt).toBeGreaterThanOrEqual(1_000);

    const remainingMs = (failed?.nextAttemptAt ?? Date.now()) - Date.now();
    await vi.advanceTimersByTimeAsync(remainingMs - 1);
    expect(runFollowup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(runFollowup).toHaveBeenCalledTimes(2));
  });

  it("grows retry delay exponentially and caps it", async () => {
    let record = await persistDurableFollowup({ queueKey: key, run: createRun(), settings });
    const delays: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const now = Date.now();
      const result = await scheduleDurableFollowupRetries({ ids: [record.id], now });
      const update = result.scheduled[0];
      expect(update).toBeDefined();
      delays.push((update?.nextAttemptAt ?? now) - now);
      vi.setSystemTime(update?.nextAttemptAt ?? now);
      record = (await loadDurableFollowups())[0]!;
    }
    expect(delays.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(delays.at(-1)).toBe(DURABLE_FOLLOWUP_RETRY_MAX_MS);
    expect(Math.max(...delays)).toBe(DURABLE_FOLLOWUP_RETRY_MAX_MS);
  });

  it("honors nextAttemptAt after restart without awaiting model completion at restore", async () => {
    const now = Date.now();
    const record = await persistDurableFollowup({ queueKey: key, run: createRun(), settings });
    await scheduleDurableFollowupRetries({ ids: [record.id], now });
    FOLLOWUP_QUEUES.delete(key);
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const runFollowup = vi.fn<(run: FollowupRun) => Promise<void>>(async () => modelGate);

    await expect(restoreDurableFollowupRuns({ runFollowup })).resolves.toBe(1);
    expect(runFollowup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(runFollowup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(runFollowup).toHaveBeenCalledTimes(1));
    releaseModel();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("treats TTL and cancellation as terminal while a retry sleeps", async () => {
    const summarySettings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const expiring = await persistDurableFollowup({
      queueKey: key,
      run: createRun(),
      settings: summarySettings,
      ttlMs: 500,
    });
    const expiringCarrier = await persistDurableFollowup({
      queueKey: key,
      run: { ...createRun(), messageId: "telegram:retry-carrier" },
      settings: summarySettings,
      ttlMs: 500,
    });
    enqueueFollowupRun(key, hydrateDurableFollowup(expiring, {}), summarySettings, "none");
    enqueueFollowupRun(key, hydrateDurableFollowup(expiringCarrier, {}), summarySettings, "none");
    retainSummarizedDurableFollowups(
      FOLLOWUP_QUEUES.get(key)!,
      [expiring.id],
      new Map([[expiring.id, expiring.expiresAt]]),
    );
    const runFollowup = vi.fn(async () => undefined);
    const queue = FOLLOWUP_QUEUES.get(key)!;
    queue.nextAttemptAt = expiringCarrier.expiresAt;
    scheduleFollowupDrain(key, runFollowup);
    await vi.advanceTimersByTimeAsync(500);
    expect(runFollowup).not.toHaveBeenCalled();
    await expect(loadDurableFollowups()).resolves.toEqual([]);

    const cancelled = await persistDurableFollowup({
      queueKey: key,
      run: createRun(),
      settings: summarySettings,
    });
    const cancelledCarrier = await persistDurableFollowup({
      queueKey: key,
      run: { ...createRun(), messageId: "telegram:cancel-carrier" },
      settings: summarySettings,
    });
    enqueueFollowupRun(key, hydrateDurableFollowup(cancelled, {}), summarySettings, "none");
    enqueueFollowupRun(key, hydrateDurableFollowup(cancelledCarrier, {}), summarySettings, "none");
    retainSummarizedDurableFollowups(
      FOLLOWUP_QUEUES.get(key)!,
      [cancelled.id],
      new Map([[cancelled.id, cancelled.expiresAt]]),
    );
    FOLLOWUP_QUEUES.get(key)!.nextAttemptAt = Date.now() + 1_000;
    scheduleFollowupDrain(key, runFollowup);
    clearFollowupQueue(key);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runFollowup).not.toHaveBeenCalled();
    await expect(loadDurableFollowups()).resolves.toEqual([]);
  });

  it("removes only expired durable content from a partial overflow summary", async () => {
    const summarySettings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 3,
      dropPolicy: "summarize",
    };
    enqueueFollowupRun(
      key,
      createRun({ prompt: "process-local summary", messageId: "telegram:process-local" }),
      summarySettings,
      "none",
    );
    const expired = await persistDurableFollowup({
      queueKey: key,
      run: createRun({
        prompt: "shared summary text expired-only",
        messageId: "telegram:expired-summary",
      }),
      settings: summarySettings,
      ttlMs: 500,
    });
    const live = await persistDurableFollowup({
      queueKey: key,
      run: createRun({
        prompt: "shared summary text live-only",
        messageId: "telegram:live-summary",
      }),
      settings: summarySettings,
      ttlMs: 2_000,
    });
    const carrierOne = await persistDurableFollowup({
      queueKey: key,
      run: createRun({ prompt: "carrier one", messageId: "telegram:carrier-one" }),
      settings: summarySettings,
      ttlMs: 2_000,
    });
    const carrierTwo = await persistDurableFollowup({
      queueKey: key,
      run: createRun({ prompt: "carrier two", messageId: "telegram:carrier-two" }),
      settings: summarySettings,
      ttlMs: 2_000,
    });
    const carrierThree = await persistDurableFollowup({
      queueKey: key,
      run: createRun({ prompt: "carrier three", messageId: "telegram:carrier-three" }),
      settings: summarySettings,
      ttlMs: 2_000,
    });
    for (const record of [expired, live, carrierOne, carrierTwo, carrierThree]) {
      enqueueFollowupRun(key, hydrateDurableFollowup(record, {}), summarySettings, "none");
    }
    const queue = FOLLOWUP_QUEUES.get(key)!;
    queue.nextAttemptAt = expired.expiresAt;
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const runFollowup = vi.fn<(run: FollowupRun) => Promise<void>>(async () => modelGate);

    scheduleFollowupDrain(key, runFollowup);
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(runFollowup).toHaveBeenCalledTimes(1));
    const prompt = runFollowup.mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).not.toContain("expired-only");
    expect(prompt).toContain("process-local summary");
    expect(prompt).toContain("shared summary text live-only");
    expect(prompt.indexOf("process-local summary")).toBeLessThan(
      prompt.indexOf("shared summary text live-only"),
    );
    expect(prompt.indexOf("shared summary text live-only")).toBeLessThan(
      prompt.indexOf("carrier one"),
    );
    expect(prompt.indexOf("carrier one")).toBeLessThan(prompt.indexOf("carrier two"));
    expect(prompt.indexOf("carrier two")).toBeLessThan(prompt.indexOf("carrier three"));
    expect((await loadDurableFollowups()).map((record) => record.id)).toContain(live.id);

    releaseModel();
    await vi.waitFor(async () => expect(await loadDurableFollowups()).toEqual([]), {
      interval: 1,
      timeout: 100,
    });
  });
});
