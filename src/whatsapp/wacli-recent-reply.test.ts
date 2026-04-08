import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildRecentReplyCliResult } from "../../skills/wacli/scripts/wacli-recent-reply.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

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

afterEach(() => {
  // No global state.
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

      expect(result.status).toBe("new_message");
      expect(result.monitorBootstrapDecision.action).toBe("process-latest");
      expect(result.latestInboundReply?.msgId).toBe("msg-2");
      const state = JSON.parse(await fs.readFile(ctx.statePath, "utf8")) as {
        lastProcessedMsgId: string;
        msgId: string;
        ts: number;
      };
      expect(state.lastProcessedMsgId).toBe("msg-2");
    } finally {
      ctx.db.close();
      await fs.rm(ctx.root, { recursive: true, force: true });
    }
  });
});
