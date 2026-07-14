import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../../test-utils/env.js";
import { resolveSessionRunActive } from "../get-reply-run.js";
import { resolveActiveRunQueueAction } from "../queue-policy.js";
import { persistDurableFollowup, scheduleDurableFollowupRetries } from "./durable-store.js";
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
});
