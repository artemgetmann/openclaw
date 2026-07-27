import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRestartSentinel } from "../../../infra/restart-sentinel.js";
import { captureEnv } from "../../../test-utils/env.js";
import { resolveSessionRunActive } from "../get-reply-run.js";
import { resolveActiveRunQueueAction } from "../queue-policy.js";
import { clearFollowupDrainCallback, scheduleFollowupDrain } from "./drain.js";
import {
  loadDurableFollowups,
  persistDurableFollowup,
  scheduleDurableFollowupRetries,
} from "./durable-store.js";
import { enqueueFollowupRunDurable, restoreDurableFollowupRuns } from "./enqueue.js";
import { clearFollowupQueue, FOLLOWUP_QUEUES, hasFollowupQueueOwnership } from "./state.js";
import type { FollowupRun, QueueSettings } from "./types.js";

const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 20 };

function createRun(prompt: string, messageId: string): FollowupRun {
  return {
    prompt,
    messageId,
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "startup-session",
      sessionKey: "agent:main:telegram:dm:startup",
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

describe("startup durable queue ownership", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let stateDir: string;
  let queueKey: string;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-startup-ownership-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    queueKey = `startup-${Date.now()}`;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
  });

  afterEach(async () => {
    clearFollowupDrainCallback(queueKey);
    clearFollowupQueue(queueKey);
    FOLLOWUP_QUEUES.delete(queueKey);
    vi.useRealTimers();
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("arms restored ownership before accepting newer same-session work without awaiting the model", async () => {
    const restored = await persistDurableFollowup({
      queueKey,
      run: createRun("restored first", "telegram:old"),
      settings,
    });
    await scheduleDurableFollowupRetries({ ids: [restored.id], now: Date.now() });
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const runFollowup = vi.fn(async () => modelGate);

    // Startup waits for disk scan + queue arming only. The unresolved provider
    // turn must not hold channel startup hostage.
    await expect(restoreDurableFollowupRuns({ runFollowup })).resolves.toBe(1);
    expect(runFollowup).not.toHaveBeenCalled();

    const queueOwned = hasFollowupQueueOwnership(queueKey);
    const isActive = resolveSessionRunActive({ embeddedRunActive: false, queueOwned });
    expect(isActive).toBe(true);
    expect(
      resolveActiveRunQueueAction({
        isActive,
        isHeartbeat: false,
        // Queue ownership, not the current per-message mode, is the ordering
        // reason this newer turn must become a followup.
        shouldFollowup: queueOwned,
        queueMode: "queue",
      }),
    ).toBe("enqueue-followup");

    await expect(
      enqueueFollowupRunDurable(queueKey, createRun("newer inbound", "telegram:new"), settings),
    ).resolves.toBe(true);
    expect(FOLLOWUP_QUEUES.get(queueKey)?.items.map((item) => item.prompt)).toEqual([
      "restored first",
      "newer inbound",
    ]);
    expect(runFollowup).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runFollowup).toHaveBeenCalledTimes(1);
    releaseModel();
    await vi.waitFor(() => expect(runFollowup).toHaveBeenCalledTimes(2), {
      interval: 1,
      timeout: 100,
    });
  });

  it("treats post-model finalization ownership as an active session turn", () => {
    expect(
      resolveSessionRunActive({
        embeddedRunActive: false,
        queueOwned: false,
        finalizationOwned: true,
      }),
    ).toBe(true);
  });

  it("restores an active durable followup exactly once after an external restart", async () => {
    await expect(
      enqueueFollowupRunDurable(
        queueKey,
        createRun("finish the accepted task", "telegram:active"),
        settings,
      ),
    ).resolves.toBe(true);

    let markOriginalRunStarted!: () => void;
    const originalRunStarted = new Promise<void>((resolve) => {
      markOriginalRunStarted = resolve;
    });
    const originalRun = vi.fn(async () => {
      markOriginalRunStarted();
      // This promise deliberately never resolves. It models SIGTERM arriving
      // while the old process owns the item and is inside model/tool work.
      await new Promise<void>(() => {});
    });
    scheduleFollowupDrain(queueKey, originalRun);
    await originalRunStarted;

    expect(originalRun).toHaveBeenCalledTimes(1);
    expect(FOLLOWUP_QUEUES.get(queueKey)?.draining).toBe(true);
    await expect(loadDurableFollowups()).resolves.toHaveLength(1);
    // The incident restart came from the macOS service reconciler, not the
    // gateway restart tool. Recovery must not depend on a prepared sentinel.
    await expect(readRestartSentinel()).resolves.toBeNull();

    // Simulate the process boundary without calling explicit queue cleanup:
    // cleanup is user cancellation and intentionally deletes durable intent.
    FOLLOWUP_QUEUES.delete(queueKey);
    clearFollowupDrainCallback(queueKey);

    let markRecoveredRunStarted!: () => void;
    let finishRecoveredRun!: () => void;
    const recoveredRunStarted = new Promise<void>((resolve) => {
      markRecoveredRunStarted = resolve;
    });
    const recoveredRunGate = new Promise<void>((resolve) => {
      finishRecoveredRun = resolve;
    });
    const recoveredRun = vi.fn(async (run: FollowupRun) => {
      expect(run.prompt).toBe("finish the accepted task");
      markRecoveredRunStarted();
      await recoveredRunGate;
    });

    // Startup restores and arms the queue without awaiting task completion.
    // At this point the gateway may report that it is back online, but that
    // service receipt is not proof that the accepted user task has finished.
    await expect(restoreDurableFollowupRuns({ runFollowup: recoveredRun })).resolves.toBe(1);
    await recoveredRunStarted;
    expect(recoveredRun).toHaveBeenCalledTimes(1);
    await expect(loadDurableFollowups()).resolves.toHaveLength(1);

    finishRecoveredRun();
    await vi.waitFor(() => expect(FOLLOWUP_QUEUES.has(queueKey)).toBe(false), {
      interval: 1,
      timeout: 100,
    });
    await expect(loadDurableFollowups()).resolves.toHaveLength(0);

    // A later startup scan must observe the durable completion and avoid a
    // duplicate model/tool turn or second user-facing delivery.
    await expect(restoreDurableFollowupRuns({ runFollowup: recoveredRun })).resolves.toBe(0);
    expect(recoveredRun).toHaveBeenCalledTimes(1);
  });
});
