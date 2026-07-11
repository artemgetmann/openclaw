import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramUserMonitorPollCommand } from "../commands/telegram-user.js";
import {
  cronIsolatedRun,
  installGatewayTestHooks,
  testState,
  withGatewayServer,
} from "../gateway/test-helpers.js";
import type { MonitorRecord } from "../monitor/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  loadTelegramUserMonitorCursorStore,
  resolveTelegramUserMonitorCursorStorePath,
} from "./monitor-listener.js";

const backendMocks = vi.hoisted(() => ({
  runTelegramUserRead: vi.fn(),
  getTelegramUserDefaultPollIntervalMs: vi.fn(() => 1),
}));

vi.mock("./backend.js", () => backendMocks);

installGatewayTestHooks();

const HOOK_TOKEN = "hook-secret";
const runtime: RuntimeEnv = {
  error: vi.fn(),
  exit: vi.fn(),
  log: vi.fn(),
};

function createTelegramMonitor(): MonitorRecord {
  return {
    monitorId: "telegram-monitor-smoke-1",
    agentId: "main",
    name: "Telegram reply smoke",
    originSessionKey: "agent:main:telegram:direct:user-1",
    originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
    monitorSessionKey: "agent:main:monitor:telegram-monitor-smoke-1",
    sourceType: "telegram-user",
    sourceTarget: {
      accountId: "personal",
      afterId: 100,
      chat: "@jarvis_tester_1_bot",
    },
    cadence: { kind: "every", everyMs: 300_000 },
    trigger: {
      kind: "local_listener",
      match: {
        sourceType: "telegram-user",
        sourceTarget: {
          accountId: "personal",
          chat: "@jarvis_tester_1_bot",
        },
        eventTypes: ["message.created"],
      },
    },
    actionPolicy: "notify_draft",
    goal: { id: "goal-telegram-smoke", objective: "Wait for a Telegram reply." },
    status: "active",
    cronJobId: "cron-telegram-monitor-smoke-1",
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

function createInboundMessage() {
  return {
    chat_id: 10,
    chat_title: "Jarvis Lab",
    chat_username: "jarvis_tester_1_bot",
    date: "2026-07-06T00:00:00.000Z",
    direct_messages_topic: null,
    direct_messages_topic_id: null,
    media_kind: null,
    message_id: 101,
    out: false,
    reply_to_msg_id: null,
    reply_to_top_id: null,
    sender_id: 456,
    text: "fresh Telegram reply",
    thread_anchor: null,
  };
}

async function seedDurableStores(root: string): Promise<{
  cronStorePath: string;
  cursorStorePath: string;
  monitorStorePath: string;
}> {
  const cronStorePath = path.join(root, "cron.json");
  const cursorStorePath = path.join(root, "telegram-user-listener-cursors.json");
  const monitorStorePath = path.join(root, "monitors.json");
  const monitor = createTelegramMonitor();

  await fs.writeFile(
    monitorStorePath,
    JSON.stringify({ version: 1, monitors: [monitor] }, null, 2),
    "utf-8",
  );
  await fs.writeFile(
    cronStorePath,
    JSON.stringify(
      {
        version: 1,
        jobs: [
          {
            id: monitor.cronJobId,
            agentId: monitor.agentId,
            name: monitor.name,
            enabled: true,
            createdAtMs: monitor.createdAtMs,
            updatedAtMs: monitor.updatedAtMs,
            schedule: monitor.cadence,
            sessionTarget: `session:${monitor.monitorSessionKey}`,
            wakeMode: "next-heartbeat",
            payload: { kind: "monitorWake", monitorId: monitor.monitorId },
            delivery: monitor.originDelivery,
            state: { nextRunAtMs: monitor.updatedAtMs + 300_000 },
          },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  );

  return { cronStorePath, cursorStorePath, monitorStorePath };
}

describe("telegram user monitor isolated smoke", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("polls Telegram, posts to the real local hook, enqueues the monitor, and commits the cursor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-smoke-"));
    try {
      const { cronStorePath, cursorStorePath, monitorStorePath } = await seedDurableStores(root);
      testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
      testState.cronStorePath = cronStorePath;
      backendMocks.runTelegramUserRead.mockResolvedValueOnce({
        messages: [createInboundMessage()],
      });

      await withGatewayServer(async ({ port }) => {
        await telegramUserMonitorPollCommand(
          {
            cronStore: cronStorePath,
            cursorStore: cursorStorePath,
            hookToken: HOOK_TOKEN,
            hookUrl: `http://127.0.0.1:${port}/hooks/telegram-user-monitor-event`,
            json: true,
            monitorStore: monitorStorePath,
          },
          runtime,
        );

        const result = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
          checked?: number;
          dispatched?: number;
          events?: Array<{
            dispatch?: {
              matched?: number;
              wakes?: Array<{ enqueue?: { enqueued?: boolean; ok?: boolean } }>;
            };
            event?: { evidence?: { text?: string } };
          }>;
          updatedCursors?: number;
        };
        expect(result).toMatchObject({ checked: 1, dispatched: 1, updatedCursors: 1 });
        expect(result.events?.[0]).toMatchObject({
          dispatch: { matched: 1, wakes: [{ enqueue: { ok: true, enqueued: true } }] },
          event: { evidence: { text: "fresh Telegram reply" } },
        });
      });

      expect(backendMocks.runTelegramUserRead).toHaveBeenCalledWith({
        afterId: 100,
        chat: "@jarvis_tester_1_bot",
        contains: undefined,
        envFile: undefined,
        limit: 80,
        session: undefined,
      });
      const cursorStore = await loadTelegramUserMonitorCursorStore(
        resolveTelegramUserMonitorCursorStorePath({ cronStorePath, cursorStorePath }),
      );
      expect(cursorStore.cursors["monitor:telegram-monitor-smoke-1"]).toMatchObject({
        lastMessageId: 101,
      });
      expect(cronIsolatedRun).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 25 });
    }
  });

  it("does not commit a cursor when the local hook rejects dispatch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-smoke-failed-"));
    try {
      const { cronStorePath, cursorStorePath, monitorStorePath } = await seedDurableStores(root);
      testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
      testState.cronStorePath = cronStorePath;
      backendMocks.runTelegramUserRead.mockResolvedValueOnce({
        messages: [createInboundMessage()],
      });

      await withGatewayServer(async ({ port }) => {
        await telegramUserMonitorPollCommand(
          {
            cronStore: cronStorePath,
            cursorStore: cursorStorePath,
            hookToken: "wrong-token",
            hookUrl: `http://127.0.0.1:${port}/hooks/telegram-user-monitor-event`,
            json: true,
            monitorStore: monitorStorePath,
          },
          runtime,
        );

        const result = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
          skipped?: Array<{ reason?: string }>;
          updatedCursors?: number;
        };
        expect(result).toMatchObject({
          updatedCursors: 0,
          skipped: [{ reason: "dispatch_error" }],
        });
      });

      await expect(fs.access(cursorStorePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 25 });
    }
  });
});
