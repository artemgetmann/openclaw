import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRun } from "./types.js";

const queueEmbeddedPiMessage = vi.fn();

vi.mock("../../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage,
}));

const { promoteQueuedFollowupToSteer } = await import("./promote.js");
const { FOLLOWUP_QUEUES, getFollowupQueue } = await import("./state.js");

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
    originatingTo: ROUTE.chatId,
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
    queueEmbeddedPiMessage.mockReset();
  });

  afterEach(async () => {
    FOLLOWUP_QUEUES.clear();
    delete process.env.OPENCLAW_STATE_DIR;
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("removes one exact queued item only when Pi accepts steering", () => {
    const queue = getFollowupQueue("session-key", {
      mode: "collect",
      debounceMs: 1_000,
    });
    queue.draining = true;
    queue.items.push(createRun());
    queueEmbeddedPiMessage.mockImplementation(
      (_sessionId: string, _prompt: string, opts?: { beforeQueue?: () => void }) => {
        opts?.beforeQueue?.();
        return true;
      },
    );

    expect(
      promoteQueuedFollowupToSteer({
        durableId: DURABLE_ID,
        expectedTelegramRoute: ROUTE,
      }),
    ).toEqual({ status: "promoted" });
    expect(queue.items).toEqual([]);
    expect(queueEmbeddedPiMessage).toHaveBeenCalledWith(
      "session-1",
      "Use the new constraint.",
      expect.objectContaining({ beforeQueue: expect.any(Function) }),
    );
  });

  it("leaves the item queued when the active run cannot accept steering", () => {
    const queue = getFollowupQueue("session-key", { mode: "collect" });
    queue.items.push(createRun());
    queueEmbeddedPiMessage.mockReturnValue(false);

    expect(
      promoteQueuedFollowupToSteer({
        durableId: DURABLE_ID,
        expectedTelegramRoute: ROUTE,
      }),
    ).toEqual({ status: "still-queued", reason: "not-streaming" });
    expect(queue.items).toHaveLength(1);
  });

  it("rejects an in-flight or wrong-route item", () => {
    const queue = getFollowupQueue("session-key", { mode: "collect" });
    queue.items.push(createRun());
    queue.inFlightDurableIds.add(DURABLE_ID);

    expect(
      promoteQueuedFollowupToSteer({
        durableId: DURABLE_ID,
        expectedTelegramRoute: ROUTE,
      }),
    ).toEqual({ status: "still-queued", reason: "in-flight" });

    queue.inFlightDurableIds.clear();
    expect(
      promoteQueuedFollowupToSteer({
        durableId: DURABLE_ID,
        expectedTelegramRoute: { ...ROUTE, threadId: 99 },
      }),
    ).toEqual({ status: "route-mismatch" });
    expect(queueEmbeddedPiMessage).not.toHaveBeenCalled();
  });
});
