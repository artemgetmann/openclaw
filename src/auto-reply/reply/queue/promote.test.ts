import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRun } from "./types.js";

const queueEmbeddedPiMessageAsync = vi.fn();

vi.mock("../../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessageAsync,
}));

const { promoteQueuedFollowupToSteer } = await import("./promote.js");
const { FOLLOWUP_QUEUES, getFollowupQueue } = await import("./state.js");
const { loadDurableFollowups, persistDurableFollowup } = await import("./durable-store.js");
const { enqueueFollowupRunDurableWithReceipt } = await import("./enqueue.js");

const DURABLE_ID = "12345678-1234-4234-8234-123456789abc";
const ROUTE = {
  chatId: "-100123",
  accountId: "default",
  threadId: 42,
};

function createRun(): FollowupRun {
  return {
    durableId: DURABLE_ID,
    prompt: "Use the new constraint.",
    messageId: "77",
    enqueuedAt: Date.now(),
    originatingChannel: "telegram",
    originatingTo: `telegram:${ROUTE.chatId}`,
    originatingAccountId: ROUTE.accountId,
    originatingThreadId: ROUTE.threadId,
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      config: {},
      provider: "test",
      model: "test",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  };
}

describe("promoteQueuedFollowupToSteer", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-queue-promote-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    FOLLOWUP_QUEUES.clear();
    queueEmbeddedPiMessageAsync.mockReset();
  });

  afterEach(async () => {
    FOLLOWUP_QUEUES.clear();
    delete process.env.OPENCLAW_STATE_DIR;
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("removes one exact queued item only when Pi accepts steering", async () => {
    const queue = getFollowupQueue("session-key", {
      mode: "collect",
      debounceMs: 1_000,
    });
    queue.draining = true;
    queue.items.push(createRun());
    queueEmbeddedPiMessageAsync.mockResolvedValue(true);

    await expect(
      promoteQueuedFollowupToSteer({
        durableId: DURABLE_ID,
        expectedTelegramRoute: ROUTE,
      }),
    ).resolves.toEqual({ status: "promoted" });
    expect(queue.items).toEqual([]);
    expect(queueEmbeddedPiMessageAsync).toHaveBeenCalledWith(
      "session-1",
      "Use the new constraint.",
    );
  });

  it("leaves the item queued when the active run cannot accept steering", async () => {
    const queue = getFollowupQueue("session-key", { mode: "collect" });
    queue.items.push(createRun());
    queueEmbeddedPiMessageAsync.mockResolvedValue(false);

    await expect(
      promoteQueuedFollowupToSteer({
        durableId: DURABLE_ID,
        expectedTelegramRoute: ROUTE,
      }),
    ).resolves.toEqual({ status: "still-queued", reason: "not-streaming" });
    expect(queue.items).toHaveLength(1);
  });

  it("promotes an exact durable item after summarize overflow removes it from queue.items", async () => {
    const settings = {
      mode: "collect",
      cap: 1,
      dropPolicy: "summarize",
    } as const;
    const queue = getFollowupQueue("session-key", settings);
    queue.draining = true;
    const summarized = createRun();
    const live = {
      ...createRun(),
      durableId: "22345678-1234-4234-8234-123456789abc",
      messageId: "78",
      prompt: "Keep this newer follow-up queued.",
    };
    await expect(
      enqueueFollowupRunDurableWithReceipt("session-key", summarized, settings),
    ).resolves.toEqual({ accepted: true, durableId: DURABLE_ID });
    await expect(
      enqueueFollowupRunDurableWithReceipt("session-key", live, settings),
    ).resolves.toEqual({ accepted: true, durableId: live.durableId });
    expect(queue.items.map((item) => item.durableId)).toEqual([live.durableId]);
    expect(queue.summarizedDurableFollowups?.has(DURABLE_ID)).toBe(true);
    queueEmbeddedPiMessageAsync.mockResolvedValue(true);

    await expect(
      promoteQueuedFollowupToSteer({
        durableId: DURABLE_ID,
        expectedTelegramRoute: ROUTE,
      }),
    ).resolves.toEqual({ status: "promoted" });

    expect(queueEmbeddedPiMessageAsync).toHaveBeenCalledWith(
      "session-1",
      "Use the new constraint.",
    );
    expect(queue.summarizedDurableFollowups?.has(DURABLE_ID)).toBe(false);
    expect(queue.droppedCount).toBe(0);
    expect((await loadDurableFollowups()).map((record) => record.id)).toEqual([live.durableId]);
  });

  it("restores summarized ownership when the active run cannot accept steering", async () => {
    const queue = getFollowupQueue("session-key", {
      mode: "collect",
      cap: 1,
      dropPolicy: "summarize",
    });
    const run = createRun();
    await persistDurableFollowup({
      queueKey: "session-key",
      run,
      settings: { mode: "collect", cap: 1, dropPolicy: "summarize" },
    });
    queue.summarizedDurableFollowups?.set(DURABLE_ID, {
      id: DURABLE_ID,
      sequence: 1,
      summaryLine: run.prompt,
    });
    queue.droppedCount = 1;
    queue.summaryLines = [run.prompt];
    queueEmbeddedPiMessageAsync.mockResolvedValue(false);

    await expect(
      promoteQueuedFollowupToSteer({
        durableId: DURABLE_ID,
        expectedTelegramRoute: ROUTE,
      }),
    ).resolves.toEqual({ status: "still-queued", reason: "not-streaming" });

    expect(queue.summarizedDurableFollowups?.get(DURABLE_ID)).toEqual(
      expect.objectContaining({ summaryLine: run.prompt }),
    );
    expect(queue.droppedCount).toBe(1);
    await expect(loadDurableFollowups()).resolves.toHaveLength(1);
  });

  it("restores FIFO ownership when Pi rejects steering", async () => {
    const queue = getFollowupQueue("session-key", { mode: "collect" });
    const first = createRun();
    const second = { ...createRun(), durableId: "22345678-1234-4234-8234-123456789abc" };
    queue.items.push(first, second);
    queueEmbeddedPiMessageAsync.mockRejectedValue(new Error("steer rejected"));

    await expect(
      promoteQueuedFollowupToSteer({
        durableId: DURABLE_ID,
        expectedTelegramRoute: ROUTE,
      }),
    ).rejects.toThrow("steer rejected");
    expect(queue.items).toEqual([first, second]);
  });

  it("rejects an in-flight or wrong-route item", async () => {
    const queue = getFollowupQueue("session-key", { mode: "collect" });
    queue.items.push(createRun());
    queue.inFlightDurableIds.add(DURABLE_ID);

    await expect(
      promoteQueuedFollowupToSteer({
        durableId: DURABLE_ID,
        expectedTelegramRoute: ROUTE,
      }),
    ).resolves.toEqual({ status: "still-queued", reason: "in-flight" });

    queue.inFlightDurableIds.clear();
    await expect(
      promoteQueuedFollowupToSteer({
        durableId: DURABLE_ID,
        expectedTelegramRoute: { ...ROUTE, threadId: 99 },
      }),
    ).resolves.toEqual({ status: "route-mismatch" });
    expect(queueEmbeddedPiMessageAsync).not.toHaveBeenCalled();
  });
});
