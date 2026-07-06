import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dispatchMonitorEventToCron } from "../gateway/server-methods/monitor.js";
import type { MonitorRecord, MonitorStoreFile } from "../monitor/types.js";
import {
  loadTelegramUserMonitorCursorStore,
  pollTelegramUserMonitorEvents,
  resolveTelegramUserMonitorCursorStorePath,
} from "./monitor-listener.js";
import type { TelegramUserMessage } from "./types.js";

function message(overrides: Partial<TelegramUserMessage> = {}): TelegramUserMessage {
  return {
    chat_id: 10,
    chat_title: "Jarvis Lab",
    chat_username: "jarvis_tester_1_bot",
    date: "2026-07-06T00:00:00.000Z",
    direct_messages_topic: null,
    direct_messages_topic_id: null,
    media_kind: null,
    message_id: 100,
    out: false,
    reply_to_msg_id: null,
    reply_to_top_id: null,
    sender_id: 456,
    text: "telegram reply",
    thread_anchor: 7001,
    ...overrides,
  };
}

function goalBoundTelegramMonitor(overrides: Partial<MonitorRecord> = {}): MonitorRecord {
  return {
    monitorId: "telegram-monitor-1",
    agentId: "main",
    name: "Telegram-as-me wait",
    originSessionKey: "agent:main:telegram:direct:user-1",
    originDelivery: {
      mode: "announce",
      channel: "telegram",
      to: "user-1",
      accountId: "default",
    },
    monitorSessionKey: "agent:main:monitor:telegram-monitor-1",
    sourceType: "telegram-user",
    sourceTarget: {
      accountId: "personal",
      chat: "@jarvis_tester_1_bot",
      threadAnchor: "7001",
    },
    cadence: { kind: "every", everyMs: 300_000 },
    trigger: {
      kind: "hybrid",
      schedule: { cadence: { kind: "every", everyMs: 300_000 } },
      event: {
        kind: "local_listener",
        match: {
          sourceType: "telegram-user",
          sourceTarget: {
            accountId: "personal",
            chat: "@jarvis_tester_1_bot",
            threadAnchor: "7001",
          },
          eventTypes: ["message.created"],
        },
      },
    },
    actionPolicy: "notify_draft",
    goal: {
      id: "goal-telegram-reply",
      objective: "Wait until the Telegram contact replies.",
    },
    status: "active",
    cronJobId: "cron-telegram-monitor-1",
    createdAtMs: 1_000_000,
    updatedAtMs: 1_000_000,
    ...overrides,
  };
}

