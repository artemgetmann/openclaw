import { afterEach, describe, expect, it, vi } from "vitest";
import type { FollowupRun, QueueSettings } from "./types.js";

const mocks = vi.hoisted(() => ({
  ackDurableFollowup: vi.fn(async () => undefined),
  completeDurableFollowup: vi.fn(async () => undefined),
  ackDurableFollowupsForQueueSync: vi.fn(),
  ackDurableFollowupsSync: vi.fn(),
}));

vi.mock("./durable-store.js", () => ({
  ackDurableFollowup: mocks.ackDurableFollowup,
  completeDurableFollowup: mocks.completeDurableFollowup,
  ackDurableFollowupsForQueueSync: mocks.ackDurableFollowupsForQueueSync,
  ackDurableFollowupsSync: mocks.ackDurableFollowupsSync,
}));

const { enqueueFollowupRun } = await import("./enqueue.js");
const { retainSummarizedDurableFollowups, scheduleFollowupDrain } = await import("./drain.js");
const { clearFollowupQueue, getExistingFollowupQueue } = await import("./state.js");

const settings: QueueSettings = {
  mode: "collect",
  debounceMs: 0,
  cap: 20,
  dropPolicy: "summarize",
};

function createRun(id: string, to: string): FollowupRun {
  return {
    durableId: id,
    prompt: `queued ${id}`,
    enqueuedAt: Date.now(),
    originatingChannel: "slack",
    originatingTo: to,
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session-1",
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

describe("durable followup drain", () => {
  const keys: string[] = [];

  afterEach(() => {
    for (const key of keys.splice(0)) {
      clearFollowupQueue(key);
    }
    mocks.ackDurableFollowup.mockClear();
    mocks.completeDurableFollowup.mockClear();
    mocks.ackDurableFollowupsForQueueSync.mockClear();
    mocks.ackDurableFollowupsSync.mockClear();
  });

  it("acks every individually drained collect item after successful processing", async () => {
    const key = `durable-collect-${Date.now()}`;
    keys.push(key);
    const runFollowup = vi.fn(async () => undefined);
    enqueueFollowupRun(key, createRun("durable-1", "channel:A"), settings, "none");
    enqueueFollowupRun(key, createRun("durable-2", "channel:B"), settings, "none");

    scheduleFollowupDrain(key, runFollowup);

    await vi.waitFor(() => {
      expect(runFollowup).toHaveBeenCalledTimes(2);
      expect(mocks.completeDurableFollowup).toHaveBeenNthCalledWith(1, "durable-1");
      expect(mocks.completeDurableFollowup).toHaveBeenNthCalledWith(2, "durable-2");
    });
    expect(mocks.completeDurableFollowup.mock.invocationCallOrder[0]).toBeGreaterThan(
      runFollowup.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.completeDurableFollowup.mock.invocationCallOrder[1]).toBeGreaterThan(
      runFollowup.mock.invocationCallOrder[1] ?? 0,
    );
  });

  it("does not ack an item until a failed processing attempt later succeeds", async () => {
    const key = `durable-collect-retry-${Date.now()}`;
    keys.push(key);
    let releaseRetry: (() => void) | undefined;
    const retryBarrier = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const runFollowup = vi.fn(async (_run: FollowupRun) => {
      if (runFollowup.mock.calls.length === 1) {
        throw new Error("agent processing failed");
      }
      await retryBarrier;
    });
    enqueueFollowupRun(key, createRun("durable-retry", "channel:A"), settings, "none");

    scheduleFollowupDrain(key, runFollowup);

    await vi.waitFor(() => expect(runFollowup).toHaveBeenCalledTimes(2));
    expect(mocks.completeDurableFollowup).not.toHaveBeenCalled();
    releaseRetry?.();
    await vi.waitFor(() => expect(mocks.completeDurableFollowup).toHaveBeenCalledTimes(1));
    expect(mocks.completeDurableFollowup).toHaveBeenCalledWith("durable-retry");
  });

  it("acks summarized durable records only after the summary turn succeeds", async () => {
    const key = `durable-summary-${Date.now()}`;
    keys.push(key);
    const summarySettings: QueueSettings = {
      ...settings,
      cap: 1,
    };
    let finishSummary: (() => void) | undefined;
    const summaryBarrier = new Promise<void>((resolve) => {
      finishSummary = resolve;
    });
    const runFollowup = vi.fn(async (_run: FollowupRun) => {
      if (runFollowup.mock.calls.length === 1) {
        throw new Error("summary processing failed");
      }
      await summaryBarrier;
    });
    enqueueFollowupRun(key, createRun("durable-dropped", "channel:A"), summarySettings, "none");
    enqueueFollowupRun(key, createRun("durable-carrier", "channel:A"), summarySettings, "none");
    // Durable enqueue transfers IDs removed by `drop:summarize` into the
    // drain-owned pending set. This test isolates that acknowledgement phase.
    retainSummarizedDurableFollowups(getExistingFollowupQueue(key)!, ["durable-dropped"]);

    scheduleFollowupDrain(key, runFollowup);

    await vi.waitFor(() => expect(runFollowup).toHaveBeenCalledTimes(2));
    for (const [run] of runFollowup.mock.calls) {
      expect(run.prompt).toContain("queued durable-dropped");
      expect(run.durableIds).toEqual(
        expect.arrayContaining(["durable-dropped", "durable-carrier"]),
      );
    }
    expect(mocks.completeDurableFollowup).not.toHaveBeenCalled();
    finishSummary?.();
    await vi.waitFor(() => expect(mocks.completeDurableFollowup).toHaveBeenCalledTimes(2));
    expect(mocks.completeDurableFollowup).toHaveBeenCalledWith("durable-dropped");
    expect(mocks.completeDurableFollowup).toHaveBeenCalledWith("durable-carrier");
  });
});
