import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../../src/memory/sqlite.js";
import { buildMonitorCheckCliResult, resolveMonitorStateFile } from "./wacli-monitor-check.js";

type TempDbContext = {
  root: string;
  dbPath: string;
  stateDir: string;
  db: DatabaseSync;
};

async function createTempDb(): Promise<TempDbContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wacli-monitor-check-"));
  const dbPath = path.join(root, "wacli.db");
  const stateDir = path.join(root, "state");
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
  return { root, dbPath, stateDir, db };
}

function seedArtemInbound(db: TempDbContext["db"], msgId: string, ts: number) {
  db.exec(`
    INSERT INTO chats (jid, kind, name, last_message_ts) VALUES
      ('971507664706@s.whatsapp.net', 'dm', 'Artem Getman', 1775566934),
      ('74333133234289@lid', 'unknown', 'Artem Getman', ${ts});
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
        '${msgId}',
        '74333133234289:12@lid',
        'Artem Getman',
        ${ts},
        0,
        'Wanna go to Georgian restaurant today at 7pm?',
        'Wanna go to Georgian restaurant today at 7pm?',
        NULL,
        NULL
      );
  `);
}

describe("wacli monitor check helper", () => {
  it("derives a stable state file from target and persists first-run baseline", async () => {
    const ctx = await createTempDb();
    try {
      seedArtemInbound(ctx.db, "msg-1", 1775627140);
      const result = await buildMonitorCheckCliResult({
        dbPath: ctx.dbPath,
        json: true,
        lastProcessedMsgId: null,
        stateDir: ctx.stateDir,
        stateFile: null,
        target: "971507664706@s.whatsapp.net",
      });

      expect(result.monitorStatus).toBe("new_message");
      expect(result.status).toBe("new_message");
      expect(result.latestInboundReply?.msgId).toBe("msg-1");

      const expectedStateFile = resolveMonitorStateFile(
        "971507664706@s.whatsapp.net",
        ctx.stateDir,
      );
      expect(result.stateFile).toBe(expectedStateFile);

      const persisted = JSON.parse(await fs.readFile(expectedStateFile, "utf8")) as {
        lastProcessedMsgId: string;
      };
      expect(persisted.lastProcessedMsgId).toBe("msg-1");
    } finally {
      ctx.db.close();
      await fs.rm(ctx.root, { recursive: true, force: true });
    }
  });

  it("returns no_change on a second run with the same latest inbound", async () => {
    const ctx = await createTempDb();
    try {
      seedArtemInbound(ctx.db, "msg-1", 1775627140);
      await buildMonitorCheckCliResult({
        dbPath: ctx.dbPath,
        json: true,
        lastProcessedMsgId: null,
        stateDir: ctx.stateDir,
        stateFile: null,
        target: "971507664706@s.whatsapp.net",
      });

      const secondRun = await buildMonitorCheckCliResult({
        dbPath: ctx.dbPath,
        json: true,
        lastProcessedMsgId: null,
        stateDir: ctx.stateDir,
        stateFile: null,
        target: "971507664706@s.whatsapp.net",
      });

      expect(secondRun.monitorStatus).toBe("no_change");
      expect(secondRun.monitorBootstrapDecision.action).toBe("noop");
      expect(secondRun.monitorBootstrapDecision.reason).toBe("already-processed");
    } finally {
      ctx.db.close();
      await fs.rm(ctx.root, { recursive: true, force: true });
    }
  });

  it("uses explicit --state-file when provided", async () => {
    const ctx = await createTempDb();
    try {
      seedArtemInbound(ctx.db, "msg-1", 1775627140);
      const customStateFile = path.join(ctx.root, "custom-state.json");
      const result = await buildMonitorCheckCliResult({
        dbPath: ctx.dbPath,
        json: true,
        lastProcessedMsgId: null,
        stateDir: ctx.stateDir,
        stateFile: customStateFile,
        target: "971507664706@s.whatsapp.net",
      });

      expect(result.stateFile).toBe(customStateFile);
      const persisted = JSON.parse(await fs.readFile(customStateFile, "utf8")) as {
        lastProcessedMsgId: string;
      };
      expect(persisted.lastProcessedMsgId).toBe("msg-1");
    } finally {
      ctx.db.close();
      await fs.rm(ctx.root, { recursive: true, force: true });
    }
  });
});