async function seedStores(monitors: MonitorRecord[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-monitor-listener-"));
  const cronStorePath = path.join(root, "cron.json");
  const monitorStorePath = path.join(root, "monitors.json");
  await fs.writeFile(
    cronStorePath,
    JSON.stringify(
      {
        version: 1,
        jobs: [
          {
            id: "cron-telegram-monitor-1",
            agentId: "main",
            name: "Telegram-as-me wait",
            enabled: true,
            createdAtMs: 1_000_000,
            updatedAtMs: 1_000_000,
            schedule: { kind: "every", everyMs: 300_000 },
            sessionTarget: "session:agent:main:monitor:telegram-monitor-1",
            wakeMode: "next-heartbeat",
            payload: { kind: "monitorWake", monitorId: "telegram-monitor-1" },
            delivery: {
              mode: "announce",
              channel: "telegram",
              to: "user-1",
              accountId: "default",
            },
            state: { nextRunAtMs: 1_300_000 },
          },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  );
  const store: MonitorStoreFile = { version: 1, monitors };
  await fs.writeFile(monitorStorePath, JSON.stringify(store, null, 2), "utf-8");
  return { cronStorePath, monitorStorePath, root };
}

describe("telegram-user monitor listener cursor", () => {
  it("polls goal-bound Telegram-as-me monitors from cursor into monitor event dispatch", async () => {
    const { cronStorePath, monitorStorePath } = await seedStores([goalBoundTelegramMonitor()]);
    const enqueueRun = vi.fn(
      async (_jobId: string, _mode?: "due" | "force") =>
        ({
          ok: true,
          enqueued: true,
          runId: "run-telegram-monitor-1",
        }) as const,
    );
    const readTelegramUser = vi
      .fn()
      .mockResolvedValueOnce({ messages: [message({ message_id: 100, text: "old reply" })] })
      .mockResolvedValueOnce({ messages: [message({ message_id: 101, text: "fresh reply" })] });

    const first = await pollTelegramUserMonitorEvents({
      cronStorePath,
      monitorStorePath,
      nowMs: 2_000_000,
      readTelegramUser,
      dispatchEvent: async ({ event }) =>
        dispatchMonitorEventToCron({
          cronStorePath,
          cron: { enqueueRun },
          event,
        }),
    });

    expect(first.events).toEqual([]);
    expect(first.updatedCursors).toBe(1);
    expect(enqueueRun).not.toHaveBeenCalled();
    expect(readTelegramUser).toHaveBeenLastCalledWith(
      expect.objectContaining({
        afterId: 0,
        chat: "@jarvis_tester_1_bot",
      }),
    );

    const second = await pollTelegramUserMonitorEvents({
      cronStorePath,
      monitorStorePath,
      nowMs: 2_000_500,
      readTelegramUser,
      dispatchEvent: async ({ event }) =>
        dispatchMonitorEventToCron({
          cronStorePath,
          cron: { enqueueRun },
          event,
        }),
    });

    expect(second.events).toHaveLength(1);
    expect(second.dispatched).toBe(1);
    expect(second.events[0]?.event).toMatchObject({
      triggerKind: "local_listener",
      sourceType: "telegram-user",
      sourceTarget: {
        accountId: "personal",
        chat: "@jarvis_tester_1_bot",
        threadAnchor: "7001",
      },
      eventType: "message.created",
      evidence: expect.objectContaining({
        messageId: "101",
        text: "fresh reply",
      }),
    });
    expect(enqueueRun).toHaveBeenCalledWith("cron-telegram-monitor-1", "force");

    const cursorStore = await loadTelegramUserMonitorCursorStore(
      resolveTelegramUserMonitorCursorStorePath({ monitorStorePath }),
    );
    expect(cursorStore.cursors["monitor:telegram-monitor-1"]?.lastMessageId).toBe(101);
  });

  it("uses explicit afterId seeds so a new reply can wake on the first poll", async () => {
    const { cronStorePath, monitorStorePath } = await seedStores([
      goalBoundTelegramMonitor({
        sourceTarget: {
          accountId: "personal",
          afterId: 200,
          chat: "@jarvis_tester_1_bot",
          threadAnchor: "7001",
        },
      }),
    ]);
    const readTelegramUser = vi.fn().mockResolvedValueOnce({
      messages: [message({ message_id: 201, text: "seeded fresh reply" })],
    });
    const dispatchEvent = vi.fn(async () => ({ matched: 1 }));

    const result = await pollTelegramUserMonitorEvents({
      cronStorePath,
      monitorStorePath,
      nowMs: 3_000_000,
      readTelegramUser,
      dispatchEvent,
    });

    expect(result.events).toHaveLength(1);
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          evidence: expect.objectContaining({ messageId: "201" }),
        }),
      }),
    );
    expect(readTelegramUser).toHaveBeenCalledWith(
      expect.objectContaining({
        afterId: 200,
        chat: "@jarvis_tester_1_bot",
      }),
    );
  });

  it("bootstraps contains-filtered monitors from unfiltered visible history", async () => {
    const { cronStorePath, monitorStorePath } = await seedStores([
      goalBoundTelegramMonitor({
        sourceTarget: {
          accountId: "personal",
          chat: "@jarvis_tester_1_bot",
          contains: "target",
          threadAnchor: "7001",
        },
      }),
    ]);
    const readTelegramUser = vi.fn().mockResolvedValueOnce({
      messages: [
        message({ message_id: 450, text: "older target reply" }),
        message({ message_id: 500, text: "newer unrelated reply" }),
      ],
    });
    const dispatchEvent = vi.fn(async () => ({ matched: 1 }));

    const result = await pollTelegramUserMonitorEvents({
      cronStorePath,
      monitorStorePath,
      nowMs: 3_250_000,
      readTelegramUser,
      dispatchEvent,
    });

    expect(result.events).toEqual([]);
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(readTelegramUser).toHaveBeenCalledWith(
      expect.objectContaining({
        afterId: 0,
        contains: undefined,
      }),
    );
    const cursorStore = await loadTelegramUserMonitorCursorStore(
      resolveTelegramUserMonitorCursorStorePath({ monitorStorePath }),
    );
    expect(cursorStore.cursors["monitor:telegram-monitor-1"]?.lastMessageId).toBe(500);
  });

  it("pages topic-scoped reads before applying the local thread filter", async () => {
    const { cronStorePath, monitorStorePath } = await seedStores([
      goalBoundTelegramMonitor({
        sourceTarget: {
          accountId: "personal",
          afterId: 100,
          chat: "@busy_group",
          contains: "target",
          threadAnchor: "7001",
        },
        trigger: {
          kind: "hybrid",
          schedule: { cadence: { kind: "every", everyMs: 300_000 } },
          event: {
            kind: "local_listener",
            match: {
              sourceType: "telegram-user",
              sourceTarget: {
                accountId: "personal",
                chat: "@busy_group",
                threadAnchor: "7001",
              },
              eventTypes: ["message.created"],
            },
          },
        },
      }),
    ]);
    const readTelegramUser = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [
          message({ message_id: 200, text: "new off-topic", thread_anchor: 9000 }),
          message({ message_id: 199, text: "newer off-topic", thread_anchor: 9000 }),
          message({ message_id: 198, text: "also off-topic", thread_anchor: 9000 }),
        ],
      })
      .mockResolvedValueOnce({
        messages: [
          message({ message_id: 197, text: "target topic reply", thread_anchor: 7001 }),
          message({ message_id: 196, text: "older off-topic", thread_anchor: 9000 }),
        ],
      });
    const dispatchEvent = vi.fn(async () => ({ matched: 1 }));

    const result = await pollTelegramUserMonitorEvents({
      cronStorePath,
      limit: 3,
      monitorStorePath,
      nowMs: 3_500_000,
      readTelegramUser,
      dispatchEvent,
    });

    expect(readTelegramUser).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        afterId: 100,
        beforeId: undefined,
        chat: "@busy_group",
        contains: undefined,
        limit: 3,
      }),
    );
    expect(readTelegramUser).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        afterId: 100,
        beforeId: 198,
        chat: "@busy_group",
        contains: undefined,
        limit: 3,
      }),
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.message.message_id).toBe(197);
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          evidence: expect.objectContaining({ messageId: "197" }),
        }),
      }),
    );
  });

  it("does not poll non-goal Telegram local listeners", async () => {
    const { cronStorePath, monitorStorePath } = await seedStores([
      goalBoundTelegramMonitor({ goal: undefined }),
    ]);
    const readTelegramUser = vi.fn();

    const result = await pollTelegramUserMonitorEvents({
      cronStorePath,
      monitorStorePath,
      readTelegramUser,
    });

    expect(readTelegramUser).not.toHaveBeenCalled();
    expect(result.skipped).toContainEqual({
      monitorId: "telegram-monitor-1",
      reason: "missing_goal",
    });
  });

  it("does not advance the cursor when dispatch fails", async () => {
    const { cronStorePath, monitorStorePath } = await seedStores([
      goalBoundTelegramMonitor({
        sourceTarget: {
          accountId: "personal",
          afterId: 300,
          chat: "@jarvis_tester_1_bot",
          threadAnchor: "7001",
        },
      }),
    ]);
    const readTelegramUser = vi.fn().mockResolvedValueOnce({
      messages: [message({ message_id: 301, text: "fresh but undispatched" })],
    });

    const result = await pollTelegramUserMonitorEvents({
      cronStorePath,
      monitorStorePath,
      readTelegramUser,
      dispatchEvent: async () => {
        throw new Error("gateway unavailable");
      },
    });

    expect(result.events).toEqual([]);
    expect(result.skipped).toContainEqual({
      monitorId: "telegram-monitor-1",
      reason: "dispatch_error",
      error: "Error: gateway unavailable",
    });
    const cursorStore = await loadTelegramUserMonitorCursorStore(
      resolveTelegramUserMonitorCursorStorePath({ monitorStorePath }),
    );
    expect(cursorStore.cursors["monitor:telegram-monitor-1"]).toBeUndefined();
  });

  it("does not advance the cursor when dispatch matches no monitor", async () => {
    const { cronStorePath, monitorStorePath } = await seedStores([
      goalBoundTelegramMonitor({
        sourceTarget: {
          accountId: "personal",
          afterId: 400,
          chat: "@jarvis_tester_1_bot",
          threadAnchor: "7001",
        },
      }),
    ]);
    const readTelegramUser = vi.fn().mockResolvedValueOnce({
      messages: [message({ message_id: 401, text: "fresh but unmatched" })],
    });

    const result = await pollTelegramUserMonitorEvents({
      cronStorePath,
      monitorStorePath,
      readTelegramUser,
      dispatchEvent: async () => ({ matched: 0, wakes: [] }),
    });

    expect(result.events).toEqual([]);
    expect(result.skipped).toContainEqual({
      monitorId: "telegram-monitor-1",
      reason: "dispatch_error",
      error: "dispatch did not confirm monitor wake",
    });
    const cursorStore = await loadTelegramUserMonitorCursorStore(
      resolveTelegramUserMonitorCursorStorePath({ monitorStorePath }),
    );
    expect(cursorStore.cursors["monitor:telegram-monitor-1"]).toBeUndefined();
  });
});
