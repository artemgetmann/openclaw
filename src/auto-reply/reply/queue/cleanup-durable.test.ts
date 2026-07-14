import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../../test-utils/env.js";
import { clearSessionQueues } from "./cleanup.js";
import { loadDurableFollowups, persistDurableFollowup } from "./durable-store.js";
import {
  enqueueFollowupRunDurable,
  getFollowupQueueDepth,
  restoreDurableFollowupRuns,
} from "./enqueue.js";
import type { FollowupRun, QueueSettings } from "./types.js";

const summarizeSettings: QueueSettings = {
  mode: "collect",
  debounceMs: 0,
  cap: 1,
  dropPolicy: "summarize",
};

function createRun(messageId: string): FollowupRun {
  return {
    prompt: `queued ${messageId}`,
    messageId,
    enqueuedAt: Date.now(),
    originatingChannel: "telegram",
    originatingTo: "-100123",
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

describe("durable followup cancellation", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let stateDir: string;
  let key: string;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-followup-cancel-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    key = `cancel-${Date.now()}`;
  });

  afterEach(async () => {
    // Safe to repeat: cancellation acknowledgement uses forceful deletion.
    clearSessionQueues([key]);
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("acks live and summary-owned records before a session queue clear returns", async () => {
    await enqueueFollowupRunDurable(key, createRun("telegram:1"), summarizeSettings);
    await enqueueFollowupRunDurable(key, createRun("telegram:2"), summarizeSettings);

    // cap=1 leaves one live item while the older durable ID is owned only by
    // the overflow summary; both records must be part of explicit cancellation.
    expect(getFollowupQueueDepth(key)).toBe(1);
    await expect(loadDurableFollowups()).resolves.toHaveLength(2);

    expect(clearSessionQueues([key, key])).toMatchObject({
      followupCleared: 2,
      keys: [key],
    });

    // The synchronous clear boundary must already be durable: neither a disk
    // scan nor startup restore may observe the explicitly cancelled records.
    await expect(loadDurableFollowups()).resolves.toEqual([]);
    await expect(restoreDurableFollowupRuns()).resolves.toBe(0);
  });

  it("acks disk-only records when no queue has been restored into RAM", async () => {
    await persistDurableFollowup({
      queueKey: key,
      run: createRun("telegram:disk-only"),
      settings: summarizeSettings,
    });
    expect(getFollowupQueueDepth(key)).toBe(0);
    await expect(loadDurableFollowups()).resolves.toHaveLength(1);

    // Keep RAM-compatible count semantics while still making the explicit
    // cancellation durable for records discovered solely by queue key.
    expect(clearSessionQueues([key])).toMatchObject({ followupCleared: 0, keys: [key] });
    await expect(loadDurableFollowups()).resolves.toEqual([]);
    await expect(restoreDurableFollowupRuns()).resolves.toBe(0);
  });

  it("tombstones a durable write that began before cancellation", async () => {
    const record = await persistDurableFollowup({
      queueKey: key,
      run: createRun("telegram:in-flight"),
      settings: summarizeSettings,
    });
    const lateRecordContents = `${JSON.stringify(record)}\n`;
    clearSessionQueues([key]);

    // Recreate the atomic rename ordering that caused the race: the write began
    // before cancellation, but its completed record appears after the scan.
    const queueDir = path.join(stateDir, "followup-queue");
    await fs.mkdir(queueDir, { recursive: true });
    await fs.writeFile(path.join(queueDir, `${record.id}.json`), lateRecordContents);
    await expect(loadDurableFollowups()).resolves.toEqual([]);
    await expect(restoreDurableFollowupRuns()).resolves.toBe(0);
  });

  it("allows genuinely new work after an earlier cancellation cutoff", async () => {
    clearSessionQueues([key]);

    await expect(
      persistDurableFollowup({
        queueKey: key,
        run: createRun("telegram:after-cancel"),
        settings: summarizeSettings,
      }),
    ).resolves.toMatchObject({ queueKey: key });
    await expect(loadDurableFollowups()).resolves.toHaveLength(1);
  });
});
