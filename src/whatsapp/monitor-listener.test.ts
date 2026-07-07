import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { monitorHandlers } from "../gateway/server-methods/monitor.js";
import type { MonitorRecord } from "../monitor/types.js";
import {
  loadWhatsAppMonitorCursorStore,
  pollWhatsAppMonitorEvents,
  resolveWhatsAppMonitorCursorStorePath,
} from "./monitor-listener.js";
import type { WacliReplyLookupResult } from "./wacli-reconciliation.js";

function createLookup(
  target: string,
  msgId: string,
  opts: {
    latestTs?: number;
    recentConversation?: WacliReplyLookupResult["recentConversation"];
    seedMessage?: WacliReplyLookupResult["seedMessage"];
  } = {},
): WacliReplyLookupResult {
  const latestTs = opts.latestTs ?? 1_775_039_860;
  return {
    target,
    seedJids: ["971552857036@s.whatsapp.net"],
    seedPhones: ["971552857036"],
    identityNames: ["artem"],
    candidates: [
      {
        jid: "74333133234289@lid",
        kind: "unknown",
        name: "Artem",
        lastMessageTs: 1_775_039_860,
        reasons: ["active-inbound-thread", "matching-name"],
        score: 220,
      },
      {
        jid: "971552857036@s.whatsapp.net",
        kind: "dm",
        name: "Artem",
        lastMessageTs: 1_775_039_816,
        reasons: ["exact-jid", "matching-phone"],
        score: 150,
      },
    ],
    seedMessage: opts.seedMessage ?? null,
    latestInboundReply: {
      chatJid: "74333133234289@lid",
      msgId,
      senderJid: "74333133234289:12@lid",
      ts: latestTs,
      fromMe: false,
      text: "Need this handled today",
      mediaType: null,
      mediaCaption: null,
      displayText: "Need this handled today",
      chatName: "Artem",
      senderName: "Artem",
      effectiveText: "Need this handled today",
      hasRenderableContent: true,
    },
    recentConversation: opts.recentConversation ?? [],
    continuity: {
      contextChatJid: "74333133234289@lid",
      recentTurnCount: 0,
      hasPriorInbound: false,
      hasPriorOutbound: false,
      lastOutboundReply: null,
      previousOutboundReply: null,
      lastOutboundNormalizedText: null,
      previousOutboundNormalizedText: null,
      lastOutboundIsRepeatOfPrevious: false,
    },
    preferredMonitorChatJid: "74333133234289@lid",
  };
}

