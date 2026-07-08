import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { whatsappMonitorPollCommand } from "../commands/whatsapp-monitor.js";
import {
  cronIsolatedRun,
  installGatewayTestHooks,
  testState,
  withGatewayServer,
} from "../gateway/test-helpers.js";
import type { MonitorRecord } from "../monitor/types.js";
import {
  loadWhatsAppMonitorCursorStore,
  resolveWhatsAppMonitorCursorStorePath,
} from "./monitor-listener.js";
import type { WacliReplyLookupResult } from "./wacli-reconciliation.js";

const lookupMocks = vi.hoisted(() => ({
  findLatestInboundReplyAcrossResolvedChats: vi.fn(),
}));

vi.mock("./wacli-reconciliation.js", async () => {
  const actual = await vi.importActual<typeof import("./wacli-reconciliation.js")>(
    "./wacli-reconciliation.js",
  );
  return {
    ...actual,
    findLatestInboundReplyAcrossResolvedChats:
      lookupMocks.findLatestInboundReplyAcrossResolvedChats,
  };
});

installGatewayTestHooks();

const HOOK_TOKEN = "hook-secret";

function createWhatsAppMonitor(): MonitorRecord {
  return {
    monitorId: "whatsapp-monitor-smoke-1",
    agentId: "main",
    name: "WhatsApp smoke wait",
    originSessionKey: "agent:main:telegram:direct:user-1",
    originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
    monitorSessionKey: "agent:main:monitor:whatsapp-monitor-smoke-1",
    sourceType: "whatsapp",
    sourceTarget: {
      accountId: "personal",
      afterMsgId: "outbound-seed-1",
      target: "+971552857036",
    },
    cadence: { kind: "every", everyMs: 300_000 },
    trigger: {
      kind: "hybrid",
      schedule: { cadence: { kind: "every", everyMs: 300_000 } },
      event: {
        kind: "local_listener",
        match: {
          sourceType: "whatsapp",
          sourceTarget: {
            accountId: "personal",
            target: "+971552857036",
          },
          eventTypes: ["message.created"],
        },
      },
    },
    actionPolicy: "notify_draft",
    goal: { id: "goal-whatsapp-smoke", objective: "Wait for a WhatsApp reply." },
    status: "active",
    cronJobId: "cron-whatsapp-monitor-smoke-1",
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

function createLookupResult(): WacliReplyLookupResult {
  return {
    target: "+971552857036",
    seedJids: ["971552857036@s.whatsapp.net"],
    seedPhones: ["971552857036"],
    identityNames: ["Artem"],
    candidates: [
      {
        jid: "971552857036@s.whatsapp.net",
        kind: "dm",
        name: "Artem",
        lastMessageTs: 1_775_040_100,
        reasons: ["exact-jid", "matching-phone"],
        score: 150,
      },
    ],
    seedMessage: {
      chatJid: "971552857036@s.whatsapp.net",
      msgId: "outbound-seed-1",
      senderJid: null,
      ts: 1_775_040_000,
      fromMe: true,
      text: "I will wait for your reply.",
      mediaType: null,
      mediaCaption: null,
      displayText: "I will wait for your reply.",
      chatName: "Artem",
      senderName: "Me",
      direction: "outbound",
      effectiveText: "I will wait for your reply.",
      hasRenderableContent: true,
    },
    latestInboundReply: {
      chatJid: "971552857036@s.whatsapp.net",
      msgId: "inbound-reply-1",
      senderJid: "971552857036@s.whatsapp.net",
      ts: 1_775_040_100,
      fromMe: false,
      text: "Yes, got it.",
      mediaType: null,
      mediaCaption: null,
      displayText: "Yes, got it.",
      chatName: "Artem",
      senderName: "Artem",
      effectiveText: "Yes, got it.",
      hasRenderableContent: true,
    },
    // Keep row order explicit so the poller proves the reply is after the seed
    // without relying on opaque WhatsApp message ids as clocks.
    recentConversation: [
      {
        chatJid: "971552857036@s.whatsapp.net",
        msgId: "outbound-seed-1",
        senderJid: null,
        ts: 1_775_040_000,
        fromMe: true,
        text: "I will wait for your reply.",
        mediaType: null,
        mediaCaption: null,
        displayText: "I will wait for your reply.",
        chatName: "Artem",
        senderName: "Me",
        direction: "outbound",
        effectiveText: "I will wait for your reply.",
        hasRenderableContent: true,
      },
      {
        chatJid: "971552857036@s.whatsapp.net",
        msgId: "inbound-reply-1",
        senderJid: "971552857036@s.whatsapp.net",
        ts: 1_775_040_100,
        fromMe: false,
        text: "Yes, got it.",
        mediaType: null,
        mediaCaption: null,
        displayText: "Yes, got it.",
        chatName: "Artem",
        senderName: "Artem",
        direction: "inbound",
        effectiveText: "Yes, got it.",
        hasRenderableContent: true,
      },
    ],
    continuity: {
      contextChatJid: "971552857036@s.whatsapp.net",
      recentTurnCount: 2,
      hasPriorInbound: true,
      hasPriorOutbound: true,
      lastOutboundReply: null,
      previousOutboundReply: null,
      lastOutboundNormalizedText: null,
      previousOutboundNormalizedText: null,
      lastOutboundIsRepeatOfPrevious: false,
    },
    preferredMonitorChatJid: "971552857036@s.whatsapp.net",
  };
}

async function seedDurableStores(root: string): Promise<{
  cronStorePath: string;
  cursorStorePath: string;
  dbPath: string;
}> {
  const cronStorePath = path.join(root, "cron.json");
  const monitorStorePath = path.join(root, "monitors.json");
  const cursorStorePath = path.join(root, "whatsapp-listener-cursors.json");
  const dbPath = path.join(root, "wacli-fixture.db");
  const monitor = createWhatsAppMonitor();

  await fs.writeFile(dbPath, "", "utf-8");
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

  return { cronStorePath, cursorStorePath, dbPath };
}

describe("whatsapp monitor isolated smoke", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("polls a goal-bound WhatsApp wait, posts the generic hook, enqueues the monitor, and commits the cursor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-smoke-"));
    try {
      const { cronStorePath, cursorStorePath, dbPath } = await seedDurableStores(root);
      testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
      testState.cronStorePath = cronStorePath;
      lookupMocks.findLatestInboundReplyAcrossResolvedChats.mockReturnValue(createLookupResult());

      await withGatewayServer(async ({ port }) => {
        const logs: string[] = [];
        await whatsappMonitorPollCommand(
          {
            cronStore: cronStorePath,
            cursorStore: cursorStorePath,
            dbPath,
            hookToken: HOOK_TOKEN,
            hookUrl: `http://127.0.0.1:${port}/hooks/monitor-event`,
            json: true,
          },
          { log: (line: string) => logs.push(line) } as never,
        );

        expect(logs).toHaveLength(1);
        const result = JSON.parse(logs[0]) as {
          checked?: number;
          dispatched?: number;
          events?: Array<{
            dispatch?: {
              matched?: number;
              wakes?: Array<{
                enqueue?: { enqueued?: boolean; ok?: boolean };
                monitorSessionKey?: string;
                originSessionKey?: string;
              }>;
            };
            event?: { evidence?: { text?: string } };
          }>;
          updatedCursors?: number;
        };
        expect(result.checked).toBe(1);
        expect(result.dispatched).toBe(1);
        expect(result.updatedCursors).toBe(1);
        expect(result.events?.[0]?.dispatch).toMatchObject({
          matched: 1,
          wakes: [
            {
              enqueue: { ok: true, enqueued: true },
              monitorSessionKey: "agent:main:monitor:whatsapp-monitor-smoke-1",
              originSessionKey: "agent:main:telegram:direct:user-1",
            },
          ],
        });
        expect(result.events?.[0]?.event?.evidence?.text).toBe("Yes, got it.");
      });

      expect(lookupMocks.findLatestInboundReplyAcrossResolvedChats).toHaveBeenCalledWith({
        dbPath,
        seedMsgId: "outbound-seed-1",
        target: "+971552857036",
      });
      const cursorStore = await loadWhatsAppMonitorCursorStore(
        resolveWhatsAppMonitorCursorStorePath({ cronStorePath, cursorStorePath }),
      );
      expect(cursorStore.cursors["monitor:whatsapp-monitor-smoke-1"]).toMatchObject({
        lastMsgId: "inbound-reply-1",
      });
      expect(cronIsolatedRun).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, {
        force: true,
        maxRetries: 20,
        recursive: true,
        retryDelay: 25,
      });
    }
  });
});
