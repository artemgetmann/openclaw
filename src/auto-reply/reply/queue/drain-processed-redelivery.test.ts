import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../../test-utils/env.js";
import { clearFollowupDrainCallback, scheduleFollowupDrain } from "./drain.js";
import {
  enqueueFollowupRunDurable,
  getFollowupQueueDepth,
  resetRecentQueuedMessageIdDedupe,
} from "./enqueue.js";
import { clearFollowupQueue, FOLLOWUP_QUEUES } from "./state.js";
import type { FollowupRun, QueueSettings } from "./types.js";

const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 20 };

function createRun(messageId: string): FollowupRun {
  return {
    prompt: `queued ${messageId}`,
    messageId,
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

describe("durable drain processed-message redelivery", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let stateDir: string;
  let key: string;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-drain-redelivery-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    key = `drain-redelivery-${Date.now()}`;
  });

  afterEach(async () => {
    clearFollowupQueue(key);
    clearFollowupDrainCallback(key);
    resetRecentQueuedMessageIdDedupe();
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("does not run a drained Telegram message twice after restart redelivery", async () => {
    const runFollowup = vi.fn(async (_run: FollowupRun) => undefined);
    const original = createRun("telegram:101");
    await expect(enqueueFollowupRunDurable(key, original, settings)).resolves.toBe(true);
    scheduleFollowupDrain(key, runFollowup);

    await vi.waitFor(() => {
      expect(runFollowup).toHaveBeenCalledTimes(1);
      expect(getFollowupQueueDepth(key)).toBe(0);
    });

    // Simulate the exact crash boundary: drain and durable completion finished,
    // but Telegram redelivers before its update offset write. Process-global
    // queue, callback, and five-minute message cache are all gone after restart.
    FOLLOWUP_QUEUES.delete(key);
    clearFollowupDrainCallback(key);
    resetRecentQueuedMessageIdDedupe();

    await expect(enqueueFollowupRunDurable(key, original, settings)).resolves.toBe(false);
    expect(runFollowup).toHaveBeenCalledTimes(1);

    const genuinelyNew = createRun("telegram:102");
    await expect(enqueueFollowupRunDurable(key, genuinelyNew, settings)).resolves.toBe(true);
    scheduleFollowupDrain(key, runFollowup);
    await vi.waitFor(() => expect(runFollowup).toHaveBeenCalledTimes(2));
    expect(runFollowup.mock.calls[1]?.[0]?.messageId).toBe("telegram:102");
  });
});
