import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../../test-utils/env.js";
import { loadDurableFollowups } from "./durable-store.js";
import type { FollowupRun, QueueSettings } from "./types.js";

vi.mock("./drain.js", () => ({
  kickFollowupDrainIfIdle: vi.fn(),
  retainSummarizedDurableFollowups: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
}));

const { enqueueFollowupRunDurable, getFollowupQueueDepth, restoreDurableFollowupRuns } =
  await import("./enqueue.js");
const { retainSummarizedDurableFollowups, scheduleFollowupDrain } = await import("./drain.js");
const { clearFollowupQueue } = await import("./state.js");

const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 20 };
let keySequence = 0;

function createRun(): FollowupRun {
  return {
    prompt: "queued while busy",
    messageId: "telegram:101",
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

describe("durable followup enqueue", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let stateDir: string;
  let key: string;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-followup-enqueue-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    keySequence += 1;
    key = `queue-${Date.now()}-${keySequence}`;
    vi.mocked(retainSummarizedDurableFollowups).mockClear();
    vi.mocked(scheduleFollowupDrain).mockClear();
  });

  afterEach(async () => {
    clearFollowupQueue(key);
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("has a durable record before reporting RAM acceptance", async () => {
    await expect(enqueueFollowupRunDurable(key, createRun(), settings)).resolves.toBe(true);
    expect(getFollowupQueueDepth(key)).toBe(1);
    await expect(loadDurableFollowups()).resolves.toHaveLength(1);
  });

  it("rehydrates and explicitly schedules every restored queue", async () => {
    const secondKey = `${key}-second`;
    await enqueueFollowupRunDurable(key, createRun(), settings);
    await enqueueFollowupRunDurable(secondKey, createRun(), settings);
    clearFollowupQueue(key);
    clearFollowupQueue(secondKey);
    const runFollowup = vi.fn(async () => undefined);

    await expect(restoreDurableFollowupRuns({ runFollowup })).resolves.toBe(2);
    expect(getFollowupQueueDepth(key)).toBe(1);
    expect(getFollowupQueueDepth(secondKey)).toBe(1);
    expect(scheduleFollowupDrain).toHaveBeenCalledTimes(2);
    expect(scheduleFollowupDrain).toHaveBeenCalledWith(key, runFollowup);
    expect(scheduleFollowupDrain).toHaveBeenCalledWith(secondKey, runFollowup);
    clearFollowupQueue(secondKey);
  });

  it("does not restore a durable ID that is already present in the global queue", async () => {
    await enqueueFollowupRunDurable(key, createRun(), settings);
    const runFollowup = vi.fn(async () => undefined);

    await expect(restoreDurableFollowupRuns({ runFollowup })).resolves.toBe(0);

    expect(getFollowupQueueDepth(key)).toBe(1);
    expect(scheduleFollowupDrain).not.toHaveBeenCalled();
    await expect(loadDurableFollowups()).resolves.toHaveLength(1);
  });

  it("retains summarized durable records until the RAM-only summary is processed", async () => {
    const summarizeSettings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    await enqueueFollowupRunDurable(key, createRun(), summarizeSettings);
    const firstRecord = (await loadDurableFollowups())[0];
    if (!firstRecord) {
      throw new Error("expected the first durable record");
    }
    await enqueueFollowupRunDurable(
      key,
      { ...createRun(), prompt: "second queued message", messageId: "telegram:102" },
      summarizeSettings,
    );

    expect(getFollowupQueueDepth(key)).toBe(1);
    expect(retainSummarizedDurableFollowups).toHaveBeenLastCalledWith(expect.anything(), [
      firstRecord.id,
    ]);
    await expect(loadDurableFollowups()).resolves.toHaveLength(2);
  });

  it("does not mutate RAM when persistence fails", async () => {
    const notADirectory = path.join(stateDir, "state-file");
    await fs.writeFile(notADirectory, "not a directory");
    process.env.OPENCLAW_STATE_DIR = notADirectory;

    await expect(enqueueFollowupRunDurable(key, createRun(), settings)).rejects.toThrow();
    expect(getFollowupQueueDepth(key)).toBe(0);
  });
});
