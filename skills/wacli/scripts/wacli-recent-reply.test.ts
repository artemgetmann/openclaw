import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../../src/memory/sqlite.js";
import {
  buildRecentReplyCliResult,
  forceRefreshAndRead,
  parseArgs,
  type RefreshDeps,
} from "./wacli-recent-reply.js";

type TempDbContext = {
  root: string;
  dbPath: string;
  statePath: string;
  db: DatabaseSync;
};

async function createTempDb(): Promise<TempDbContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wacli-recent-reply-"));
  const dbPath = path.join(root, "wacli.db");
  const statePath = path.join(root, "monitor-state.json");
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE chats (
      jid TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT,
      last_message_ts INTEGER
    );
    CREATE TABLE contacts (
      jid TEXT PRIMARY KEY,
      phone TEXT,
      push_name TEXT,
      full_name TEXT,
      first_name TEXT,
      business_name TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE contact_aliases (
      jid TEXT PRIMARY KEY,
      alias TEXT NOT NULL,
      notes TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      chat_name TEXT,
      msg_id TEXT NOT NULL,
      sender_jid TEXT,
      sender_name TEXT,
      ts INTEGER NOT NULL,
      from_me INTEGER NOT NULL,
      text TEXT,
      display_text TEXT,
      media_type TEXT,
      media_caption TEXT
    );
  `);
  return { root, dbPath, statePath, db };
}

function seedArtemDinnerThread(db: TempDbContext["db"], params: { ts: number; msgId: string }) {
  db.exec(`
    INSERT INTO chats (jid, kind, name, last_message_ts) VALUES
      ('971507664706@s.whatsapp.net', 'dm', 'Artem Getman', 1775566934),
      ('74333133234289@lid', 'unknown', 'Artem Getman', ${params.ts});
    INSERT INTO contacts (
      jid, phone, push_name, full_name, first_name, business_name, updated_at
    ) VALUES
      ('971507664706@s.whatsapp.net', '971507664706', 'Artem Getman', 'Artem Getman', 'Artem', NULL, 1775566934),
      ('74333133234289@lid', NULL, 'Artem Getman', 'Artem Getman', 'Artem', NULL, 1775566934);
    INSERT INTO contact_aliases (jid, alias, notes, updated_at) VALUES
      ('971507664706@s.whatsapp.net', 'Artem Getman', NULL, 1775566934);
    INSERT INTO messages (
      chat_jid, chat_name, msg_id, sender_jid, sender_name, ts, from_me, text, display_text, media_type, media_caption
    ) VALUES
      (
        '971507664706@s.whatsapp.net',
        'Artem Getman',
        'outbound-1',
        NULL,
        NULL,
        1775566934,
        1,
        'Dinner?',
        'Dinner?',
        NULL,
        NULL
      ),
      (
        '74333133234289@lid',
        'Artem Getman',
        '${params.msgId}',
        '74333133234289:12@lid',
        'Artem Getman',
        ${params.ts},
        0,
        'Wanna go to Georgian restaurant today at 7pm?',
        'Wanna go to Georgian restaurant today at 7pm?',
        NULL,
        NULL
      );
  `);
}

function seedNegotiationThread(
  db: TempDbContext["db"],
  params?: { includeRepeatedOutbound?: boolean },
) {
  const includeRepeatedOutbound = params?.includeRepeatedOutbound ?? false;
  db.exec(`
    INSERT INTO chats (jid, kind, name, last_message_ts) VALUES
      ('971507664706@s.whatsapp.net', 'dm', 'Artem Getman', 1775635000),
      ('74333133234289@lid', 'unknown', 'Artem Getman', ${includeRepeatedOutbound ? 1775649600 : 1775642400});
    INSERT INTO contacts (
      jid, phone, push_name, full_name, first_name, business_name, updated_at
    ) VALUES
      ('971507664706@s.whatsapp.net', '971507664706', 'Artem Getman', 'Artem Getman', 'Artem', NULL, 1775566934),
      ('74333133234289@lid', NULL, 'Artem Getman', 'Artem Getman', 'Artem', NULL, 1775566934);
    INSERT INTO contact_aliases (jid, alias, notes, updated_at) VALUES
      ('971507664706@s.whatsapp.net', 'Artem Getman', NULL, 1775566934);
    INSERT INTO messages (
      chat_jid, chat_name, msg_id, sender_jid, sender_name, ts, from_me, text, display_text, media_type, media_caption
    ) VALUES
      (
        '74333133234289@lid',
        'Artem Getman',
        'inbound-1',
        '74333133234289:12@lid',
        'Artem Getman',
        1775635000,
        0,
        'Wanna go to Georgian restaurant today at 7pm?',
        'Wanna go to Georgian restaurant today at 7pm?',
        NULL,
        NULL
      ),
      (
        '74333133234289@lid',
        'Artem Getman',
        'outbound-1',
        NULL,
        NULL,
        1775638600,
        1,
        'Yeah, dinner works and Georgian is fine. 8pm or a bit later works better for me — can we do 8?',
        'Yeah, dinner works and Georgian is fine. 8pm or a bit later works better for me — can we do 8?',
        NULL,
        NULL
      ),
      (
        '74333133234289@lid',
        'Artem Getman',
        'inbound-2',
        '74333133234289:12@lid',
        'Artem Getman',
        1775642400,
        0,
        'Hmm maybe 7:30 pm?',
        'Hmm maybe 7:30 pm?',
        NULL,
        NULL
      )
      ${
        includeRepeatedOutbound
          ? `,
      (
        '74333133234289@lid',
        'Artem Getman',
        'outbound-2',
        NULL,
        NULL,
        1775646000,
        1,
        'Yeah, dinner works and Georgian is fine. 8pm or a bit later works better for me — can we do 8?',
        'Yeah, dinner works and Georgian is fine. 8pm or a bit later works better for me — can we do 8?',
        NULL,
        NULL
      ),
      (
        '74333133234289@lid',
        'Artem Getman',
        'inbound-3',
        '74333133234289:12@lid',
        'Artem Getman',
        1775649600,
        0,
        'What bout 7:45 pm bro please',
        'What bout 7:45 pm bro please',
        NULL,
        NULL
      )`
          : ""
      }
      ;
  `);
}

afterEach(() => {
  // No global state leaks across tests.
});

describe("wacli recent reply monitor state", () => {
  it("marks first actionable inbound as new_message and persists baseline state", async () => {
    const ctx = await createTempDb();
    try {
      seedArtemDinnerThread(ctx.db, { ts: 1775627140, msgId: "msg-1" });
      const result = await buildRecentReplyCliResult({
        dbPath: ctx.dbPath,
        json: true,
        lastProcessedMsgId: null,
        stateFile: ctx.statePath,
        target: "971507664706@s.whatsapp.net",
      });

      expect(result.monitorStatus).toBe("new_message");
      expect(result.status).toBe("new_message");
      expect(result.monitorBootstrapDecision.action).toBe("process-latest");
      expect(result.latestInboundReply?.msgId).toBe("msg-1");
      const state = JSON.parse(await fs.readFile(ctx.statePath, "utf8")) as {
        lastProcessedMsgId: string;
        msgId: string;
        ts: number;
      };
      expect(state.lastProcessedMsgId).toBe("msg-1");
      expect(state.msgId).toBe("msg-1");
      expect(state.ts).toBe(1775627140);
    } finally {
      ctx.db.close();
      await fs.rm(ctx.root, { recursive: true, force: true });
    }
  });

  it("returns no_change on an unchanged run once the baseline is persisted", async () => {
    const ctx = await createTempDb();
    try {
      seedArtemDinnerThread(ctx.db, { ts: 1775627140, msgId: "msg-1" });
      await fs.writeFile(
        ctx.statePath,
        JSON.stringify({ lastProcessedMsgId: "msg-1", ts: 1775627140 }),
      );

      const result = await buildRecentReplyCliResult({
        dbPath: ctx.dbPath,
        json: true,
        lastProcessedMsgId: null,
        stateFile: ctx.statePath,
        target: "971507664706@s.whatsapp.net",
      });

      expect(result.monitorStatus).toBe("no_change");
      expect(result.status).toBe("no_change");
      expect(result.monitorBootstrapDecision.action).toBe("noop");
      expect(result.monitorBootstrapDecision.reason).toBe("already-processed");
    } finally {
      ctx.db.close();
      await fs.rm(ctx.root, { recursive: true, force: true });
    }
  });

  it("returns new_message again when a newer inbound arrives", async () => {
    const ctx = await createTempDb();
    try {
      seedArtemDinnerThread(ctx.db, { ts: 1775627140, msgId: "msg-1" });
      await fs.writeFile(
        ctx.statePath,
        JSON.stringify({ lastProcessedMsgId: "msg-1", ts: 1775627140 }),
      );

      ctx.db.exec(`
        UPDATE chats
        SET last_message_ts = 1775630000
        WHERE jid = '74333133234289@lid';
        INSERT INTO messages (
          chat_jid, chat_name, msg_id, sender_jid, sender_name, ts, from_me, text, display_text, media_type, media_caption
        ) VALUES
          (
            '74333133234289@lid',
            'Artem Getman',
            'msg-2',
            '74333133234289:12@lid',
            'Artem Getman',
            1775630000,
            0,
            'Confirming dinner works for me.',
            'Confirming dinner works for me.',
            NULL,
            NULL
          );
      `);

      const result = await buildRecentReplyCliResult({
        dbPath: ctx.dbPath,
        json: true,
        lastProcessedMsgId: null,
        stateFile: ctx.statePath,
        target: "971507664706@s.whatsapp.net",
      });

      expect(result.monitorStatus).toBe("new_message");
      expect(result.status).toBe("new_message");
      expect(result.monitorBootstrapDecision.action).toBe("process-latest");
      expect(result.latestInboundReply?.msgId).toBe("msg-2");
      const state = JSON.parse(await fs.readFile(ctx.statePath, "utf8")) as {
        lastProcessedMsgId: string;
        msgId: string;
        ts: number;
      };
      expect(state.lastProcessedMsgId).toBe("msg-2");
      expect(state.ts).toBe(1775630000);
    } finally {
      ctx.db.close();
      await fs.rm(ctx.root, { recursive: true, force: true });
    }
  });

  it("returns recent conversation turns so monitors can continue the negotiation", async () => {
    const ctx = await createTempDb();
    try {
      seedNegotiationThread(ctx.db);

      const result = await buildRecentReplyCliResult({
        dbPath: ctx.dbPath,
        json: true,
        lastProcessedMsgId: null,
        stateFile: null,
        target: "971507664706@s.whatsapp.net",
      });

      expect(result.latestInboundReply?.msgId).toBe("inbound-2");
      expect(result.recentConversation.map((turn) => [turn.direction, turn.effectiveText])).toEqual(
        [
          ["inbound", "Wanna go to Georgian restaurant today at 7pm?"],
          [
            "outbound",
            "Yeah, dinner works and Georgian is fine. 8pm or a bit later works better for me — can we do 8?",
          ],
          ["inbound", "Hmm maybe 7:30 pm?"],
        ],
      );
      expect(result.continuity.contextChatJid).toBe("74333133234289@lid");
      expect(result.continuity.hasPriorOutbound).toBe(true);
      expect(result.continuity.lastOutboundReply?.msgId).toBe("outbound-1");
      expect(result.continuity.lastOutboundReply?.effectiveText).toContain("8pm");
      expect(result.continuity.lastOutboundIsRepeatOfPrevious).toBe(false);
    } finally {
      ctx.db.close();
      await fs.rm(ctx.root, { recursive: true, force: true });
    }
  });

  it("flags repeated outbound negotiation lines as repeat risk", async () => {
    const ctx = await createTempDb();
    try {
      seedNegotiationThread(ctx.db, { includeRepeatedOutbound: true });

      const result = await buildRecentReplyCliResult({
        dbPath: ctx.dbPath,
        json: true,
        lastProcessedMsgId: null,
        stateFile: null,
        target: "971507664706@s.whatsapp.net",
      });

      expect(result.latestInboundReply?.msgId).toBe("inbound-3");
      expect(result.continuity.lastOutboundReply?.msgId).toBe("outbound-2");
      expect(result.continuity.previousOutboundReply?.msgId).toBe("outbound-1");
      expect(result.continuity.lastOutboundNormalizedText).toBe(
        result.continuity.previousOutboundNormalizedText,
      );
      expect(result.continuity.lastOutboundIsRepeatOfPrevious).toBe(true);
    } finally {
      ctx.db.close();
      await fs.rm(ctx.root, { recursive: true, force: true });
    }
  });
});

type RecentReplyResult = Awaited<ReturnType<typeof buildRecentReplyCliResult>>;

function refreshArgs(dbPath: string) {
  return {
    dbPath,
    json: true,
    lastProcessedMsgId: null,
    refresh: true,
    stateFile: null,
    target: "971507664706@s.whatsapp.net",
  };
}

function restoredOwnerStatus(overrides: Record<string, unknown> = {}) {
  return {
    ownerRunning: true,
    ownerPid: 202,
    ownerCommandMatches: true,
    lockHeldByOwner: true,
    lockPid: 202,
    connected: true,
    ...overrides,
  };
}

function refreshDeps(result: RecentReplyResult, overrides: Partial<RefreshDeps> = {}): RefreshDeps {
  return {
    acquireStoreLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
    ensureOwner: vi.fn(async () => restoredOwnerStatus()),
    readResult: vi.fn(async () => result),
    runBoundedSync: vi.fn(async () => undefined),
    statusOwner: vi.fn(async () => ({
      ownerRunning: false,
      ownerCommandMatches: false,
      lockHeldByOwner: false,
    })),
    stopOwner: vi.fn(async () => ({
      ownerRunning: false,
      ownerCommandMatches: false,
      lockHeldByOwner: false,
      stoppedPid: 101,
      stopReason: "stopped",
    })),
    ...overrides,
  };
}

describe("wacli forced catch-up", () => {
  it("parses forced refresh while preserving the caller's custom database path", () => {
    expect(
      parseArgs(["--target", "+15550001111", "--db", "/tmp/custom-store/history.db", "--refresh"]),
    ).toMatchObject({
      dbPath: "/tmp/custom-store/history.db",
      refresh: true,
      target: "+15550001111",
    });
  });

  it("runs bounded catch-up without owner churn when no owner is recorded", async () => {
    const result = {} as RecentReplyResult;
    const deps = refreshDeps(result);

    const refreshed = await forceRefreshAndRead(refreshArgs("/tmp/custom-store/history.db"), deps);

    expect(deps.acquireStoreLock).toHaveBeenCalledWith("/tmp/custom-store");
    expect(deps.runBoundedSync).toHaveBeenCalledWith("/tmp/custom-store");
    expect(deps.stopOwner).not.toHaveBeenCalled();
    expect(deps.ensureOwner).not.toHaveBeenCalled();
    expect(refreshed).toEqual({
      refresh: {
        attempted: true,
        freshnessProven: true,
        ownerRestored: false,
        ownerWasRunning: false,
        succeeded: true,
      },
      result,
    });
  });

  it("refuses a running recorded owner whose command identity does not match", async () => {
    const deps = refreshDeps({} as RecentReplyResult, {
      statusOwner: vi.fn(async () => ({
        ownerRunning: true,
        ownerPid: 101,
        ownerCommandMatches: false,
        lockHeldByOwner: false,
      })),
    });

    await expect(
      forceRefreshAndRead(refreshArgs("/tmp/custom-store/history.db"), deps),
    ).rejects.toThrow("recorded live owner command does not match");
    expect(deps.stopOwner).not.toHaveBeenCalled();
    expect(deps.runBoundedSync).not.toHaveBeenCalled();
    expect(deps.ensureOwner).not.toHaveBeenCalled();
  });

  it("refuses catch-up when the owner identity changes at stop time", async () => {
    const deps = refreshDeps({} as RecentReplyResult, {
      statusOwner: vi.fn(async () => restoredOwnerStatus({ ownerPid: 101, lockPid: 101 })),
      stopOwner: vi.fn(async () => ({
        ownerRunning: false,
        ownerCommandMatches: false,
        lockHeldByOwner: false,
        stopReason: "pid_command_mismatch",
      })),
    });

    await expect(
      forceRefreshAndRead(refreshArgs("/tmp/custom-store/history.db"), deps),
    ).rejects.toThrow("recorded owner changed while it was being paused");
    expect(deps.runBoundedSync).not.toHaveBeenCalled();
    expect(deps.ensureOwner).toHaveBeenCalledTimes(1);
  });

  it("restores the exact owner after bounded sync fails", async () => {
    const deps = refreshDeps({} as RecentReplyResult, {
      statusOwner: vi.fn(async () => restoredOwnerStatus({ ownerPid: 101, lockPid: 101 })),
      runBoundedSync: vi.fn(async () => {
        throw new Error("bounded sync failed");
      }),
    });

    await expect(
      forceRefreshAndRead(refreshArgs("/tmp/custom-store/history.db"), deps),
    ).rejects.toThrow("bounded sync failed");
    expect(deps.ensureOwner).toHaveBeenCalledTimes(1);
    expect(deps.readResult).not.toHaveBeenCalled();
  });

  it("fails when restoration lacks exact command and store-lock proof", async () => {
    const deps = refreshDeps({} as RecentReplyResult, {
      statusOwner: vi.fn(async () => restoredOwnerStatus({ ownerPid: 101, lockPid: 101 })),
      ensureOwner: vi.fn(async () =>
        restoredOwnerStatus({ lockHeldByOwner: false, connected: false }),
      ),
    });

    await expect(
      forceRefreshAndRead(refreshArgs("/tmp/custom-store/history.db"), deps),
    ).rejects.toThrow("could not be proven restored");
  });

  it("composes sync and restoration errors instead of masking either failure", async () => {
    const deps = refreshDeps({} as RecentReplyResult, {
      statusOwner: vi.fn(async () => restoredOwnerStatus({ ownerPid: 101, lockPid: 101 })),
      runBoundedSync: vi.fn(async () => {
        throw new Error("bounded sync failed");
      }),
      ensureOwner: vi.fn(async () => {
        throw new Error("owner ensure failed");
      }),
    });

    await expect(
      forceRefreshAndRead(refreshArgs("/tmp/custom-store/history.db"), deps),
    ).rejects.toThrow(
      "Forced WhatsApp catch-up failed: bounded sync failed Restoration also failed: owner ensure failed",
    );
  });

  it("rereads the database only after catch-up adds the newer inbound", async () => {
    const ctx = await createTempDb();
    try {
      seedArtemDinnerThread(ctx.db, { ts: 1775627140, msgId: "older-inbound" });
      const args = refreshArgs(ctx.dbPath);
      const initial = await buildRecentReplyCliResult(args);
      const deps = refreshDeps(initial, {
        runBoundedSync: vi.fn(async () => {
          ctx.db.exec(`
            UPDATE chats
            SET last_message_ts = 1775630000
            WHERE jid = '74333133234289@lid';
            INSERT INTO messages (
              chat_jid, chat_name, msg_id, sender_jid, sender_name, ts, from_me,
              text, display_text, media_type, media_caption
            ) VALUES (
              '74333133234289@lid', 'Artem Getman', 'newer-inbound',
              '74333133234289:12@lid', 'Artem Getman', 1775630000, 0,
              'The newer update is available.', 'The newer update is available.', NULL, NULL
            );
          `);
        }),
        readResult: vi.fn(async (readArgs) => await buildRecentReplyCliResult(readArgs)),
      });

      const refreshed = await forceRefreshAndRead(args, deps);

      expect(refreshed.refresh.freshnessProven).toBe(true);
      expect(refreshed.result.latestInboundReply?.msgId).toBe("newer-inbound");
      expect(deps.runBoundedSync).toHaveBeenCalledBefore(
        deps.readResult as ReturnType<typeof vi.fn>,
      );
    } finally {
      ctx.db.close();
      await fs.rm(ctx.root, { recursive: true, force: true });
    }
  });
});