function createMonitor(overrides?: Partial<MonitorRecord>): MonitorRecord {
  return {
    monitorId: "whatsapp-monitor-1",
    agentId: "main",
    name: "WhatsApp reply wait",
    originSessionKey: "agent:main:telegram:direct:user-1",
    originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
    monitorSessionKey: "agent:main:monitor:whatsapp-monitor-1",
    sourceType: "whatsapp",
    sourceTarget: { accountId: "personal", target: "+971552857036" },
    cadence: { kind: "every", everyMs: 300_000 },
    trigger: {
      kind: "hybrid",
      schedule: { cadence: { kind: "every", everyMs: 300_000 } },
      event: {
        kind: "local_listener",
        match: {
          sourceType: "whatsapp",
          sourceTarget: { accountId: "personal", target: "+971552857036" },
          eventTypes: ["message.created"],
        },
      },
    },
    actionPolicy: "notify_draft",
    goal: { id: "goal-1", objective: "Get a WhatsApp reply." },
    status: "active",
    cronJobId: "cron-whatsapp-monitor-1",
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

async function withTempStores(
  run: (paths: { root: string; cronStorePath: string }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-monitor-poll-"));
  try {
    const cronStorePath = path.join(root, "cron.json");
    const monitorStorePath = path.join(root, "monitors.json");
    await fs.writeFile(
      monitorStorePath,
      JSON.stringify({ version: 1, monitors: [createMonitor()] }, null, 2),
      "utf-8",
    );
    await fs.writeFile(
      cronStorePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "cron-whatsapp-monitor-1",
              agentId: "main",
              name: "WhatsApp reply wait",
              enabled: true,
              createdAtMs: 1_000,
              updatedAtMs: 1_000,
              schedule: { kind: "every", everyMs: 300_000 },
              sessionTarget: "session:agent:main:monitor:whatsapp-monitor-1",
              wakeMode: "next-heartbeat",
              payload: { kind: "monitorWake", monitorId: "whatsapp-monitor-1" },
              delivery: { mode: "announce", channel: "telegram", to: "user-1" },
              state: { nextRunAtMs: 301_000 },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await run({ root, cronStorePath });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("pollWhatsAppMonitorEvents", () => {
  it("checkpoints current WhatsApp history on first run without waking old replies", async () => {
    await withTempStores(async ({ cronStorePath }) => {
      const dispatchEvent = vi.fn();

      const result = await pollWhatsAppMonitorEvents({
        cronStorePath,
        dbPath: "/tmp/wacli.db",
        dispatchEvent,
        lookupReply: ({ target }) => createLookup(target, "inbound-1"),
        nowMs: 10_000,
      });

      expect(result).toMatchObject({
        checked: 1,
        dispatched: 0,
        events: [],
        skipped: [],
        updatedCursors: 1,
      });
      expect(dispatchEvent).not.toHaveBeenCalled();

      const cursorStore = await loadWhatsAppMonitorCursorStore(
        resolveWhatsAppMonitorCursorStorePath({ cronStorePath }),
      );
      expect(cursorStore.cursors["monitor:whatsapp-monitor-1"]).toMatchObject({
        lastMsgId: "inbound-1",
        updatedAtMs: 10_000,
      });
    });
  });

  it("leaves older inbound history for seeded waits uncommitted", async () => {
    await withTempStores(async ({ cronStorePath }) => {
      const dispatchEvent = vi.fn();
      const seededMonitor = createMonitor({
        sourceTarget: {
          accountId: "personal",
          target: "+971552857036",
          afterMsgId: "outbound-seed",
        },
      });
      const monitorStorePath = path.join(path.dirname(cronStorePath), "monitors.json");
      await fs.writeFile(
        monitorStorePath,
        JSON.stringify({ version: 1, monitors: [seededMonitor] }, null, 2),
        "utf-8",
      );

      const result = await pollWhatsAppMonitorEvents({
        cronStorePath,
        dbPath: "/tmp/wacli.db",
        dispatchEvent,
        lookupReply: ({ target }) =>
          createLookup(target, "old-inbound", {
            latestTs: 100,
            recentConversation: [
              {
                ...createLookup(target, "old-inbound", { latestTs: 100 }).latestInboundReply!,
                direction: "inbound",
                effectiveText: "Need this handled today",
                hasRenderableContent: true,
              },
              {
                chatJid: "74333133234289@lid",
                msgId: "outbound-seed",
                senderJid: null,
                ts: 200,
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
            ],
          }),
        nowMs: 10_000,
      });

      expect(result).toMatchObject({
        checked: 1,
        dispatched: 0,
        events: [],
        skipped: [],
        updatedCursors: 0,
      });
      expect(dispatchEvent).not.toHaveBeenCalled();

      const cursorStore = await loadWhatsAppMonitorCursorStore(
        resolveWhatsAppMonitorCursorStorePath({ cronStorePath }),
      );
      expect(cursorStore.cursors["monitor:whatsapp-monitor-1"]).toBeUndefined();
    });
  });

  it("keeps seed ordering checks for legacy seeded cursors", async () => {
    await withTempStores(async ({ cronStorePath }) => {
      const seededMonitor = createMonitor({
        sourceTarget: {
          accountId: "personal",
          target: "+971552857036",
          afterMsgId: "outbound-seed",
        },
      });
      const monitorStorePath = path.join(path.dirname(cronStorePath), "monitors.json");
      await fs.writeFile(
        monitorStorePath,
        JSON.stringify({ version: 1, monitors: [seededMonitor] }, null, 2),
        "utf-8",
      );

      await fs.writeFile(
        resolveWhatsAppMonitorCursorStorePath({ cronStorePath }),
        JSON.stringify(
          {
            version: 1,
            cursors: {
              "monitor:whatsapp-monitor-1": {
                lastMsgId: "old-inbound",
                sourceSignature: JSON.stringify({
                  accountId: "personal",
                  seed: "outbound-seed",
                  target: "+971552857036",
                }),
                updatedAtMs: 5_000,
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const dispatchEvent = vi.fn();
      const result = await pollWhatsAppMonitorEvents({
        cronStorePath,
        dbPath: "/tmp/wacli.db",
        dispatchEvent,
        lookupReply: ({ target, seedMsgId }) =>
          createLookup(target, "newly-synced-stale-inbound", {
            latestTs: 150,
            seedMessage: {
              chatJid: "971552857036@s.whatsapp.net",
              msgId: seedMsgId ?? "outbound-seed",
              senderJid: null,
              ts: 200,
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
          }),
        nowMs: 10_000,
      });

      expect(dispatchEvent).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        dispatched: 0,
        events: [],
        skipped: [],
        updatedCursors: 0,
      });

      const cursorStore = await loadWhatsAppMonitorCursorStore(
        resolveWhatsAppMonitorCursorStorePath({ cronStorePath }),
      );
      expect(cursorStore.cursors["monitor:whatsapp-monitor-1"]?.lastMsgId).toBe("old-inbound");
    });
  });

  it("dispatches the first seeded reply when the seed is found in a sibling candidate chat", async () => {
    await withTempStores(async ({ cronStorePath }) => {
      const seededMonitor = createMonitor({
        sourceTarget: {
          accountId: "personal",
          target: "971552857036@s.whatsapp.net",
          afterMsgId: "phone-outbound-seed",
        },
      });
      const monitorStorePath = path.join(path.dirname(cronStorePath), "monitors.json");
      await fs.writeFile(
        monitorStorePath,
        JSON.stringify({ version: 1, monitors: [seededMonitor] }, null, 2),
        "utf-8",
      );

      const dispatchEvent = vi.fn(async () => ({
        matched: 1,
        wakes: [
          {
            monitorId: seededMonitor.monitorId,
            enqueue: { ok: true, enqueued: true },
          },
        ],
      }));
      const result = await pollWhatsAppMonitorEvents({
        cronStorePath,
        dbPath: "/tmp/wacli.db",
        dispatchEvent,
        lookupReply: ({ target, seedMsgId }) =>
          createLookup(target, "lid-inbound-1", {
            latestTs: 300,
            seedMessage: {
              chatJid: "971552857036@s.whatsapp.net",
              msgId: seedMsgId ?? "phone-outbound-seed",
              senderJid: null,
              ts: 200,
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
            recentConversation: [
              {
                ...createLookup(target, "lid-inbound-1", { latestTs: 300 }).latestInboundReply!,
                direction: "inbound",
                effectiveText: "Need this handled today",
                hasRenderableContent: true,
              },
            ],
          }),
        nowMs: 30_000,
      });

      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      expect(result.dispatched).toBe(1);
      expect(result.updatedCursors).toBe(1);

      const cursorStore = await loadWhatsAppMonitorCursorStore(
        resolveWhatsAppMonitorCursorStorePath({ cronStorePath }),
      );
      expect(cursorStore.cursors["monitor:whatsapp-monitor-1"]?.lastMsgId).toBe("lid-inbound-1");
    });
  });

  it("leaves unresolved seeded replies uncommitted instead of marking them seen", async () => {
    await withTempStores(async ({ cronStorePath }) => {
      const seededMonitor = createMonitor({
        sourceTarget: {
          accountId: "personal",
          target: "971552857036@s.whatsapp.net",
          afterMsgId: "missing-seed",
        },
      });
      const monitorStorePath = path.join(path.dirname(cronStorePath), "monitors.json");
      await fs.writeFile(
        monitorStorePath,
        JSON.stringify({ version: 1, monitors: [seededMonitor] }, null, 2),
        "utf-8",
      );

      const result = await pollWhatsAppMonitorEvents({
        cronStorePath,
        dbPath: "/tmp/wacli.db",
        dispatchEvent: vi.fn(),
        lookupReply: ({ target }) => createLookup(target, "possibly-new-inbound"),
        nowMs: 30_000,
      });

      expect(result).toMatchObject({
        dispatched: 0,
        events: [],
        skipped: [],
        updatedCursors: 0,
      });

      const cursorStore = await loadWhatsAppMonitorCursorStore(
        resolveWhatsAppMonitorCursorStorePath({ cronStorePath }),
      );
      expect(cursorStore.cursors["monitor:whatsapp-monitor-1"]).toBeUndefined();
    });
  });

  it("leaves equal-timestamp sibling seeded replies uncommitted", async () => {
    await withTempStores(async ({ cronStorePath }) => {
      const seededMonitor = createMonitor({
        sourceTarget: {
          accountId: "personal",
          target: "971552857036@s.whatsapp.net",
          afterMsgId: "phone-outbound-seed",
        },
      });
      const monitorStorePath = path.join(path.dirname(cronStorePath), "monitors.json");
      await fs.writeFile(
        monitorStorePath,
        JSON.stringify({ version: 1, monitors: [seededMonitor] }, null, 2),
        "utf-8",
      );

      const dispatchEvent = vi.fn();
      const result = await pollWhatsAppMonitorEvents({
        cronStorePath,
        dbPath: "/tmp/wacli.db",
        dispatchEvent,
        lookupReply: ({ target, seedMsgId }) =>
          createLookup(target, "lid-inbound-same-second", {
            latestTs: 300,
            seedMessage: {
              chatJid: "971552857036@s.whatsapp.net",
              msgId: seedMsgId ?? "phone-outbound-seed",
              senderJid: null,
              ts: 300,
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
          }),
        nowMs: 30_000,
      });

      expect(dispatchEvent).not.toHaveBeenCalled();
      expect(result.updatedCursors).toBe(0);

      const cursorStore = await loadWhatsAppMonitorCursorStore(
        resolveWhatsAppMonitorCursorStorePath({ cronStorePath }),
      );
      expect(cursorStore.cursors["monitor:whatsapp-monitor-1"]).toBeUndefined();
    });
  });

  it("resets the cursor when a same-target monitor gets a new seed", async () => {
    await withTempStores(async ({ cronStorePath }) => {
      const monitorStorePath = path.join(path.dirname(cronStorePath), "monitors.json");
      await fs.writeFile(
        monitorStorePath,
        JSON.stringify(
          {
            version: 1,
            monitors: [
              createMonitor({
                sourceTarget: {
                  accountId: "personal",
                  target: "+971552857036",
                  afterMsgId: "old-seed",
                },
              }),
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      await fs.writeFile(
        resolveWhatsAppMonitorCursorStorePath({ cronStorePath }),
        JSON.stringify(
          {
            version: 1,
            cursors: {
              "monitor:whatsapp-monitor-1": {
                lastMsgId: "old-inbound",
                sourceSignature: JSON.stringify({
                  accountId: "personal",
                  seed: "old-seed",
                  target: "+971552857036",
                }),
                updatedAtMs: 10_000,
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await fs.writeFile(
        monitorStorePath,
        JSON.stringify(
          {
            version: 1,
            monitors: [
              createMonitor({
                sourceTarget: {
                  accountId: "personal",
                  target: "+971552857036",
                  afterMsgId: "new-seed",
                },
              }),
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const dispatchEvent = vi.fn(async () => ({
        matched: 1,
        wakes: [
          {
            monitorId: "whatsapp-monitor-1",
            enqueue: { ok: true, enqueued: true },
          },
        ],
      }));
      const result = await pollWhatsAppMonitorEvents({
        cronStorePath,
        dbPath: "/tmp/wacli.db",
        dispatchEvent,
        lookupReply: ({ target, seedMsgId }) =>
          createLookup(target, "post-new-seed-inbound", {
            latestTs: 250,
            seedMessage: {
              chatJid: "971552857036@s.whatsapp.net",
              msgId: seedMsgId ?? "new-seed",
              senderJid: null,
              ts: 200,
              fromMe: true,
              text: "New seed.",
              mediaType: null,
              mediaCaption: null,
              displayText: "New seed.",
              chatName: "Artem",
              senderName: "Me",
              direction: "outbound",
              effectiveText: "New seed.",
              hasRenderableContent: true,
            },
          }),
        nowMs: 20_000,
      });

      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      expect(result.updatedCursors).toBe(1);

      const cursorStore = await loadWhatsAppMonitorCursorStore(
        resolveWhatsAppMonitorCursorStorePath({ cronStorePath }),
      );
      expect(cursorStore.cursors["monitor:whatsapp-monitor-1"]).toMatchObject({
        lastMsgId: "post-new-seed-inbound",
        sourceSignature: JSON.stringify({
          accountId: "personal",
          seed: "new-seed",
          target: "+971552857036",
        }),
      });
    });
  });

  it("dispatches a new reply through monitor.routeEvent and commits after confirmed wake", async () => {
    await withTempStores(async ({ cronStorePath }) => {
      await pollWhatsAppMonitorEvents({
        cronStorePath,
        dbPath: "/tmp/wacli.db",
        lookupReply: ({ target }) => createLookup(target, "inbound-1"),
        nowMs: 10_000,
      });

      const respond = vi.fn();
      const enqueueRun = vi.fn(async (jobId: string, mode: "due" | "force") => ({
        ok: true,
        enqueued: true,
        runId: `manual:${jobId}:${mode}`,
      }));
      const result = await pollWhatsAppMonitorEvents({
        cronStorePath,
        dbPath: "/tmp/wacli.db",
        dispatchEvent: async ({ event, monitor }) => {
          await monitorHandlers["monitor.routeEvent"]({
            params: event,
            respond: respond as never,
            context: {
              cronStorePath,
              cron: {
                add: vi.fn(),
                update: vi.fn(),
                enqueueRun,
              },
            } as never,
            client: null,
            req: {
              type: "req",
              id: "req-whatsapp-monitor-poll-route",
              method: "monitor.routeEvent",
            },
            isWebchatConnect: () => false,
          });
          expect(monitor.monitorId).toBe("whatsapp-monitor-1");
          return respond.mock.calls.at(-1)?.[1];
        },
        lookupReply: ({ target }) => createLookup(target, "inbound-2"),
        nowMs: 20_000,
      });

      expect(enqueueRun).toHaveBeenCalledWith("cron-whatsapp-monitor-1", "force");
      expect(result.dispatched).toBe(1);
      expect(result.events[0]?.dispatch).toMatchObject({
        matched: 1,
        wakes: [
          {
            monitorId: "whatsapp-monitor-1",
            originSessionKey: "agent:main:telegram:direct:user-1",
            originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
          },
        ],
      });

      const cursorStore = await loadWhatsAppMonitorCursorStore(
        resolveWhatsAppMonitorCursorStorePath({ cronStorePath }),
      );
      expect(cursorStore.cursors["monitor:whatsapp-monitor-1"]?.lastMsgId).toBe("inbound-2");
    });
  });

  it("does not commit a new cursor when dispatch does not confirm a monitor wake", async () => {
    await withTempStores(async ({ cronStorePath }) => {
      await pollWhatsAppMonitorEvents({
        cronStorePath,
        dbPath: "/tmp/wacli.db",
        lookupReply: ({ target }) => createLookup(target, "inbound-1"),
        nowMs: 10_000,
      });

      const result = await pollWhatsAppMonitorEvents({
        cronStorePath,
        dbPath: "/tmp/wacli.db",
        dispatchEvent: async () => ({ matched: 0, wakes: [] }),
        lookupReply: ({ target }) => createLookup(target, "inbound-2"),
        nowMs: 20_000,
      });

      expect(result.events).toEqual([]);
      expect(result.skipped).toEqual([
        {
          error: "dispatch did not confirm monitor wake",
          monitorId: "whatsapp-monitor-1",
          reason: "dispatch_error",
        },
      ]);

      const cursorStore = await loadWhatsAppMonitorCursorStore(
        resolveWhatsAppMonitorCursorStorePath({ cronStorePath }),
      );
      expect(cursorStore.cursors["monitor:whatsapp-monitor-1"]?.lastMsgId).toBe("inbound-1");
    });
  });

  it("does not commit a new cursor when cron does not enqueue the matched wake", async () => {
    await withTempStores(async ({ cronStorePath }) => {
      await pollWhatsAppMonitorEvents({
        cronStorePath,
        dbPath: "/tmp/wacli.db",
        lookupReply: ({ target }) => createLookup(target, "inbound-1"),
        nowMs: 10_000,
      });

      const result = await pollWhatsAppMonitorEvents({
        cronStorePath,
        dbPath: "/tmp/wacli.db",
        dispatchEvent: async () => ({
          matched: 1,
          wakes: [
            {
              monitorId: "whatsapp-monitor-1",
              enqueue: { ok: true, ran: false, reason: "already-running" },
            },
          ],
        }),
        lookupReply: ({ target }) => createLookup(target, "inbound-2"),
        nowMs: 20_000,
      });

      expect(result.events).toEqual([]);
      expect(result.skipped).toEqual([
        {
          error: "dispatch did not confirm monitor wake",
          monitorId: "whatsapp-monitor-1",
          reason: "dispatch_error",
        },
      ]);

      const cursorStore = await loadWhatsAppMonitorCursorStore(
        resolveWhatsAppMonitorCursorStorePath({ cronStorePath }),
      );
      expect(cursorStore.cursors["monitor:whatsapp-monitor-1"]?.lastMsgId).toBe("inbound-1");
    });
  });
});
